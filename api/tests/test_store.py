from decimal import Decimal

import pytest

from grubgrab.store import Store, random_invite_code


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
        assert len(code) == 6
        assert set(code) <= set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        assert not set(code) & set("01OI")

    def test_codes_are_unique_per_household(self, table):
        s = Store(table, codes("AAAAAA", "AAAAAA", "BBBBBB"))
        first = s.get_or_create_household("alice")
        second = s.get_or_create_household("bob")
        assert (first["inviteCode"], second["inviteCode"]) == ("AAAAAA", "BBBBBB")
        assert s.join_household("carol", "AAAAAA")["householdId"] == first["householdId"]

    def test_gives_up_after_repeated_collisions(self, table):
        s = Store(table, lambda: "AAAAAA")
        s.get_or_create_household("alice")
        with pytest.raises(RuntimeError, match="unique invite code"):
            s.get_or_create_household("bob")


class TestHouseholds:
    def test_created_once_then_reused(self, store):
        first = store.get_or_create_household("alice")
        assert store.get_or_create_household("alice") == first
        assert store.household_for("alice") == first["householdId"]

    def test_parallel_first_request_uses_existing_household(self, table):
        Store(table).table.put_item(Item={"PK": "HH#theirs", "SK": "META", "inviteCode": "ZZZZZZ"})
        s = Store(LateProfileTable(table, "theirs"))
        assert s.get_or_create_household("alice") == {"householdId": "theirs", "inviteCode": "ZZZZZZ"}

    def test_household_without_meta(self, store):
        assert store.get_household("missing") == {"householdId": "missing", "inviteCode": None}

    def test_join_normalises_code(self, store):
        hh = store.get_or_create_household("alice")
        assert store.join_household("bob", f"  {hh['inviteCode'].lower()} ") == hh
        assert store.household_for("bob") == hh["householdId"]

    def test_join_unknown_code(self, store):
        assert store.join_household("bob", "NOPE00") is None


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
