import base64
import json
from decimal import Decimal

import boto3
import pytest

from grubgrab import ai, handler
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
        assert json.loads(resp["body"]) == {"error": "Not signed in", "code": "not_signed_in", "params": {}}

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


class TestLanguages:
    def test_each_person_keeps_their_own_app_language_on_their_account(self, store):
        assert "language" not in call(store, "GET /me", sub="alice")[1]
        assert call(store, "PATCH /me", sub="alice", body={"language": "lt"}) == (204, None)
        call(store, "PATCH /me", sub="bob", body={"language": "pl"})
        assert call(store, "GET /me", sub="alice")[1]["language"] == "lt"
        assert call(store, "GET /me", sub="bob")[1]["language"] == "pl"
        call(store, "PATCH /me", sub="alice", body={"language": "en"})
        assert call(store, "GET /me", sub="alice")[1]["language"] == "en"

    def test_works_before_joining_a_household(self, store):
        assert call(store, "PATCH /me", sub="carol", body={"language": "pl"})[0] == 204
        assert call(store, "GET /me", sub="carol")[1] == {"householdId": None, "inviteCode": None, "language": "pl"}

    def test_a_new_household_takes_its_creators_language_and_anyone_in_it_can_change_it(self, store):
        status, started = call(store, "POST /household", sub="carol", body={"language": "lt"})
        assert status == 200 and started["recipeLanguage"] == "lt"
        call(store, "POST /household/join", sub="dan", body={"code": started["inviteCode"]})
        status, changed = call(store, "PUT /household/recipe-language", sub="dan", body={"language": "pl"})
        assert status == 200 and changed["recipeLanguage"] == "pl"
        assert call(store, "GET /me", sub="carol")[1]["recipeLanguage"] == "pl"  # shared by the household
        assert call(store, "POST /household", sub="erin")[1]["recipeLanguage"] == "en"  # no language sent

    def test_anyone_in_the_household_can_move_an_item_to_another_aisle(self, store):
        started = call(store, "POST /household", sub="carol")[1]
        call(store, "POST /household/join", sub="dan", body={"code": started["inviteCode"]})
        status, changed = call(store, "PUT /household/aisles", sub="dan", body={"name": "  Tahini   Paste ", "aisle": "pantry"})
        assert status == 200 and changed["aisles"] == {"tahini paste": "pantry"}  # by name, however it was typed
        assert call(store, "GET /me", sub="carol")[1]["aisles"] == {"tahini paste": "pantry"}

    @pytest.mark.parametrize(
        "body, expected",
        [
            ({"name": "kefir", "aisle": "garden"}, (400, "Unknown aisle 'garden'")),
            ({"name": "kefir"}, (400, "Unknown aisle 'None'")),
            ({"aisle": "dairy"}, (400, "Name is required")),
            ({"name": "x" * 201, "aisle": "dairy"}, (400, "Name is too long (max 200)")),
        ],
    )
    def test_aisle_moves_are_checked(self, store, body, expected):
        assert error(store, "PUT /household/aisles", body=body) == expected

    def test_aisle_moves_are_capped(self, store, monkeypatch):
        monkeypatch.setattr(store, "set_aisle", lambda hh, name, aisle: False)
        assert error(store, "PUT /household/aisles", body={"name": "kefir", "aisle": "dairy"}) == (
            409,
            "Your household already has 500 items moved to other aisles",
        )

    @pytest.mark.parametrize("body", [{}, {"language": "de"}, {"language": 5}])
    def test_only_languages_the_app_speaks(self, store, body):
        assert error(store, "PATCH /me", body=body)[0] == 400
        assert error(store, "PUT /household/recipe-language", body=body) == (400, f"Unknown language {str(body.get('language'))[:10]!r}")
        assert call(store, "POST /household", sub="frank", body={**body, "language": body.get("language", "xx")})[0] == 400

    def test_settings_go_when_the_account_does(self, store):
        call(store, "PATCH /me", sub="alice", body={"language": "lt"})
        store.delete_user_data("alice", "Google_alice")
        assert store.get_user_language("alice") is None


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

    def test_ingredients_keep_a_known_aisle_and_drop_anything_else(self, store):
        r = create(
            store,
            {
                "title": "Soup",
                "ingredients": [
                    {"name": "Leek", "aisle": "produce"},
                    {"name": "Salt", "aisle": "garden centre"},
                    {"name": "Stock", "aisle": 5},
                ],
            },
        )
        assert [i.get("aisle") for i in r["ingredients"]] == ["produce", None, None]

    def test_aisles_follow_ingredients_onto_the_list(self, store):
        soup = create(store, {"title": "Soup", "ingredients": [{"name": "Leek", "aisle": "produce"}, {"name": "Salt"}]})
        _, items = call(store, "POST /list/generate", body={"recipeIds": [soup["id"]]})
        assert [(i["name"], i.get("aisle")) for i in items] == [("Leek", "produce"), ("Salt", None)]

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
            ({"link": 5}, "Link must be text"),
            ({"link": "x" * 2001}, "Link is too long (max 2000)"),
            ({"link": "javascript:alert(1)"}, "Link must be a web address starting with http:// or https://"),
            ({"link": "kwestiasmaku.com/przepis"}, "Link must be a web address starting with http:// or https://"),
            ({"link": "https://"}, "Link must be a web address starting with http:// or https://"),
            ({"link": "ftp://example.com/x"}, "Link must be a web address starting with http:// or https://"),
            ({"tags": "soup"}, "Tags must be a list"),
            ({"tags": [5]}, "Tag must be text"),
            ({"tags": ["x" * 31]}, "Tag is too long (max 30)"),
            ({"tags": [f"t{n}" for n in range(21)]}, "Too many tags (max 20)"),
        ],
    )
    def test_validation(self, store, patch, msg):
        assert error(store, "POST /recipes", body={**PASTA, **patch}) == (400, msg)

    def test_tags_are_cleaned_and_saved(self, store):
        r = create(store, {"title": "Zurek", "tags": [" Soup ", "soup", "MEAT", "", "  ", "meat"]})
        assert r["tags"] == ["soup", "meat"]  # trimmed, lower-cased, blanks and duplicates dropped, order kept
        assert call(store, "GET /recipes/{id}", path={"id": r["id"]})[1]["tags"] == ["soup", "meat"]
        status, updated = call(store, "PUT /recipes/{id}", path={"id": r["id"]}, body={"title": "Zurek", "tags": None})
        assert status == 200 and updated["tags"] == []
        assert create(store, {"title": "x", "tags": [f"t{n}" for n in range(20)]})["tags"][-1] == "t19"  # 20 is fine

    def test_recipes_saved_before_tags_and_links_existed(self, store):
        hh = store.household_for("alice")
        store.table.put_item(Item={"PK": f"HH#{hh}", "SK": "RECIPE#old", "id": "old", "title": "Old", "ingredients": []})
        for got in (call(store, "GET /recipes/{id}", path={"id": "old"})[1], call(store, "GET /recipes")[1][0]):
            assert got["tags"] == [] and got["link"] == ""

    def test_link_is_saved_and_can_be_cleared(self, store):
        r = create(store, {"title": "Zurek", "link": "  HTTPS://www.kwestiasmaku.com/przepis/zurek?x=1  "})
        assert r["link"] == "HTTPS://www.kwestiasmaku.com/przepis/zurek?x=1"
        assert call(store, "GET /recipes/{id}", path={"id": r["id"]})[1]["link"] == r["link"]
        assert create(store, {"title": "Old site", "link": "http://example.com"})["link"] == "http://example.com"
        _, cleared = call(store, "PUT /recipes/{id}", path={"id": r["id"]}, body={"title": "Zurek", "link": None})
        assert cleared["link"] == ""

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

    def test_picked_recipes_wait_under_to_cook_until_unticked(self, store):
        p, c, s = create(store, PASTA), create(store, CURRY), create(store, {"title": "Soup", "ingredients": []})
        call(store, "POST /list/generate", body={"recipeIds": [p["id"]]})
        call(store, "POST /list/generate", body={"recipeIds": [c["id"]], "mode": "replace"})  # a new list keeps them
        call(store, "POST /list/generate", body={"recipeIds": [s["id"], p["id"]], "mode": "append"})
        assert call(store, "GET /me")[1]["toCook"] == sorted([p["id"], c["id"], s["id"]])
        status, household = call(store, "DELETE /household/to-cook/{id}", path={"id": c["id"]})  # cooked it
        assert status == 200 and household["toCook"] == sorted([p["id"], s["id"]])
        call(store, "DELETE /household/to-cook/{id}", path={"id": "never-picked"})  # nothing to do, no error
        call(store, "DELETE /recipes/{id}", path={"id": s["id"]})  # a deleted recipe goes from the list too
        assert call(store, "GET /me")[1]["toCook"] == [p["id"]]

    def test_to_cook_is_shared_by_the_household_and_no_one_else(self, store):
        p = create(store, PASTA)
        call(store, "POST /list/generate", body={"recipeIds": [p["id"]]})
        assert call(store, "GET /me", sub="bob")[1]["toCook"] == []  # another household
        call(store, "DELETE /household/to-cook/{id}", sub="bob", path={"id": p["id"]})  # can't touch it
        assert call(store, "GET /me")[1]["toCook"] == [p["id"]]

    def test_a_failed_list_marks_nothing(self, store):
        p = create(store, PASTA)
        assert call(store, "POST /list/generate", body={"recipeIds": [p["id"], "missing"]})[0] == 404
        assert call(store, "GET /me")[1]["toCook"] == []

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


