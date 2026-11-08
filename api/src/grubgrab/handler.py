"""Lambda entry point for the HTTP API (payload format 2.0)."""

from __future__ import annotations

import base64
import binascii
import json
import os
import time
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse

import boto3

from . import ai
from .aggregate import aggregate, combine, normalise_name
from .aisles import AISLES, MAX_REMEMBERED
from .errors import ApiError
from . import feedback
from .store import INVITE_LENGTH, Store, normalise_invite_code

MAX_TEXT = 200
MAX_NOTES = 10_000
MAX_INGREDIENTS = 200
MAX_LINK = 2000
MAX_TAGS = 20
MAX_TAG_LEN = 30
MAX_RECIPES_PER_LIST = 50
MAX_QUANTITY = Decimal(1_000_000)
MAX_JOIN_ATTEMPTS_PER_HOUR = 5
# Per-household caps: far above real use, low enough that one account can't run up a storage bill.
MAX_RECIPES = 500
MAX_LIST_ITEMS = 500
ADMIN_GROUP = "admins"  # Cognito group; members approve sign-up requests
DEFAULT_AI_MONTHLY_LIMIT = 20  # AI recipe imports per household per month (AI_MONTHLY_LIMIT overrides)

_store: Store | None = None


def _get_store() -> Store:
    global _store
    if _store is None:
        _store = Store()
    return _store


def _json_default(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Not serialisable: {type(value)}")


def _resp(status: int, body=None) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body, default=_json_default) if body is not None else "",
    }


# ---- input parsing -------------------------------------------------------------


def _body(event: dict) -> dict:
    raw = event.get("body") or "{}"
    try:
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw, validate=True).decode()
        data = json.loads(raw, parse_float=Decimal)
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ApiError(400, "bad_request", "Body must be JSON") from exc
    if not isinstance(data, dict):
        raise ApiError(400, "bad_request", "Body must be a JSON object")
    return data


def _field_key(label: str) -> str:
    """"Ingredient name" -> "ingredient_name": the app translates field names by this key."""
    return label.lower().replace(" ", "_")


def _text(value, field: str, *, required: bool = False, max_len: int = MAX_TEXT) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(400, "field_not_text", f"{field} must be text", field=_field_key(field))
    value = value.strip()
    if required and not value:
        raise ApiError(400, "field_required", f"{field} is required", field=_field_key(field))
    if len(value) > max_len:
        raise ApiError(400, "field_too_long", f"{field} is too long (max {max_len})", field=_field_key(field), max=max_len)
    return value


def _quantity(value) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, Decimal, str)):
        raise ApiError(400, "quantity_invalid", f"Invalid quantity: {value!r}", value=str(value)[:40])
    try:
        q = Decimal(str(value).strip())
    except InvalidOperation as exc:
        raise ApiError(400, "quantity_invalid", f"Invalid quantity: {value!r}", value=str(value)[:40]) from exc
    if not q.is_finite() or q < 0 or q > MAX_QUANTITY:
        raise ApiError(400, "quantity_invalid", f"Invalid quantity: {value!r}", value=str(value)[:40])
    return q


def _link(value) -> str:
    """Where the recipe came from. Only http(s) web addresses, so a link can never run code when tapped."""
    link = _text(value, "Link", max_len=MAX_LINK)
    if not link:
        return ""
    parsed = urlparse(link)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise ApiError(400, "link_invalid", "Link must be a web address starting with http:// or https://")
    return link


