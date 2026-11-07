import type { Backend, Household, ListItem, Recipe, RecipeInput } from '../types'
import { aggregate, normaliseName, normaliseUnit } from './aggregate'
import { getAccessToken } from './auth'
import type { AppConfig } from './config'

export class AuthRequiredError extends Error {}

// ---------------------------------------------------------------------------
// Cloud: talks to the Lambda API. Data is shared across a household.
// ---------------------------------------------------------------------------
export class CloudBackend implements Backend {
  readonly mode = 'cloud' as const
  private cfg: AppConfig
  constructor(cfg: AppConfig) {
    this.cfg = cfg
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getAccessToken(this.cfg)
    if (!token) throw new AuthRequiredError('Please sign in')
    const res = await fetch(`${this.cfg.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401) throw new AuthRequiredError('Please sign in')
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `Request failed (${res.status})`)
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  me = () => this.req<Household>('GET', '/me')
  joinHousehold = (code: string) => this.req<Household>('POST', '/household/join', { code })
  listRecipes = () => this.req<Recipe[]>('GET', '/recipes')
  createRecipe = (r: RecipeInput) => this.req<Recipe>('POST', '/recipes', r)
  updateRecipe = (id: string, r: RecipeInput) => this.req<Recipe>('PUT', `/recipes/${id}`, r)
  deleteRecipe = (id: string) => this.req<void>('DELETE', `/recipes/${id}`)
  getList = () => this.req<ListItem[]>('GET', '/list')
  generateList = (recipeIds: string[], mode: 'replace' | 'append') =>
    this.req<ListItem[]>('POST', '/list/generate', { recipeIds, mode })
  addItem = (item: Pick<ListItem, 'name' | 'quantity' | 'unit'>) => this.req<ListItem>('POST', '/list/items', item)
  setChecked = (id: string, checked: boolean) => this.req<ListItem>('PATCH', `/list/items/${id}`, { checked })
  deleteItem = (id: string) => this.req<void>('DELETE', `/list/items/${id}`)
  clearList = (onlyChecked: boolean) => this.req<void>('DELETE', `/list${onlyChecked ? '?checked=true' : ''}`)
}

// ---------------------------------------------------------------------------
// Local: everything in localStorage. Used when no /config.json is deployed,
// so the app is usable straight from `npm run dev`.
// ---------------------------------------------------------------------------
const KEY = 'gg.local'
interface LocalData {
  recipes: Recipe[]
  items: ListItem[]
}

const uid = () => crypto.randomUUID().replace(/-/g, '')
const sortItems = (items: ListItem[]) =>
  [...items].sort((a, b) => Number(a.checked) - Number(b.checked) || a.name.localeCompare(b.name))

export class LocalBackend implements Backend {
  readonly mode = 'local' as const

  private load(): LocalData {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '') as LocalData
    } catch {
      return { recipes: [], items: [] }
    }
  }
  private save(d: LocalData) {
    localStorage.setItem(KEY, JSON.stringify(d))
  }

  async me(): Promise<Household> {
    return { householdId: 'local', inviteCode: null }
  }
  async joinHousehold(): Promise<Household> {
    throw new Error('Sharing needs the cloud version — see the README to deploy.')
  }
  async listRecipes() {
    return this.load().recipes.sort((a, b) => a.title.localeCompare(b.title))
  }
  async createRecipe(r: RecipeInput) {
    const d = this.load()
    const recipe = { ...r, id: uid() }
    d.recipes.push(recipe)
    this.save(d)
    return recipe
  }
  async updateRecipe(id: string, r: RecipeInput) {
    const d = this.load()
    const recipe = { ...r, id }
    d.recipes = d.recipes.map((x) => (x.id === id ? recipe : x))
    this.save(d)
    return recipe
  }
  async deleteRecipe(id: string) {
    const d = this.load()
    d.recipes = d.recipes.filter((x) => x.id !== id)
    this.save(d)
  }
  async getList() {
    return sortItems(this.load().items)
  }
  async generateList(recipeIds: string[], mode: 'replace' | 'append') {
    const d = this.load()
    const recipes = d.recipes.filter((r) => recipeIds.includes(r.id))
    let items = mode === 'replace' ? [] : d.items
    for (const n of aggregate(recipes)) {
      const [nu] = normaliseUnit(n.unit, null)
      const existing = items.find(
        (o) => !o.checked && normaliseName(o.name) === normaliseName(n.name) && normaliseUnit(o.unit, null)[0] === nu,
      )
      if (existing) {
        const [, oq] = normaliseUnit(existing.unit, existing.quantity)
        const [, nq] = normaliseUnit(n.unit, n.quantity)
        const total = oq === null && nq === null ? null : (oq ?? 0) + (nq ?? 0)
        const [merged] = aggregate([{ ingredients: [{ name: n.name, quantity: total, unit: nu }] }])
        items = items.filter((i) => i !== existing)
        items.push({ ...merged, id: uid(), checked: false, recipes: [...new Set([...existing.recipes, ...n.recipes])] })
      } else {
        items.push({ ...n, id: uid(), checked: false })
      }
    }
    d.items = items
    this.save(d)
    return sortItems(items)
  }
  async addItem(item: Pick<ListItem, 'name' | 'quantity' | 'unit'>) {
    const d = this.load()
    const li = { ...item, id: uid(), checked: false, recipes: [] }
    d.items.push(li)
    this.save(d)
    return li
  }
  async setChecked(id: string, checked: boolean) {
    const d = this.load()
    const item = d.items.find((i) => i.id === id)
    if (!item) throw new Error('Item not found')
    item.checked = checked
    this.save(d)
    return item
  }
  async deleteItem(id: string) {
    const d = this.load()
    d.items = d.items.filter((i) => i.id !== id)
    this.save(d)
  }
  async clearList(onlyChecked: boolean) {
    const d = this.load()
    d.items = onlyChecked ? d.items.filter((i) => !i.checked) : []
    this.save(d)
  }
}
