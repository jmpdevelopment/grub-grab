export interface Ingredient {
  name: string
  quantity: number | null
  unit: string
  /** Shop aisle (see lib/aisles), from "Fill from link". Missing on ingredients typed by hand. */
  aisle?: string
}

export interface Recipe {
  id: string
  title: string
  servings: number | null
  notes: string
  ingredients: Ingredient[]
  /** Lower-case labels like "soup" or "fish". Missing on recipes saved before tags existed. */
  tags?: string[]
  /** Web page the recipe came from ('' or missing if none). */
  link?: string
}

export type RecipeInput = Omit<Recipe, 'id'>

/** What "Fill from link" returns: a draft for the editor to review. It is never saved by itself. */
export interface ImportedRecipe {
  recipe: { title: string; servings: number | null; link: string; tags?: string[]; ingredients: Ingredient[] }
  remaining: number // imports left for the household this month
  /** The server's import job: a problem report or the import's outcome refers to it. */
  jobId?: string
}

/** A problem report, automatic error report or import outcome (POST /feedback; see lib/feedback). */
export interface FeedbackBody {
  kind: 'import' | 'general' | 'error' | 'outcome'
  jobId?: string
  problems?: string[]
  marked?: string[] // the AI's ingredients someone marked as wrong
  note?: string
  edits?: unknown // what they changed in the AI's draft (lib/importChanges)
  errorCode?: string // why an import failed, when it never got a job
  error?: { code: string; where: string; message: string; stack: string }
  outcome?: 'unchanged' | 'edited' | 'abandoned'
  changes?: Record<string, number>
  client?: Record<string, string | boolean>
  journey?: unknown[]
}

export interface ListItem {
  id: string
  name: string
  quantity: number | null
  unit: string
  checked: boolean
  recipes: string[]
  /** Shop aisle the item's ingredient came with, if any (see lib/aisles). */
  aisle?: string
}

export interface Household {
  /** null until the user starts a household or joins one (cloud mode, first sign-in). */
  householdId: string | null
  inviteCode: string | null
  /** What "Fill from link" writes in, for everyone in the household. */
  recipeLanguage?: string
  /** Where the household moved list items: {item name: aisle}, applied from then on. */
  aisles?: Record<string, string>
  /** Recipes picked for a shopping list, shown under "To cook" until someone unticks them. */
  toCook?: string[]
  /** This person's app language, saved on their account (absent until first saved). */
  language?: string
  /** Admins approve sign-up requests; only present for them. */
  admin?: boolean
  pendingRequests?: number
}

/** Someone who signed in with Google and is waiting for an admin to let them in. */
export interface AccessRequest {
  username: string
  email: string
  name: string
  requestedAt: number // seconds since 1970
}

export interface Backend {
  readonly mode: 'local' | 'cloud'
  me(): Promise<Household>
  createHousehold(language?: string): Promise<Household>
  saveLanguage(language: string): Promise<void>
  setRecipeLanguage(language: string): Promise<Household>
  joinHousehold(code: string): Promise<Household>
  rotateInvite(): Promise<Household>
  /** Put this item (by name) in another aisle, for the whole household from now on. */
  setAisle(name: string, aisle: string): Promise<Household>
  /** Take a recipe off "To cook" (it's been cooked, or isn't planned any more). */
  removeToCook(recipeId: string): Promise<Household>
  importRecipe(link: string): Promise<ImportedRecipe>
  /** Problem reports, error reports and import outcomes. Local mode has nowhere to send them. */
  sendFeedback(body: FeedbackBody): Promise<void>
  /** Permanently delete the account (cloud) or this device's data (local). */
  deleteAccount(): Promise<void>
  listAccessRequests(): Promise<AccessRequest[]>
  decideAccess(username: string, approve: boolean): Promise<void>
  declineAllPending(): Promise<number>
  listRecipes(): Promise<Recipe[]>
  createRecipe(r: RecipeInput): Promise<Recipe>
  updateRecipe(id: string, r: RecipeInput): Promise<Recipe>
  deleteRecipe(id: string): Promise<void>
  getList(): Promise<ListItem[]>
  generateList(recipeIds: string[], mode: 'replace' | 'append'): Promise<ListItem[]>
  addItem(item: Pick<ListItem, 'name' | 'quantity' | 'unit'>): Promise<ListItem>
  setChecked(id: string, checked: boolean): Promise<ListItem>
  deleteItem(id: string): Promise<void>
  clearList(onlyChecked: boolean): Promise<void>
}
