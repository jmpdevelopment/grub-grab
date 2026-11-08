// An in-memory stand-in for the Grub Grab HTTP API (the network boundary), plus Cognito's token endpoint.
import { aggregate } from '../lib/aggregate'
import type { AccessRequest, FeedbackBody, ListItem, Recipe } from '../types'
import { CFG, fakeFetch, json, type Handler } from './fakes'

const API = CFG.apiUrl.replace(/\/$/, '')

export interface ApiState {
  recipes: Recipe[]
  items: ListItem[]
  household: {
    householdId: string | null
    inviteCode: string | null
    admin?: boolean
    pendingRequests?: number
    language?: string
    recipeLanguage?: string
    aisles?: Record<string, string>
  }
  requests: AccessRequest[]
  feedback: FeedbackBody[]
}

let n = 0
const id = () => `id-${++n}`
const body = (init: RequestInit) => JSON.parse(String(init.body))
const noContent = () => new Response(null, { status: 204 })

export function fakeApi(initial: Partial<ApiState> = {}, overrides: Record<string, Handler> = {}) {
  const state: ApiState = {
    recipes: [],
    items: [],
    household: { householdId: 'h1', inviteCode: 'ABCDEFGH23' },
    requests: [],
    feedback: [],
    ...initial,
  }
  const itemId = (url: URL) => url.pathname.split('/').pop()!
  // Like the real API: data routes refuse until the user has started or joined a household.
  const needsHousehold = (handler: Handler): Handler => (url, init) =>
    state.household.householdId ? handler(url, init) : json({ error: 'No household yet. Start one or join one with a code.' }, 409)

  const routes: Record<string, Handler> = {
    'GET /config.json': () => json(CFG),
    [`GET ${API}/me`]: () => json(state.household),
    [`PATCH ${API}/me`]: (_u, init) => {
      state.household = { ...state.household, language: body(init).language }
      return noContent()
    },
    [`PUT ${API}/household/recipe-language`]: (_u, init) => {
      state.household = { ...state.household, recipeLanguage: body(init).language }
      return json({ householdId: state.household.householdId, inviteCode: state.household.inviteCode, recipeLanguage: body(init).language })
    },
    [`PUT ${API}/household/aisles`]: (_u, init) => {
      const { name, aisle } = body(init)
      state.household = { ...state.household, aisles: { ...state.household.aisles, [name.trim().toLowerCase()]: aisle } }
      return json(state.household)
    },
    [`DELETE ${API}/me`]: () => {
      state.recipes = []
      state.items = []
      state.household = { householdId: null, inviteCode: null }
      return json({ deleted: true, householdDeleted: true })
    },
    [`POST ${API}/household`]: (_u, init) => {
      state.household = state.household.householdId
        ? state.household
        : { householdId: 'h-new', inviteCode: 'NEWHOME234', recipeLanguage: body(init).language }
      return json(state.household)
    },
    [`POST ${API}/household/join`]: (_u, init) => {
      state.household = { householdId: 'h2', inviteCode: body(init).code }
      state.recipes = [{ id: id(), title: 'Shared stew', servings: null, notes: '', ingredients: [] }]
      return json(state.household)
    },
    [`POST ${API}/household/invite`]: () => {
      state.household = { ...state.household, inviteCode: 'ROTATED234' }
      return json(state.household)
    },
    [`POST ${API}/feedback`]: (_u, init) => {
      state.feedback.push(body(init))
      return json({ id: `fb-${state.feedback.length}` }, 201)
    },
    [`GET ${API}/admin/requests`]: () => json(state.requests),
    [`POST ${API}/admin/requests/decline-pending`]: () => {
      const declined = state.requests.length
      state.requests = []
      return json({ declined })
    },
    [`POST ${CFG.cognitoDomain}/oauth2/revoke`]: () => new Response(null, { status: 200 }),
    [`GET ${API}/recipes`]: needsHousehold(() => json(state.recipes)),
    [`GET ${API}/list`]: needsHousehold(() => json(state.items)),
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
        const decision = key.match(/^POST .+\/admin\/requests\/([^/]+)\/(approve|decline)$/)
        if (decision)
          return () => {
            state.requests = state.requests.filter((r) => r.username !== decodeURIComponent(decision[1]))
            return json({ username: decision[1], status: decision[2] === 'approve' ? 'approved' : 'declined' })
          }
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
