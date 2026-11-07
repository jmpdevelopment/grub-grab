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
    key = (unit or "").strip().lower()
    if key in _UNIT_ALIASES:
        base, factor = _UNIT_ALIASES[key]
        return base, (quantity * factor if quantity is not None else None)
    return key, quantity


def _pretty(unit: str, quantity: Decimal | None) -> tuple[str, Decimal | None]:
    """Scale base units back up when large (2500 g -> 2.5 kg)."""
    if quantity is None:
        return unit, None
    if unit == "g" and quantity >= 1000:
        return "kg", quantity / 1000
    if unit == "ml" and quantity >= 1000:
        return "l", quantity / 1000
    if unit == "tsp" and quantity >= 3 and quantity % 3 == 0:
        return "tbsp", quantity / 3
    return unit, quantity


def aggregate(recipes: Iterable[dict]) -> list[dict]:
    """Merge ingredients by (name, unit). Quantities are summed where known.

    Each returned item has: name, quantity (Decimal | None), unit, recipes (list of titles).
    """
    merged: dict[tuple[str, str], dict] = {}
    for recipe in recipes:
        title = recipe.get("title", "")
        for ing in recipe.get("ingredients", []):
            raw_name = (ing.get("name") or "").strip()
            if not raw_name:
                continue
            qty = ing.get("quantity")
            qty = Decimal(str(qty)) if qty not in (None, "") else None
            unit, qty = normalise_unit(ing.get("unit"), qty)
            key = (normalise_name(raw_name), unit)
            entry = merged.setdefault(
                key,
                {"name": raw_name, "quantity": None, "unit": unit, "recipes": [], "_unknown": False},
            )
            if qty is None:
                entry["_unknown"] = True
            else:
                entry["quantity"] = (entry["quantity"] or Decimal(0)) + qty
            if title and title not in entry["recipes"]:
                entry["recipes"].append(title)

    out = []
    for entry in merged.values():
        unit, qty = _pretty(entry["unit"], entry["quantity"])
        out.append({"name": entry["name"], "quantity": qty, "unit": unit, "recipes": entry["recipes"]})
    out.sort(key=lambda i: normalise_name(i["name"]))
    return out
