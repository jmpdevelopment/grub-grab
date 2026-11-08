import { describe, expect, it } from 'vitest'
import { CFG, fakeFetch, json, saveTokens } from '../test/fakes'
import type { RecipeInput } from '../types'
import { AuthRequiredError, CloudBackend, LocalBackend } from './backend'

const API = 'https://api.example.com'
const PASTA: RecipeInput = {
  title: 'Pasta',
  servings: 2,
  notes: '',
  ingredients: [
    { name: 'Spaghetti', quantity: 500, unit: 'g' },
    { name: 'Garlic', quantity: 3, unit: 'cloves' },
    { name: 'Salt', quantity: null, unit: '' },
  ],
}
const CURRY: RecipeInput = {
  title: 'Curry',
  servings: null,
  notes: '',
  ingredients: [
    { name: 'garlic', quantity: 4, unit: 'cloves' },
    { name: 'Rice', quantity: 1, unit: 'kg' },
  ],
}

describe('CloudBackend', () => {
  const ok = (body: unknown = {}) => () => json(body)

  it('sends the bearer token and JSON body to the right endpoint for every call', async () => {
    saveTokens({ accessToken: 'tok' })
    const { calls } = fakeFetch({
      [`GET ${API}/me`]: ok({ householdId: 'h', inviteCode: 'ABC234' }),
      [`POST ${API}/household/join`]: ok({ householdId: 'h2', inviteCode: 'XYZ234' }),
      [`POST ${API}/household/invite`]: ok({ householdId: 'h', inviteCode: 'NEWCODE234' }),
      [`GET ${API}/recipes`]: ok([]),
      [`POST ${API}/recipes`]: ok({ id: 'r1' }),
      [`PUT ${API}/recipes/r1`]: ok({ id: 'r1' }),
      [`DELETE ${API}/recipes/r1`]: () => new Response(null, { status: 204 }),
      [`GET ${API}/list`]: ok([]),
      [`POST ${API}/list/generate`]: ok([]),
      [`POST ${API}/list/items`]: ok({ id: 'i1' }),
      [`PATCH ${API}/list/items/i1`]: ok({ id: 'i1', checked: true }),
      [`DELETE ${API}/list/items/i1`]: () => new Response(null, { status: 204 }),
      [`DELETE ${API}/list`]: () => new Response(null, { status: 204 }),
    })
    const b = new CloudBackend(CFG)

    expect(b.mode).toBe('cloud')
    expect(await b.me()).toEqual({ householdId: 'h', inviteCode: 'ABC234' })
    expect(await b.joinHousehold('xyz234')).toEqual({ householdId: 'h2', inviteCode: 'XYZ234' })
    expect(await b.rotateInvite()).toEqual({ householdId: 'h', inviteCode: 'NEWCODE234' })
    await b.listRecipes()
    await b.createRecipe(PASTA)
    await b.updateRecipe('r1', CURRY)
    expect(await b.deleteRecipe('r1')).toBeUndefined()
    await b.getList()
    await b.generateList(['r1'], 'append')
    await b.addItem({ name: 'Milk', quantity: 1, unit: 'l' })
    await b.setChecked('i1', true)
    await b.deleteItem('i1')
    await b.clearList(false)
    await b.clearList(true)

    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /me',
      'POST /household/join',
      'POST /household/invite',
      'GET /recipes',
      'POST /recipes',
      'PUT /recipes/r1',
      'DELETE /recipes/r1',
      'GET /list',
      'POST /list/generate',
      'POST /list/items',
      'PATCH /list/items/i1',
      'DELETE /list/items/i1',
      'DELETE /list',
      'DELETE /list?checked=true',
    ])
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true)
    expect(calls[1].body).toEqual({ code: 'xyz234' })
    expect(calls[8].body).toEqual({ recipeIds: ['r1'], mode: 'append' })
    expect(calls[10].body).toEqual({ checked: true })
    expect(calls[0].headers['content-type']).toBeUndefined()
    expect(calls[1].headers['content-type']).toBe('application/json')
  })

  it('works whether or not the API URL ends with a slash', async () => {
    saveTokens()
    const { calls } = fakeFetch({ [`GET ${API}/recipes`]: ok([]) })
    await new CloudBackend({ ...CFG, apiUrl: API }).listRecipes()
    await new CloudBackend({ ...CFG, apiUrl: `${API}/` }).listRecipes()
    expect(calls.map((c) => c.url.href)).toEqual([`${API}/recipes`, `${API}/recipes`])
  })

  it('asks for sign-in without calling the API when there is no token', async () => {
    const { fn } = fakeFetch({})
    await expect(new CloudBackend(CFG).listRecipes()).rejects.toBeInstanceOf(AuthRequiredError)
    expect(fn).not.toHaveBeenCalled()
  })

  it('asks for sign-in when the API says 401', async () => {
    saveTokens()
    fakeFetch({ [`GET ${API}/list`]: () => json({ message: 'Unauthorized' }, 401) })
    await expect(new CloudBackend(CFG).getList()).rejects.toBeInstanceOf(AuthRequiredError)
  })

  it('surfaces the API error message', async () => {
    saveTokens()
    fakeFetch({ [`POST ${API}/household/join`]: () => json({ error: 'Invite code not found' }, 404) })
    await expect(new CloudBackend(CFG).joinHousehold('NOPE')).rejects.toThrow('Invite code not found')
  })

  it('falls back to the status code when the error body is not JSON', async () => {
    saveTokens()
    fakeFetch({ [`GET ${API}/recipes`]: () => new Response('Bad gateway', { status: 502 }) })
    await expect(new CloudBackend(CFG).listRecipes()).rejects.toThrow('Request failed (502)')
  })

  it('falls back to the status code when the error JSON has no message', async () => {
    saveTokens()
    fakeFetch({ [`GET ${API}/recipes`]: () => json({}, 500) })
    await expect(new CloudBackend(CFG).listRecipes()).rejects.toThrow('Request failed (500)')
  })
})