# ---- per-household limits ------------------------------------------------------------------


class TestLimits:
    def test_recipe_limit(self, store, monkeypatch):
        monkeypatch.setattr(handler, "MAX_RECIPES", 2)
        create(store, PASTA)
        create(store, CURRY)
        assert error(store, "POST /recipes", body=PASTA) == (
            409,
            "You've reached the limit of 2 recipes. Delete some to add more.",
        )
        assert call(store, "POST /recipes", sub="bob", body=PASTA)[0] == 201  # per household, not global

    def test_list_item_limit(self, store, monkeypatch):
        monkeypatch.setattr(handler, "MAX_LIST_ITEMS", 1)
        assert call(store, "POST /list/items", body={"name": "Milk"})[0] == 201
        assert error(store, "POST /list/items", body={"name": "Eggs"}) == (409, "The list is full (1 items). Clear some to add more.")

    @pytest.mark.parametrize(
        "mode, extra_ingredients",
        [("replace", 6), ("append", 1)],  # replace: 6 alone is too many; append: 5 already there + 1 more
    )
    def test_an_oversized_list_is_refused_before_anything_is_written(self, store, monkeypatch, mode, extra_ingredients):
        monkeypatch.setattr(handler, "MAX_LIST_ITEMS", 5)
        ids = [create(store, PASTA)["id"], create(store, CURRY)["id"]]  # 5 distinct ingredients together
        assert len(call(store, "POST /list/generate", body={"recipeIds": ids})[1]) == 5
        first = call(store, "GET /list")[1][0]["id"]
        call(store, "PATCH /list/items/{id}", path={"id": first}, body={"checked": True})  # ticked items count too
        before = call(store, "GET /list")[1]
        big = create(store, {"title": "Big", "ingredients": [{"name": f"thing {n}"} for n in range(extra_ingredients)]})
        assert error(store, "POST /list/generate", body={"recipeIds": [big["id"]], "mode": mode}) == (
            409,
            "That would make the list longer than 5 items",
        )
        assert call(store, "GET /list")[1] == before  # nothing was written


