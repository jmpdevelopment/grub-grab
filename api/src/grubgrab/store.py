"""DynamoDB access. Single table, everything scoped to a household.

Key layout:
  PK=USER#<sub>        SK=PROFILE          -> householdId
  PK=USER#<sub>        SK=SETTINGS         -> language — the app language this person chose (any device)
  PK=USER#<sub>        SK=JOINS#<window>   -> attempts, expiresAt (TTL)  — join rate limit
  PK=INVITE#<code>     SK=INVITE           -> householdId
  PK=HH#<id>           SK=META             -> inviteCode, createdAt, recipeLanguage (what imports write in),
                                              aisles ({item name: aisle} — where the household moved items)
  PK=HH#<id>           SK=RECIPE#<id>      -> title, servings, ingredients, notes
  PK=HH#<id>           SK=ITEM#<id>        -> name, quantity, unit, checked, recipes, aisle (if known)
  PK=ACCESS            SK=REQ#<username>   -> email, name, status (pending/approved/declined), requestedAt
  PK=ACCESS            SK=NOTIFY           -> lastAt — at most one "new request" email per hour
  PK=HH#<id>           SK=AI#<yyyy-mm>     -> imports, expiresAt (TTL) — AI recipe imports this month
  PK=HH#<id>           SK=IMPORT#<id>      -> status, link, recipe | error, details, pageData, outcomeAt, expiresAt (TTL)
                                              — one AI import job
  PK=USER#<sub>        SK=FEEDBACK#<kind>#<day> -> reports, expiresAt (TTL) — daily report limit

Problem reports and import outcomes live in a separate table (FEEDBACK_TABLE, see feedback.py).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
import uuid
from decimal import Decimal
from typing import Callable

import boto3
from boto3.dynamodb.conditions import Attr, Key

from .aisles import MAX_REMEMBERED

INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
INVITE_LENGTH = 10  # 32^10 ≈ 1.1e15 codes (50 bits)
JOIN_WINDOW_SECONDS = 3600
_INVITE_ATTEMPTS = 5
PENDING_REQUEST_TTL = 30 * 24 * 3600  # unanswered sign-up requests disappear after a month
DECLINED_REQUEST_TTL = 365 * 24 * 3600  # a decline sticks for a year
NOTIFY_EVERY_SECONDS = 3600
_ACCESS = "ACCESS"
IMPORT_JOB_TTL = 30 * 24 * 3600  # long enough for a problem report about the import to include its details
FEEDBACK_TTL = 365 * 24 * 3600  # problem reports and import outcomes are kept a year


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
        feedback_table=None,
    ):
        if table is None:
            table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
        self.table = table
        self._feedback_table = feedback_table
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

    def create_household(self, user_sub: str, recipe_language: str = "en") -> dict:
        """Start a new household for the user. If they already have one, that one is returned instead.
        Its recipe language starts as the creator's app language; anyone in it can change it later."""
        key = {"PK": f"USER#{user_sub}", "SK": "PROFILE"}
        existing = self.find_household(user_sub)
        if existing:
            return existing

        # Build the household completely before pointing the user at it, so any request that finds the
        # profile also finds its invite code (e.g. a double-tapped "Start" button, or /me right after).
        household_id = uuid.uuid4().hex
        code = self._claim_invite_code(household_id)
        meta_key = {"PK": f"HH#{household_id}", "SK": "META"}
        self.table.put_item(Item={**meta_key, "inviteCode": code, "createdAt": self._now(), "recipeLanguage": recipe_language})
        if not self._put_if_absent({**key, "householdId": household_id}):
            # A parallel request claimed the user first: drop ours and use theirs.
            self.table.delete_item(Key={"PK": f"INVITE#{code}", "SK": "INVITE"})
            self.table.delete_item(Key=meta_key)
            return self.create_household(user_sub, recipe_language)
        return {"householdId": household_id, "inviteCode": code, "recipeLanguage": recipe_language, "aisles": {}}

    def get_household(self, household_id: str) -> dict:
        key = {"PK": f"HH#{household_id}", "SK": "META"}
        meta = self.table.get_item(Key=key, ConsistentRead=True).get("Item") or {}
        # Households from before recipe languages existed were filled in English.
        return {
            "householdId": household_id,
            "inviteCode": meta.get("inviteCode"),
            "recipeLanguage": meta.get("recipeLanguage", "en"),
            "aisles": meta.get("aisles", {}),
        }

    def set_aisle(self, household_id: str, name: str, aisle: str) -> bool:
        """Remember the aisle for an item name (one entry, so two people moving items don't undo each other).
        False if the household already remembers MAX_REMEMBERED other names."""
        key, names = {"PK": f"HH#{household_id}", "SK": "META"}, {"#a": "aisles"}
        failed = self.table.meta.client.exceptions.ConditionalCheckFailedException
        for _ in range(2):  # the second round covers someone else creating the map in between
            try:
                self.table.update_item(
                    Key=key,
                    UpdateExpression="SET #a.#n = :v",
                    ConditionExpression="attribute_exists(#a) AND (size(#a) < :max OR attribute_exists(#a.#n))",
                    ExpressionAttributeNames={**names, "#n": name},
                    ExpressionAttributeValues={":v": aisle, ":max": MAX_REMEMBERED},
                )
                return True
            except failed:
                pass
            try:  # the household's first one
                self.table.update_item(
                    Key=key,
                    UpdateExpression="SET #a = :m",
                    ConditionExpression="attribute_not_exists(#a)",
                    ExpressionAttributeNames=names,
                    ExpressionAttributeValues={":m": {name: aisle}},
                )
                return True
            except failed:
                pass
        return False

    def set_recipe_language(self, household_id: str, language: str) -> dict:
        self.table.update_item(
            Key={"PK": f"HH#{household_id}", "SK": "META"},
            UpdateExpression="SET recipeLanguage = :l",
            ExpressionAttributeValues={":l": language},
        )
        return self.get_household(household_id)

    def get_user_language(self, user_sub: str) -> str | None:
        item = self.table.get_item(Key={"PK": f"USER#{user_sub}", "SK": "SETTINGS"}, ConsistentRead=True).get("Item")
        return item.get("language") if item else None

    def set_user_language(self, user_sub: str, language: str) -> None:
        self.table.put_item(Item={"PK": f"USER#{user_sub}", "SK": "SETTINGS", "language": language})

    def record_ai_import(self, household_id: str) -> int:
        """Count an AI recipe import this calendar month (UTC); returns imports so far, this one included."""
        month = time.strftime("%Y-%m", time.gmtime(self._now()))
        resp = self.table.update_item(
            Key={"PK": f"HH#{household_id}", "SK": f"AI#{month}"},
            UpdateExpression="ADD imports :one SET expiresAt = if_not_exists(expiresAt, :exp)",
            ExpressionAttributeValues={":one": 1, ":exp": self._now() + 62 * 24 * 3600},
            ReturnValues="UPDATED_NEW",
        )
        return int(resp["Attributes"]["imports"])

    def create_import_job(self, household_id: str, link: str, language: str = "en") -> str:
        job_id = uuid.uuid4().hex
        now = self._now()
        self.table.put_item(
            Item={
                "PK": f"HH#{household_id}",
                "SK": f"IMPORT#{job_id}",
                "status": "pending",
                "link": link,
                "language": language,
                "createdAt": now,
                "expiresAt": now + IMPORT_JOB_TTL,
            }
        )
        return job_id

    def finish_import_job(
        self,
        household_id: str,
        job_id: str,
        *,
        recipe: dict | None = None,
        error: str = "",
        error_code: str = "unexpected",
        details: dict | None = None,
        page_data: dict | None = None,
    ) -> None:
        """Record the result. `details` (model, tokens, request id...) and `page_data` (the page's own recipe data)
        are kept for problem reports only; the app never gets them back."""
        # DynamoDB stores numbers as Decimal, so round-trip floats (draft quantities, costs) through JSON.
        dec = lambda value: json.loads(json.dumps(value), parse_float=Decimal)  # noqa: E731
        if recipe is not None:
            update, values = "SET #s = :s, recipe = :r", {":s": "done", ":r": dec(recipe)}
        else:
            update, values = "SET #s = :s, #e = :e, errorCode = :c", {":s": "failed", ":e": error, ":c": error_code}
        update += ", details = :d, pageData = :p"
        values.update({":d": dec(details or {}), ":p": dec(page_data) if page_data else None})
        self.table.update_item(
            Key={"PK": f"HH#{household_id}", "SK": f"IMPORT#{job_id}"},
            UpdateExpression=update,
            ExpressionAttributeNames={"#s": "status", **({"#e": "error"} if recipe is None else {})},
            ExpressionAttributeValues=values,
        )

    def get_import_job(self, household_id: str, job_id: str) -> dict | None:
        item = self.table.get_item(Key={"PK": f"HH#{household_id}", "SK": f"IMPORT#{job_id}"}, ConsistentRead=True).get("Item")
        if not item:
            return None
        return {k: item[k] for k in ("status", "recipe", "error", "errorCode") if k in item}

    def import_job_record(self, household_id: str, job_id: str) -> dict | None:
        """Everything kept about an import, for a problem report (or None if it has gone)."""
        item = self.table.get_item(Key={"PK": f"HH#{household_id}", "SK": f"IMPORT#{job_id}"}, ConsistentRead=True).get("Item")
        return _strip_keys(item) if item else None

    def claim_import_outcome(self, household_id: str, job_id: str) -> bool:
        """Mark that an import's outcome (saved or abandoned) was recorded; False if it already was, or the job is gone."""
        try:
            self.table.update_item(
                Key={"PK": f"HH#{household_id}", "SK": f"IMPORT#{job_id}"},
                UpdateExpression="SET outcomeAt = :t",
                ConditionExpression="attribute_exists(PK) AND attribute_not_exists(outcomeAt)",
                ExpressionAttributeValues={":t": self._now()},
            )
            return True
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return False

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
        return self.get_household(household_id)

    def household_for(self, user_sub: str) -> str | None:
        household = self.find_household(user_sub)
        return household["householdId"] if household else None

    # ---- generic helpers ---------------------------------------------------

    def _query(self, pk: str, prefix: str | None = None, **extra) -> list[dict]:
        condition = Key("PK").eq(pk) & Key("SK").begins_with(prefix) if prefix else Key("PK").eq(pk)
        items, kwargs = [], {"KeyConditionExpression": condition, **extra}
        while True:
            resp = self.table.query(**kwargs)
            items.extend(resp.get("Items", []))
            if "LastEvaluatedKey" not in resp:
                return items
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    def _query_prefix(self, household_id: str, prefix: str) -> list[dict]:
        return self._query(f"HH#{household_id}", prefix)

    # ---- deleting an account ------------------------------------------------

    def _others_in_household(self, household_id: str, user_sub: str) -> bool:
        """Does anyone besides this user belong to the household? Checks every profile, so it never
        guesses wrong (a full scan, but the table is small and deleting an account is rare)."""
        kwargs = {"FilterExpression": Attr("SK").eq("PROFILE") & Attr("householdId").eq(household_id)}
        while True:
            page = self.table.scan(**kwargs)
            if any(i["PK"] != f"USER#{user_sub}" for i in page["Items"]):
                return True
            if "LastEvaluatedKey" not in page:
                return False
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def delete_user_data(self, user_sub: str, username: str) -> bool:
        """Remove everything stored about a user. Their household (recipes, list, invite code) goes too
        if nobody else is in it; otherwise it stays for the others. Returns True if it was deleted."""
        household = self.find_household(user_sub)
        household_deleted = False
        with self.table.batch_writer() as batch:
            if household and not self._others_in_household(household["householdId"], user_sub):
                for item in self._query(f"HH#{household['householdId']}"):
                    batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
                if household["inviteCode"]:
                    batch.delete_item(Key={"PK": f"INVITE#{household['inviteCode']}", "SK": "INVITE"})
                household_deleted = True
            for item in self._query(f"USER#{user_sub}"):  # profile and join-attempt counters
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
            batch.delete_item(Key={"PK": _ACCESS, "SK": f"REQ#{username}"})  # signing in again means asking again
        self.delete_user_feedback(user_sub)  # their problem reports and import outcomes
        return household_deleted

    # ---- problem reports and import outcomes (their own table) --------------

    @property
    def feedback_table(self):
        if self._feedback_table is None:
            self._feedback_table = boto3.resource("dynamodb").Table(os.environ["FEEDBACK_TABLE"])
        return self._feedback_table

    def add_feedback(self, record: dict) -> None:
        self.feedback_table.put_item(Item=record)

    def count_feedback(self, user_sub: str, kind: str) -> int:
        """Count a report today (automatic error reports separately from the rest); returns today's total."""
        day = self._now() // 86400
        group = "error" if kind == "error" else "report"
        resp = self.table.update_item(
            Key={"PK": f"USER#{user_sub}", "SK": f"FEEDBACK#{group}#{day}"},
            UpdateExpression="ADD reports :one SET expiresAt = if_not_exists(expiresAt, :exp)",
            ExpressionAttributeValues={":one": 1, ":exp": (day + 2) * 86400},
            ReturnValues="UPDATED_NEW",
        )
        return int(resp["Attributes"]["reports"])

    def delete_user_feedback(self, user_sub: str) -> None:
        keys, kwargs = [], {"IndexName": "byUser", "KeyConditionExpression": Key("userId").eq(user_sub)}
        while True:
            resp = self.feedback_table.query(**kwargs)
            keys += [{"kind": i["kind"], "sk": i["sk"]} for i in resp.get("Items", [])]
            if "LastEvaluatedKey" not in resp:
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        with self.feedback_table.batch_writer() as batch:
            for key in keys:
                batch.delete_item(Key=key)

    def count_recipes(self, household_id: str) -> int:
        return len(self._query_prefix(household_id, "RECIPE#"))

    def count_items(self, household_id: str) -> int:
        return len(self._query_prefix(household_id, "ITEM#"))

    # ---- sign-up approval ---------------------------------------------------

    def request_access(self, username: str, email: str, name: str) -> tuple[str, bool]:
        """Record a sign-up request (first time only). Returns (status, newly_created)."""
        key = {"PK": _ACCESS, "SK": f"REQ#{username}"}
        existing = self.table.get_item(Key=key, ConsistentRead=True).get("Item")
        if existing:
            return existing["status"], False
        now = self._now()
        item = {**key, "username": username, "email": email[:200], "name": name[:200], "status": "pending",
                "requestedAt": now, "expiresAt": now + PENDING_REQUEST_TTL}
        if self._put_if_absent(item):
            return "pending", True
        return self.request_access(username, email, name)  # a parallel attempt created it first

    def access_requests(self) -> list[dict]:
        """Pending sign-up requests, newest first."""
        items = self._query(_ACCESS, "REQ#")
        pending = [i for i in items if i.get("status") == "pending"]
        keep = ("username", "email", "name", "requestedAt")
        return sorted(({k: i.get(k) for k in keep} for i in pending), key=lambda r: -r["requestedAt"])

    def decide_access(self, username: str, approve: bool) -> dict | None:
        """Approve or decline a request. None if there is no such request."""
        update = "SET #s = :s REMOVE expiresAt" if approve else "SET #s = :s, expiresAt = :exp"
        values = {":s": "approved" if approve else "declined"}
        if not approve:
            values[":exp"] = self._now() + DECLINED_REQUEST_TTL
        try:
            resp = self.table.update_item(
                Key={"PK": _ACCESS, "SK": f"REQ#{username}"},
                UpdateExpression=update,
                ConditionExpression="attribute_exists(PK)",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return None
        item = resp["Attributes"]
        return {k: item.get(k) for k in ("username", "email", "name", "status")}

    def decline_all_pending(self) -> int:
        pending = self.access_requests()
        for r in pending:
            self.decide_access(r["username"], approve=False)
        return len(pending)

    def claim_notification(self) -> bool:
        """True at most once per NOTIFY_EVERY_SECONDS, so a flood of requests can't flood your inbox."""
        now = self._now()
        try:
            self.table.update_item(
                Key={"PK": _ACCESS, "SK": "NOTIFY"},
                UpdateExpression="SET lastAt = :now",
                ConditionExpression="attribute_not_exists(lastAt) OR lastAt < :cutoff",
                ExpressionAttributeValues={":now": now, ":cutoff": now - NOTIFY_EVERY_SECONDS},
            )
            return True
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return False

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

    def replace_items(self, household_id: str, remove_ids: list[str], new_items: list[dict]) -> None:
        """Delete some items and add others in batches (fewer round trips when building a list)."""
        with self.table.batch_writer() as batch:
            for item_id in remove_ids:
                batch.delete_item(Key={"PK": f"HH#{household_id}", "SK": f"ITEM#{item_id}"})
            for i in new_items:
                item_id = uuid.uuid4().hex
                batch.put_item(
                    Item={
                        "PK": f"HH#{household_id}",
                        "SK": f"ITEM#{item_id}",
                        "id": item_id,
                        "name": i["name"],
                        "quantity": i["quantity"],
                        "unit": i["unit"] or "",
                        "checked": False,
                        "recipes": i["recipes"] or [],
                        **({"aisle": i["aisle"]} if i.get("aisle") else {}),
                    }
                )

    def clear_items(self, household_id: str, only_checked: bool = False) -> None:
        with self.table.batch_writer() as batch:
            for item in self._query_prefix(household_id, "ITEM#"):
                if only_checked and not item.get("checked"):
                    continue
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
