"""Lambda entry point for the HTTP API (payload format 2.0)."""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation

from .aggregate import aggregate, normalise_name, normalise_unit
from .store import Store

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


def _body(event: dict) -> dict:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64

        raw = base64.b64decode(raw).decode()
    try:
        data = json.loads(raw, parse_float=Decimal)
    except json.JSONDecodeError as exc:
        raise ApiError(400, "Body must be JSON") from exc
    if not isinstance(data, dict):
        raise ApiError(400, "Body must be a JSON object")
    return data


def _quantity(value) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        q = Decimal(str(value))
    except InvalidOperation as exc:
        raise ApiError(400, f"Invalid quantity: {value!r}") from exc
    if q < 0:
        raise ApiError(400, "Quantity cannot be negative")
    return q


def _validate_recipe(data: dict) -> dict:
    title = (data.get("title") or "").strip()
    if not title:
        raise ApiError(400, "Recipe needs a title")
    ingredients = []
    for ing in data.get("ingredients") or []:
        name = (ing.get("name") or "").strip()
        if not name:
            continue
        ingredients.append({"name": name, "quantity": _quantity(ing.get("quantity")), "unit": (ing.get("unit") or "").strip()})
    servings = data.get("servings")
    return {
        "title": title,
        "servings": int(servings) if servings not in (None, "") else None,
        "notes": (data.get("notes") or "").strip(),
        "ingredients": ingredients,
    }


def _generate_list(store: Store, hh: str, data: dict) -> list[dict]:
    recipe_ids = data.get("recipeIds") or []
    if not recipe_ids:
        raise ApiError(400, "Pick at least one recipe")
    recipes = []
    for rid in recipe_ids:
        recipe = store.get_recipe(hh, rid)
        if recipe is None:
            raise ApiError(404, f"Recipe {rid} not found")
        recipes.append(recipe)

    if data.get("mode", "replace") == "replace":
        store.clear_items(hh)
        existing = []
    else:
        existing = [i for i in store.list_items(hh) if not i.get("checked")]

    for new in aggregate(recipes):
        match = None
        for old in existing:
            old_unit, old_qty = normalise_unit(old.get("unit"), old.get("quantity"))
            new_unit, new_qty = normalise_unit(new["unit"], new["quantity"])
            if normalise_name(old["name"]) == normalise_name(new["name"]) and old_unit == new_unit:
                match = (old, old_qty, new_qty)
                break
        if match:
            old, old_qty, new_qty = match
            store.delete_item(hh, old["id"])
            merged_recipes = list(dict.fromkeys((old.get("recipes") or []) + new["recipes"]))
            total = None if old_qty is None and new_qty is None else (old_qty or 0) + (new_qty or 0)
            base_unit = normalise_unit(new["unit"], None)[0]
            # Run the total back through aggregate so units are displayed consistently (e.g. 1500 g -> 1.5 kg).
            pretty = aggregate([{"ingredients": [{"name": new["name"], "quantity": total, "unit": base_unit}]}])[0]
            store.add_item(hh, pretty["name"], pretty["quantity"], pretty["unit"], merged_recipes)
        else:
            store.add_item(hh, new["name"], new["quantity"], new["unit"], new["recipes"])
    return store.list_items(hh)


def route(event: dict, store: Store) -> dict:
    claims = (event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}) or {}).get("claims", {})
    sub = claims.get("sub")
    if not sub:
        raise ApiError(401, "Not signed in")

    route_key = event.get("routeKey", "")
    params = event.get("pathParameters") or {}

    if route_key == "GET /me":
        return _resp(200, store.get_or_create_household(sub))
    if route_key == "POST /household/join":
        joined = store.join_household(sub, _body(event).get("code") or "")
        if not joined:
            raise ApiError(404, "That invite code doesn't exist")
        return _resp(200, joined)

    hh = store.household_for(sub)

    if route_key == "GET /recipes":
        return _resp(200, store.list_recipes(hh))
    if route_key == "POST /recipes":
        return _resp(201, store.put_recipe(hh, _validate_recipe(_body(event))))
    if route_key == "GET /recipes/{id}":
        recipe = store.get_recipe(hh, params["id"])
        if not recipe:
            raise ApiError(404, "Recipe not found")
        return _resp(200, recipe)
    if route_key == "PUT /recipes/{id}":
        if not store.get_recipe(hh, params["id"]):
            raise ApiError(404, "Recipe not found")
        return _resp(200, store.put_recipe(hh, _validate_recipe(_body(event)), params["id"]))
    if route_key == "DELETE /recipes/{id}":
        store.delete_recipe(hh, params["id"])
        return _resp(204)

    if route_key == "GET /list":
        return _resp(200, store.list_items(hh))
    if route_key == "POST /list/generate":
        return _resp(200, _generate_list(store, hh, _body(event)))
    if route_key == "POST /list/items":
        data = _body(event)
        name = (data.get("name") or "").strip()
        if not name:
            raise ApiError(400, "Item needs a name")
        return _resp(201, store.add_item(hh, name, _quantity(data.get("quantity")), (data.get("unit") or "").strip()))
    if route_key == "PATCH /list/items/{id}":
        item = store.set_checked(hh, params["id"], bool(_body(event).get("checked")))
        if not item:
            raise ApiError(404, "Item not found")
        return _resp(200, item)
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
