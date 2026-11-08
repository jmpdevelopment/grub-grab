"""Lambda entry point for the HTTP API (payload format 2.0)."""

from __future__ import annotations

import base64
import binascii
import json
from decimal import Decimal, InvalidOperation

from .aggregate import aggregate, combine
from .store import INVITE_LENGTH, Store, normalise_invite_code

MAX_TEXT = 200
MAX_NOTES = 10_000
MAX_INGREDIENTS = 200
MAX_RECIPES_PER_LIST = 50
MAX_QUANTITY = Decimal(1_000_000)
MAX_JOIN_ATTEMPTS_PER_HOUR = 5

_store: Store | None = None


def _get_store() -> Store:
    global _store
    if _store is None:
        _store = Store()
    return _store


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


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
        raise ApiError(400, "Body must be JSON") from exc
    if not isinstance(data, dict):
        raise ApiError(400, "Body must be a JSON object")
    return data


def _text(value, field: str, *, required: bool = False, max_len: int = MAX_TEXT) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(400, f"{field} must be text")
    value = value.strip()
    if required and not value:
        raise ApiError(400, f"{field} is required")
    if len(value) > max_len:
        raise ApiError(400, f"{field} is too long (max {max_len})")
    return value


def _quantity(value) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, Decimal, str)):
        raise ApiError(400, f"Invalid quantity: {value!r}")
    try:
        q = Decimal(str(value).strip())
    except InvalidOperation as exc:
        raise ApiError(400, f"Invalid quantity: {value!r}") from exc
    if not q.is_finite() or q < 0 or q > MAX_QUANTITY:
        raise ApiError(400, f"Invalid quantity: {value!r}")
    return q


def _servings(value) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)) or value != int(value) or not 1 <= value <= 1000:
        raise ApiError(400, "Servings must be a whole number from 1 to 1000")
    return int(value)


def _validate_recipe(data: dict) -> dict:
    raw_ingredients = data.get("ingredients") or []
    if not isinstance(raw_ingredients, list):
        raise ApiError(400, "Ingredients must be a list")
    if len(raw_ingredients) > MAX_INGREDIENTS:
        raise ApiError(400, f"Too many ingredients (max {MAX_INGREDIENTS})")
    ingredients = []
    for ing in raw_ingredients:
        if not isinstance(ing, dict):
            raise ApiError(400, "Each ingredient must be an object")
        name = _text(ing.get("name"), "Ingredient name")
        if not name:
            continue  # blank rows from the editor are dropped
        ingredients.append(
            {"name": name, "quantity": _quantity(ing.get("quantity")), "unit": _text(ing.get("unit"), "Unit")}
        )
    return {
        "title": _text(data.get("title"), "Title", required=True),
        "servings": _servings(data.get("servings")),
        "notes": _text(data.get("notes"), "Notes", max_len=MAX_NOTES),
        "ingredients": ingredients,
    }


def _recipe_ids(data: dict) -> list[str]:
    ids = data.get("recipeIds")
    if not isinstance(ids, list) or not ids:
        raise ApiError(400, "Pick at least one recipe")
    if not all(isinstance(i, str) and i for i in ids):
        raise ApiError(400, "Recipe ids must be text")
    if len(ids) > MAX_RECIPES_PER_LIST:
        raise ApiError(400, f"Too many recipes (max {MAX_RECIPES_PER_LIST})")
    return list(dict.fromkeys(ids))  # ignore duplicates


# ---- operations ------------------------------------------------------------------


def _generate_list(store: Store, hh: str, data: dict) -> list[dict]:
    mode = data.get("mode", "replace")
    if mode not in ("replace", "append"):
        raise ApiError(400, "Mode must be 'replace' or 'append'")
    recipes = []
    for rid in _recipe_ids(data):
        recipe = store.get_recipe(hh, rid)
        if recipe is None:
            raise ApiError(404, f"Recipe {rid} not found")
        recipes.append(recipe)

    if mode == "replace":
        store.clear_items(hh)
        new_items = aggregate(recipes)
    else:
        # Fold the new ingredients into what's still unticked; ticked items are left alone.
        unticked = [i for i in store.list_items(hh) if not i.get("checked")]
        new_items = combine(unticked + aggregate(recipes))
        for item in unticked:
            store.delete_item(hh, item["id"])

    for item in new_items:
        store.add_item(hh, item["name"], item["quantity"], item["unit"], item["recipes"])
    return store.list_items(hh)


def _require(found, what: str):
    if not found:
        raise ApiError(404, f"{what} not found")
    return found


def route(event: dict, store: Store) -> dict:
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt", {}).get("claims", {})
    sub = claims.get("sub")
    if not sub:
        raise ApiError(401, "Not signed in")

    route_key = event.get("routeKey", "")
    params = event.get("pathParameters") or {}

    if route_key == "GET /me":
        # New users have no household until they start one or join one (the app asks on first sign-in).
        return _resp(200, store.find_household(sub) or {"householdId": None, "inviteCode": None})
    if route_key == "POST /household":
        return _resp(200, store.create_household(sub))
    if route_key == "POST /household/join":
        # Count every attempt before looking anything up, so codes can't be brute-forced.
        if store.record_join_attempt(sub) > MAX_JOIN_ATTEMPTS_PER_HOUR:
            raise ApiError(429, "Too many attempts. Try again in an hour.")
        code = normalise_invite_code(_text(_body(event).get("code"), "Code", required=True, max_len=20))
        if len(code) != INVITE_LENGTH:
            raise ApiError(400, f"Invite codes are {INVITE_LENGTH} characters")
        return _resp(200, _require(store.join_household(sub, code), "Invite code"))

    hh = store.household_for(sub)
    if hh is None:
        raise ApiError(409, "No household yet. Start one or join one with a code.")

    if route_key == "POST /household/invite":
        return _resp(200, store.rotate_invite(hh))

    if route_key == "GET /recipes":
        return _resp(200, store.list_recipes(hh))
    if route_key == "POST /recipes":
        return _resp(201, store.put_recipe(hh, _validate_recipe(_body(event))))
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
        return _resp(201, store.add_item(hh, name, _quantity(data.get("quantity")), _text(data.get("unit"), "Unit")))
    if route_key == "PATCH /list/items/{id}":
        checked = _body(event).get("checked")
        if not isinstance(checked, bool):
            raise ApiError(400, "checked must be true or false")
        return _resp(200, _require(store.set_checked(hh, params["id"], checked), "Item"))
    if route_key == "DELETE /list/items/{id}":
        store.delete_item(hh, params["id"])
        return _resp(204)
    if route_key == "DELETE /list":
        only_checked = (event.get("queryStringParameters") or {}).get("checked") == "true"
        store.clear_items(hh, only_checked=only_checked)
        return _resp(204)

    raise ApiError(404, f"No route for {route_key}")


def handle(event: dict, store: Store) -> dict:
    try:
        return route(event, store)
    except ApiError as err:
        return _resp(err.status, {"error": err.message})


def lambda_handler(event, context):
    return handle(event, _get_store())