def _tags(value) -> list[str]:
    """Free-form labels like "soup" or "fish". Lower-cased and de-duplicated so filters group them."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError(400, "bad_request", "Tags must be a list")
    tags: list[str] = []
    for raw in value:
        tag = _text(raw, "Tag", max_len=MAX_TAG_LEN).lower()
        if tag and tag not in tags:
            tags.append(tag)
    if len(tags) > MAX_TAGS:
        raise ApiError(400, "too_many_tags", f"Too many tags (max {MAX_TAGS})", max=MAX_TAGS)
    return tags


def _servings(value) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)) or value != int(value) or not 1 <= value <= 1000:
        raise ApiError(400, "servings_invalid", "Servings must be a whole number from 1 to 1000")
    return int(value)


def _validate_recipe(data: dict) -> dict:
    raw_ingredients = data.get("ingredients") or []
    if not isinstance(raw_ingredients, list):
        raise ApiError(400, "bad_request", "Ingredients must be a list")
    if len(raw_ingredients) > MAX_INGREDIENTS:
        raise ApiError(400, "too_many_ingredients", f"Too many ingredients (max {MAX_INGREDIENTS})", max=MAX_INGREDIENTS)
    ingredients = []
    for ing in raw_ingredients:
        if not isinstance(ing, dict):
            raise ApiError(400, "bad_request", "Each ingredient must be an object")
        name = _text(ing.get("name"), "Ingredient name")
        if not name:
            continue  # blank rows from the editor are dropped
        ingredient = {"name": name, "quantity": _quantity(ing.get("quantity")), "unit": _text(ing.get("unit"), "Unit")}
        if ing.get("aisle") in AISLES:  # from "Fill from link"; anything else is dropped, not an error
            ingredient["aisle"] = ing["aisle"]
        ingredients.append(ingredient)
    return {
        "title": _text(data.get("title"), "Title", required=True),
        "servings": _servings(data.get("servings")),
        "notes": _text(data.get("notes"), "Notes", max_len=MAX_NOTES),
        "link": _link(data.get("link")),
        "tags": _tags(data.get("tags")),
        "ingredients": ingredients,
    }


def _recipe_ids(data: dict) -> list[str]:
    ids = data.get("recipeIds")
    if not isinstance(ids, list) or not ids:
        raise ApiError(400, "pick_recipe", "Pick at least one recipe")
    if not all(isinstance(i, str) and i for i in ids):
        raise ApiError(400, "bad_request", "Recipe ids must be text")
    if len(ids) > MAX_RECIPES_PER_LIST:
        raise ApiError(400, "too_many_recipes", f"Too many recipes (max {MAX_RECIPES_PER_LIST})", max=MAX_RECIPES_PER_LIST)
    return list(dict.fromkeys(ids))  # ignore duplicates


# ---- operations ------------------------------------------------------------------


def _generate_list(store: Store, hh: str, data: dict) -> list[dict]:
    mode = data.get("mode", "replace")
    if mode not in ("replace", "append"):
        raise ApiError(400, "bad_request", "Mode must be 'replace' or 'append'")
    recipes = []
    for rid in _recipe_ids(data):
        recipe = store.get_recipe(hh, rid)
        if recipe is None:
            raise ApiError(404, "recipe_not_found", f"Recipe {rid} not found")
        recipes.append(recipe)

    current = store.list_items(hh)
    if mode == "replace":
        remove, kept = current, 0
        new_items = aggregate(recipes)
    else:
        # Fold the new ingredients into what's still unticked; ticked items are left alone.
        remove = [i for i in current if not i.get("checked")]
        kept = len(current) - len(remove)
        new_items = combine(remove + aggregate(recipes))
    # Check the size before writing anything, so an oversized request costs nothing.
    if kept + len(new_items) > MAX_LIST_ITEMS:
        raise ApiError(409, "list_too_long", f"That would make the list longer than {MAX_LIST_ITEMS} items", max=MAX_LIST_ITEMS)
    store.replace_items(hh, [i["id"] for i in remove], new_items)
    return store.list_items(hh)


def _set_aisle(store: Store, hh: str, data: dict) -> dict:
    """Someone moved an item to another aisle: put it there from now on, for the whole household."""
    name = normalise_name(_text(data.get("name"), "Name", required=True))
    aisle = data.get("aisle")
    if aisle not in AISLES:
        raise ApiError(400, "aisle_invalid", f"Unknown aisle {str(aisle)[:20]!r}")
    if not store.set_aisle(hh, name, aisle):
        raise ApiError(409, "aisle_limit", f"Your household already has {MAX_REMEMBERED} items moved to other aisles", max=MAX_REMEMBERED)
    return _resp(200, store.get_household(hh))


def _language(data: dict) -> str:
    language = data.get("language")
    if language not in ai.recipe.LANGUAGES:
        raise ApiError(400, "language_invalid", f"Unknown language {str(language)[:10]!r}")
    return language


def _start_import_worker(household_id: str, job_id: str, link: str, language: str) -> None:
    """Hand the job to the import worker function and return at once (it can take longer than an API call)."""
    boto3.client("lambda").invoke(
        FunctionName=os.environ["IMPORT_WORKER_NAME"],
        InvocationType="Event",
        Payload=json.dumps({"householdId": household_id, "jobId": job_id, "link": link, "language": language}).encode(),
    )


def _import_recipe(store: Store, hh: str, data: dict) -> dict:
    """Start filling a recipe draft from a web page with AI. The app polls for the result and shows it for
    review; nothing is saved by this."""
    if not ai.enabled():
        raise ApiError(404, "import_off", "Recipe import isn't set up on this server.")
    link = _link(data.get("link"))
    if not link:
        raise ApiError(400, "link_required", "Paste a link to a recipe page first")
    # Count the attempt before calling the AI, so the monthly allowance also caps what failures can cost.
    limit = int(os.environ.get("AI_MONTHLY_LIMIT") or DEFAULT_AI_MONTHLY_LIMIT)
    used = store.record_ai_import(hh)
    if used > limit:
        raise ApiError(
            429, "import_limit", f"Your household has used this month's {limit} recipe imports. Add this one by hand.", limit=limit
        )
    # Written in the household's recipe language, whoever imports it, so names and tags match across the
    # household and the shopping list can add them up.
    language = store.get_household(hh)["recipeLanguage"]
    job_id = store.create_import_job(hh, link, language)
    _start_import_worker(hh, job_id, link, language)
    return _resp(202, {"jobId": job_id, "remaining": limit - used})


def _delete_sign_in(username: str) -> None:
    """Remove the Cognito user, so the account is gone and its sessions stop working."""
    client = boto3.client("cognito-idp")
    try:
        client.admin_delete_user(UserPoolId=os.environ["USER_POOL_ID"], Username=username)
    except client.exceptions.UserNotFoundException:
        pass  # already gone (e.g. a retry after a partial failure)


def _delete_account(sub: str, claims: dict, store: Store) -> dict:
    username = claims.get("username")
    if not username:
        raise ApiError(400, "account_unknown", "Can't tell which account to delete")
    # Data first: if removing the sign-in then fails, a retry finishes the job (nothing is left orphaned).
    household_deleted = store.delete_user_data(sub, username)
    _delete_sign_in(username)
    return _resp(200, {"deleted": True, "householdDeleted": household_deleted})


def _feedback(store: Store, sub: str, data: dict) -> dict:
    """A problem report, an automatic error report, or an import's outcome (see feedback.py)."""
    kind = data.get("kind")
    if kind not in feedback.KINDS:
        raise ApiError(400, "feedback_invalid", f"Unknown kind {str(kind)[:20]!r}")
    hh = store.household_for(sub)
    job_id = data.get("jobId")
    job = None
    if job_id:
        if not isinstance(job_id, str) or not hh:
            raise ApiError(404, "import_not_found", "Import not found")
        job = _require(store.import_job_record(hh, job_id[:64]), "Import")
    elif kind == "outcome":
        raise ApiError(400, "feedback_invalid", "An outcome needs its import")
    if kind != "outcome" and store.count_feedback(sub, kind) > feedback.daily_limit(kind):
        raise ApiError(429, "feedback_limit", "Too many reports today. Try again tomorrow.")
    record = feedback.build(data, user=sub, household=hh, job=job, now=time.time())
    if kind == "outcome" and not store.claim_import_outcome(hh, job_id):
        return _resp(200, {"recorded": False})  # already recorded once (e.g. sent again after being offline)
    store.add_feedback(record)
    return _resp(201, {"id": record["id"]})


