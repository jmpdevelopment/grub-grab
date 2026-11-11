import { describe, expect, it, vi } from 'vitest'
import { CFG, fakeFetch, json, saveTokens } from '../test/fakes'
import type { RecipeInput } from '../types'
import { AuthRequiredError, CloudBackend, jobIdOf, LocalBackend } from './backend'
import { journey } from './journey'

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
      [`GET ${API}/admin/requests`]: ok([]),
      [`POST ${API}/admin/requests/Google_1%20x/approve`]: ok({ status: 'approved' }),
      [`POST ${API}/admin/requests/Google_2/decline`]: ok({ status: 'declined' }),
      [`POST ${API}/admin/requests/decline-pending`]: ok({ declined: 3 }),
      [`POST ${API}/recipes/import`]: ok({ jobId: 'j1', remaining: 3 }),
      [`GET ${API}/recipes/import/j1`]: ok({ status: 'done', recipe: { title: 'T', servings: null, link: 'https://e.com', ingredients: [] } }),
      [`DELETE ${API}/me`]: ok({ deleted: true, householdDeleted: false }),
      [`POST ${API}/household`]: ok({ householdId: 'h', inviteCode: 'ABC234' }),
      [`PATCH ${API}/me`]: () => new Response(null, { status: 204 }),
      [`PUT ${API}/household/recipe-language`]: ok({ householdId: 'h', inviteCode: 'ABC234', recipeLanguage: 'pl' }),
      [`POST ${API}/household/join`]: ok({ householdId: 'h2', inviteCode: 'XYZ234' }),
      [`POST ${API}/household/invite`]: ok({ householdId: 'h', inviteCode: 'NEWCODE234' }),
      [`PUT ${API}/household/aisles`]: ok({ householdId: 'h', inviteCode: 'ABC234', aisles: { tahini: 'pantry' } }),
      [`DELETE ${API}/household/to-cook/r1`]: ok({ householdId: 'h', inviteCode: 'ABC234', toCook: [] }),
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
    expect((await b.importRecipe('https://e.com')).remaining).toBe(3)
    expect(await b.deleteAccount()).toBeUndefined()
    expect(await b.listAccessRequests()).toEqual([])
    expect(await b.decideAccess('Google_1 x', true)).toBeUndefined()
    expect(await b.decideAccess('Google_2', false)).toBeUndefined()
    expect(await b.declineAllPending()).toBe(3)
    expect(await b.createHousehold()).toEqual({ householdId: 'h', inviteCode: 'ABC234' })
    expect(await b.saveLanguage('lt')).toBeUndefined()
    expect((await b.setRecipeLanguage('pl')).recipeLanguage).toBe('pl')
    expect(await b.joinHousehold('xyz234')).toEqual({ householdId: 'h2', inviteCode: 'XYZ234' })
    expect(await b.rotateInvite()).toEqual({ householdId: 'h', inviteCode: 'NEWCODE234' })
    expect((await b.setAisle('Tahini', 'pantry')).aisles).toEqual({ tahini: 'pantry' })
    expect((await b.removeToCook('r1')).toCook).toEqual([])
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
      'POST /recipes/import',
      'GET /recipes/import/j1',
      'DELETE /me',
      'GET /admin/requests',
      'POST /admin/requests/Google_1%20x/approve',
      'POST /admin/requests/Google_2/decline',
      'POST /admin/requests/decline-pending',
      'POST /household',
      'PATCH /me',
      'PUT /household/recipe-language',
      'POST /household/join',
      'POST /household/invite',
      'PUT /household/aisles',
      'DELETE /household/to-cook/r1',
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
    const body = (path: string) => calls.find((c) => `${c.method} ${c.url.pathname}${c.url.search}` === path)!
    expect(body('POST /household/join').body).toEqual({ code: 'xyz234' })
    expect(body('POST /recipes/import').body).toEqual({ link: 'https://e.com' }) // the server uses the household's recipe language
    expect(body('POST /list/generate').body).toEqual({ recipeIds: ['r1'], mode: 'append' })
    expect(body('PATCH /list/items/i1').body).toEqual({ checked: true })
    expect(body('GET /me').headers['content-type']).toBeUndefined()
    expect(body('POST /household').body).toEqual({ language: 'en' })
    expect(body('PATCH /me').body).toEqual({ language: 'lt' })
    expect(body('PUT /household/recipe-language').body).toEqual({ language: 'pl' })
    expect(body('PUT /household/aisles').body).toEqual({ name: 'Tahini', aisle: 'pantry' }) // the server makes the key
    expect(body('POST /household/join').headers['content-type']).toBe('application/json')
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

