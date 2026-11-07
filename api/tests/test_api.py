import json
import sys
from decimal import Decimal
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from grubgrab.aggregate import aggregate  # noqa: E402
from grubgrab.handler import handle  # noqa: E402
from grubgrab.store import Store  # noqa: E402


@pytest.fixture
def store():
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="eu-west-2")
        table = ddb.create_table(
            TableName="grubgrab",
            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield Store(table)


def call(store, route_key, sub="alice", body=None, path=None, query=None):
    event = {
        "routeKey": route_key,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub}}}},
        "pathParameters": path or {},
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
    }
    resp = handle(event, store)
    return resp["statusCode"], (json.loads(resp["body"]) if resp["body"] else None)


PASTA = {
    "title": "Pasta",
    "ingredients": [
        {"name": "Spaghetti", "quantity": 500, "unit": "g"},
        {"name": "Garlic", "quantity": 3, "unit": "cloves"},
        {"name": "Salt", "unit": ""},
    ],
}
CURRY = {
    "title": "Curry",
    "ingredients": [
        {"name": "garlic", "quantity": 4, "unit": "cloves"},
        {"name": "Rice", "quantity": 1, "unit": "kg"},
        {"name": "Coconut milk", "quantity": 400, "unit": "ml"},
    ],
}


def test_aggregate_merges_and_converts_units():
    items = aggregate([
        {"title": "A", "ingredients": [{"name": "Flour", "quantity": 600, "unit": "g"}]},
        {"title": "B", "ingredients": [{"name": "flour ", "quantity": "0.5", "unit": "kg"}]},
    ])
    assert len(items) == 1
    assert items[0]["unit"] == "kg"
    assert items[0]["quantity"] == Decimal("1.1")
    assert items[0]["recipes"] == ["A", "B"]


def test_recipe_crud(store):
    status, created = call(store, "POST /recipes", body=PASTA)
    assert status == 201
    status, recipes = call(store, "GET /recipes")
    assert [r["title"] for r in recipes] == ["Pasta"]

    status, updated = call(store, "PUT /recipes/{id}", path={"id": created["id"]}, body={**PASTA, "title": "Pasta aglio"})
    assert updated["title"] == "Pasta aglio"

    status, _ = call(store, "DELETE /recipes/{id}", path={"id": created["id"]})
    assert status == 204
    assert call(store, "GET /recipes")[1] == []


def test_recipe_validation(store):
    status, body = call(store, "POST /recipes", body={"title": " ", "ingredients": []})
    assert status == 400


def test_generate_list_and_check_off(store):
    _, pasta = call(store, "POST /recipes", body=PASTA)
    _, curry = call(store, "POST /recipes", body=CURRY)

    status, items = call(store, "POST /list/generate", body={"recipeIds": [pasta["id"], curry["id"]]})
    assert status == 200
    by_name = {i["name"].lower(): i for i in items}
    assert by_name["garlic"]["quantity"] == 7
    assert set(by_name["garlic"]["recipes"]) == {"Pasta", "Curry"}
    assert by_name["rice"]["unit"] == "kg"

    garlic_id = by_name["garlic"]["id"]
    status, item = call(store, "PATCH /list/items/{id}", path={"id": garlic_id}, body={"checked": True})
    assert item["checked"] is True

    call(store, "DELETE /list", query={"checked": "true"})
    names = [i["name"].lower() for i in call(store, "GET /list")[1]]
    assert "garlic" not in names and "rice" in names


def test_append_merges_with_existing(store):
    _, pasta = call(store, "POST /recipes", body=PASTA)
    call(store, "POST /list/generate", body={"recipeIds": [pasta["id"]]})
    _, items = call(store, "POST /list/generate", body={"recipeIds": [pasta["id"]], "mode": "append"})
    spaghetti = [i for i in items if i["name"] == "Spaghetti"]
    assert len(spaghetti) == 1
    assert spaghetti[0]["quantity"] == 1 and spaghetti[0]["unit"] == "kg"


def test_household_sharing(store):
    _, me = call(store, "GET /me", sub="alice")
    call(store, "POST /recipes", sub="alice", body=PASTA)

    # Bob starts with his own empty household, then joins Alice's.
    assert call(store, "GET /recipes", sub="bob")[1] == []
    status, joined = call(store, "POST /household/join", sub="bob", body={"code": me["inviteCode"].lower()})
    assert status == 200 and joined["householdId"] == me["householdId"]
    assert [r["title"] for r in call(store, "GET /recipes", sub="bob")[1]] == ["Pasta"]


def test_bad_invite_and_unauthenticated(store):
    assert call(store, "POST /household/join", body={"code": "NOPE00"})[0] == 404
    resp = handle({"routeKey": "GET /recipes", "requestContext": {}}, store)
    assert resp["statusCode"] == 401


def test_spoons_shown_as_tablespoons_when_whole():
    items = aggregate([
        {"title": "A", "ingredients": [{"name": "Oil", "quantity": 4, "unit": "tbsp"}]},
        {"title": "B", "ingredients": [{"name": "oil", "quantity": 2, "unit": "tbsp"}]},
    ])
    assert (items[0]["quantity"], items[0]["unit"]) == (6, "tbsp")
    mixed = aggregate([{"ingredients": [{"name": "Salt", "quantity": 1, "unit": "tbsp"}, {"name": "salt", "quantity": 1, "unit": "tsp"}]}])
    assert (mixed[0]["quantity"], mixed[0]["unit"]) == (4, "tsp")
