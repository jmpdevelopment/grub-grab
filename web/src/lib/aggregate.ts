// Mirrors api/src/grubgrab/aggregate.py so local mode behaves like the cloud API.
import type { Ingredient, ListItem } from '../types'

const UNIT_ALIASES = new Map<string, [string, number]>([
  ['g', ['g', 1]], ['gram', ['g', 1]], ['grams', ['g', 1]], ['kg', ['g', 1000]],
  ['ml', ['ml', 1]], ['l', ['ml', 1000]], ['litre', ['ml', 1000]], ['litres', ['ml', 1000]],
  ['liter', ['ml', 1000]], ['liters', ['ml', 1000]],
  ['tsp', ['tsp', 1]], ['tbsp', ['tsp', 3]],
])

// Words the paste parser treats as units even though they don't convert.
const COUNT_UNITS = new Set(['clove', 'cloves', 'cup', 'cups', 'tin', 'tins', 'can', 'cans', 'pinch', 'bunch', 'pack', 'packs'])

/** Round away float noise (0.1 + 0.2) without losing real precision. */
export const round = (n: number) => Math.round(n * 1000) / 1000

export const normaliseName = (n: string) => n.trim().toLowerCase().split(/\s+/).join(' ')

export function normaliseUnit(unit: string | null | undefined, qty: number | null): [string, number | null] {
  const key = (unit ?? '').trim().toLowerCase()
  const alias = UNIT_ALIASES.get(key)
  if (alias) return [alias[0], qty === null ? null : qty * alias[1]]
  return [key, qty]
}

export function prettyUnit(unit: string, qty: number | null): [string, number | null] {
  if (qty === null) return [unit, null]
  if (unit === 'g' && qty >= 1000) return ['kg', qty / 1000]
  if (unit === 'ml' && qty >= 1000) return ['l', qty / 1000]
  if (unit === 'tsp' && qty >= 3 && qty % 3 === 0) return ['tbsp', qty / 3]
  return [unit, qty]
}

export type Aggregated = Omit<ListItem, 'id' | 'checked'>
type Entry = { name?: string | null; quantity?: number | null; unit?: string | null; recipes?: string[]; aisle?: string }

/** Merge entries sharing a name and unit family; known quantities are summed, the first aisle given is kept.
 * Sorted by name. */
export function combine(entries: Entry[]): Aggregated[] {
  const merged = new Map<string, Aggregated>()
  for (const e of entries) {
    const name = (e.name ?? '').trim()
    if (!name) continue
    const [unit, qty] = normaliseUnit(e.unit, e.quantity ?? null)
    const key = `${normaliseName(name)}|${unit}`
    const out = merged.get(key) ?? { name, quantity: null, unit, recipes: [] }
    if (qty !== null) out.quantity = (out.quantity ?? 0) + qty
    if (!out.aisle && e.aisle) out.aisle = e.aisle
    for (const title of e.recipes ?? []) if (!out.recipes.includes(title)) out.recipes.push(title)
    merged.set(key, out)
  }
  return [...merged.values()]
    .map((out) => {
      const [unit, qty] = prettyUnit(out.unit, out.quantity)
      return { ...out, unit, quantity: qty === null ? null : round(qty) }
    })
    .sort((a, b) => normaliseName(a.name).localeCompare(normaliseName(b.name)))
}

/** Flatten recipes' ingredients (tagged with the recipe title) and combine them. */
export function aggregate(recipes: { title?: string; ingredients?: Ingredient[] }[]): Aggregated[] {
  return combine(
    recipes.flatMap((r) => (r.ingredients ?? []).map((ing) => ({ ...ing, recipes: r.title ? [r.title] : [] }))),
  )
}

export function formatQty(item: { quantity: number | null; unit: string }): string {
  if (item.quantity === null) return item.unit
  const q = String(round(item.quantity))
  return item.unit ? `${q} ${item.unit}` : q
}

function parseNumber(raw: string): number | null {
  const mixed = raw.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) {
    const [, whole, a, b] = mixed.map(Number)
    return b === 0 ? null : whole + a / b
  }
  if (raw.includes('/')) {
    const [a, b] = raw.split('/').map(Number)
    return b === 0 ? null : a / b
  }
  return Number(raw.replace(',', '.'))
}

/** Parse a pasted line like "500 g spaghetti", "1 1/2 cups flour", "2 onions", "salt". */
export function parseIngredientLine(line: string): Ingredient | null {
  const text = line.replace(/^[-*•\s]+/, '').trim()
  if (!text) return null
  const m = text.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s*([a-zA-Z]+\b)?\s*(.*)$/)
  if (!m) return { name: text, quantity: null, unit: '' }
  const qty = parseNumber(m[1])
  if (qty === null) return { name: text, quantity: null, unit: '' }
  const word = m[2] ?? ''
  const rest = m[3].trim()
  const isUnit = UNIT_ALIASES.has(word.toLowerCase()) || COUNT_UNITS.has(word.toLowerCase())
  if (isUnit && rest) return { name: rest, quantity: qty, unit: word.toLowerCase() }
  const name = `${word} ${rest}`.trim()
  // A bare number ("4") isn't an ingredient; keep the text so nothing is lost.
  return name ? { name, quantity: qty, unit: '' } : { name: text, quantity: null, unit: '' }
}

export function listAsText(items: ListItem[]): string {
  return items
    .filter((i) => !i.checked)
    .map((i) => {
      const q = formatQty(i)
      return q ? `- ${i.name} (${q})` : `- ${i.name}`
    })
    .join('\n')
}
