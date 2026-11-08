import base64
import json
from decimal import Decimal

import pytest

from grubgrab import handler
from grubgrab.handler import handle, lambda_handler
from grubgrab.store import Store


def event(route_key, sub="alice", body=None, path=None, query=None, raw_body=None, b64=False):
    if raw_body is None and body is not None:
        raw_body = json.dumps(body)
    if b64 and raw_body is not None:
        raw_body = base64.b64encode(raw_body.encode()).decode()
    return {
        "routeKey": route_key,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub}}}} if sub else {},
        "pathParameters": path,
        "queryStringParameters": query,
        "body": raw_body,
        "isBase64Encoded": b64,
    }


def call(store, *args, **kwargs):
    resp = handle(event(*args, **kwargs), store)
    assert resp["headers"]["content-type"] == "application/json"
    return resp["statusCode"], (json.loads(resp["body"]) if resp["body"] else None)


def error(store, *args, **kwargs):
    status, body = call(store, *args, **kwargs)
    return status, body["error"]


@pytest.fixture
def store(table):
    """Alice and Bob have each started a household, as the app asks on first sign-in. Anyone else hasn't."""
    s = Store(table)
    s.create_household("alice")
    s.create_household("bob")
    return s


PASTA = {
    "title": "Pasta",
    "servings": 2,
    "ingredients": [
        {"name": "Spaghetti", "quantity": 500, "unit": "g"},
        {"name": "Garlic", "quantity": 3, "unit": "cloves"},
        {"name": "Olive oil", "quantity": 4, "unit": "tbsp"},
        {"name": "Salt"},
    ],
}
CURRY = {
    "title": "Curry",
    "ingredients": [
        {"name": "garlic", "quantity": 4, "unit": "cloves"},
        {"name": "Rice", "quantity": "1", "unit": "kg"},
        {"name": "olive oil", "quantity": 2, "unit": "tbsp"},
    ],
}


def create(store, recipe, sub="alice"):
    status, body = call(store, "POST /recipes", sub=sub, body=recipe)
    assert status == 201
    return body


# ---- auth, routing, envelope ------------------------------------------------------


class TestEnvelope:
    @pytest.mark.parametrize(
        "evt",
        [
            {"routeKey": "GET /recipes"},
            {"routeKey": "GET /recipes", "requestContext": None},
            {"routeKey": "GET /recipes", "requestContext": {"authorizer": None}},
            {"routeKey": "GET /recipes", "requestContext": {"authorizer": {"jwt": {"claims": {}}}}},
        ],
    )
    def test_unauthenticated(self, store, evt):
        resp = handle(evt, store)
        assert resp["statusCode"] == 401
        assert json.loads(resp["body"]) == {"error": "Not signed in"}

    def test_unknown_route(self, store):
        assert error(store, "GET /nope") == (404, "No route for GET /nope")

    def test_missing_route_key(self, store):
        resp = handle({"requestContext": {"authorizer": {"jwt": {"claims": {"sub": "alice"}}}}}, store)
        assert resp["statusCode"] == 404

    def test_base64_body(self, store):
        status, body = call(store, "POST /recipes", body={"title": "B64"}, b64=True)
        assert status == 201 and body["title"] == "B64"

    @pytest.mark.parametrize(
        "raw, b64, msg",
        [
            ("{not json", False, "Body must be JSON"),
            ("not base64!!", True, "Body must be JSON"),
            (base64.b64encode(b"\xff\xfe").decode(), True, "Body must be JSON"),
            ("[1, 2]", False, "Body must be a JSON object"),
            ('"text"', False, "Body must be a JSON object"),
        ],
    )
    def test_bad_bodies(self, store, raw, b64, msg):
        evt = event("POST /recipes")
        evt["body"], evt["isBase64Encoded"] = raw, b64
        resp = handle(evt, store)
        assert resp["statusCode"] == 400 and json.loads(resp["body"])["error"] == msg

    def test_empty_body_treated_as_empty_object(self, store):
        assert error(store, "POST /recipes", raw_body="") == (400, "Title is required")

    def test_decimal_serialisation(self):
        assert json.loads(handler._resp(200, {"a": Decimal("1.5"), "b": Decimal("2")})["body"]) == {"a": 1.5, "b": 2}

    def test_unserialisable_value_is_a_bug_not_silently_dropped(self):
        with pytest.raises(TypeError, match="Not serialisable"):
            handler._resp(200, {"x": object()})

    def test_lambda_handler_uses_table_from_environment(self, table, monkeypatch):
        monkeypatch.setattr(handler, "_store", None)
        first = lambda_handler(event("GET /me"), None)
        assert first["statusCode"] == 200
        cached = handler._store
        lambda_handler(event("GET /recipes"), None)
        assert handler._store is cached  # store reused across warm invocations


