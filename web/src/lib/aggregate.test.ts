import { describe, expect, it } from 'vitest'
import {
  aggregate,
  combine,
  formatQty,
  listAsText,
  normaliseName,
  normaliseUnit,
  parseIngredientLine,
  prettyUnit,
  round,
} from './aggregate'

describe('normaliseName', () => {
  it.each([
    ['Garlic', 'garlic'],
    ['  red   onion ', 'red onion'],
    ['OLIVE\tOIL', 'olive oil'],
    ['', ''],
  ])('%j -> %j', (raw, expected) => expect(normaliseName(raw)).toBe(expected))
})

describe('normaliseUnit', () => {
  it.each([
    ['kg', 1.5, ['g', 1500]],
    [' Litres ', 2, ['ml', 2000]],
    ['tbsp', 2, ['tsp', 6]],
    ['cloves', 3, ['cloves', 3]],
    ['', 2, ['', 2]],
    [null, 2, ['', 2]],
    [undefined, 2, ['', 2]],
    ['kg', null, ['g', null]],
    // Object prototype names must not be mistaken for units.
    ['constructor', 2, ['constructor', 2]],
    ['toString', 1, ['tostring', 1]],
  ] as const)('%j %j', (unit, qty, expected) => expect(normaliseUnit(unit, qty)).toEqual(expected))
})

describe('prettyUnit', () => {
  it.each([
    ['g', 999, ['g', 999]],
    ['g', 1000, ['kg', 1]],
    ['ml', 999, ['ml', 999]],
    ['ml', 2500, ['l', 2.5]],
    ['tsp', 2, ['tsp', 2]],
    ['tsp', 3, ['tbsp', 1]],
    ['tsp', 4, ['tsp', 4]],
    ['tsp', 18, ['tbsp', 6]],
    ['cloves', 7, ['cloves', 7]],
    ['g', null, ['g', null]],
  ] as const)('%s %s', (unit, qty, expected) => expect(prettyUnit(unit, qty)).toEqual(expected))
})

describe('round', () => {
  it('removes float noise but keeps 3 decimals', () => {
    expect(round(0.1 + 0.2)).toBe(0.3)
    expect(round(1.2345)).toBe(1.235)
  })
})

describe('combine', () => {
  it('returns nothing for no input', () => expect(combine([])).toEqual([]))

  it('sums the same name across unit families it can convert', () => {
    expect(
      combine([
        { name: 'Flour', quantity: 600, unit: 'g', recipes: ['A'] },
        { name: 'flour ', quantity: 0.5, unit: 'kg', recipes: ['B'] },
      ]),
    ).toEqual([{ name: 'Flour', quantity: 1.1, unit: 'kg', recipes: ['A', 'B'] }])
  })

  it('keeps unconvertible units apart', () => {
    const out = combine([
      { name: 'Milk', quantity: 1, unit: 'l' },
      { name: 'Milk', quantity: 2, unit: 'cups' },
    ])
    expect(out.map((i) => [i.quantity, i.unit])).toEqual([
      [1, 'l'],
      [2, 'cups'],
    ])
  })

  it('ignores unknown quantities in the total, but keeps zero', () => {
    expect(combine([{ name: 'Salt', quantity: null }, { name: 'salt', quantity: 1 }])[0].quantity).toBe(1)
    expect(combine([{ name: 'Salt' }, { name: 'salt' }])[0].quantity).toBeNull()
    expect(combine([{ name: 'Ice', quantity: 0, unit: 'g' }])[0].quantity).toBe(0)
  })

  it('skips blank names', () => {
    expect(combine([{ name: '  ', quantity: 1 }, { quantity: 2 }, { name: null }])).toEqual([])
  })

  it('first spelling wins, recipes are de-duplicated, output sorted', () => {
    const out = combine([
      { name: 'banana' },
      { name: 'Garlic', quantity: 1, unit: 'cloves', recipes: ['A', 'B'] },
      { name: 'GARLIC', quantity: 2, unit: 'Cloves', recipes: ['B', 'C'] },
      { name: 'Apple' },
    ])
    expect(out.map((i) => i.name)).toEqual(['Apple', 'banana', 'Garlic'])
    expect(out[2]).toEqual({ name: 'Garlic', quantity: 3, unit: 'cloves', recipes: ['A', 'B', 'C'] })
  })

  it('handles float noise', () => {
    expect(combine([{ name: 'Oil', quantity: 0.1, unit: 'l' }, { name: 'oil', quantity: 0.2, unit: 'l' }])[0]).toMatchObject({
      quantity: 300,
      unit: 'ml',
    })
  })
})

