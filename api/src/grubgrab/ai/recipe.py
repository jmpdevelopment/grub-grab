"""Provider-neutral pieces of "fill a recipe from a link": the task, the answer's shape, and its checks.

Every AI provider adapter (see providers in __init__.py) sends RECIPE_INSTRUCTIONS and asks for an answer
matching RECIPE_SCHEMA, then hands the parsed JSON to to_draft(). Nothing here knows which provider ran.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

RECIPE_INSTRUCTIONS = """\
You read a recipe web page and turn it into a shopping-friendly recipe for a household recipe app.

Fetch the page at the link the user gives, then fill in the answer:
- found: false if the page has no recipe (or could not be read); then leave the other fields empty.
- title: the dish's name in English, short and natural (e.g. "Zurek soup", "Chicken curry").
- servings: the number of servings or portions if the page states one, otherwise null.
- ingredients: every ingredient the cook needs to buy or have, in the page's order, once each.
  - name: the ingredient in English, singular or plural as a shopper would say it, without the amount
    (e.g. "potatoes", "olive oil", "garlic"). Keep a short qualifier only when it matters when shopping
    (e.g. "smoked paprika", "chicken thighs").
  - quantity: a number, converting fractions to decimals ("1/2" -> 0.5, "1 1/2" -> 1.5). If a range is
    given, use the larger number. null when there is no amount ("salt to taste", "oil for frying").
  - unit: one of g, kg, ml, l, tsp, tbsp, cloves, cans, pinch, bunch, or "" for countable items
    ("2 onions" -> quantity 2, unit ""). Convert spoon and cup measures in other languages to these
    (a Polish "łyżka" is tbsp, "łyżeczka" is tsp, "szklanka" is a glass of about 250 ml).
  - Translate from the page's language into English. Do not invent ingredients that are not on the page,
    and skip equipment, garnish suggestions and serving ideas that are not part of the recipe.
"""

RECIPE_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["found", "title", "servings", "ingredients"],
    "properties": {
        "found": {"type": "boolean"},
        "title": {"type": "string"},
        "servings": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "quantity", "unit"],
                "properties": {
                    "name": {"type": "string"},
                    "quantity": {"anyOf": [{"type": "number"}, {"type": "null"}]},
                    "unit": {"type": "string"},
                },
            },
        },
    },
}


class ExtractionError(Exception):
    """Something the person should be told, e.g. the page has no recipe. The message is shown in the app."""


# Defensive limits: the app's own validation applies too, but an AI answer is never trusted blindly.
_MAX_INGREDIENTS = 200
_MAX_TEXT = 200


def _quantity(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        q = Decimal(str(value))
    except InvalidOperation:
        return None
    if not q.is_finite() or q < 0 or q > 1_000_000:
        return None
    return float(round(q, 3))


def _text(value, limit: int = _MAX_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def to_draft(answer: dict, link: str) -> dict:
    """Check and tidy a provider's answer into a recipe draft for the editor (never saved by itself)."""
    if not isinstance(answer, dict) or not answer.get("found"):
        raise ExtractionError("Couldn't find a recipe on that page.")
    ingredients = []
    for raw in answer.get("ingredients") or []:
        if not isinstance(raw, dict) or not _text(raw.get("name")):
            continue
        ingredients.append({"name": _text(raw.get("name")), "quantity": _quantity(raw.get("quantity")), "unit": _text(raw.get("unit"), 20)})
        if len(ingredients) == _MAX_INGREDIENTS:
            break
    if not ingredients:
        raise ExtractionError("Couldn't find any ingredients on that page.")
    servings = answer.get("servings")
    valid_servings = isinstance(servings, int) and not isinstance(servings, bool) and 1 <= servings <= 1000
    return {
        "title": _text(answer.get("title")) or "Untitled recipe",
        "servings": servings if valid_servings else None,
        "link": link,
        "ingredients": ingredients,
    }
