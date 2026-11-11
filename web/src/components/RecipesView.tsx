import { useState } from 'react'
import { useI18n } from '../i18n'
import { safeHref } from '../lib/links'
import type { Recipe } from '../types'
import { LoadingCards } from './LoadingCards'

const tagsOf = (r: Recipe) => r.tags ?? [] // recipes saved before tags existed have none

interface Props {
  recipes: Recipe[]
  onOpen: (r: Recipe | null) => void
  onMakeList: (ids: string[], mode: 'replace' | 'append') => Promise<void>
  hasList: boolean
  /** True until the first load has arrived: show placeholders, not "No recipes yet". */
  loading?: boolean
  /** Recipes picked for a shopping list: kept at the top, ticked, until someone unticks them. */
  toCook?: string[]
  onCooked?: (recipe: Recipe) => void
}

export function RecipesView({ recipes, onOpen, onMakeList, hasList, loading = false, toCook = [], onCooked }: Props) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const make = async (mode: 'replace' | 'append') => {
    if (mode === 'replace' && hasList && !confirm(t('recipes.confirmReplace'))) return
    setBusy(true)
    try {
      await onMakeList([...selected], mode)
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  // Every tag in use, most-used first, for the filter chips.
  const counts = new Map<string, number>()
  for (const r of recipes) for (const tag of tagsOf(r)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const allTags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag)
  const activeTag = tag && counts.has(tag) ? tag : null // forget a filter whose last recipe lost the tag

  const q = query.trim().toLowerCase()
  const matches = (r: Recipe) =>
    !q ||
    r.title.toLowerCase().includes(q) ||
    r.ingredients.some((i) => i.name.toLowerCase().includes(q)) ||
    tagsOf(r).some((tag) => tag.includes(q))
  const shown = recipes.filter((r) => matches(r) && (!activeTag || tagsOf(r).includes(activeTag)))
  const cooking = new Set(toCook)
  const toCookShown = shown.filter((r) => cooking.has(r.id))
  const rest = shown.filter((r) => !cooking.has(r.id))

  const card = (r: Recipe, planned: boolean) => (
    <li key={r.id} className={planned ? 'card to-cook' : selected.has(r.id) ? 'card selected' : 'card'}>
      <label className="check">
        {planned ? (
          // Ticked while it's still to cook; unticking takes it off (cooked, or not planned any more).
          <input type="checkbox" checked aria-label={t('recipes.toCookItem', { title: r.title })} onChange={() => onCooked?.(r)} />
        ) : (
          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
        )}
      </label>
      <button className="card-body" onClick={() => onOpen(r)}>
        <strong>{r.title}</strong>
        <span className="muted">
          {t('recipes.ingredientCount', { count: r.ingredients.length })}
          {r.servings ? ` · ${t('recipes.serves', { count: r.servings })}` : ''}
        </span>
        {tagsOf(r).length > 0 && <span className="card-tags">{tagsOf(r).join(' · ')}</span>}
      </button>
      {safeHref(r.link) && (
        <a
          className="card-link"
          href={safeHref(r.link)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('recipes.openPage', { title: r.title })}
        >
          ↗
        </a>
      )}
    </li>
  )

  return (
    <>
      <header className="bar">
        <h1>{t('recipes.title')}</h1>
        <button className="link strong" onClick={() => onOpen(null)}>{t('recipes.new')}</button>
      </header>
      <div className="content">
        {recipes.length > 4 && (
          <input className="search" type="search" placeholder={t('recipes.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        )}

        {allTags.length > 0 && (
          <div className="tag-filter" role="group" aria-label={t('recipes.filterByTag')}>
            {allTags.map((tag) => (
              <button key={tag} className="tag" aria-pressed={activeTag === tag} onClick={() => setTag(activeTag === tag ? null : tag)}>
                {tag}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <LoadingCards label={t('recipes.loading')} />
        ) : recipes.length === 0 ? (
          <div className="empty">
            <p>{t('recipes.empty')}</p>
            <button className="btn" onClick={() => onOpen(null)}>{t('recipes.addFirst')}</button>
          </div>
        ) : (
          <>
            {toCookShown.length > 0 && (
              <section aria-labelledby="to-cook">
                <h2 id="to-cook" className="section-title">{t('recipes.toCook')}</h2>
                <p className="hint">{t('recipes.toCookHint')}</p>
                <ul className="cards">{toCookShown.map((r) => card(r, true))}</ul>
              </section>
            )}
            {toCookShown.length > 0 && <h2 className="section-title">{t('recipes.all')}</h2>}
            <p className="hint">{t('recipes.hint')}</p>
            {shown.length === 0 && <p className="muted">{t('recipes.noMatch')}</p>}
            <ul className="cards">{rest.map((r) => card(r, false))}</ul>
          </>
        )}
      </div>

      {selected.size > 0 && (
        <div className="action-bar">
          {hasList && (
            <button className="btn secondary" disabled={busy} onClick={() => make('append')}>
              {t('recipes.addToList')}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => make('replace')}>
            {t(hasList ? 'recipes.newList' : 'recipes.makeList', { count: selected.size })}
          </button>
        </div>
      )}
    </>
  )
}