# ---- households ----------------------------------------------------------------------


class TestHouseholds:
    def test_new_user_has_no_household(self, store):
        assert call(store, "GET /me", sub="carol") == (200, {"householdId": None, "inviteCode": None})

    @pytest.mark.parametrize(
        "route, kwargs",
        [
            ("GET /recipes", {}),
            ("POST /recipes", {"body": {"title": "Soup"}}),
            ("GET /list", {}),
            ("POST /list/items", {"body": {"name": "Milk"}}),
            ("POST /household/invite", {}),
        ],
    )
    def test_data_needs_a_household_first(self, store, route, kwargs):
        assert error(store, route, sub="carol", **kwargs) == (409, "No household yet. Start one or join one with a code.")
        assert call(store, "GET /me", sub="carol")[1]["householdId"] is None  # nothing was created on the way

    def test_start_a_household(self, store):
        status, started = call(store, "POST /household", sub="carol")
        assert status == 200 and len(started["inviteCode"]) == 10
        assert call(store, "GET /me", sub="carol")[1] == started
        assert call(store, "POST /household", sub="carol")[1] == started  # a second tap changes nothing
        assert call(store, "GET /recipes", sub="carol") == (200, [])

    def test_join_as_a_brand_new_user(self, store):
        _, alices = call(store, "GET /me", sub="alice")
        create(store, PASTA, sub="alice")
        status, joined = call(store, "POST /household/join", sub="carol", body={"code": alices["inviteCode"]})
        assert status == 200 and joined == alices
        assert [r["title"] for r in call(store, "GET /recipes", sub="carol")[1]] == ["Pasta"]
        metas = [i for i in store.table.scan()["Items"] if i["SK"] == "META"]
        assert len(metas) == 2  # alice's and bob's: carol never got an empty household of her own

    def test_me_is_stable(self, store):
        _, me = call(store, "GET /me")
        assert len(me["inviteCode"]) == 10
        assert call(store, "GET /me")[1] == me

    def test_join_shares_data_both_ways(self, store):
        _, me = call(store, "GET /me", sub="alice")
        create(store, PASTA, sub="alice")
        assert call(store, "GET /recipes", sub="bob")[1] == []

        status, joined = call(store, "POST /household/join", sub="bob", body={"code": me["inviteCode"].lower()})
        assert status == 200 and joined == me
        assert [r["title"] for r in call(store, "GET /recipes", sub="bob")[1]] == ["Pasta"]
        create(store, CURRY, sub="bob")
        assert len(call(store, "GET /recipes", sub="alice")[1]) == 2

    @pytest.mark.parametrize(
        "body, expected",
        [
            ({"code": "NOPENOPE22"}, (404, "Invite code not found")),
            ({"code": "NOPE00"}, (400, "Invite codes are 10 characters")),
            ({"code": "abcde-fghjk-x"}, (400, "Invite codes are 10 characters")),
            ({}, (400, "Code is required")),
            ({"code": "   "}, (400, "Code is required")),
            ({"code": 123456}, (400, "Code must be text")),
            ({"code": "A" * 21}, (400, "Code is too long (max 20)")),
        ],
    )
    def test_join_errors(self, store, body, expected):
        assert error(store, "POST /household/join", body=body) == expected

    def test_join_accepts_formatted_code(self, store):
        _, me = call(store, "GET /me", sub="alice")
        code = me["inviteCode"]
        status, joined = call(store, "POST /household/join", sub="bob", body={"code": f" {code[:5].lower()}-{code[5:]} "})
        assert status == 200 and joined == me

    def test_join_is_rate_limited_per_user(self, table):
        now = [1_000_000.0]
        s = Store(table, clock=lambda: now[0])
        _, me = call(s, "POST /household", sub="alice")
        for _ in range(5):
            assert call(s, "POST /household/join", sub="mallory", body={"code": "WRONGWRONG"})[0] == 404
        # Even the right code is refused once the limit is hit, and invalid input still counts.
        assert error(s, "POST /household/join", sub="mallory", body={"code": me["inviteCode"]}) == (
            429,
            "Too many attempts. Try again in an hour.",
        )
        assert error(s, "POST /household/join", sub="mallory", body={})[0] == 429
        # Other users are unaffected.
        assert call(s, "POST /household/join", sub="bob", body={"code": me["inviteCode"]})[0] == 200
        # The limit resets the next hour.
        now[0] += 3600
        assert call(s, "POST /household/join", sub="mallory", body={"code": me["inviteCode"]})[0] == 200

    def test_rotate_invite(self, store):
        _, me = call(store, "GET /me", sub="alice")
        status, rotated = call(store, "POST /household/invite", sub="alice")
        assert status == 200
        assert rotated["householdId"] == me["householdId"]
        assert rotated["inviteCode"] != me["inviteCode"] and len(rotated["inviteCode"]) == 10
        assert error(store, "POST /household/join", sub="bob", body={"code": me["inviteCode"]})[0] == 404
        assert call(store, "POST /household/join", sub="bob", body={"code": rotated["inviteCode"]})[0] == 200
        assert call(store, "GET /me", sub="bob")[1] == rotated