# ---- sign-up approval (admins) ---------------------------------------------------------------


def admin_call(store, route_key, groups="[admins]", **kwargs):
    evt = event(route_key, **kwargs)
    evt["requestContext"]["authorizer"]["jwt"]["claims"]["cognito:groups"] = groups
    resp = handle(evt, store)
    return resp["statusCode"], (json.loads(resp["body"]) if resp["body"] else None)


class TestAdmin:
    @pytest.fixture
    def requests(self, store):
        store.request_access("Google_1", "first@x.com", "First")
        store.request_access("Google_2", "second@x.com", "Second")
        return store

    @pytest.mark.parametrize("groups", ["[admins]", "[family admins]", "admins", ["admins"], "[family,admins]"])
    def test_admins_see_pending_requests_and_a_count(self, requests, groups):
        status, listed = admin_call(requests, "GET /admin/requests", groups=groups)
        assert status == 200 and {r["username"] for r in listed} == {"Google_1", "Google_2"}
        _, me = admin_call(requests, "GET /me", groups=groups)
        assert me["admin"] is True and me["pendingRequests"] == 2

    @pytest.mark.parametrize("groups", [None, "", "[]", "[family]", "[administrators]", ["family"]])
    def test_everyone_else_is_refused(self, requests, groups):
        for route, path in [
            ("GET /admin/requests", None),
            ("POST /admin/requests/{username}/approve", {"username": "Google_1"}),
            ("POST /admin/requests/{username}/decline", {"username": "Google_1"}),
            ("POST /admin/requests/decline-pending", None),
        ]:
            status, body = admin_call(requests, route, groups=groups, path=path)
            assert (status, body) == (403, {"error": "Only admins can do that", "code": "admins_only", "params": {}})
        _, me = admin_call(requests, "GET /me", groups=groups)
        assert "admin" not in me and "pendingRequests" not in me
        assert len(requests.access_requests()) == 2  # nothing changed

    def test_approve_decline_and_decline_all(self, requests):
        status, approved = admin_call(requests, "POST /admin/requests/{username}/approve", path={"username": "Google_1"})
        assert status == 200 and approved["status"] == "approved"
        _, declined = admin_call(requests, "POST /admin/requests/{username}/decline", path={"username": "Google_2"})
        assert declined["status"] == "declined"
        assert admin_call(requests, "GET /admin/requests")[1] == []

        requests.request_access("Google_3", "bot@x.com", "")
        requests.request_access("Google_4", "bot2@x.com", "")
        assert admin_call(requests, "POST /admin/requests/decline-pending") == (200, {"declined": 2})

    def test_unknown_request_and_route(self, requests):
        assert admin_call(requests, "POST /admin/requests/{username}/approve", path={"username": "Google_x"}) == (
            404,
            {"error": "Request not found", "code": "request_not_found", "params": {}},
        )
        assert admin_call(requests, "GET /admin/nope") == (404, {"error": "No route for GET /admin/nope", "code": "bad_request", "params": {}})

    def test_admin_without_a_household_can_still_review(self, requests):
        status, me = admin_call(requests, "GET /me", sub="newadmin")
        assert status == 200 and me["householdId"] is None and me["pendingRequests"] == 2


