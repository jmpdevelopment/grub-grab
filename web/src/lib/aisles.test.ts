import { describe, expect, it } from 'vitest'
import { AISLES, aisleKey, aisleOf, byAisle } from './aisles'

describe('aisles', () => {
  it('remembers names however they were typed', () => {
    expect(aisleKey('  Tahini   Paste ')).toBe('tahini paste')
  })

  it('a remembered move wins, then the aisle the item came with, then "other"', () => {
    expect(aisleOf({ name: 'Leek', aisle: 'produce' }, { leek: 'pantry' })).toBe('pantry')
    expect(aisleOf({ name: 'Leek', aisle: 'produce' }, { leek: 'garden' })).toBe('produce') // not a real aisle: ignored
    expect(aisleOf({ name: 'Leek', aisle: 'garden' })).toBe('other')
    expect(aisleOf({ name: 'Leek' })).toBe('other')
  })

  it('groups in walking order, skipping empty aisles and keeping each group in order', () => {
    const items = [{ name: 'milk', aisle: 'dairy' }, { name: 'b' }, { name: 'leek', aisle: 'produce' }, { name: 'a' }]
    expect(byAisle(items).map((g) => [g.aisle, g.items.map((i) => i.name)])).toEqual([
      ['produce', ['leek']],
      ['dairy', ['milk']],
      ['other', ['b', 'a']],
    ])
    expect(byAisle([])).toEqual([])
  })

  it('walks the shop from fresh food to "other"', () => {
    expect(AISLES[0]).toBe('produce')
    expect(AISLES.at(-1)).toBe('other')
  })
})
