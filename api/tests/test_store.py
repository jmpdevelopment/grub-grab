from decimal import Decimal

import pytest

from grubgrab.store import (
    DECLINED_REQUEST_TTL,
    JOIN_WINDOW_SECONDS,
    PENDING_REQUEST_TTL,
    Store,
    normalise_invite_code,
    random_invite_code,
)


def codes(*values):
    """Deterministic invite-code generator (dependency injection, not a mock)."""
    it = iter(values)
    return lambda: next(it)


class PagingTable:
    """Wraps the real (moto) table and forces 1-item pages, to exercise pagination."""

    def __init__(self, table):
        self._table = table

    def query(self, **kwargs):
        return self._table.query(Limit=1, **kwargs)

    def __getattr__(self, name):
        return getattr(self._table, name)


class LateProfileTable:
    """Simulates a parallel request: the first profile read misses, then a profile appears before our write."""

    def __init__(self, table, other_household):
        self._table = table
        self._other = other_household
        self._raced = False

    def get_item(self, **kwargs):
        if not self._raced and kwargs["Key"]["SK"] == "PROFILE":
            self._raced = True
            self._table.put_item(Item={**kwargs["Key"], "householdId": self._other})
            return {}
        return self._table.get_item(**kwargs)

    def __getattr__(self, name):
        return getattr(self._table, name)


class TestInviteCodes:
    def test_random_code_shape(self):
        code = random_invite_code()
        assert len(code) == 10
        assert set(code) <= set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        assert not set(code) & set("01OI")

    def test_codes_are_unique_per_household(self, table):
        s = Store(table, codes("AAAAAA", "AAAAAA", "BBBBBB"))
        first = s.create_household("alice")
        second = s.create_household("bob")
        assert (first["inviteCode"], second["inviteCode"]) == ("AAAAAA", "BBBBBB")
        assert s.join_household("carol", "AAAAAA")["householdId"] == first["householdId"]

    def test_gives_up_after_repeated_collisions(self, table):
        s = Store(table, lambda: "AAAAAA")
        s.create_household("alice")
        with pytest.raises(RuntimeError, match="unique invite code"):
            s.create_household("bob")