describe('LocalBackend', () => {
  const stored = () => JSON.parse(localStorage.getItem('gg.local')!)

  it('has a fixed local household and cannot join others', async () => {
    const b = new LocalBackend()
    expect(b.mode).toBe('local')
    expect(await b.me()).toEqual({ householdId: 'local', inviteCode: null })
    await expect(b.joinHousehold()).rejects.toThrow('Sharing needs the cloud version')
    await expect(b.rotateInvite()).rejects.toThrow('Sharing needs the cloud version')
  })

  it('starts empty, and survives corrupt or unexpected storage', async () => {
    const b = new LocalBackend()
    expect(await b.listRecipes()).toEqual([])
    for (const raw of ['{oops', 'null', '42', '{"recipes": "nope", "items": {}}']) {
      localStorage.setItem('gg.local', raw)
      expect(await b.listRecipes()).toEqual([])
      expect(await b.getList()).toEqual([])
    }
  })

  it('creates, sorts, updates and deletes recipes', async () => {
    const b = new LocalBackend()
    const p = await b.createRecipe(PASTA)
    const c = await b.createRecipe(CURRY)
    expect(p.id).not.toBe(c.id)
    expect((await b.listRecipes()).map((r) => r.title)).toEqual(['Curry', 'Pasta'])

    await b.updateRecipe(p.id, { ...PASTA, title: 'Aglio' })
    expect((await b.listRecipes()).map((r) => r.title)).toEqual(['Aglio', 'Curry'])

    await b.deleteRecipe(c.id)
    expect((await b.listRecipes()).map((r) => r.id)).toEqual([p.id])
    expect(stored().recipes).toHaveLength(1)
  })

  it('generates a combined list', async () => {
    const b = new LocalBackend()
    const p = await b.createRecipe(PASTA)
    const c = await b.createRecipe(CURRY)
    const items = await b.generateList([p.id, c.id, p.id], 'replace')
    const garlic = items.find((i) => i.name === 'Garlic')!
    expect(garlic).toMatchObject({ quantity: 7, unit: 'cloves', recipes: ['Pasta', 'Curry'], checked: false })
    expect(items).toHaveLength(4)
    expect(new Set(items.map((i) => i.id)).size).toBe(4)
  })

  it('replace drops the old list; append folds into unticked items and keeps ticked ones', async () => {
    const b = new LocalBackend()
    const p = await b.createRecipe(PASTA)
    const c = await b.createRecipe(CURRY)
    const first = await b.generateList([p.id], 'replace')
    const spaghetti = first.find((i) => i.name === 'Spaghetti')!
    await b.setChecked(spaghetti.id, true)
    await b.addItem({ name: 'Lemons', quantity: 2, unit: '' })

    const appended = await b.generateList([c.id, p.id], 'append')
    const unticked = appended.filter((i) => !i.checked)
    expect(appended.filter((i) => i.checked).map((i) => i.name)).toEqual(['Spaghetti'])
    expect(unticked.find((i) => i.name === 'Garlic')!.quantity).toBe(3 + 4 + 3)
    expect(unticked.find((i) => i.name === 'Lemons')!.quantity).toBe(2)
    expect(unticked.find((i) => i.name === 'Spaghetti')!.quantity).toBe(500)
    // Ticked items sort last.
    expect(appended.at(-1)!.name).toBe('Spaghetti')

    const replaced = await b.generateList([c.id], 'replace')
    expect(replaced.map((i) => i.name)).toEqual(['garlic', 'Rice'])
  })

  it('rejects empty selections and unknown recipes without touching the list', async () => {
    const b = new LocalBackend()
    const p = await b.createRecipe(PASTA)
    await b.generateList([p.id], 'replace')
    await expect(b.generateList([], 'replace')).rejects.toThrow('Pick at least one recipe')
    await expect(b.generateList([p.id, 'gone'], 'replace')).rejects.toThrow('Recipe gone not found')
    expect(await b.getList()).toHaveLength(3)
  })

  it('adds, ticks, deletes and clears items', async () => {
    const b = new LocalBackend()
    const milk = await b.addItem({ name: 'Milk', quantity: 1, unit: 'l' })
    const eggs = await b.addItem({ name: 'Eggs', quantity: 6, unit: '' })
    expect(milk).toMatchObject({ checked: false, recipes: [] })

    expect((await b.setChecked(milk.id, true)).checked).toBe(true)
    expect((await b.getList()).map((i) => i.name)).toEqual(['Eggs', 'Milk'])
    await expect(b.setChecked('nope', true)).rejects.toThrow('Item not found')

    await b.clearList(true)
    expect((await b.getList()).map((i) => i.id)).toEqual([eggs.id])

    await b.deleteItem(eggs.id)
    expect(await b.getList()).toEqual([])

    await b.addItem({ name: 'Bread', quantity: null, unit: '' })
    await b.clearList(false)
    expect(await b.getList()).toEqual([])
  })
})
