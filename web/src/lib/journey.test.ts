import { describe, expect, it } from 'vitest'
import { journey, MAX_AGE_MS, MAX_STEPS, record, resetJourney, routeOf } from './journey'

describe('journey', () => {
  it('keeps steps in order with their time, on this device for the session', () => {
    record({ type: 'screen', name: 'recipes' }, 1000)
    record({ type: 'api', route: 'GET /list', status: 200, ms: 40 }, 2000)
    expect(journey(2000)).toEqual([
      { type: 'screen', name: 'recipes', t: 1000 },
      { type: 'api', route: 'GET /list', status: 200, ms: 40, t: 2000 },
    ])
    expect(JSON.parse(sessionStorage.getItem('gg.journey')!)).toHaveLength(2)
  })

  it('survives a reload (e.g. after a crash) but not a broken or odd store', () => {
    sessionStorage.setItem('gg.journey', JSON.stringify([{ type: 'screen', name: 'list', t: 5 }]))
    resetJourney()
    sessionStorage.setItem('gg.journey', JSON.stringify([{ type: 'screen', name: 'list', t: 5 }]))
    expect(journey(10)).toEqual([{ type: 'screen', name: 'list', t: 5 }])
    for (const raw of ['{oops', '{"a":1}']) {
      resetJourney()
      sessionStorage.setItem('gg.journey', raw)
      expect(journey(10)).toEqual([])
    }
  })

  it('keeps only the last 100 steps of the last 30 minutes', () => {
    for (let n = 0; n < MAX_STEPS + 20; n++) record({ type: 'action', name: `a${n}` }, 1000 + n)
    expect(journey(2000)).toHaveLength(MAX_STEPS)
    expect(journey(2000)[0]).toMatchObject({ name: 'a20' })
    expect(journey(1000 + MAX_STEPS + 19 + MAX_AGE_MS)).toHaveLength(1) // only the newest is that recent
  })

  it('still works when storage is full', () => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      record({ type: 'screen', name: 'list' }, 1)
      expect(journey(1)).toHaveLength(1)
    } finally {
      Storage.prototype.setItem = setItem
    }
  })

  it.each([
    ['/recipes/import/3f2a9c1e7b6d4e5f8a9b0c1d2e3f4a5b', '/recipes/import/:id'],
    ['/list/items/abc12345def', '/list/items/:id'],
    ['/admin/requests/Google_1%20x/approve', '/admin/requests/:user/approve'],
    ['/list?checked=true', '/list?checked=true'],
    ['/household/recipe-language', '/household/recipe-language'],
  ])('routes leave out ids: %s', (path, route) => expect(routeOf(path)).toBe(route))
})