class TestHouseholds:
    def test_new_user_has_no_household_until_they_start_one(self, store):
        assert store.find_household("alice") is None
        assert store.household_for("alice") is None
        first = store.create_household("alice")
        assert store.find_household("alice") == first
        assert store.household_for("alice") == first["householdId"]

    def test_starting_twice_keeps_the_first_household(self, store):
        first = store.create_household("alice")
        assert store.create_household("alice") == first
        assert [i["PK"] for i in store.table.scan()["Items"] if i["SK"] == "META"] == [f"HH#{first['householdId']}"]

    def test_join_without_a_household_of_your_own(self, store):
        hh = store.create_household("alice")
        assert store.join_household("bob", hh["inviteCode"]) == hh
        assert store.find_household("bob") == hh

    def test_parallel_first_request_uses_existing_household(self, table):
        Store(table).table.put_item(Item={"PK": "HH#theirs", "SK": "META", "inviteCode": "ZZZZZZ"})
        s = Store(LateProfileTable(table, "theirs"), codes("LOSERCODE2"))
        assert s.create_household("alice") == {"householdId": "theirs", "inviteCode": "ZZZZZZ", "recipeLanguage": "en", "aisles": {}}
        # The losing request cleans up the household it built: no orphan META, and its code doesn't work.
        metas = [i for i in table.scan()["Items"] if i["SK"] == "META"]
        assert [m["PK"] for m in metas] == ["HH#theirs"]
        assert s.join_household("bob", "LOSERCODE2") is None

    def test_profile_never_points_at_a_half_built_household(self, table):
        """Regression: a request that sees the new profile must also see the invite code.

        On first sign-in the app sends /me, /recipes and /list together. Previously the profile was written
        before the household's META, so /me could return inviteCode None and Settings showed '…'.
        """
        seen = []

        class WatchProfileWrites:
            def put_item(self, **kwargs):
                result = table.put_item(**kwargs)
                if kwargs["Item"]["SK"] == "PROFILE":  # a parallel request reads right after the profile lands
                    seen.append(Store(table).create_household("alice"))
                return result

            def __getattr__(self, name):
                return getattr(table, name)

        created = Store(WatchProfileWrites(), codes("FRESHCODE2")).create_household("alice")
        assert seen == [created] and created["inviteCode"] == "FRESHCODE2"

    def test_household_without_meta(self, store):
        assert store.get_household("missing") == {"householdId": "missing", "inviteCode": None, "recipeLanguage": "en", "aisles": {}}

    def test_join(self, store):
        hh = store.create_household("alice")
        assert store.join_household("bob", hh["inviteCode"]) == hh
        assert store.household_for("bob") == hh["householdId"]

    @pytest.mark.parametrize(
        "raw, expected",
        [("abcde-fghjk", "ABCDEFGHJK"), ("  ABCDE FGHJK ", "ABCDEFGHJK"), ("a.b_c", "ABC"), ("", "")],
    )
    def test_normalise_code(self, raw, expected):
        assert normalise_invite_code(raw) == expected

    def test_join_unknown_code(self, store):
        assert store.join_household("bob", "NOPE00") is None

    def test_leaving_a_household_nobody_else_is_in_deletes_it(self, store):
        mine = store.create_household("bob")
        store.put_recipe(mine["householdId"], {"title": "Old soup", "ingredients": []})
        store.add_item(mine["householdId"], "leek", None, "")
        theirs = store.create_household("alice")
        assert store.join_household("bob", theirs["inviteCode"]) == theirs
        assert store._query(f"HH#{mine['householdId']}") == []  # recipes, list, settings: gone
        assert store.join_household("carol", mine["inviteCode"]) is None  # its old code no longer works
        assert store.list_recipes(theirs["householdId"]) == []  # the new one is untouched

    def test_leaving_a_shared_household_keeps_it_for_the_others(self, store):
        shared = store.create_household("alice")
        store.join_household("bob", shared["inviteCode"])
        store.put_recipe(shared["householdId"], {"title": "Stew", "ingredients": []})
        elsewhere = store.create_household("carol")
        store.join_household("bob", elsewhere["inviteCode"])
        assert [r["title"] for r in store.list_recipes(shared["householdId"])] == ["Stew"]
        assert store.household_for("alice") == shared["householdId"]

    def test_joining_your_own_household_again_changes_nothing(self, store):
        mine = store.create_household("bob")
        store.put_recipe(mine["householdId"], {"title": "Soup", "ingredients": []})
        assert store.join_household("bob", mine["inviteCode"]) == mine
        assert [r["title"] for r in store.list_recipes(mine["householdId"])] == ["Soup"]