# ---- recipes ---------------------------------------------------------------------------


class TestRecipes:
    def test_crud(self, store):
        created = create(store, PASTA)
        assert created["servings"] == 2
        assert created["ingredients"][3] == {"name": "Salt", "quantity": None, "unit": ""}

        status, got = call(store, "GET /recipes/{id}", path={"id": created["id"]})
        assert status == 200 and got == created | {"updatedAt": got["updatedAt"]}

        status, updated = call(store, "PUT /recipes/{id}", path={"id": created["id"]}, body={**PASTA, "title": "Aglio"})
        assert status == 200 and updated["id"] == created["id"] and updated["title"] == "Aglio"

        assert call(store, "DELETE /recipes/{id}", path={"id": created["id"]}) == (204, None)
        assert call(store, "GET /recipes")[1] == []

    def test_cleans_input(self, store):
        r = create(
            store,
            {
                "title": "  Toast  ",
                "notes": "  crispy  ",
                "servings": "",
                "ingredients": [
                    {"name": " Bread ", "quantity": " 2 ", "unit": " slices "},
                    {"name": "", "quantity": 5},
                    {"name": "   "},
                    {"name": "Butter", "quantity": ""},
                    {"name": "Jam", "quantity": 1.5},
                ],
            },
        )
        assert r["title"] == "Toast" and r["notes"] == "crispy" and r["servings"] is None
        assert r["ingredients"] == [
            {"name": "Bread", "quantity": 2, "unit": "slices"},
            {"name": "Butter", "quantity": None, "unit": ""},
            {"name": "Jam", "quantity": 1.5, "unit": ""},
        ]

    def test_ingredients_null_is_empty(self, store):
        assert create(store, {"title": "Air", "ingredients": None})["ingredients"] == []

    @pytest.mark.parametrize(
        "patch, msg",
        [
            ({"title": ""}, "Title is required"),
            ({"title": None}, "Title is required"),
            ({"title": 5}, "Title must be text"),
            ({"title": "x" * 201}, "Title is too long (max 200)"),
            ({"notes": "x" * 10_001}, "Notes is too long (max 10000)"),
            ({"servings": 0}, "Servings must be a whole number from 1 to 1000"),
            ({"servings": 1001}, "Servings must be a whole number from 1 to 1000"),
            ({"servings": 2.5}, "Servings must be a whole number from 1 to 1000"),
            ({"servings": "4"}, "Servings must be a whole number from 1 to 1000"),
            ({"servings": True}, "Servings must be a whole number from 1 to 1000"),
            ({"ingredients": "eggs"}, "Ingredients must be a list"),
            ({"ingredients": ["eggs"]}, "Each ingredient must be an object"),
            ({"ingredients": [{"name": 3}]}, "Ingredient name must be text"),
            ({"ingredients": [{"name": "Egg", "unit": 1}]}, "Unit must be text"),
            ({"ingredients": [{"name": "x"}] * 201}, "Too many ingredients (max 200)"),
            ({"ingredients": [{"name": "Egg", "quantity": -1}]}, "Invalid quantity: -1"),
            ({"ingredients": [{"name": "Egg", "quantity": "two"}]}, "Invalid quantity: 'two'"),
            ({"ingredients": [{"name": "Egg", "quantity": "NaN"}]}, "Invalid quantity: 'NaN'"),
            ({"ingredients": [{"name": "Egg", "quantity": "Infinity"}]}, "Invalid quantity: 'Infinity'"),
            ({"ingredients": [{"name": "Egg", "quantity": 1_000_001}]}, "Invalid quantity: 1000001"),
            ({"ingredients": [{"name": "Egg", "quantity": True}]}, "Invalid quantity: True"),
            ({"ingredients": [{"name": "Egg", "quantity": [1]}]}, "Invalid quantity: [1]"),
        ],
    )
    def test_validation(self, store, patch, msg):
        assert error(store, "POST /recipes", body={**PASTA, **patch}) == (400, msg)

    def test_boundary_values_accepted(self, store):
        r = create(
            store,
            {"title": "x" * 200, "servings": 1000, "ingredients": [{"name": "Egg", "quantity": 0}, {"name": "Rice", "quantity": 1_000_000}]},
        )
        assert [i["quantity"] for i in r["ingredients"]] == [0, 1_000_000]

    def test_missing_recipe(self, store):
        assert error(store, "GET /recipes/{id}", path={"id": "nope"}) == (404, "Recipe not found")
        assert error(store, "PUT /recipes/{id}", path={"id": "nope"}, body=PASTA) == (404, "Recipe not found")
        assert call(store, "DELETE /recipes/{id}", path={"id": "nope"}) == (204, None)  # idempotent

    def test_invalid_update_is_rejected_before_lookup(self, store):
        assert error(store, "PUT /recipes/{id}", path={"id": "nope"}, body={"title": ""}) == (400, "Title is required")

    def test_cannot_touch_another_households_recipe(self, store):
        r = create(store, PASTA, sub="alice")
        assert error(store, "GET /recipes/{id}", sub="eve", path={"id": r["id"]})[0] == 409  # no household at all
        call(store, "POST /household", sub="eve")
        assert error(store, "GET /recipes/{id}", sub="eve", path={"id": r["id"]})[0] == 404
        assert error(store, "PUT /recipes/{id}", sub="eve", path={"id": r["id"]}, body=CURRY)[0] == 404
        call(store, "DELETE /recipes/{id}", sub="eve", path={"id": r["id"]})
        assert call(store, "GET /recipes/{id}", sub="alice", path={"id": r["id"]})[0] == 200


