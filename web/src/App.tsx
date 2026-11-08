import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessRequests } from './components/AccessRequests'
import { HouseholdSetup } from './components/HouseholdSetup'
import { LanguagePicker } from './components/LanguagePicker'
import { PullToRefresh } from './components/PullToRefresh'
import { ListView } from './components/ListView'
import { RecipeEditor } from './components/RecipeEditor'
import { RecipesView } from './components/RecipesView'
import { SettingsView } from './components/SettingsView'
import { updateApp, watchForAppUpdates } from './lib/appUpdate'
import { completeSignIn, currentEmail, forgetSession, getAccessToken, SignInNotice, signIn, signOut } from './lib/auth'
import { AuthRequiredError, CloudBackend, LocalBackend } from './lib/backend'
import { loadConfig, type AppConfig } from './lib/config'
import { I18nProvider, isLang, useI18n, type MessageKey } from './i18n'
import type { Backend, Household, ListItem, Recipe } from './types'

type Tab = 'recipes' | 'list' | 'settings'
type Boot = { state: 'loading' } | { state: 'signin'; cfg: AppConfig } | { state: 'ready'; backend: Backend; cfg: AppConfig | null }

export const POLL_MS = 8000

/** Returned by `guard` when the call failed (distinct from a call that succeeds with no data). */
const FAILED = Symbol('failed')

const byTitle = (a: Recipe, b: Recipe) => a.title.localeCompare(b.title)

export default function App() {
  return (
    <I18nProvider>
      <GrubGrab />
    </I18nProvider>
  )
}

