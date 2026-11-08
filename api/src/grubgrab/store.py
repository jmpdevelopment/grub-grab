"""DynamoDB access. Single table, everything scoped to a household.

Key layout:
  PK=USER#<sub>        SK=PROFILE          -> householdId
  PK=INVITE#<code>     SK=INVITE           -> householdId
  PK=HH#<id>           SK=META             -> inviteCode, createdAt
  PK=HH#<id>           SK=RECIPE#<id>      -> title, servings, ingredients, notes
  PK=HH#<id>           SK=ITEM#<id>        -> name, quantity, unit, checked, recipes
"""

from __future__ import annotations

import os
import secrets
import time
import uuid
from decimal import Decimal
from typing import Callable

import boto3
from boto3.dynamodb.conditions import Key

_INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
_INVITE_ATTEMPTS = 5


def _now() -> int:
    return int(time.time())


def _strip_keys(item: dict) -> dict:
    return {k: v for k, v in item.items() if k not in ("PK", "SK")}


def random_invite_code() -> str:
    return "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(6))


class Store:
    def __init__(self, table=None, new_invite_code: Callable[[], str] = random_invite_code):
        if table is None:
            table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
        self.table = table
        self._new_invite_code = new_invite_code

    # ---- households -------------------------------------------------------

    def _put_if_absent(self, item: dict) -> bool:
        try:
            self.table.put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
            return True
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return False

    def _claim_invite_code(self, household_id: str) -> str:
        for _ in range(_INVITE_ATTEMPTS):
            code = self._new_invite_code()
            if self._put_if_absent({"PK": f"INVITE#{code}", "SK": "INVITE", "householdId": household_id}):
                return code
        raise RuntimeError("Could not allocate a unique invite code")

    def get_or_create_household(self, user_sub: str) -> dict:
        key = {"PK": f"USER#{user_sub}", "SK": "PROFILE"}
        profile = self.table.get_item(Key=key, ConsistentRead=True).get("Item")
        if profile:
            return self.get_household(profile["householdId"])

        household_id = uuid.uuid4().hex
        # Claim the user first: if a parallel first request already did, use its household.
        if not self._put_if_absent({**key, "householdId": household_id}):
            return self.get_or_create_household(user_sub)
        code = self._claim_invite_code(household_id)
        self.table.put_item(Item={"PK": f"HH#{household_id}", "SK": "META", "inviteCode": code, "createdAt": _now()})
        return {"householdId": household_id, "inviteCode": code}

    def get_household(self, household_id: str) -> dict:
        meta = self.table.get_item(Key={"PK": f"HH#{household_id}", "SK": "META"}).get("Item") or {}
        return {"householdId": household_id, "inviteCode": meta.get("inviteCode")}

    def join_household(self, user_sub: str, code: str) -> dict | None:
        invite = self.table.get_item(Key={"PK": f"INVITE#{code.strip().upper()}", "SK": "INVITE"}).get("Item")
        if not invite:
            return None
        self.table.put_item(Item={"PK": f"USER#{user_sub}", "SK": "PROFILE", "householdId": invite["householdId"]})
        return self.get_household(invite["householdId"])

    def household_for(self, user_sub: str) -> str:
        return self.get_or_create_household(user_sub)["householdId"]

    # ---- generic helpers ---------------------------------------------------

    def _query_prefix(self, household_id: str, prefix: str) -> list[dict]:
        items, kwargs = [], {
            "KeyConditionExpression": Key("PK").eq(f"HH#{household_id}") & Key("SK").begins_with(prefix)
        }
        while True:
            resp = self.table.query(**kwargs)
            items.extend(resp.get("Items", []))
            if "LastEvaluatedKey" not in resp:
                return items
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    # ---- recipes ------------------------------------------------------------

    def list_recipes(self, household_id: str) -> list[dict]:
        recipes = [_strip_keys(i) for i in self._query_prefix(household_id, "RECIPE#")]
        return sorted(recipes, key=lambda r: r.get("title", "").lower())

    def get_recipe(self, household_id: str, recipe_id: str) -> dict | None:
        item = self.table.get_item(Key={"PK": f"HH#{household_id}", "SK": f"RECIPE#{recipe_id}"}).get("Item")
        return _strip_keys(item) if item else None

    def put_recipe(self, household_id: str, recipe: dict, recipe_id: str | None = None) -> dict:
        recipe_id = recipe_id or uuid.uuid4().hex
        item = {
            "PK": f"HH#{household_id}",
            "SK": f"RECIPE#{recipe_id}",
            "id": recipe_id,
            "title": recipe["title"],
            "servings": recipe.get("servings"),
            "notes": recipe.get("notes", ""),
            "ingredients": recipe["ingredients"],
            "updatedAt": _now(),
        }
        self.table.put_item(Item=item)
        return _strip_keys(item)

    def delete_recipe(self, household_id: str, recipe_id: str) -> None:
        self.table.delete_item(Key={"PK": f"HH#{household_id}", "SK": f"RECIPE#{recipe_id}"})

    # ---- shopping list -------------------------------------------------------

    def list_items(self, household_id: str) -> list[dict]:
        items = [_strip_keys(i) for i in self._query_prefix(household_id, "ITEM#")]
        return sorted(items, key=lambda i: (i.get("checked", False), i.get("name", "").lower()))

    def add_item(self, household_id: str, name: str, quantity: Decimal | None, unit: str, recipes=None) -> dict:
        item_id = uuid.uuid4().hex
        item = {
            "PK": f"HH#{household_id}",
            "SK": f"ITEM#{item_id}",
            "id": item_id,
            "name": name,
            "quantity": quantity,
            "unit": unit or "",
            "checked": False,
            "recipes": recipes or [],
        }
        self.table.put_item(Item=item)
        return _strip_keys(item)

    def set_checked(self, household_id: str, item_id: str, checked: bool) -> dict | None:
        try:
            resp = self.table.update_item(
                Key={"PK": f"HH#{household_id}", "SK": f"ITEM#{item_id}"},
                UpdateExpression="SET checked = :c",
                ConditionExpression="attribute_exists(PK)",
                ExpressionAttributeValues={":c": checked},
                ReturnValues="ALL_NEW",
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return None
        return _strip_keys(resp["Attributes"])

    def delete_item(self, household_id: str, item_id: str) -> None:
        self.table.delete_item(Key={"PK": f"HH#{household_id}", "SK": f"ITEM#{item_id}"})

    def clear_items(self, household_id: str, only_checked: bool = False) -> None:
        with self.table.batch_writer() as batch:
            for item in self._query_prefix(household_id, "ITEM#"):
                if only_checked and not item.get("checked"):
                    continue
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