# ---- deleting your account ---------------------------------------------------------------


class TestDeleteAccount:
    @pytest.fixture
    def pool(self, monkeypatch):
        """A real Cognito user pool API, served in-process by moto (already active via the table fixture)."""
        cognito = boto3.client("cognito-idp")
        pool_id = cognito.create_user_pool(PoolName="test")["UserPool"]["Id"]
        for username in ("Google_alice", "Google_carol"):
            cognito.admin_create_user(UserPoolId=pool_id, Username=username)
        monkeypatch.setenv("USER_POOL_ID", pool_id)
        return cognito, pool_id

    @staticmethod
    def delete_me(store, sub, username):
        evt = event("DELETE /me", sub=sub)
        if username:
            evt["requestContext"]["authorizer"]["jwt"]["claims"]["username"] = username
        resp = handle(evt, store)
        return resp["statusCode"], json.loads(resp["body"])

    @staticmethod
    def users(pool):
        cognito, pool_id = pool
        return sorted(u["Username"] for u in cognito.list_users(UserPoolId=pool_id)["Users"])

    def test_last_person_out_takes_the_household_with_them(self, store, pool):
        _, alices = call(store, "GET /me", sub="alice")
        create(store, PASTA, sub="alice")
        call(store, "POST /list/items", sub="alice", body={"name": "Milk"})
        call(store, "POST /household/join", sub="alice", body={"code": "WRONGWRONG"})  # leaves a counter behind
        store.request_access("Google_alice", "alice@x.com", "Alice")
        create(store, CURRY, sub="bob")

        assert self.delete_me(store, "alice", "Google_alice") == (200, {"deleted": True, "householdDeleted": True})

        left = store.table.scan()["Items"]
        assert not [i for i in left if alices["householdId"] in json.dumps(i, default=str)]  # recipes, list, META, invite
        assert not [i for i in left if i["PK"] == "USER#alice"]  # profile and join counters
        assert store.access_requests() == [] and not [i for i in left if i["SK"] == "REQ#Google_alice"]
        assert self.users(pool) == ["Google_carol"]  # the sign-in itself is gone
        assert call(store, "GET /me", sub="alice")[1] == {"householdId": None, "inviteCode": None}
        assert error(store, "POST /household/join", sub="bob", body={"code": alices["inviteCode"]})[0] == 404
        assert [r["title"] for r in call(store, "GET /recipes", sub="bob")[1]] == ["Curry"]  # others untouched

    def test_shared_recipes_stay_with_the_rest_of_the_household(self, store, pool):
        _, alices = call(store, "GET /me", sub="alice")
        create(store, PASTA, sub="alice")
        call(store, "POST /household/join", sub="carol", body={"code": alices["inviteCode"]})
        assert self.delete_me(store, "carol", "Google_carol") == (200, {"deleted": True, "householdDeleted": False})
        assert [r["title"] for r in call(store, "GET /recipes", sub="alice")[1]] == ["Pasta"]
        assert call(store, "GET /me", sub="alice")[1] == alices  # invite code still works for them
        assert self.users(pool) == ["Google_alice"]

    def test_someone_without_a_household_or_a_sign_in_left(self, store, pool):
        assert self.delete_me(store, "nobody", "Google_nobody") == (200, {"deleted": True, "householdDeleted": False})

    def test_needs_the_username_from_the_token(self, store, pool):
        assert self.delete_me(store, "alice", None) == (
            400,
            {"error": "Can't tell which account to delete", "code": "account_unknown", "params": {}},
        )
        assert call(store, "GET /me", sub="alice")[1]["householdId"]  # nothing deleted


