// Shop aisles for grouping the shopping list. "Fill from link" gives each ingredient its aisle (the AI
// reads it off the recipe), recipes keep it, and list items carry it. Anything else (typed recipes, items
// added by hand) starts in "other" until someone moves it; the household then remembers where it goes.

/** In the order most shops are walked. Same codes as AISLES in api/src/grubgrab/aisles.py (a test checks). */
export const AISLES = ['produce', 'bakery', 'meat', 'dairy', 'pantry', 'spices', 'frozen', 'drinks', 'household', 'other'] as const
export type Aisle = (typeof AISLES)[number]

/** Where a household has moved items: {item name (see aisleKey): aisle}. */
export type RememberedAisles = Record<string, string>

/** The key a remembered aisle is stored under: the name in lower case with single spaces (as the API does). */
export const aisleKey = (name: string) => name.trim().toLowerCase().split(/\s+/).join(' ')

const isAisle = (value: unknown): value is Aisle => AISLES.includes(value as Aisle)

/** Where the household put this item before, else the aisle it came with, else "other". */
export function aisleOf(item: { name: string; aisle?: string }, remembered: RememberedAisles = {}): Aisle {
  const chosen = remembered[aisleKey(item.name)]
  if (isAisle(chosen)) return chosen
  return isAisle(item.aisle) ? item.aisle : 'other'
}

/** Items grouped by aisle in walking order; empty aisles are left out, and each group keeps the items' order. */
export function byAisle<T extends { name: string; aisle?: string }>(items: T[], remembered: RememberedAisles = {}) {
  const groups = new Map<Aisle, T[]>(AISLES.map((a) => [a, []]))
  for (const item of items) groups.get(aisleOf(item, remembered))!.push(item)
  return AISLES.filter((a) => groups.get(a)!.length).map((aisle) => ({ aisle, items: groups.get(aisle)! }))
}