function GrubGrab() {
  const { t, errorText, lang, setLang } = useI18n()
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })
  const [tab, setTab] = useState<Tab>('recipes')
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [items, setItems] = useState<ListItem[]>([])
  const [household, setHousehold] = useState<Household | null>(null)
  const [editing, setEditing] = useState<Recipe | null | 'new'>(null)
  // Kept as the error / message key (not text) so they show in whatever language is picked.
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<MessageKey | null>(null)
  const [loaded, setLoaded] = useState(false) // first recipes + list have arrived
  const [refreshes, setRefreshes] = useState(0) // tells panels that load their own data to reload
  // The app language saved on the signed-in account (null until /me has loaded): it follows them across
  // devices. Kept in refs so changing language doesn't re-run the data loading.
  const accountLang = useRef<string | null>(null)
  const langRef = useRef(lang)
  useEffect(() => {
    langRef.current = lang
  }, [lang])

  // ---- startup -------------------------------------------------------------
  useEffect(() => {
    watchForAppUpdates()
    ;(async () => {
      const cfg = await loadConfig()
      if (!cfg) return setBoot({ state: 'ready', backend: new LocalBackend(), cfg: null })
      try {
        await completeSignIn(cfg)
      } catch (e) {
        if (e instanceof SignInNotice) setNotice(e.key)
        else setError(e)
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
        else setError(e)
        return FAILED
      }
    },
    [cfg],
  )

  const refresh = useCallback(async () => {
    if (!backend) return
    await guard(async () => {
      const h = await backend.me()
      if (backend.mode === 'cloud' && accountLang.current === null) {
        if (isLang(h.language)) {
          accountLang.current = h.language
          setLang(h.language) // their account's choice wins over this device's
        } else {
          accountLang.current = langRef.current // a new account starts with whatever they're using now
          backend.saveLanguage(langRef.current).catch(() => {})
        }
      }
      setHousehold(h)
      setRefreshes((n) => n + 1)
      if (!h.householdId) return // new user: the welcome screen asks them to start or join one first
      const [r, l] = await Promise.all([backend.listRecipes(), backend.getList()])
      setRecipes(r)
      setItems(l)
      setLoaded(true)
    })
  }, [backend, guard, setLang])

  // Picking a language while signed in saves it to the account (best effort: it still applies here).
  useEffect(() => {
    if (backend?.mode !== 'cloud' || accountLang.current === null || accountLang.current === lang) return
    accountLang.current = lang
    backend.saveLanguage(lang).catch(() => {})
  }, [backend, lang])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Admin panel: stable callbacks so it loads once per visit to Settings.
  const loadRequests = useCallback(() => backend!.listAccessRequests(), [backend])
  // The panel only shows once the household has loaded, so it's always set here.
  const setPendingCount = useCallback((pendingRequests: number) => setHousehold((h) => ({ ...h!, pendingRequests })), [])

  /** Pull-to-refresh: switch to a newly deployed version if there is one, otherwise reload the data. */
  const pullRefresh = useCallback(async () => {
    if (await updateApp()) return
    await refresh()
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
  if (boot.state === 'loading') return <div className="splash">{t('app.loading')}</div>

  if (boot.state === 'signin')
    return (
      <div className="splash">
        <div className="splash-lang">
          <LanguagePicker />
        </div>
        <img src="/icon.svg" alt="" width={96} height={96} />
        <h1>Grub Grab</h1>
        <p className="muted">{t('app.tagline')}</p>
        {notice && <p className="notice">{t(notice)}</p>}
        {error !== null && <p className="error">{errorText(error)}</p>}
        <button className="btn google" onClick={() => signIn(boot.cfg)}>
          {t('signin.google')}
        </button>
        <p className="legal">
          <a href="/privacy.html" target="_blank" rel="noopener">
            {t('app.privacy')}
          </a>
        </p>
      </div>
    )

  const b = boot.backend

  // Wait for /me before showing anything, so a new user never sees an empty app flash before the welcome screen.
  // (If /me fails, fall through to the app, which shows the error banner.)
  if (household === null && error === null) return <div className="splash">{t('app.loading')}</div>

  if (household && !household.householdId)
    return (
      <div className="app">
        <main>
          <HouseholdSetup
            email={currentEmail()}
            onSignOut={() => void signOut(cfg!)} // only cloud users lack a household, and cloud mode always has cfg
            onStart={async () => {
              setHousehold(await b.createHousehold(lang)) // its recipe language starts as theirs
              await refresh()
            }}
            onJoin={async (code) => {
              setHousehold(await b.joinHousehold(code))
              await refresh()
            }}
          />
        </main>
      </div>
    )

  if (editing !== null) {
    const recipe = editing === 'new' ? null : editing
    return (
      <RecipeEditor
        recipe={recipe}
        knownTags={[...new Set(recipes.flatMap((r) => r.tags ?? []))].sort()}
        onImport={cfg?.aiImport && b.mode === 'cloud' ? b.importRecipe : undefined}
        recipeLanguage={isLang(household?.recipeLanguage) ? household.recipeLanguage : undefined}
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
  // Placeholders until the first load arrives. If it failed, the error banner explains instead.
  const loading = !loaded && !error

  return (
    <div className="app">
      <PullToRefresh onRefresh={pullRefresh} />
      {error !== null && (
        <button className="banner" role="alert" onClick={() => setError(null)}>
          {errorText(error)}
        </button>
      )}
      <main>
        {tab === 'recipes' && (
          <RecipesView
            recipes={recipes}
            loading={loading}
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
            loading={loading}
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
            onSignOut={() => void signOut(cfg!)} // the button only exists in cloud mode, where cfg is set
            onDeleteAccount={
              b.mode === 'cloud'
                ? async () => {
                    await b.deleteAccount()
                    forgetSession()
                    setRecipes([])
                    setItems([])
                    setHousehold(null)
                    setNotice('signin.accountDeleted')
                    setBoot({ state: 'signin', cfg: cfg! })
                  }
                : undefined
            }
            adminPanel={
              household?.admin && (
                <AccessRequests
                  load={loadRequests}
                  decide={b.decideAccess}
                  declineAll={b.declineAllPending}
                  onCount={setPendingCount}
                  reloadKey={refreshes}
                />
              )
            }
            onRotate={async () => setHousehold(await b.rotateInvite())}
            onRecipeLanguage={
              b.mode === 'cloud'
                ? async (language) => {
                    const updated = await guard(() => b.setRecipeLanguage(language))
                    if (updated !== FAILED) setHousehold((h) => ({ ...h!, ...updated }))
                  }
                : undefined
            }
            onJoin={async (code) => {
              setHousehold(await b.joinHousehold(code))
              await refresh()
            }}
          />
        )}
      </main>

      <nav className="tabs">
        <button className={tab === 'recipes' ? 'active' : ''} onClick={() => setTab('recipes')}>
          <span aria-hidden>📖</span>
          {t('tab.recipes')}
        </button>
        <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>
          <span aria-hidden>🛒</span>
          {t('tab.list')}
          {toBuy ? ` (${toBuy})` : ''}
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span aria-hidden>⚙️</span>
          {t('tab.settings')}
          {household?.pendingRequests ? ` (${household.pendingRequests})` : ''}
        </button>
      </nav>
    </div>
  )
}
