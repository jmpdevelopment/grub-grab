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

const POLL_MS = 8000

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

  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        setError(null)
        return await fn()
      } catch (e) {
        if (e instanceof AuthRequiredError && boot.state === 'ready' && boot.cfg) {
          setBoot({ state: 'signin', cfg: boot.cfg })
          return
        }
        setError((e as Error).message)
      }
    },
    [boot],
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
    const tick = () => document.visibilityState === 'visible' && backend.getList().then(setItems).catch(() => {})
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
        <button className="btn" onClick={() => signIn(boot.cfg)}>Sign in</button>
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
          setRecipes((prev) => [...prev.filter((r) => r.id !== saved.id), saved].sort((x, y) => x.title.localeCompare(y.title)))
          setEditing(null)
        }}
        onDelete={
          recipe
            ? async () => {
                await guard(() => b.deleteRecipe(recipe.id))
                setRecipes((prev) => prev.filter((r) => r.id !== recipe.id))
                setEditing(null)
              }
            : undefined
        }
      />
    )
  }

  return (
    <div className="app">
      {error && (
        <div className="banner" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <main>
        {tab === 'recipes' && (
          <RecipesView
            recipes={recipes}
            hasList={items.length > 0}
            onOpen={(r) => setEditing(r ?? 'new')}
            onMakeList={async (ids, mode) => {
              const list = await guard(() => b.generateList(ids, mode))
              if (list) {
                setItems(list)
                setTab('list')
              }
            }}
          />
        )}
        {tab === 'list' && (
          <ListView
            items={items}
            onRefresh={refresh}
            onToggle={async (item) => {
              // Optimistic: tick instantly, roll back if the request fails.
              setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: !i.checked } : i)))
              const ok = await guard(() => b.setChecked(item.id, !item.checked))
              if (!ok) setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)))
            }}
            onAdd={async (input) => {
              const added = await guard(() => b.addItem(input))
              if (added) setItems((prev) => [added, ...prev])
            }}
            onDelete={async (item) => {
              setItems((prev) => prev.filter((i) => i.id !== item.id))
              await guard(() => b.deleteItem(item.id))
            }}
            onClear={async (onlyChecked) => {
              await guard(() => b.clearList(onlyChecked))
              setItems((prev) => (onlyChecked ? prev.filter((i) => !i.checked) : []))
            }}
          />
        )}
        {tab === 'settings' && (
          <SettingsView
            mode={b.mode}
            household={household}
            email={currentEmail()}
            onSignOut={() => boot.cfg && signOut(boot.cfg)}
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
          <span aria-hidden>🛒</span>List{items.some((i) => !i.checked) ? ` (${items.filter((i) => !i.checked).length})` : ''}
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span aria-hidden>⚙️</span>Settings
        </button>
      </nav>
    </div>
  )
}
