import { describe, expect, it } from 'vitest'
import { anyChanges, changeCounts, compareToDraft, suggestedProblems, touchedIngredients, type RecipeShape } from './importChanges'

const DRAFT: RecipeShape = {
  title: 'Curry',
  servings: 4,
  tags: ['chicken'],
  ingredients: [
    { name: 'chicken thighs', quantity: 6, unit: '' },
    { name: 'onion', quantity: 1, unit: '' },
    { name: 'garam masala', quantity: 2, unit: 'tsp' },
    { name: 'parsley', quantity: null, unit: '' },
  ],
}

describe('compareToDraft', () => {
  it('nothing changed', () => {
    const same = compareToDraft(DRAFT, { ...DRAFT, title: ' Curry ', tags: ['Chicken'], ingredients: [...DRAFT.ingredients].reverse() })
    expect(anyChanges(same)).toBe(false)
    expect(changeCounts(same)).toEqual({})
    expect(suggestedProblems(same)).toEqual([])
  })

  it('sees what was fixed', () => {
    const now: RecipeShape = {
      title: 'Chicken curry',
      servings: 2,
      tags: ['chicken', 'quick'],
      ingredients: [
        { name: 'Chicken thighs', quantity: 8, unit: '' }, // amount
        { name: 'red onion', quantity: 1, unit: '' }, // renamed from onion
        { name: 'garam masala', quantity: 2, unit: 'tbsp' }, // unit
        { name: 'rice', quantity: 300, unit: 'g' }, // parsley's place: counted as a rename
        { name: 'yoghurt', quantity: null, unit: '' }, // the AI missed it
      ],
    }
    const c = compareToDraft(DRAFT, now)
    expect(c).toEqual({
      title: true,
      servings: true,
      tagsAdded: ['quick'],
      tagsRemoved: [],
      renamed: [
        { from: 'onion', to: 'red onion' },
        { from: 'parsley', to: 'rice' },
      ],
      removed: [],
      added: ['yoghurt'],
      amounts: ['chicken thighs'],
      units: ['garam masala'],
    })
    expect(changeCounts(c)).toEqual({ title: 1, servings: 1, tagsAdded: 1, added: 1, renamed: 2, amounts: 1, units: 1 })
    expect(suggestedProblems(c)).toEqual(['missing', 'amounts', 'names', 'tags', 'title'])
    expect(touchedIngredients(c)).toEqual(['chicken thighs', 'garam masala', 'onion', 'parsley'])
  })

  it('removed ingredients and tags', () => {
    const c = compareToDraft(DRAFT, { ...DRAFT, tags: [], ingredients: DRAFT.ingredients.slice(0, 2) })
    expect(c.removed).toEqual(['garam masala', 'parsley'])
    expect(c.tagsRemoved).toEqual(['chicken'])
    expect(suggestedProblems(c)).toEqual(['extra', 'tags'])
    expect(changeCounts(c)).toEqual({ tagsRemoved: 1, removed: 2 })
  })
})
