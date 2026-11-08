"""DynamoDB access. Single table, everything scoped to a household.

Key layout:
  PK=USER#<sub>        SK=PROFILE          -> householdId
  PK=USER#<sub>        SK=JOINS#<window>   -> attempts, expiresAt (TTL)  — join rate limit
  PK=INVITE#<code>     SK=INVITE           -> householdId
  PK=HH#<id>           SK=META             -> inviteCode, createdAt
  PK=HH#<id>           SK=RECIPE#<id>      -> title, servings, ingredients, notes
  PK=HH#<id>           SK=ITEM#<id>        -> name, quantity, unit, checked, recipes
"""

from __future__ import annotations

import os
import re
import secrets
import time
import uuid
from decimal import Decimal
from typing import Callable

import boto3
from boto3.dynamodb.conditions import Key

INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
INVITE_LENGTH = 10  # 32^10 ≈ 1.1e15 codes (50 bits)
JOIN_WINDOW_SECONDS = 3600
_INVITE_ATTEMPTS = 5


def _strip_keys(item: dict) -> dict:
    return {k: v for k, v in item.items() if k not in ("PK", "SK")}


def _recipe(item: dict) -> dict:
    return {"tags": [], "link": "", **_strip_keys(item)}  # recipes saved before these fields existed


def random_invite_code() -> str:
    return "".join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_LENGTH))


def normalise_invite_code(raw: str) -> str:
    """Accept codes typed with spaces, dashes or lower case ("abcde-fghjk")."""
    return re.sub(r"[^A-Za-z0-9]", "", raw).upper()


class Store:
    def __init__(
        self,
        table=None,
        new_invite_code: Callable[[], str] = random_invite_code,
        clock: Callable[[], float] = time.time,
    ):
        if table is None:
            table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
        self.table = table
        self._new_invite_code = new_invite_code
        self._clock = clock

    def _now(self) -> int:
        return int(self._clock())

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

    def find_household(self, user_sub: str) -> dict | None:
        """The user's household, or None if they haven't created or joined one yet."""
        profile = self.table.get_item(Key={"PK": f"USER#{user_sub}", "SK": "PROFILE"}, ConsistentRead=True).get("Item")
        return self.get_household(profile["householdId"]) if profile else None

    def create_household(self, user_sub: str) -> dict:
        """Start a new household for the user. If they already have one, that one is returned instead."""
        key = {"PK": f"USER#{user_sub}", "SK": "PROFILE"}
        existing = self.find_household(user_sub)
        if existing:
            return existing

        # Build the household completely before pointing the user at it, so any request that finds the
        # profile also finds its invite code (e.g. a double-tapped "Start" button, or /me right after).
        household_id = uuid.uuid4().hex
        code = self._claim_invite_code(household_id)
        meta_key = {"PK": f"HH#{household_id}", "SK": "META"}
        self.table.put_item(Item={**meta_key, "inviteCode": code, "createdAt": self._now()})
        if not self._put_if_absent({**key, "householdId": household_id}):
            # A parallel request claimed the user first: drop ours and use theirs.
            self.table.delete_item(Key={"PK": f"INVITE#{code}", "SK": "INVITE"})
            self.table.delete_item(Key=meta_key)
            return self.create_household(user_sub)
        return {"householdId": household_id, "inviteCode": code}

    def get_household(self, household_id: str) -> dict:
        key = {"PK": f"HH#{household_id}", "SK": "META"}
        meta = self.table.get_item(Key=key, ConsistentRead=True).get("Item") or {}
        return {"householdId": household_id, "inviteCode": meta.get("inviteCode")}

    def record_join_attempt(self, user_sub: str) -> int:
        """Count a join attempt in the current hour; returns attempts so far. Old windows expire via TTL."""
        window = self._now() // JOIN_WINDOW_SECONDS
        resp = self.table.update_item(
            Key={"PK": f"USER#{user_sub}", "SK": f"JOINS#{window}"},
            UpdateExpression="ADD attempts :one SET expiresAt = if_not_exists(expiresAt, :exp)",
            ExpressionAttributeValues={":one": 1, ":exp": (window + 2) * JOIN_WINDOW_SECONDS},
            ReturnValues="UPDATED_NEW",
        )
        return int(resp["Attributes"]["attempts"])

    def join_household(self, user_sub: str, code: str) -> dict | None:
        invite = self.table.get_item(Key={"PK": f"INVITE#{code}", "SK": "INVITE"}).get("Item")
        if not invite:
            return None
        self.table.put_item(Item={"PK": f"USER#{user_sub}", "SK": "PROFILE", "householdId": invite["householdId"]})
        return self.get_household(invite["householdId"])

    def rotate_invite(self, household_id: str) -> dict:
        """Issue a new invite code; the old one stops working immediately."""
        code = self._claim_invite_code(household_id)
        resp = self.table.update_item(
            Key={"PK": f"HH#{household_id}", "SK": "META"},
            UpdateExpression="SET inviteCode = :c",
            ExpressionAttributeValues={":c": code},
            ReturnValues="UPDATED_OLD",
        )
        old = resp.get("Attributes", {}).get("inviteCode")
        if old:
            self.table.delete_item(Key={"PK": f"INVITE#{old}", "SK": "INVITE"})
        return {"householdId": household_id, "inviteCode": code}

    def household_for(self, user_sub: str) -> str | None:
        household = self.find_household(user_sub)
        return household["householdId"] if household else None

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
        recipes = [_recipe(i) for i in self._query_prefix(household_id, "RECIPE#")]
        return sorted(recipes, key=lambda r: r.get("title", "").lower())

    def get_recipe(self, household_id: str, recipe_id: str) -> dict | None:
        item = self.table.get_item(Key={"PK": f"HH#{household_id}", "SK": f"RECIPE#{recipe_id}"}).get("Item")
        return _recipe(item) if item else None

    def put_recipe(self, household_id: str, recipe: dict, recipe_id: str | None = None) -> dict:
        recipe_id = recipe_id or uuid.uuid4().hex
        item = {
            "PK": f"HH#{household_id}",
            "SK": f"RECIPE#{recipe_id}",
            "id": recipe_id,
            "title": recipe["title"],
            "servings": recipe.get("servings"),
            "notes": recipe.get("notes", ""),
            "link": recipe.get("link", ""),
            "tags": recipe.get("tags", []),
            "ingredients": recipe["ingredients"],
            "updatedAt": self._now(),
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
