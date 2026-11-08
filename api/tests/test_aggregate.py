from decimal import Decimal

import pytest

from grubgrab.aggregate import aggregate, combine, normalise_name, normalise_unit, pretty_unit


class TestNormalise:
    @pytest.mark.parametrize(
        "raw, expected",
        [("Garlic", "garlic"), ("  red   onion ", "red onion"), ("OLIVE\tOIL", "olive oil"), ("", "")],
    )
    def test_name(self, raw, expected):
        assert normalise_name(raw) == expected

    @pytest.mark.parametrize(
        "unit, qty, expected",
        [
            ("kg", Decimal("1.5"), ("g", Decimal("1500"))),
            ("KG", Decimal(1), ("g", Decimal(1000))),
            (" grams ", Decimal(5), ("g", Decimal(5))),
            ("l", Decimal("0.5"), ("ml", Decimal("500.0"))),
            ("Litres", Decimal(2), ("ml", Decimal(2000))),
            ("tbsp", Decimal(2), ("tsp", Decimal(6))),
            ("cloves", Decimal(3), ("cloves", Decimal(3))),  # unknown units pass through, lower-cased
            ("", Decimal(2), ("", Decimal(2))),
            (None, Decimal(2), ("", Decimal(2))),
            ("kg", None, ("g", None)),  # unit still normalised when there's no quantity
        ],
    )
    def test_unit(self, unit, qty, expected):
        assert normalise_unit(unit, qty) == expected


class TestPrettyUnit:
    @pytest.mark.parametrize(
        "unit, qty, expected",
        [
            ("g", Decimal(999), ("g", Decimal(999))),
            ("g", Decimal(1000), ("kg", Decimal(1))),
            ("g", Decimal(2500), ("kg", Decimal("2.5"))),
            ("ml", Decimal(999), ("ml", Decimal(999))),
            ("ml", Decimal(1000), ("l", Decimal(1))),
            ("tsp", Decimal(2), ("tsp", Decimal(2))),  # below a tablespoon
            ("tsp", Decimal(3), ("tbsp", Decimal(1))),
            ("tsp", Decimal(4), ("tsp", Decimal(4))),  # not a whole number of tablespoons
            ("tsp", Decimal(18), ("tbsp", Decimal(6))),
            ("cloves", Decimal(7), ("cloves", Decimal(7))),
            ("g", None, ("g", None)),
        ],
    )
    def test_scaling(self, unit, qty, expected):
        assert pretty_unit(unit, qty) == expected


class TestCombine:
    def test_empty(self):
        assert combine([]) == []

    def test_sums_same_name_and_unit_family(self):
        out = combine(
            [
                {"name": "Flour", "quantity": 600, "unit": "g", "recipes": ["A"]},
                {"name": "flour ", "quantity": "0.5", "unit": "kg", "recipes": ["B"]},
            ]
        )
        assert out == [{"name": "Flour", "quantity": Decimal("1.1"), "unit": "kg", "recipes": ["A", "B"]}]

    def test_different_unit_families_stay_separate(self):
        out = combine([{"name": "Milk", "quantity": 1, "unit": "l"}, {"name": "Milk", "quantity": 2, "unit": "cups"}])
        assert [(i["quantity"], i["unit"]) for i in out] == [(Decimal(1), "l"), (Decimal(2), "cups")]

    def test_unknown_quantity_does_not_affect_total(self):
        out = combine([{"name": "Salt", "quantity": None, "unit": ""}, {"name": "salt", "quantity": 1, "unit": ""}])
        assert out[0]["quantity"] == Decimal(1)

    def test_all_unknown_quantities_stay_none(self):
        out = combine([{"name": "Salt", "unit": ""}, {"name": "salt", "unit": ""}])
        assert out == [{"name": "Salt", "quantity": None, "unit": "", "recipes": []}]

    def test_zero_quantity_is_kept_not_treated_as_unknown(self):
        assert combine([{"name": "Ice", "quantity": 0, "unit": "g"}])[0]["quantity"] == Decimal(0)

    def test_skips_blank_and_missing_names(self):
        assert combine([{"name": "  ", "quantity": 1}, {"quantity": 2}, {"name": None}]) == []

    def test_first_spelling_wins_and_recipes_deduplicated(self):
        out = combine(
            [
                {"name": "Garlic", "quantity": 1, "unit": "cloves", "recipes": ["A", "B"]},
                {"name": "GARLIC", "quantity": 2, "unit": "Cloves", "recipes": ["B", "C"]},
            ]
        )
        assert out == [{"name": "Garlic", "quantity": Decimal(3), "unit": "cloves", "recipes": ["A", "B", "C"]}]

    def test_sorted_by_normalised_name(self):
        out = combine([{"name": "banana"}, {"name": "Apple"}, {"name": "cherry"}])
        assert [i["name"] for i in out] == ["Apple", "banana", "cherry"]

    def test_float_input_does_not_leak_binary_error(self):
        out = combine([{"name": "Oil", "quantity": 0.1, "unit": "l"}, {"name": "oil", "quantity": 0.2, "unit": "l"}])
        assert out[0]["quantity"] == Decimal("300.0") and out[0]["unit"] == "ml"


class TestAggregate:
    def test_tags_each_ingredient_with_recipe_title(self):
        out = aggregate(
            [
                {"title": "Pasta", "ingredients": [{"name": "Garlic", "quantity": 3, "unit": "cloves"}]},
                {"title": "Curry", "ingredients": [{"name": "garlic", "quantity": 4, "unit": "cloves"}]},
            ]
        )
        assert out == [{"name": "Garlic", "quantity": Decimal(7), "unit": "cloves", "recipes": ["Pasta", "Curry"]}]

    def test_items_keep_the_aisle_their_ingredients_came_with(self):
        out = aggregate(
            [
                {"title": "Pasta", "ingredients": [{"name": "Garlic", "quantity": 3, "unit": "cloves"}, {"name": "Salt", "quantity": None, "unit": ""}]},
                {"title": "Curry", "ingredients": [{"name": "garlic", "quantity": 4, "unit": "cloves", "aisle": "produce"}]},
            ]
        )
        assert [(i["name"], i.get("aisle")) for i in out] == [("Garlic", "produce"), ("Salt", None)]

    def test_recipe_without_title_or_ingredients(self):
        assert aggregate([{"ingredients": [{"name": "Egg", "quantity": 2}]}, {"title": "Empty"}]) == [
            {"name": "Egg", "quantity": Decimal(2), "unit": "", "recipes": []}
        ]

    def test_tablespoons_add_up_and_display_as_tablespoons(self):
        out = aggregate(
            [
                {"title": "A", "ingredients": [{"name": "Oil", "quantity": 4, "unit": "tbsp"}]},
                {"title": "B", "ingredients": [{"name": "oil", "quantity": 2, "unit": "tbsp"}]},
            ]
        )
        assert (out[0]["quantity"], out[0]["unit"]) == (Decimal(6), "tbsp")

    def test_mixed_spoons_fall_back_to_teaspoons(self):
        out = aggregate([{"ingredients": [{"name": "Salt", "quantity": 1, "unit": "tbsp"}, {"name": "salt", "quantity": 1, "unit": "tsp"}]}])
        assert (out[0]["quantity"], out[0]["unit"]) == (Decimal(4), "tsp")
