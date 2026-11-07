// Mirrors api/src/grubgrab/aggregate.py so local mode behaves like the cloud API.
import type { Ingredient, ListItem } from '../types'

const UNIT_ALIASES: Record<string, [string, number]> = {
  g: ['g', 1], gram: ['g', 1], grams: ['g', 1], kg: ['g', 1000],
  ml: ['ml', 1], l: ['ml', 1000], litre: ['ml', 1000], litres: ['ml', 1000], liter: ['ml', 1000], liters: ['ml', 1000],
  tsp: ['tsp', 1], tbsp: ['tsp', 3],
}

export const normaliseName = (n: string) => n.trim().toLowerCase().split(/\s+/).join(' ')

export function normaliseUnit(unit: string, qty: number | null): [string, number | null] {
  const key = unit.trim().toLowerCase()
  const alias = UNIT_ALIASES[key]
  if (alias) return [alias[0], qty === null ? null : qty * alias[1]]
  return [key, qty]
}

function pretty(unit: string, qty: number | null): [string, number | null] {
  if (qty === null) return [unit, null]
  if (unit === 'g' && qty >= 1000) return ['kg', qty / 1000]
  if (unit === 'ml' && qty >= 1000) return ['l', qty / 1000]
  if (unit === 'tsp' && qty >= 3 && qty % 3 === 0) return ['tbsp', qty / 3]
  return [unit, qty]
}

const round = (n: number) => Math.round(n * 1000) / 1000

export type Aggregated = Omit<ListItem, 'id' | 'checked'>

export function aggregate(recipes: { title?: string; ingredients: Ingredient[] }[]): Aggregated[] {
  const merged = new Map<string, Aggregated>()
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      const name = ing.name.trim()
      if (!name) continue
      const [unit, qty] = normaliseUnit(ing.unit ?? '', ing.quantity)
      const key = `${normaliseName(name)}|${unit}`
      const entry = merged.get(key) ?? { name, quantity: null, unit, recipes: [] }
      if (qty !== null) entry.quantity = (entry.quantity ?? 0) + qty
      if (r.title && !entry.recipes.includes(r.title)) entry.recipes.push(r.title)
      merged.set(key, entry)
    }
  }
  return [...merged.values()]
    .map((e) => {
      const [unit, qty] = pretty(e.unit, e.quantity)
      return { ...e, unit, quantity: qty === null ? null : round(qty) }
    })
    .sort((a, b) => normaliseName(a.name).localeCompare(normaliseName(b.name)))
}

export function formatQty(item: { quantity: number | null; unit: string }): string {
  if (item.quantity === null) return item.unit
  const q = Number.isInteger(item.quantity) ? String(item.quantity) : String(round(item.quantity))
  return item.unit ? `${q} ${item.unit}` : q
}

/** Parse a pasted line like "500 g spaghetti", "2 onions", "1.5 tbsp olive oil", "salt". */
export function parseIngredientLine(line: string): Ingredient | null {
  const text = line.replace(/^[-*•\s]+/, '').trim()
  if (!text) return null
  const m = text.match(/^(\d+(?:[.,]\d+)?|\d+\/\d+)\s*([a-zA-Z]+\b)?\s*(.*)$/)
  if (!m) return { name: text, quantity: null, unit: '' }
  let qty: number
  if (m[1].includes('/')) {
    const [a, b] = m[1].split('/').map(Number)
    qty = a / b
  } else qty = Number(m[1].replace(',', '.'))
  const word = m[2] ?? ''
  const known = word.toLowerCase() in UNIT_ALIASES || ['cloves', 'clove', 'cup', 'cups', 'tin', 'tins', 'can', 'cans', 'pinch', 'bunch', 'pack', 'packs'].includes(word.toLowerCase())
  if (known) return { name: m[3].trim() || word, quantity: qty, unit: word.toLowerCase() }
  return { name: `${word} ${m[3]}`.trim(), quantity: qty, unit: '' }
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