def _is_admin(claims: dict) -> bool:
    # API Gateway passes list claims as text, e.g. "[admins]" or "[admins other]".
    groups = claims.get("cognito:groups") or []
    if isinstance(groups, str):
        groups = groups.strip("[]").replace(",", " ").split()
    return ADMIN_GROUP in groups


def _admin_route(route_key: str, params: dict, claims: dict, store: Store) -> dict:
    if not _is_admin(claims):
        raise ApiError(403, "admins_only", "Only admins can do that")
    if route_key == "GET /admin/requests":
        return _resp(200, store.access_requests())
    if route_key == "POST /admin/requests/decline-pending":
        return _resp(200, {"declined": store.decline_all_pending()})
    if route_key in ("POST /admin/requests/{username}/approve", "POST /admin/requests/{username}/decline"):
        decided = store.decide_access(params["username"], approve=route_key.endswith("/approve"))
        return _resp(200, _require(decided, "Request"))
    raise ApiError(404, "bad_request", f"No route for {route_key}")


def _require(found, what: str):
    if not found:
        raise ApiError(404, f"{_field_key(what)}_not_found", f"{what} not found")
    return found


def route(event: dict, store: Store) -> dict:
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt", {}).get("claims", {})
    sub = claims.get("sub")
    if not sub:
        raise ApiError(401, "not_signed_in", "Not signed in")

    route_key = event.get("routeKey", "")
    params = event.get("pathParameters") or {}

    if route_key.split(" ", 1)[-1].startswith("/admin/"):
        return _admin_route(route_key, params, claims, store)
    if route_key == "GET /me":
        # New users have no household until they start one or join one (the app asks on first sign-in).
        me = store.find_household(sub) or {"householdId": None, "inviteCode": None}
        language = store.get_user_language(sub)
        if language:
            me = {**me, "language": language}
        if _is_admin(claims):
            me = {**me, "admin": True, "pendingRequests": len(store.access_requests())}
        return _resp(200, me)
    if route_key == "PATCH /me":
        store.set_user_language(sub, _language(_body(event)))
        return _resp(204)
    if route_key == "DELETE /me":
        return _delete_account(sub, claims, store)
    if route_key == "POST /feedback":  # works before joining a household too (e.g. an error on the welcome screen)
        return _feedback(store, sub, _body(event))
    if route_key == "POST /household":
        data = _body(event)
        return _resp(200, store.create_household(sub, _language(data) if "language" in data else "en"))
    if route_key == "POST /household/join":
        # Count every attempt before looking anything up, so codes can't be brute-forced.
        if store.record_join_attempt(sub) > MAX_JOIN_ATTEMPTS_PER_HOUR:
            raise ApiError(429, "too_many_attempts", "Too many attempts. Try again in an hour.")
        code = normalise_invite_code(_text(_body(event).get("code"), "Code", required=True, max_len=20))
        if len(code) != INVITE_LENGTH:
            raise ApiError(400, "invite_code_length", f"Invite codes are {INVITE_LENGTH} characters", length=INVITE_LENGTH)
        return _resp(200, _require(store.join_household(sub, code), "Invite code"))

    hh = store.household_for(sub)
    if hh is None:
        raise ApiError(409, "no_household", "No household yet. Start one or join one with a code.")

    if route_key == "PUT /household/recipe-language":
        return _resp(200, store.set_recipe_language(hh, _language(_body(event))))
    if route_key == "PUT /household/aisles":
        return _set_aisle(store, hh, _body(event))
    if route_key == "POST /household/invite":
        return _resp(200, store.rotate_invite(hh))

    if route_key == "GET /recipes":
        return _resp(200, store.list_recipes(hh))
    if route_key == "POST /recipes":
        recipe = _validate_recipe(_body(event))
        if store.count_recipes(hh) >= MAX_RECIPES:
            raise ApiError(409, "recipe_limit", f"You've reached the limit of {MAX_RECIPES} recipes. Delete some to add more.", max=MAX_RECIPES)
        return _resp(201, store.put_recipe(hh, recipe))
    if route_key == "POST /recipes/import":
        return _import_recipe(store, hh, _body(event))
    if route_key == "GET /recipes/import/{id}":
        return _resp(200, _require(store.get_import_job(hh, params["id"]), "Import"))
    if route_key == "GET /recipes/{id}":
        return _resp(200, _require(store.get_recipe(hh, params["id"]), "Recipe"))
    if route_key == "PUT /recipes/{id}":
        recipe = _validate_recipe(_body(event))
        _require(store.get_recipe(hh, params["id"]), "Recipe")
        return _resp(200, store.put_recipe(hh, recipe, params["id"]))
    if route_key == "DELETE /recipes/{id}":
        store.delete_recipe(hh, params["id"])
        return _resp(204)

    if route_key == "GET /list":
        return _resp(200, store.list_items(hh))
    if route_key == "POST /list/generate":
        return _resp(200, _generate_list(store, hh, _body(event)))
    if route_key == "POST /list/items":
        data = _body(event)
        name = _text(data.get("name"), "Name", required=True)
        if store.count_items(hh) >= MAX_LIST_ITEMS:
            raise ApiError(409, "list_full", f"The list is full ({MAX_LIST_ITEMS} items). Clear some to add more.", max=MAX_LIST_ITEMS)
        return _resp(201, store.add_item(hh, name, _quantity(data.get("quantity")), _text(data.get("unit"), "Unit")))
    if route_key == "PATCH /list/items/{id}":
        checked = _body(event).get("checked")
        if not isinstance(checked, bool):
            raise ApiError(400, "bad_request", "checked must be true or false")
        return _resp(200, _require(store.set_checked(hh, params["id"], checked), "Item"))
    if route_key == "DELETE /list/items/{id}":
        store.delete_item(hh, params["id"])
        return _resp(204)
    if route_key == "DELETE /list":
        only_checked = (event.get("queryStringParameters") or {}).get("checked") == "true"
        store.clear_items(hh, only_checked=only_checked)
        return _resp(204)

    raise ApiError(404, "bad_request", f"No route for {route_key}")


def handle(event: dict, store: Store) -> dict:
    try:
        return route(event, store)
    except ApiError as err:
        return _resp(err.status, {"error": err.message, "code": err.code, "params": err.params})


def lambda_handler(event, context):
    return handle(event, _get_store())
