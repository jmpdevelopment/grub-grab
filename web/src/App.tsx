import { useCallback, useEffect, useState } from 'react'
import { ListView } from './components/ListView'
import { RecipeEditor } from './components/RecipeEditor'
import { RecipesView } from './components/RecipesView'
import { SettingsView } from './components/SettingsView'
import { completeSignIn, currentEmail, getAccessToken, signIn, signOut } from './lib/auth'
import { AuthRequiredError, CloudBackend, LocalBackend } from './lib/backend'
import { loadConfig, type AppConfig } from './lib/config'
import type { Backend, Household, ListItem, Recipe } from './types'

type Tab = 'recipes' | 'list' | 'settings'
type Boot = { state: 'loading' } | { state: 'signin'; cfg: AppConfig } | { state: 'ready'; backend: Backend; cfg: AppConfig | null }

export const POLL_MS = 8000

/** Returned by `guard` when the call failed (distinct from a call that succeeds with no data). */
const FAILED = Symbol('failed')

const byTitle = (a: Recipe, b: Recipe) => a.title.localeCompare(b.title)

export default function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })
  const [tab, setTab] = useState<Tab>('recipes')
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [items, setItems] = useState<ListItem[]>([])
  const [household, setHousehold] = useState<Household | null>(null)
  const [editing, setEditing] = useState<Recipe | null | 'new'>(null)
  const [error, setError] = useState<string | null>(null)

  // ---- startup -------------------------------------------------------------
  useEffect(() => {
    ;(async () => {
      const cfg = await loadConfig()
      if (!cfg) return setBoot({ state: 'ready', backend: new LocalBackend(), cfg: null })
      try {
        await completeSignIn(cfg)
      } catch (e) {
        setError((e as Error).message)
      }
      if (!(await getAccessToken(cfg))) return setBoot({ state: 'signin', cfg })
      setBoot({ state: 'ready', backend: new CloudBackend(cfg), cfg })
    })()
  }, [])

  const backend = boot.state === 'ready' ? boot.backend : null
  const cfg = boot.state === 'loading' ? null : boot.cfg

  /** Run a backend call: clear the old error, show a new one, or send the user to sign in. */
  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | typeof FAILED> => {
      try {
        setError(null)
        return await fn()
      } catch (e) {
        // Only the cloud backend raises AuthRequiredError, and it only exists when cfg is set.
        if (e instanceof AuthRequiredError) setBoot({ state: 'signin', cfg: cfg! })
        else setError((e as Error).message)
        return FAILED
      }
    },
    [cfg],
  )

  const refresh = useCallback(async () => {
    if (!backend) return
    await guard(async () => {
      const [r, l, h] = await Promise.all([backend.listRecipes(), backend.getList(), backend.me()])
      setRecipes(r)
      setItems(l)
      setHousehold(h)
    })
  }, [backend, guard])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Keep the list in sync with the other phone while it's open.
  useEffect(() => {
    if (backend?.mode !== 'cloud' || tab !== 'list') return
    const tick = () => {
      if (document.visibilityState === 'visible') backend.getList().then(setItems, () => {})
    }
    const id = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [backend, tab])

  // ---- render ---------------------------------------------------------------
  if (boot.state === 'loading') return <div className="splash">Loading…</div>

  if (boot.state === 'signin')
    return (
      <div className="splash">
        <img src="/icon.svg" alt="" width={96} height={96} />
        <h1>Grub Grab</h1>
        <p className="muted">Recipes in, shopping list out.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" onClick={() => signIn(boot.cfg)}>
          Sign in
        </button>
      </div>
    )

  const b = boot.backend

  if (editing !== null) {
    const recipe = editing === 'new' ? null : editing
    return (
      <RecipeEditor
        recipe={recipe}
        onCancel={() => setEditing(null)}
        onSave={async (input) => {
          const saved = recipe ? await b.updateRecipe(recipe.id, input) : await b.createRecipe(input)
          setRecipes((prev) => [...prev.filter((r) => r.id !== saved.id), saved].sort(byTitle))
          setEditing(null)
        }}
        onDelete={
          recipe
            ? async () => {
                await b.deleteRecipe(recipe.id) // errors are shown by the editor
                setRecipes((prev) => prev.filter((r) => r.id !== recipe.id))
                setEditing(null)
              }
            : undefined
        }
      />
    )
  }

  const toBuy = items.filter((i) => !i.checked).length

  return (
    <div className="app">
      {error && (
        <button className="banner" role="alert" onClick={() => setError(null)}>
          {error}
        </button>
      )}
      <main>
        {tab === 'recipes' && (
          <RecipesView
            recipes={recipes}
            hasList={items.length > 0}
            onOpen={(r) => setEditing(r ?? 'new')}
            onMakeList={async (ids, mode) => {
              const list = await guard(() => b.generateList(ids, mode))
              if (list === FAILED) return
              setItems(list)
              setTab('list')
            }}
          />
        )}
        {tab === 'list' && (
          <ListView
            items={items}
            onRefresh={refresh}
            onToggle={async (item) => {
              // Optimistic: tick instantly, roll back if the request fails.
              setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: !item.checked } : i)))
              if ((await guard(() => b.setChecked(item.id, !item.checked))) === FAILED)
                setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)))
            }}
            onAdd={async (input) => {
              const added = await guard(() => b.addItem(input))
              if (added !== FAILED) setItems((prev) => [added, ...prev])
            }}
            onDelete={async (item) => {
              setItems((prev) => prev.filter((i) => i.id !== item.id))
              if ((await guard(() => b.deleteItem(item.id))) === FAILED) setItems((prev) => [...prev, item])
            }}
            onClear={async (onlyChecked) => {
              if ((await guard(() => b.clearList(onlyChecked))) === FAILED) return
              setItems((prev) => (onlyChecked ? prev.filter((i) => !i.checked) : []))
            }}
          />
        )}
        {tab === 'settings' && (
          <SettingsView
            mode={b.mode}
            household={household}
            email={currentEmail()}
            onSignOut={() => signOut(cfg!)} // the button only exists in cloud mode, where cfg is set
            onJoin={async (code) => {
              setHousehold(await b.joinHousehold(code))
              await refresh()
            }}
          />
        )}
      </main>

      <nav className="tabs">
        <button className={tab === 'recipes' ? 'active' : ''} onClick={() => setTab('recipes')}>
          <span aria-hidden>📖</span>Recipes
        </button>
        <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>
          <span aria-hidden>🛒</span>List{toBuy ? ` (${toBuy})` : ''}
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span aria-hidden>⚙️</span>Settings
        </button>
      </nav>
    </div>
  )
}
