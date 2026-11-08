// An in-memory stand-in for the Grub Grab HTTP API (the network boundary), plus Cognito's token endpoint.
import { aggregate } from '../lib/aggregate'
import type { ListItem, Recipe } from '../types'
import { CFG, fakeFetch, json, type Handler } from './fakes'

const API = CFG.apiUrl.replace(/\/$/, '')

export interface ApiState {
  recipes: Recipe[]
  items: ListItem[]
  household: { householdId: string; inviteCode: string }
}

let n = 0
const id = () => `id-${++n}`
const body = (init: RequestInit) => JSON.parse(String(init.body))
const noContent = () => new Response(null, { status: 204 })

export function fakeApi(initial: Partial<ApiState> = {}, overrides: Record<string, Handler> = {}) {
  const state: ApiState = {
    recipes: [],
    items: [],
    household: { householdId: 'h1', inviteCode: 'ABC234' },
    ...initial,
  }
  const itemId = (url: URL) => url.pathname.split('/').pop()!

  const routes: Record<string, Handler> = {
    'GET /config.json': () => json(CFG),
    [`GET ${API}/me`]: () => json(state.household),
    [`POST ${API}/household/join`]: (_u, init) => {
      state.household = { householdId: 'h2', inviteCode: body(init).code }
      state.recipes = [{ id: id(), title: 'Shared stew', servings: null, notes: '', ingredients: [] }]
      return json(state.household)
    },
    [`GET ${API}/recipes`]: () => json(state.recipes),
    [`GET ${API}/list`]: () => json(state.items),
    [`POST ${API}/list/generate`]: (_u, init) => {
      const { recipeIds } = body(init)
      state.items = aggregate(state.recipes.filter((r) => recipeIds.includes(r.id))).map((i) => ({ ...i, id: id(), checked: false }))
      return json(state.items)
    },
    [`POST ${API}/list/items`]: (_u, init) => {
      const item = { ...body(init), id: id(), checked: false, recipes: [] }
      state.items.push(item)
      return json(item, 201)
    },
    [`DELETE ${API}/list`]: () => {
      state.items = []
      return noContent()
    },
    ...overrides,
  }

  // Item and recipe routes have ids in the path; register them dynamically.
  const withIds = fakeFetch(
    new Proxy(routes, {
      get(target, key: string) {
        if (key in target) return target[key]
        const m = key.match(/^(PATCH|DELETE|PUT) (.+)\/(list\/items|recipes)\/[^/]+$/)
        if (!m) return undefined
        const override = target[`${m[1]} ${m[2]}/${m[3]}/:id`]
        if (override) return override
        if (m[1] === 'PATCH')
          return (url: URL, init: RequestInit) => {
            const item = state.items.find((i) => i.id === itemId(url))!
            item.checked = body(init).checked
            return json(item)
          }
        if (m[1] === 'DELETE' && m[3] === 'list/items')
          return (url: URL) => {
            state.items = state.items.filter((i) => i.id !== itemId(url))
            return noContent()
          }
        if (m[1] === 'DELETE')
          return (url: URL) => {
            state.recipes = state.recipes.filter((r) => r.id !== itemId(url))
            return noContent()
          }
        return undefined
      },
    }),
  )
  return { state, ...withIds }
}

export const fail = (status = 500, error = 'Server error') => () => json({ error }, status)
