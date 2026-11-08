"""Combine ingredients from several recipes into one shopping list."""

from __future__ import annotations

from decimal import Decimal
from typing import Iterable

# Units that can be folded into a common base unit, with their factor.
_UNIT_ALIASES: dict[str, tuple[str, Decimal]] = {
    "g": ("g", Decimal(1)),
    "gram": ("g", Decimal(1)),
    "grams": ("g", Decimal(1)),
    "kg": ("g", Decimal(1000)),
    "ml": ("ml", Decimal(1)),
    "l": ("ml", Decimal(1000)),
    "litre": ("ml", Decimal(1000)),
    "litres": ("ml", Decimal(1000)),
    "liter": ("ml", Decimal(1000)),
    "liters": ("ml", Decimal(1000)),
    "tsp": ("tsp", Decimal(1)),
    "tbsp": ("tsp", Decimal(3)),
}


def normalise_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def normalise_unit(unit: str | None, quantity: Decimal | None) -> tuple[str, Decimal | None]:
    """Convert to a base unit (kg -> g, tbsp -> tsp). Unknown units are just lower-cased."""
    key = (unit or "").strip().lower()
    if key in _UNIT_ALIASES:
        base, factor = _UNIT_ALIASES[key]
        return base, (quantity * factor if quantity is not None else None)
    return key, quantity


def pretty_unit(unit: str, quantity: Decimal | None) -> tuple[str, Decimal | None]:
    """Scale base units back up for display (2500 g -> 2.5 kg, 6 tsp -> 2 tbsp)."""
    if quantity is None:
        return unit, None
    if unit == "g" and quantity >= 1000:
        return "kg", quantity / 1000
    if unit == "ml" and quantity >= 1000:
        return "l", quantity / 1000
    if unit == "tsp" and quantity >= 3 and quantity % 3 == 0:
        return "tbsp", quantity / 3
    return unit, quantity


def combine(entries: Iterable[dict]) -> list[dict]:
    """Merge entries ({name, quantity, unit, recipes}) that share a name and unit family.

    Known quantities are summed; an entry with no quantity ("salt") adds nothing to the total.
    The first spelling of a name wins. Output is sorted by name.
    """
    merged: dict[tuple[str, str], dict] = {}
    for entry in entries:
        name = (entry.get("name") or "").strip()
        if not name:
            continue
        qty = entry.get("quantity")
        qty = None if qty is None else Decimal(str(qty))
        unit, qty = normalise_unit(entry.get("unit"), qty)
        out = merged.setdefault((normalise_name(name), unit), {"name": name, "quantity": None, "unit": unit, "recipes": []})
        if qty is not None:
            out["quantity"] = (out["quantity"] or Decimal(0)) + qty
        for title in entry.get("recipes") or []:
            if title not in out["recipes"]:
                out["recipes"].append(title)

    result = []
    for out in merged.values():
        unit, qty = pretty_unit(out["unit"], out["quantity"])
        result.append({**out, "unit": unit, "quantity": qty})
    return sorted(result, key=lambda i: normalise_name(i["name"]))


def aggregate(recipes: Iterable[dict]) -> list[dict]:
    """Flatten recipes' ingredients (tagged with the recipe title) and combine them."""
    return combine(
        {**ing, "recipes": [r["title"]] if r.get("title") else []}
        for r in recipes
        for ing in r.get("ingredients", [])
    )