class TestAisles:
    def test_remembers_where_the_household_moved_items(self, store):
        hh = store.create_household("alice")["householdId"]
        assert store.set_aisle(hh, "pomidory", "produce") is True  # the household's first
        assert store.set_aisle(hh, "tahini", "pantry") is True
        assert store.set_aisle(hh, "pomidory", "pantry") is True  # moved again
        assert store.get_household(hh)["aisles"] == {"pomidory": "pantry", "tahini": "pantry"}

    def test_names_with_odd_characters(self, store):
        hh = store.create_household("alice")["householdId"]
        store.set_aisle(hh, "salt & pepper. (fine)", "spices")
        store.set_aisle(hh, "#a.b", "other")
        assert store.get_household(hh)["aisles"] == {"salt & pepper. (fine)": "spices", "#a.b": "other"}

    def test_households_from_before_aisles(self, store):
        hh = store.create_household("alice")["householdId"]
        store.table.update_item(Key={"PK": f"HH#{hh}", "SK": "META"}, UpdateExpression="REMOVE aisles")
        assert store.get_household(hh)["aisles"] == {}
        assert store.set_aisle(hh, "kefir", "dairy") is True
        assert store.get_household(hh)["aisles"] == {"kefir": "dairy"}

    def test_a_limit_on_how_many(self, store, monkeypatch):
        from grubgrab import store as store_module

        monkeypatch.setattr(store_module, "MAX_REMEMBERED", 2)
        hh = store.create_household("alice")["householdId"]
        assert store.set_aisle(hh, "a", "other") and store.set_aisle(hh, "b", "other")
        assert store.set_aisle(hh, "c", "other") is False
        assert store.set_aisle(hh, "a", "dairy") is True  # moving a remembered one again is fine
        assert store.get_household(hh)["aisles"] == {"a": "dairy", "b": "other"}

    def test_two_people_moving_their_first_items_at_once(self, store):
        hh = store.create_household("alice")["householdId"]
        store.table.update_item(Key={"PK": f"HH#{hh}", "SK": "META"}, UpdateExpression="REMOVE aisles")
        real_update = store.table.update_item
        calls = []

        class RacingTable:
            """The other person's first move lands just before ours creates the map."""

            meta = store.table.meta

            def update_item(self, **kwargs):
                calls.append(kwargs["UpdateExpression"])
                if kwargs["UpdateExpression"] == "SET #a = :m" and len(calls) == 2:
                    real_update(Key=kwargs["Key"], UpdateExpression="SET aisles = :m", ExpressionAttributeValues={":m": {"leek": "produce"}})
                return real_update(**kwargs)

            def __getattr__(self, name):
                return getattr(store.table, name)

        racing = Store(RacingTable())
        assert racing.set_aisle(hh, "kefir", "dairy") is True
        assert store.get_household(hh)["aisles"] == {"leek": "produce", "kefir": "dairy"}


class TestRotateInvite:
    def test_new_code_works_and_old_one_stops(self, table):
        s = Store(table, codes("OLDOLDOLD2", "NEWNEWNEW2"))
        hh = s.create_household("alice")
        rotated = s.rotate_invite(hh["householdId"])
        assert rotated == {"householdId": hh["householdId"], "inviteCode": "NEWNEWNEW2", "recipeLanguage": "en", "aisles": {}}
        assert s.get_household(hh["householdId"])["inviteCode"] == "NEWNEWNEW2"
        assert s.join_household("bob", "OLDOLDOLD2") is None
        assert s.join_household("bob", "NEWNEWNEW2")["householdId"] == hh["householdId"]

    def test_household_without_a_previous_code(self, table):
        s = Store(table, codes("FIRSTCODE2"))
        assert s.rotate_invite("bare")["inviteCode"] == "FIRSTCODE2"