# ---- shopping list -------------------------------------------------------------------------


def names(items):
    return {i["name"].lower(): i for i in items}


class TestGenerate:
    def test_replace_combines_recipes(self, store):
        p, c = create(store, PASTA), create(store, CURRY)
        status, items = call(store, "POST /list/generate", body={"recipeIds": [p["id"], c["id"]]})
        assert status == 200
        got = names(items)
        assert (got["garlic"]["quantity"], got["garlic"]["unit"]) == (7, "cloves")
        assert got["garlic"]["recipes"] == ["Pasta", "Curry"]
        assert (got["olive oil"]["quantity"], got["olive oil"]["unit"]) == (6, "tbsp")
        assert (got["rice"]["quantity"], got["rice"]["unit"]) == (1, "kg")
        assert got["salt"]["quantity"] is None
        assert all(i["checked"] is False for i in items)

    def test_replace_discards_previous_list_including_ticked(self, store):
        p, c = create(store, PASTA), create(store, CURRY)
        _, items = call(store, "POST /list/generate", body={"recipeIds": [p["id"]]})
        call(store, "PATCH /list/items/{id}", path={"id": items[0]["id"]}, body={"checked": True})
        _, items = call(store, "POST /list/generate", body={"recipeIds": [c["id"]], "mode": "replace"})
        assert set(names(items)) == {"garlic", "rice", "olive oil"}

    def test_append_merges_into_unticked_and_leaves_ticked_alone(self, store):
        p, c = create(store, PASTA), create(store, CURRY)
        _, items = call(store, "POST /list/generate", body={"recipeIds": [p["id"]]})
        spaghetti = names(items)["spaghetti"]
        call(store, "PATCH /list/items/{id}", path={"id": spaghetti["id"]}, body={"checked": True})
        call(store, "POST /list/items", body={"name": "Lemons", "quantity": 2})

        _, items = call(store, "POST /list/generate", body={"recipeIds": [c["id"], p["id"]], "mode": "append"})
        unticked = names([i for i in items if not i["checked"]])
        ticked = names([i for i in items if i["checked"]])
        assert (ticked["spaghetti"]["quantity"], ticked["spaghetti"]["unit"]) == (500, "g")
        assert (unticked["spaghetti"]["quantity"], unticked["spaghetti"]["unit"]) == (500, "g")
        assert unticked["garlic"]["quantity"] == 3 + 4 + 3
        assert unticked["garlic"]["recipes"] == ["Pasta", "Curry"]
        assert unticked["lemons"]["quantity"] == 2  # manual item survives
        assert len(items) == len(unticked) + len(ticked)

    def test_append_to_empty_list(self, store):
        p = create(store, PASTA)
        _, items = call(store, "POST /list/generate", body={"recipeIds": [p["id"]], "mode": "append"})
        assert len(items) == 4

    def test_duplicate_ids_counted_once(self, store):
        p = create(store, PASTA)
        _, items = call(store, "POST /list/generate", body={"recipeIds": [p["id"], p["id"]]})
        assert names(items)["garlic"]["quantity"] == 3

    @pytest.mark.parametrize(
        "body, expected",
        [
            ({}, (400, "Pick at least one recipe")),
            ({"recipeIds": []}, (400, "Pick at least one recipe")),
            ({"recipeIds": "abc"}, (400, "Pick at least one recipe")),
            ({"recipeIds": [1]}, (400, "Recipe ids must be text")),
            ({"recipeIds": [""]}, (400, "Recipe ids must be text")),
            ({"recipeIds": ["a"] * 51}, (400, "Too many recipes (max 50)")),
            ({"recipeIds": ["missing"]}, (404, "Recipe missing not found")),
            ({"recipeIds": ["x"], "mode": "merge"}, (400, "Mode must be 'replace' or 'append'")),
        ],
    )
    def test_errors(self, store, body, expected):
        assert error(store, "POST /list/generate", body=body) == expected

    def test_missing_recipe_leaves_list_untouched(self, store):
        p = create(store, PASTA)
        call(store, "POST /list/generate", body={"recipeIds": [p["id"]]})
        error(store, "POST /list/generate", body={"recipeIds": [p["id"], "missing"]})
        assert len(call(store, "GET /list")[1]) == 4