# ---- AI recipe import ---------------------------------------------------------------------


class TestRecipeImport:
    """The API side: start a background job, then report it. The worker itself is in test_import_worker.py."""

    @pytest.fixture
    def started(self, monkeypatch):
        jobs = []
        monkeypatch.setenv("AI_PROVIDER", "anthropic")
        monkeypatch.setenv("AI_MONTHLY_LIMIT", "2")
        monkeypatch.setattr(handler, "_start_import_worker", lambda hh, job, link, lang: jobs.append((hh, job, link, lang)))
        return jobs

    def test_starts_a_job_and_reports_it_as_pending(self, store, started):
        status, body = call(store, "POST /recipes/import", body={"link": " https://example.com/soup "})
        assert status == 202 and body["remaining"] == 1
        hh = store.household_for("alice")
        assert started == [(hh, body["jobId"], "https://example.com/soup", "en")]
        assert call(store, "GET /recipes/import/{id}", path={"id": body["jobId"]}) == (200, {"status": "pending"})
        assert call(store, "GET /recipes")[1] == []  # nothing saved: the app shows the result for review

    def test_reports_the_finished_draft_or_the_problem(self, store, started):
        _, ok = call(store, "POST /recipes/import", body={"link": "https://e.com/a"})
        _, bad = call(store, "POST /recipes/import", body={"link": "https://e.com/b"})
        hh = store.household_for("alice")
        draft = {"title": "Soup", "servings": None, "link": "https://e.com/a", "ingredients": [{"name": "leek", "quantity": 1.5, "unit": ""}]}
        store.finish_import_job(hh, ok["jobId"], recipe=draft)
        store.finish_import_job(hh, bad["jobId"], error="Couldn't find a recipe on that page.", error_code="no_recipe")
        assert call(store, "GET /recipes/import/{id}", path={"id": ok["jobId"]}) == (200, {"status": "done", "recipe": draft})
        assert call(store, "GET /recipes/import/{id}", path={"id": bad["jobId"]}) == (
            200,
            {"status": "failed", "error": "Couldn't find a recipe on that page.", "errorCode": "no_recipe"},
        )

    def test_the_recipe_is_written_in_the_households_recipe_language(self, store, started):
        call(store, "POST /recipes/import", body={"link": "https://e.com", "language": "lt"})  # what the app sends is ignored
        assert started[-1][3] == "en"  # households from before recipe languages: English
        call(store, "PUT /household/recipe-language", body={"language": "pl"})
        call(store, "POST /recipes/import", sub="alice", body={"link": "https://e.com"})
        assert started[-1][3] == "pl"

    def test_every_error_carries_a_code_and_values_for_translation(self, store, started):
        resp = handle(event("POST /household/join", body={"code": "abc"}), store)
        assert json.loads(resp["body"]) == {
            "error": "Invite codes are 10 characters",
            "code": "invite_code_length",
            "params": {"length": 10},
        }
        resp = handle(event("POST /recipes", body={"title": "x" * 201}), store)
        assert json.loads(resp["body"])["params"] == {"field": "title", "max": 200}
        resp = handle(event("POST /recipes", body={"title": "Soup", "ingredients": [{"name": 5}]}), store)
        assert json.loads(resp["body"])["params"] == {"field": "ingredient_name"}

    def test_jobs_are_private_to_the_household(self, store, started):
        _, body = call(store, "POST /recipes/import", body={"link": "https://e.com/a"})
        assert error(store, "GET /recipes/import/{id}", sub="bob", path={"id": body["jobId"]}) == (404, "Import not found")
        assert error(store, "GET /recipes/import/{id}", path={"id": "nope"}) == (404, "Import not found")

    def test_monthly_allowance_per_household(self, table, started):
        now = [1_794_000_000.0]  # November 2026
        s = Store(table, clock=lambda: now[0])
        s.create_household("alice")
        s.create_household("bob")
        for remaining in (1, 0):
            assert call(s, "POST /recipes/import", body={"link": "https://e.com/a"})[1]["remaining"] == remaining
        assert error(s, "POST /recipes/import", body={"link": "https://e.com/a"}) == (
            429,
            "Your household has used this month's 2 recipe imports. Add this one by hand.",
        )
        assert len(started) == 2  # the refused one never reached the AI
        assert call(s, "POST /recipes/import", sub="bob", body={"link": "https://e.com/b"})[0] == 202  # per household
        now[0] += 31 * 24 * 3600  # next month starts fresh
        assert call(s, "POST /recipes/import", body={"link": "https://e.com/a"})[0] == 202

    def test_default_allowance(self, store, started, monkeypatch):
        monkeypatch.delenv("AI_MONTHLY_LIMIT")
        assert call(store, "POST /recipes/import", body={"link": "https://e.com"})[1]["remaining"] == handler.DEFAULT_AI_MONTHLY_LIMIT - 1

    @pytest.mark.parametrize(
        "body, expected",
        [
            ({}, (400, "Paste a link to a recipe page first")),
            ({"link": "  "}, (400, "Paste a link to a recipe page first")),
            ({"link": "javascript:alert(1)"}, (400, "Link must be a web address starting with http:// or https://")),
        ],
    )
    def test_needs_a_web_link(self, store, started, body, expected):
        assert error(store, "POST /recipes/import", body=body) == expected
        assert started == []

    def test_needs_a_household(self, store, started):
        assert error(store, "POST /recipes/import", sub="carol", body={"link": "https://e.com"})[0] == 409

    def test_off_when_no_provider_is_configured(self, store, monkeypatch):
        monkeypatch.delenv("AI_PROVIDER", raising=False)
        assert error(store, "POST /recipes/import", body={"link": "https://e.com"}) == (404, "Recipe import isn't set up on this server.")

    def test_hands_the_job_to_the_worker_without_waiting(self, monkeypatch):
        from botocore.stub import Stubber

        client = boto3.client("lambda")
        stub = Stubber(client)
        payload = json.dumps({"householdId": "h1", "jobId": "j1", "link": "https://e.com", "language": "pl"}).encode()
        stub.add_response(
            "invoke", {"StatusCode": 202}, {"FunctionName": "import-worker", "InvocationType": "Event", "Payload": payload}
        )
        monkeypatch.setenv("IMPORT_WORKER_NAME", "import-worker")
        monkeypatch.setattr(handler.boto3, "client", lambda service: client)
        with stub:
            handler._start_import_worker("h1", "j1", "https://e.com", "pl")
        stub.assert_no_pending_responses()
