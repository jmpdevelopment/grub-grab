"""The shop aisles the shopping list is grouped by. "Fill from link" asks the AI for each ingredient's aisle,
recipes keep it, and list items carry it. Anything else starts in "other" until someone moves it; the
household then remembers where that item goes."""

# Same codes, in the same order, as AISLES in web/src/lib/aisles.ts (a test checks).
AISLES = ("produce", "bakery", "meat", "dairy", "pantry", "spices", "frozen", "drinks", "household", "other")
MAX_REMEMBERED = 500  # item names per household; a few hundred covers any family's shopping
