export interface Ingredient {
  name: string
  quantity: number | null
  unit: string
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
}

export interface ListItem {
  id: string
  name: string
  quantity: number | null
  unit: string
  checked: boolean
  recipes: string[]
}

export interface Household {
  /** null until the user starts a household or joins one (cloud mode, first sign-in). */
  householdId: string | null
  inviteCode: string | null
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
  createHousehold(): Promise<Household>
  joinHousehold(code: string): Promise<Household>
  rotateInvite(): Promise<Household>
  importRecipe(link: string): Promise<ImportedRecipe>
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