class TestItems:
    def test_add_parses_and_cleans(self, store):
        status, item = call(store, "POST /list/items", body={"name": "  Milk ", "quantity": "1.5", "unit": " l "})
        assert status == 201
        assert item == {"id": item["id"], "name": "Milk", "quantity": 1.5, "unit": "l", "checked": False, "recipes": []}

    @pytest.mark.parametrize(
        "body, msg",
        [
            ({}, "Name is required"),
            ({"name": " "}, "Name is required"),
            ({"name": ["Milk"]}, "Name must be text"),
            ({"name": "Milk", "quantity": -2}, "Invalid quantity: -2"),
            ({"name": "Milk", "unit": 3}, "Unit must be text"),
        ],
    )
    def test_add_validation(self, store, body, msg):
        assert error(store, "POST /list/items", body=body) == (400, msg)

    def test_tick_and_untick(self, store):
        _, item = call(store, "POST /list/items", body={"name": "Milk"})
        path = {"id": item["id"]}
        assert call(store, "PATCH /list/items/{id}", path=path, body={"checked": True})[1]["checked"] is True
        assert call(store, "PATCH /list/items/{id}", path=path, body={"checked": False})[1]["checked"] is False

    @pytest.mark.parametrize("value", ["false", "true", 1, 0, None])
    def test_tick_requires_real_boolean(self, store, value):
        _, item = call(store, "POST /list/items", body={"name": "Milk"})
        assert error(store, "PATCH /list/items/{id}", path={"id": item["id"]}, body={"checked": value}) == (
            400,
            "checked must be true or false",
        )
        assert call(store, "GET /list")[1][0]["checked"] is False

    def test_tick_missing_item(self, store):
        assert error(store, "PATCH /list/items/{id}", path={"id": "nope"}, body={"checked": True}) == (404, "Item not found")

    def test_delete_item(self, store):
        _, item = call(store, "POST /list/items", body={"name": "Milk"})
        assert call(store, "DELETE /list/items/{id}", path={"id": item["id"]}) == (204, None)
        assert call(store, "GET /list")[1] == []

    @pytest.mark.parametrize(
        "query, remaining",
        [(None, []), ({}, []), ({"checked": "false"}, []), ({"checked": "true"}, ["Keep"])],
    )
    def test_clear(self, store, query, remaining):
        call(store, "POST /list/items", body={"name": "Keep"})
        _, done = call(store, "POST /list/items", body={"name": "Done"})
        call(store, "PATCH /list/items/{id}", path={"id": done["id"]}, body={"checked": True})
        assert call(store, "DELETE /list", query=query) == (204, None)
        assert [i["name"] for i in call(store, "GET /list")[1]] == remaining