describe('aggregate', () => {
  it('tags ingredients with their recipe and merges across recipes', () => {
    expect(
      aggregate([
        { title: 'Pasta', ingredients: [{ name: 'Garlic', quantity: 3, unit: 'cloves' }] },
        { title: 'Curry', ingredients: [{ name: 'garlic', quantity: 4, unit: 'cloves' }] },
      ]),
    ).toEqual([{ name: 'Garlic', quantity: 7, unit: 'cloves', recipes: ['Pasta', 'Curry'] }])
  })

  it('copes with untitled recipes and recipes without ingredients', () => {
    expect(aggregate([{ ingredients: [{ name: 'Egg', quantity: 2, unit: '' }] }, { title: 'Empty' }])).toEqual([
      { name: 'Egg', quantity: 2, unit: '', recipes: [] },
    ])
  })

  it('shows whole tablespoons as tablespoons and mixed spoons as teaspoons', () => {
    const oil = aggregate([
      { title: 'A', ingredients: [{ name: 'Oil', quantity: 4, unit: 'tbsp' }] },
      { title: 'B', ingredients: [{ name: 'oil', quantity: 2, unit: 'tbsp' }] },
    ])[0]
    expect([oil.quantity, oil.unit]).toEqual([6, 'tbsp'])
    const salt = aggregate([{ ingredients: [{ name: 'Salt', quantity: 1, unit: 'tbsp' }, { name: 'salt', quantity: 1, unit: 'tsp' }] }])[0]
    expect([salt.quantity, salt.unit]).toEqual([4, 'tsp'])
  })
})

describe('formatQty', () => {
  it.each([
    [{ quantity: 2, unit: 'kg' }, '2 kg'],
    [{ quantity: 2, unit: '' }, '2'],
    [{ quantity: 1 / 3, unit: 'cup' }, '0.333 cup'],
    [{ quantity: null, unit: 'pinch' }, 'pinch'],
    [{ quantity: null, unit: '' }, ''],
  ])('%j -> %j', (item, expected) => expect(formatQty(item)).toBe(expected))
})

describe('parseIngredientLine', () => {
  it.each([
    ['500 g spaghetti', { name: 'spaghetti', quantity: 500, unit: 'g' }],
    ['500g spaghetti', { name: 'spaghetti', quantity: 500, unit: 'g' }],
    ['1.5 tbsp olive oil', { name: 'olive oil', quantity: 1.5, unit: 'tbsp' }],
    ['1,5 KG Flour', { name: 'Flour', quantity: 1.5, unit: 'kg' }],
    ['3 cloves garlic', { name: 'garlic', quantity: 3, unit: 'cloves' }],
    ['2 onions', { name: 'onions', quantity: 2, unit: '' }],
    ['2 large onions', { name: 'large onions', quantity: 2, unit: '' }],
    ['1/2 lemon', { name: 'lemon', quantity: 0.5, unit: '' }],
    ['1 1/2 cups flour', { name: 'flour', quantity: 1.5, unit: 'cups' }],
    ['3 cans', { name: 'cans', quantity: 3, unit: '' }],
    ['4', { name: '4', quantity: null, unit: '' }],
    ['salt', { name: 'salt', quantity: null, unit: '' }],
    ['- 2 eggs', { name: 'eggs', quantity: 2, unit: '' }],
    ['• salt to taste', { name: 'salt to taste', quantity: null, unit: '' }],
    ['* 1 tin tomatoes', { name: 'tomatoes', quantity: 1, unit: 'tin' }],
    ['2 constructor beams', { name: 'constructor beams', quantity: 2, unit: '' }],
    ['1/0 eggs', { name: '1/0 eggs', quantity: null, unit: '' }],
    ['1 1/0 eggs', { name: '1 1/0 eggs', quantity: null, unit: '' }],
  ])('%j', (line, expected) => expect(parseIngredientLine(line)).toEqual(expected))

  it.each(['', '   ', '- ', '•'])('blank %j -> null', (line) => expect(parseIngredientLine(line)).toBeNull())
})

describe('listAsText', () => {
  it('lists only what is left to buy', () => {
    expect(
      listAsText([
        { id: '1', name: 'Garlic', quantity: 7, unit: 'cloves', checked: false, recipes: [] },
        { id: '2', name: 'Salt', quantity: null, unit: '', checked: false, recipes: [] },
        { id: '3', name: 'Rice', quantity: 1, unit: 'kg', checked: true, recipes: [] },
      ]),
    ).toBe('- Garlic (7 cloves)\n- Salt')
  })

  it('is empty when everything is ticked', () => {
    expect(listAsText([{ id: '1', name: 'Rice', quantity: 1, unit: 'kg', checked: true, recipes: [] }])).toBe('')
  })
})
