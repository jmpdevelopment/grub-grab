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
}

export type RecipeInput = Omit<Recipe, 'id'>

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
}

export interface Backend {
  readonly mode: 'local' | 'cloud'
  me(): Promise<Household>
  createHousehold(): Promise<Household>
  joinHousehold(code: string): Promise<Household>
  rotateInvite(): Promise<Household>
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
