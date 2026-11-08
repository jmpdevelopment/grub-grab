"""Provider-neutral pieces of "fill a recipe from a link": the task, the answer's shape, and its checks.

Every AI provider adapter (see providers in __init__.py) sends RECIPE_INSTRUCTIONS and asks for an answer
matching RECIPE_SCHEMA, then hands the parsed JSON to to_draft(). Nothing here knows which provider ran.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from ..aisles import AISLES

RECIPE_INSTRUCTIONS = """\
You read a recipe web page and turn it into a shopping-friendly recipe for a household recipe app.

Fetch the page at the link the user gives, then fill in the answer:
- found: false if the page has no recipe (or could not be read); then leave the other fields empty.
- Write the title, ingredient names and tags in the language the request asks for, translating from the
  page's language when they differ.
- title: the dish's name, short and natural (e.g. "Zurek soup", "Chicken curry").
- servings: the number of servings or portions if the page states one, otherwise null.
- ingredients: every ingredient the cook needs to buy or have, in the page's order, once each.
  - name: the ingredient, singular or plural as a shopper would say it, without the amount
    (e.g. "potatoes", "olive oil", "garlic"). Keep a short qualifier only when it matters when shopping
    (e.g. "smoked paprika", "chicken thighs").
  - quantity: a number, converting fractions to decimals ("1/2" -> 0.5, "1 1/2" -> 1.5). If a range is
    given, use the larger number. null when there is no amount ("salt to taste", "oil for frying").
  - unit: always write g, kg, ml, l, tsp and tbsp as exactly these codes, in every language (the app adds
    amounts up by them): convert spoon and cup measures to them (a Polish "łyżka" or Lithuanian "šaukštas"
    is tbsp, "łyżeczka" or "šaukštelis" is tsp, a glass/"szklanka"/"stiklinė" is about 250 ml). Other units
    (cloves, cans, a pinch, a bunch) are short words in the requested language. Use "" for countable items
    ("2 onions" -> quantity 2, unit "").
  - aisle: where a shopper finds it in a supermarket, one of: produce (fruit, vegetables, fresh herbs),
    bakery (bread, rolls, wraps), meat (meat, poultry, fish, seafood, cold cuts), dairy (milk, butter, cream,
    cheese, yoghurt, eggs), pantry (pasta, rice, grains, flour, sugar, tins, jars, nuts, stock, baking),
    spices (salt, pepper, dried herbs and spices, oils, vinegar, sauces, condiments), frozen, drinks
    (juice, wine, beer, coffee, tea), household (non-food), other (when none fits).
  - Do not invent ingredients that are not on the page, and skip equipment, garnish suggestions and
    serving ideas that are not part of the recipe.
- tags: 1 to 4 short lower-case labels for finding the recipe later: its main ingredient (meat, chicken,
  fish or vegetarian) and, when one fits, the kind of dish (soup, pasta, salad, stir fry, wraps, ...).
  Prefer the household's existing tags, listed with the link, over new words for the same thing; only
  add a new tag, in the requested language, when none of them fits.
"""

# The app's languages (web/src/i18n/languages.ts) and the starter tags for a household with none yet,
# matching "tags.suggested" in web/src/i18n/locales.
LANGUAGES = {"en": "English", "pl": "Polish", "lt": "Lithuanian"}
SUGGESTED_TAGS = {
    "en": ["meat", "chicken", "fish", "vegetarian", "soup", "pasta", "salad", "quick"],
    "pl": ["mięso", "kurczak", "ryba", "wegetariańskie", "zupa", "makaron", "sałatka", "szybkie"],
    "lt": ["mėsa", "vištiena", "žuvis", "vegetariška", "sriuba", "makaronai", "salotos", "greita"],
}
_MAX_TAGS = 5
_MAX_KNOWN_TAGS = 50


def language(code) -> str:
    """The import language: one of LANGUAGES, English if missing or unknown."""
    return code if code in LANGUAGES else "en"


def request_text(link: str, known_tags: list[str], lang: str = "en") -> str:
    """The user turn every provider sends: the link, the language to write in, and the household's tags."""
    lang = language(lang)
    tags = sorted({t for t in known_tags if t})[:_MAX_KNOWN_TAGS] or SUGGESTED_TAGS[lang]
    return f"Recipe page: {link}\nWrite the recipe in: {LANGUAGES[lang]}\nThe household's existing tags: {', '.join(tags)}"

RECIPE_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["found", "title", "servings", "ingredients", "tags"],
    "properties": {
        "found": {"type": "boolean"},
        "title": {"type": "string"},
        "servings": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "quantity", "unit", "aisle"],
                "properties": {
                    "name": {"type": "string"},
                    "quantity": {"anyOf": [{"type": "number"}, {"type": "null"}]},
                    "unit": {"type": "string"},
                    "aisle": {"type": "string", "enum": list(AISLES)},
                },
            },
        },
        "tags": {"type": "array", "items": {"type": "string"}},
    },
}


class ExtractionError(Exception):
    """Something the person should be told, e.g. the page has no recipe. `code` lets the app show it in the
    person's language ("error.<code>" in web/src/i18n/locales); the message is the English text."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


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
        raise ExtractionError("no_recipe", "Couldn't find a recipe on that page.")
    ingredients = []
    for raw in answer.get("ingredients") or []:
        if not isinstance(raw, dict) or not _text(raw.get("name")):
            continue
        aisle = raw.get("aisle") if raw.get("aisle") in AISLES else "other"
        ingredients.append({"name": _text(raw.get("name")), "quantity": _quantity(raw.get("quantity")), "unit": _text(raw.get("unit"), 20), "aisle": aisle})
        if len(ingredients) == _MAX_INGREDIENTS:
            break
    if not ingredients:
        raise ExtractionError("no_ingredients", "Couldn't find any ingredients on that page.")
    tags: list[str] = []
    for raw in answer.get("tags") or []:
        tag = _text(raw, 30).lower()
        if tag and tag not in tags:
            tags.append(tag)
    servings = answer.get("servings")
    valid_servings = isinstance(servings, int) and not isinstance(servings, bool) and 1 <= servings <= 1000
    return {
        "title": _text(answer.get("title")) or "Untitled recipe",
        "servings": servings if valid_servings else None,
        "link": link,
        "tags": tags[:_MAX_TAGS],
        "ingredients": ingredients,
    }