class TestAccessRequests:
    def test_requests_are_listed_newest_first_and_expire(self, table):
        now = [100.0]
        s = Store(table, clock=lambda: now[0])
        assert s.request_access("Google_1", "a@x.com", "A") == ("pending", True)
        now[0] = 200.0
        s.request_access("Google_2", "b@x.com", "B")
        assert [r["username"] for r in s.access_requests()] == ["Google_2", "Google_1"]
        item = table.get_item(Key={"PK": "ACCESS", "SK": "REQ#Google_1"})["Item"]
        assert item["expiresAt"] == 100 + PENDING_REQUEST_TTL  # unanswered requests tidy themselves up

    def test_long_details_are_trimmed(self, store):
        store.request_access("Google_1", "e" * 300, "n" * 300)
        r = store.access_requests()[0]
        assert len(r["email"]) == 200 and len(r["name"]) == 200

    def test_approve_and_decline(self, table):
        s = Store(table, clock=lambda: 50.0)
        s.request_access("Google_1", "a@x.com", "A")
        s.request_access("Google_2", "b@x.com", "B")
        assert s.decide_access("Google_1", approve=True) == {"username": "Google_1", "email": "a@x.com", "name": "A", "status": "approved"}
        assert "expiresAt" not in table.get_item(Key={"PK": "ACCESS", "SK": "REQ#Google_1"})["Item"]
        assert s.decide_access("Google_2", approve=False)["status"] == "declined"
        assert table.get_item(Key={"PK": "ACCESS", "SK": "REQ#Google_2"})["Item"]["expiresAt"] == 50 + DECLINED_REQUEST_TTL
        assert s.access_requests() == []
        assert s.request_access("Google_2", "b@x.com", "B") == ("declined", False)
        assert s.decide_access("Google_nobody", approve=True) is None

    def test_decline_all_pending(self, store):
        for n in range(3):
            store.request_access(f"Google_{n}", f"{n}@x.com", "")
        store.decide_access("Google_0", approve=True)
        assert store.decline_all_pending() == 2
        assert store.access_requests() == []
        assert store.request_access("Google_0", "", "") == ("approved", False)

    def test_parallel_first_requests(self, table):
        class LateRequestTable:
            """The first read misses, then a parallel attempt writes the request before ours."""

            raced = False

            def get_item(self, **kwargs):
                if not self.raced:
                    self.raced = True
                    table.put_item(Item={**kwargs["Key"], "status": "pending"})
                    return {}
                return table.get_item(**kwargs)

            def __getattr__(self, name):
                return getattr(table, name)

        assert Store(LateRequestTable()).request_access("Google_1", "a@x.com", "A") == ("pending", False)


class TestDeleteUserData:
    def test_checks_every_page_of_profiles_before_deleting_a_household(self, table):
        class PagingScanTable:
            """Forces one-item scan pages, so the household check has to follow every page."""

            def scan(self, **kwargs):
                return table.scan(Limit=1, **kwargs)

            def __getattr__(self, name):
                return getattr(table, name)

        s = Store(PagingScanTable())
        hh = s.create_household("alice")
        s.put_recipe(hh["householdId"], {"title": "Soup", "ingredients": []})
        s.create_household("bob")
        s.join_household("zed", hh["inviteCode"])  # sorts last, so it's found on a later page
        assert s.delete_user_data("alice", "Google_alice") is False
        assert s.count_recipes(hh["householdId"]) == 1
        assert s.delete_user_data("zed", "Google_zed") is True
        assert s.count_recipes(hh["householdId"]) == 0


    def test_household_without_an_invite_code(self, store):
        store.table.put_item(Item={"PK": "USER#alice", "SK": "PROFILE", "householdId": "bare"})
        store.put_recipe("bare", {"title": "Soup", "ingredients": []})
        assert store.delete_user_data("alice", "Google_alice") is True
        assert store.count_recipes("bare") == 0 and store.find_household("alice") is None


class TestListWrites:
    def test_counts_and_batched_replace(self, store):
        assert (store.count_recipes("h"), store.count_items("h")) == (0, 0)
        store.put_recipe("h", {"title": "Soup", "ingredients": []})
        old = store.add_item("h", "Milk", None, "")
        store.add_item("h", "Eggs", Decimal(6), "")
        store.replace_items("h", [old["id"]], [{"name": "Bread", "quantity": None, "unit": None, "recipes": None}])
        assert sorted(i["name"] for i in store.list_items("h")) == ["Bread", "Eggs"]
        assert store.list_items("h")[0]["unit"] == "" and store.list_items("h")[0]["recipes"] == []
        assert (store.count_recipes("h"), store.count_items("h")) == (1, 2)


class TestJoinAttempts:
    def test_counts_per_user_per_hour_and_expires(self, table):
        now = [JOIN_WINDOW_SECONDS * 100 + 5]
        s = Store(table, clock=lambda: now[0])
        assert [s.record_join_attempt("alice") for _ in range(3)] == [1, 2, 3]
        assert s.record_join_attempt("bob") == 1

        item = table.get_item(Key={"PK": "USER#alice", "SK": "JOINS#100"})["Item"]
        assert item["expiresAt"] == JOIN_WINDOW_SECONDS * 102  # TTL cleans up after the window

        now[0] += JOIN_WINDOW_SECONDS  # next hour starts fresh
        assert s.record_join_attempt("alice") == 1


