import { AppError } from '../i18n/errors'
import type { AccessRequest, Backend, FeedbackBody, Household, ImportedRecipe, ListItem, Recipe, RecipeInput } from '../types'
import { aggregate, combine } from './aggregate'
import { aisleKey } from './aisles'
import { getAccessToken } from './auth'
import type { AppConfig } from './config'
import { record, routeOf } from './journey'

export class AuthRequiredError extends Error {
  name = 'AuthRequiredError'
}

/** The import job an error came from, if any (so a problem report can include it). */
export const jobIdOf = (error: unknown): string | undefined => (error as { jobId?: string } | null)?.jobId

const withJob = <E extends Error>(error: E, jobId: string) => Object.assign(error, { jobId })

/** How "Fill from link" waits for its background job. */
export interface ImportTiming {
  pollMs: number
  timeoutMs: number
}
const IMPORT_TIMING: ImportTiming = { pollMs: 2000, timeoutMs: 250_000 } // a little past the worker's 240 s
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ImportJob =
  | { status: 'pending' }
  | { status: 'done'; recipe: ImportedRecipe['recipe'] }
  | { status: 'failed'; error: string; errorCode?: string }

// ---------------------------------------------------------------------------
// Cloud: talks to the Lambda API. Data is shared across a household.
// ---------------------------------------------------------------------------
export class CloudBackend implements Backend {
  readonly mode = 'cloud' as const
  private cfg: AppConfig
  private timing: ImportTiming
  constructor(cfg: AppConfig, timing: ImportTiming = IMPORT_TIMING) {
    this.cfg = cfg
    this.timing = timing
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getAccessToken(this.cfg)
    if (!token) throw new AuthRequiredError('Please sign in')
    const started = Date.now()
    const step = { type: 'api' as const, route: `${method} ${routeOf(path)}` }
    let res: Response
    try {
      res = await fetch(`${this.cfg.apiUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      record({ ...step, status: 0, ms: Date.now() - started }) // no connection
      throw e
    }
    const requestId = res.headers.get('apigw-requestid') ?? undefined
    record({ ...step, status: res.status, ms: Date.now() - started, ...(requestId ? { requestId } : {}) })
    if (res.status === 401) throw new AuthRequiredError('Please sign in')
    if (!res.ok) {
      // The API sends a message code (shown in the person's language) with its English text.
      const err = await res.json().catch(() => ({}))
      if (err.code) throw new AppError(err.code, err.params ?? {}, err.error)
      if (err.error) throw new Error(err.error)
      throw new AppError('request_failed', { status: res.status }, `Request failed (${res.status})`)
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  me = () => this.req<Household>('GET', '/me')
  createHousehold = (language = 'en') => this.req<Household>('POST', '/household', { language })
  saveLanguage = async (language: string) => {
    await this.req('PATCH', '/me', { language })
  }
  setRecipeLanguage = (language: string) => this.req<Household>('PUT', '/household/recipe-language', { language })
  joinHousehold = (code: string) => this.req<Household>('POST', '/household/join', { code })
  rotateInvite = () => this.req<Household>('POST', '/household/invite')
  setAisle = (name: string, aisle: string) => this.req<Household>('PUT', '/household/aisles', { name, aisle })
  removeToCook = (recipeId: string) => this.req<Household>('DELETE', `/household/to-cook/${encodeURIComponent(recipeId)}`)
  /** Starts the AI import (a background job on the server, written in the household's recipe language),
   *  then checks on it until it's finished. */
  importRecipe = async (link: string): Promise<ImportedRecipe> => {
    const { jobId, remaining } = await this.req<{ jobId: string; remaining: number }>('POST', '/recipes/import', { link })
    const deadline = Date.now() + this.timing.timeoutMs
    for (;;) {
      const job = await this.req<ImportJob>('GET', `/recipes/import/${jobId}`)
      if (job.status === 'done') return { recipe: job.recipe, remaining, jobId }
      if (job.status === 'failed')
        throw withJob(job.errorCode ? new AppError(job.errorCode, {}, job.error) : new Error(job.error), jobId)
      if (Date.now() + this.timing.pollMs > deadline)
        throw withJob(
          new AppError('import_slow', {}, 'Reading that page is taking too long. Try again later, or add the recipe by hand.'),
          jobId,
        )
      await sleep(this.timing.pollMs)
    }
  }
  deleteAccount = async () => {
    await this.req('DELETE', '/me')
  }
  sendFeedback = async (body: FeedbackBody) => {
    await this.req('POST', '/feedback', body)
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
  aisles: Record<string, string>
  toCook: string[]
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
      aisles: data?.aisles && typeof data.aisles === 'object' && !Array.isArray(data.aisles) ? data.aisles : {},
      toCook: Array.isArray(data?.toCook) ? data.toCook : [],
    }
  }
  private save(d: LocalData) {
    localStorage.setItem(KEY, JSON.stringify(d))
  }

  async me(): Promise<Household> {
    const d = this.load()
    return { householdId: 'local', inviteCode: null, aisles: d.aisles, toCook: d.toCook }
  }
  async setAisle(name: string, aisle: string): Promise<Household> {
    const d = this.load()
    d.aisles[aisleKey(name)] = aisle
    this.save(d)
    return this.me()
  }
  async removeToCook(recipeId: string): Promise<Household> {
    const d = this.load()
    d.toCook = d.toCook.filter((id) => id !== recipeId)
    this.save(d)
    return this.me()
  }
  async createHousehold(): Promise<Household> {
    return this.me() // this device is the household
  }
  // No account and no shared household in local mode: the language picker alone decides.
  async saveLanguage(): Promise<void> {}
  async setRecipeLanguage(): Promise<Household> {
    return this.me()
  }
  async joinHousehold(): Promise<Household> {
    throw new AppError('cloud_only', {}, 'Sharing needs the cloud version — see the README to deploy.')
  }
  async rotateInvite(): Promise<Household> {
    throw new AppError('cloud_only', {}, 'Sharing needs the cloud version — see the README to deploy.')
  }
  async deleteAccount(): Promise<void> {
    localStorage.removeItem(KEY)
  }
  async sendFeedback(): Promise<void> {} // local mode: no server to send it to
  async importRecipe(): Promise<ImportedRecipe> {
    throw new AppError('cloud_only', {}, 'Recipe import needs the cloud version — see the README to deploy.')
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
    d.toCook = d.toCook.filter((x) => x !== id)
    this.save(d)
  }
  async getList() {
    return sortItems(this.load().items)
  }
  async generateList(recipeIds: string[], mode: 'replace' | 'append') {
    if (recipeIds.length === 0) throw new AppError('pick_recipe', {}, 'Pick at least one recipe')
    const d = this.load()
    const recipes = [...new Set(recipeIds)].map((id) => {
      const recipe = d.recipes.find((r) => r.id === id)
      if (!recipe) throw new AppError('recipe_not_found', {}, `Recipe ${id} not found`)
      return recipe
    })
    // Same rules as the API: replace drops everything; append folds into unticked items only.
    const ticked = mode === 'append' ? d.items.filter((i) => i.checked) : []
    const unticked = mode === 'append' ? d.items.filter((i) => !i.checked) : []
    const fresh = combine([...unticked, ...aggregate(recipes)]).map((i) => ({ ...i, id: uid(), checked: false }))
    d.items = [...ticked, ...fresh]
    d.toCook = [...new Set([...d.toCook, ...recipes.map((r) => r.id)])].sort() // as the API does
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
    if (!item) throw new AppError('item_not_found', {}, 'Item not found')
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
