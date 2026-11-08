// What someone changed in an AI-filled recipe before saving or reporting it. Drives the pre-ticked choices
// in a problem report (most people fix the recipe first) and the counts in an import's outcome.
import type { Ingredient } from '../types'
import { normaliseName } from './aggregate'

export interface RecipeShape {
  title: string
  servings: number | null
  tags: string[]
  ingredients: Ingredient[]
}

export interface ImportChanges {
  title: boolean
  servings: boolean
  tagsAdded: string[]
  tagsRemoved: string[]
  added: string[] // ingredients the AI missed
  removed: string[] // ingredients the AI added that weren't wanted
  renamed: { from: string; to: string }[]
  amounts: string[] // quantity changed (by the AI's name)
  units: string[] // unit changed
}

/** Compare the form as the AI filled it (`draft`) with how it is now (`now`). */
export function compareToDraft(draft: RecipeShape, now: RecipeShape): ImportChanges {
  const left = [...now.ingredients]
  const unmatched: Ingredient[] = []
  const amounts: string[] = []
  const units: string[] = []
  for (const d of draft.ingredients) {
    const i = left.findIndex((n) => normaliseName(n.name) === normaliseName(d.name))
    if (i < 0) {
      unmatched.push(d)
      continue
    }
    const [n] = left.splice(i, 1)
    if (n.quantity !== d.quantity) amounts.push(d.name)
    if (n.unit.trim().toLowerCase() !== d.unit.trim().toLowerCase()) units.push(d.name)
  }
  // What's left on both sides lines up in order: a changed name. The rest was removed or added.
  const pairs = Math.min(unmatched.length, left.length)
  const tags = (list: string[]) => new Set(list.map((t) => t.toLowerCase()))
  const [before, after] = [tags(draft.tags), tags(now.tags)]
  return {
    title: draft.title.trim() !== now.title.trim(),
    servings: draft.servings !== now.servings,
    tagsAdded: [...after].filter((t) => !before.has(t)),
    tagsRemoved: [...before].filter((t) => !after.has(t)),
    renamed: unmatched.slice(0, pairs).map((d, k) => ({ from: d.name, to: left[k].name })),
    removed: unmatched.slice(pairs).map((d) => d.name),
    added: left.slice(pairs).map((n) => n.name),
    amounts,
    units,
  }
}

/** How much changed, as counts only (an import's outcome stores no ingredient names). */
export function changeCounts(c: ImportChanges): Record<string, number> {
  const counts = {
    title: Number(c.title),
    servings: Number(c.servings),
    tagsAdded: c.tagsAdded.length,
    tagsRemoved: c.tagsRemoved.length,
    added: c.added.length,
    removed: c.removed.length,
    renamed: c.renamed.length,
    amounts: c.amounts.length,
    units: c.units.length,
  }
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0))
}

export const anyChanges = (c: ImportChanges) => Object.keys(changeCounts(c)).length > 0

/** The report choices these changes point to (see PROBLEMS in components/FeedbackSheet). */
export function suggestedProblems(c: ImportChanges): string[] {
  const picks: [boolean, string][] = [
    [c.added.length > 0, 'missing'],
    [c.removed.length > 0, 'extra'],
    [c.amounts.length + c.units.length > 0, 'amounts'],
    [c.renamed.length > 0, 'names'],
    [c.tagsAdded.length + c.tagsRemoved.length > 0, 'tags'],
    [c.title || c.servings, 'title'],
  ]
  return picks.filter(([yes]) => yes).map(([, p]) => p)
}

/** The AI's ingredients that were changed or removed: pre-marked as wrong in a report. */
export function touchedIngredients(c: ImportChanges): string[] {
  return [...new Set([...c.amounts, ...c.units, ...c.renamed.map((r) => r.from), ...c.removed])]
}
