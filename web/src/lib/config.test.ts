import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CFG, fakeFetch, json } from '../test/fakes'

// config.ts caches its result, so import a fresh copy per test.
async function fresh() {
  vi.resetModules()
  return (await import('./config')).loadConfig
}

describe('loadConfig', () => {
  beforeEach(() => vi.resetModules())

  it('returns the deployed config and caches it', async () => {
    const { fn } = fakeFetch({ 'GET /config.json': () => json(CFG) })
    const loadConfig = await fresh()
    expect(await loadConfig()).toEqual(CFG)
    expect(await loadConfig()).toEqual(CFG)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
  })

  it.each([
    ['missing file', () => new Response('not found', { status: 404 })],
    ['config without apiUrl', () => json({ clientId: 'x' })],
    ['null body', () => json(null)],
    ['not JSON (e.g. SPA fallback HTML)', () => new Response('<html>', { status: 200 })],
  ])('local mode on %s', async (_label, handler) => {
    fakeFetch({ 'GET /config.json': handler })
    expect(await (await fresh())()).toBeNull()
  })

  it('local mode when offline', async () => {
    fakeFetch({ 'GET /config.json': () => Promise.reject(new TypeError('Failed to fetch')) })
    expect(await (await fresh())()).toBeNull()
  })
})