class TestRecipes:
    def test_crud_and_sorting(self, store):
        b = store.put_recipe("h", {"title": "banana bread", "ingredients": []})
        a = store.put_recipe("h", {"title": "Apple pie", "ingredients": [{"name": "Apple", "quantity": Decimal(3), "unit": ""}]})
        assert [r["title"] for r in store.list_recipes("h")] == ["Apple pie", "banana bread"]
        assert store.get_recipe("h", a["id"])["ingredients"][0]["quantity"] == 3
        assert b["servings"] is None and b["notes"] == ""

        store.put_recipe("h", {"title": "Better bread", "ingredients": []}, b["id"])
        assert store.get_recipe("h", b["id"])["title"] == "Better bread"

        store.delete_recipe("h", a["id"])
        assert store.get_recipe("h", a["id"]) is None

    def test_households_are_isolated(self, store):
        r = store.put_recipe("h1", {"title": "Mine", "ingredients": []})
        assert store.list_recipes("h2") == []
        assert store.get_recipe("h2", r["id"]) is None

    def test_list_paginates(self, table):
        s = Store(PagingTable(table))
        for title in ("C", "A", "B"):
            s.put_recipe("h", {"title": title, "ingredients": []})
        assert [r["title"] for r in s.list_recipes("h")] == ["A", "B", "C"]


class TestItems:
    def test_add_defaults(self, store):
        item = store.add_item("h", "Milk", None, "")
        assert item == {"id": item["id"], "name": "Milk", "quantity": None, "unit": "", "checked": False, "recipes": []}

    def test_sorted_unchecked_first_then_by_name(self, store):
        b = store.add_item("h", "banana", None, "")
        store.add_item("h", "Apple", None, "")
        store.add_item("h", "cherry", None, "")
        store.set_checked("h", b["id"], True)
        assert [i["name"] for i in store.list_items("h")] == ["Apple", "cherry", "banana"]

    def test_set_checked_round_trip(self, store):
        item = store.add_item("h", "Milk", Decimal(1), "l")
        assert store.set_checked("h", item["id"], True)["checked"] is True
        assert store.set_checked("h", item["id"], False)["checked"] is False

    def test_set_checked_missing_item_does_not_create_it(self, store):
        assert store.set_checked("h", "nope", True) is None
        assert store.list_items("h") == []

    def test_delete(self, store):
        item = store.add_item("h", "Milk", None, "")
        store.delete_item("h", item["id"])
        store.delete_item("h", "never-existed")  # idempotent
        assert store.list_items("h") == []

    def test_clear_all_and_checked_only(self, store):
        keep = store.add_item("h", "Keep", None, "")
        for name in ("A", "B"):
            store.set_checked("h", store.add_item("h", name, None, "")["id"], True)
        store.clear_items("h", only_checked=True)
        assert [i["id"] for i in store.list_items("h")] == [keep["id"]]
        store.clear_items("h")
        assert store.list_items("h") == []

    def test_clear_many_items_across_pages(self, table):
        s = Store(PagingTable(table))
        for n in range(30):  # more than one 25-item batch, and many query pages
            s.add_item("h", f"item {n}", None, "")
        s.clear_items("h")
        assert s.list_items("h") == []

    def test_clear_only_touches_own_household(self, store):
        store.add_item("h1", "Mine", None, "")
        store.add_item("h2", "Theirs", None, "")
        store.clear_items("h1")
        assert [i["name"] for i in store.list_items("h2")] == ["Theirs"]


def test_default_table_from_environment(table):
    s = Store()
    assert s.table.name == "grubgrab-test"
