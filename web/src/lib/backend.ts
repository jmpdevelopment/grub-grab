import type { AccessRequest, Backend, Household, ImportedRecipe, ListItem, Recipe, RecipeInput } from '../types'
import { aggregate, combine } from './aggregate'
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
  createHousehold = () => this.req<Household>('POST', '/household')
  joinHousehold = (code: string) => this.req<Household>('POST', '/household/join', { code })
  rotateInvite = () => this.req<Household>('POST', '/household/invite')
  importRecipe = (link: string) => this.req<ImportedRecipe>('POST', '/recipes/import', { link })
  deleteAccount = async () => {
    await this.req('DELETE', '/me')
  }
  listAccessRequests = () => this.req<AccessRequest[]>('GET', '/admin/requests')
  decideAccess = async (username: string, approve: boolean) => {
    await this.req('POST', `/admin/requests/${encodeURIComponent(username)}/${approve ? 'approve' : 'decline'}`)
  }
  declineAllPending = async () => (await this.req<{ declined: number }>('POST', '/admin/requests/decline-pending')).declined
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
    let data: Partial<LocalData> | null = null
    try {
      data = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    } catch {
      // Corrupt storage: start fresh rather than crash.
    }
    return {
      recipes: Array.isArray(data?.recipes) ? data.recipes : [],
      items: Array.isArray(data?.items) ? data.items : [],
    }
  }
  private save(d: LocalData) {
    localStorage.setItem(KEY, JSON.stringify(d))
  }

  async me(): Promise<Household> {
    return { householdId: 'local', inviteCode: null }
  }
  async createHousehold(): Promise<Household> {
    return this.me() // this device is the household
  }
  async joinHousehold(): Promise<Household> {
    throw new Error('Sharing needs the cloud version — see the README to deploy.')
  }
  async rotateInvite(): Promise<Household> {
    throw new Error('Sharing needs the cloud version — see the README to deploy.')
  }
  async deleteAccount(): Promise<void> {
    localStorage.removeItem(KEY)
  }
  async importRecipe(): Promise<ImportedRecipe> {
    throw new Error('Recipe import needs the cloud version — see the README to deploy.')
  }
  // Nobody signs up in local mode, so there is never anyone to approve.
  async listAccessRequests(): Promise<AccessRequest[]> {
    return []
  }
  async decideAccess(): Promise<void> {}
  async declineAllPending(): Promise<number> {
    return 0
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
    if (recipeIds.length === 0) throw new Error('Pick at least one recipe')
    const d = this.load()
    const recipes = [...new Set(recipeIds)].map((id) => {
      const recipe = d.recipes.find((r) => r.id === id)
      if (!recipe) throw new Error(`Recipe ${id} not found`)
      return recipe
    })
    // Same rules as the API: replace drops everything; append folds into unticked items only.
    const ticked = mode === 'append' ? d.items.filter((i) => i.checked) : []
    const unticked = mode === 'append' ? d.items.filter((i) => !i.checked) : []
    const fresh = combine([...unticked, ...aggregate(recipes)]).map((i) => ({ ...i, id: uid(), checked: false }))
    d.items = [...ticked, ...fresh]
    this.save(d)
    return sortItems(d.items)
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