describe('CloudBackend: the journey', () => {
  it('notes each request: route without ids, result, time and request id', async () => {
    saveTokens({ accessToken: 'tok' })
    fakeFetch({
      [`GET ${API}/list`]: () => new Response('[]', { status: 200, headers: { 'apigw-requestid': 'Req-1' } }),
      [`DELETE ${API}/list/items/abcdef123456`]: () => new Response(null, { status: 204 }),
      [`POST ${API}/feedback`]: () => json({ id: 'f1' }, 201),
    })
    const b = new CloudBackend(CFG)
    await b.getList()
    await b.deleteItem('abcdef123456')
    expect(await b.sendFeedback({ kind: 'general', problems: ['idea'] })).toBeUndefined()
    const steps = journey()
    expect(steps.map((s) => s.type === 'api' && [s.route, s.status, s.requestId])).toEqual([
      ['GET /list', 200, 'Req-1'],
      ['DELETE /list/items/:id', 204, undefined],
      ['POST /feedback', 201, undefined],
    ])
    expect(steps.every((s) => s.type === 'api' && s.ms >= 0)).toBe(true)
  })

  it('a request that never reached the server is noted as status 0', async () => {
    saveTokens({ accessToken: 'tok' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(new CloudBackend(CFG).getList()).rejects.toThrow('Failed to fetch')
    expect(journey()).toEqual([expect.objectContaining({ type: 'api', route: 'GET /list', status: 0 })])
  })
})

describe('LocalBackend', () => {
  const stored = () => JSON.parse(localStorage.getItem('gg.local')!)

  it('has a fixed local household and cannot join others', async () => {
    const b = new LocalBackend()
    expect(b.mode).toBe('local')
    const local = { householdId: 'local', inviteCode: null, aisles: {}, toCook: [] }
    expect(await b.me()).toEqual(local)
    expect(await b.createHousehold()).toEqual(local)
    expect(await b.saveLanguage()).toBeUndefined()
    expect(await b.setRecipeLanguage()).toEqual(local)
    await b.createRecipe({ title: 'Soup', servings: null, notes: '', ingredients: [] })
    await expect(b.importRecipe()).rejects.toThrow('Recipe import needs the cloud version')
    expect(await b.sendFeedback()).toBeUndefined() // nowhere to send it
    await b.deleteAccount() // local mode: wipes this device's data
    expect(await b.listRecipes()).toEqual([])
    expect(await b.listAccessRequests()).toEqual([])
    expect(await b.decideAccess()).toBeUndefined()
    expect(await b.declineAllPending()).toBe(0)
    await expect(b.joinHousehold()).rejects.toThrow('Sharing needs the cloud version')
    await expect(b.rotateInvite()).rejects.toThrow('Sharing needs the cloud version')
  })

  it('keeps picked recipes under "To cook" until unticked, like the API', async () => {
    const b = new LocalBackend()
    const soup = await b.createRecipe({ title: 'Soup', servings: null, notes: '', ingredients: [{ name: 'leek', quantity: 1, unit: '' }] })
    const stew = await b.createRecipe({ title: 'Stew', servings: null, notes: '', ingredients: [] })
    await b.generateList([soup.id], 'replace')
    await b.generateList([stew.id, soup.id], 'append')
    expect((await b.me()).toCook).toEqual([soup.id, stew.id].sort())
    expect((await b.removeToCook(soup.id)).toCook).toEqual([stew.id])
    await b.deleteRecipe(stew.id)
    expect((await b.me()).toCook).toEqual([])
    localStorage.setItem('gg.local', JSON.stringify({ toCook: 'nope' }))
    expect((await b.me()).toCook).toEqual([])
  })

  it('remembers where items were moved, on this device', async () => {
    const b = new LocalBackend()
    expect((await b.setAisle('  Tahini ', 'pantry')).aisles).toEqual({ tahini: 'pantry' })
    await b.setAisle('Leek', 'produce')
    expect((await b.me()).aisles).toEqual({ tahini: 'pantry', leek: 'produce' })
    for (const aisles of ['nope', [1], null]) {
      localStorage.setItem('gg.local', JSON.stringify({ aisles }))
      expect((await b.me()).aisles).toEqual({})
    }
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

describe('CloudBackend: Fill from link (background job)', () => {
  const draft = { title: 'Soup', servings: 2, link: 'https://e.com', ingredients: [] }
  const fast = { pollMs: 1, timeoutMs: 50 }

  function job(...states: object[]) {
    saveTokens({ accessToken: 'tok' })
    let n = 0
    return fakeFetch({
      [`POST ${API}/recipes/import`]: () => json({ jobId: 'j9', remaining: 7 }, 202),
      [`GET ${API}/recipes/import/j9`]: () => json(states[Math.min(n++, states.length - 1)]),
    })
  }

  it('checks until the job is done, then returns the draft', async () => {
    const { calls } = job({ status: 'pending' }, { status: 'pending' }, { status: 'done', recipe: draft })
    expect(await new CloudBackend(CFG, fast).importRecipe('https://e.com')).toEqual({ recipe: draft, remaining: 7, jobId: 'j9' })
    expect(calls.filter((c) => c.url.pathname === '/recipes/import/j9')).toHaveLength(3)
  })

  it('reports why a job failed', async () => {
    job({ status: 'pending' }, { status: 'failed', error: "Couldn't find a recipe on that page." })
    const err = await new CloudBackend(CFG, fast).importRecipe('https://e.com').catch((e) => e)
    expect(err.message).toBe("Couldn't find a recipe on that page.")
    expect(jobIdOf(err)).toBe('j9') // so a problem report can include the import
  })

  it('gives up after a while', async () => {
    job({ status: 'pending' })
    const err = await new CloudBackend(CFG, { pollMs: 20, timeoutMs: 30 }).importRecipe('https://e.com').catch((e) => e)
    expect(err.message).toContain('taking too long')
    expect(jobIdOf(err)).toBe('j9')
    expect(jobIdOf(new Error('x'))).toBeUndefined()
    expect(jobIdOf(null)).toBeUndefined()
  })
})

describe('CloudBackend: errors carry codes for translation', () => {
  it('passes on the server\'s code and values', async () => {
    saveTokens({ accessToken: 'tok' })
    fakeFetch({
      [`POST ${API}/household/join`]: () => json({ error: 'Invite codes are 10 characters', code: 'invite_code_length', params: { length: 10 } }, 400),
    })
    const err = await new CloudBackend(CFG).joinHousehold('x').catch((e) => e)
    expect(err).toMatchObject({ code: 'invite_code_length', params: { length: 10 }, message: 'Invite codes are 10 characters' })
  })

  it('a failed import job reports its code', async () => {
    saveTokens({ accessToken: 'tok' })
    fakeFetch({
      [`POST ${API}/recipes/import`]: () => json({ jobId: 'j2', remaining: 1 }, 202),
      [`GET ${API}/recipes/import/j2`]: () => json({ status: 'failed', error: "Couldn't find a recipe on that page.", errorCode: 'no_recipe' }),
    })
    const err = await new CloudBackend(CFG, { pollMs: 1, timeoutMs: 50 }).importRecipe('https://e.com').catch((e) => e)
    expect(err).toMatchObject({ code: 'no_recipe', message: "Couldn't find a recipe on that page." })
  })
})
