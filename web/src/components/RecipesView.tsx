import { useState } from 'react'
import { safeHref } from '../lib/links'
import type { Recipe } from '../types'

const tagsOf = (r: Recipe) => r.tags ?? [] // recipes saved before tags existed have none

interface Props {
  recipes: Recipe[]
  onOpen: (r: Recipe | null) => void
  onMakeList: (ids: string[], mode: 'replace' | 'append') => Promise<void>
  hasList: boolean
}

export function RecipesView({ recipes, onOpen, onMakeList, hasList }: Props) {
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
    if (mode === 'replace' && hasList && !confirm('Replace the current shopping list?')) return
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
  for (const r of recipes) for (const t of tagsOf(r)) counts.set(t, (counts.get(t) ?? 0) + 1)
  const allTags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
  const activeTag = tag && counts.has(tag) ? tag : null // forget a filter whose last recipe lost the tag

  const q = query.trim().toLowerCase()
  const matches = (r: Recipe) =>
    !q ||
    r.title.toLowerCase().includes(q) ||
    r.ingredients.some((i) => i.name.toLowerCase().includes(q)) ||
    tagsOf(r).some((t) => t.includes(q))
  const shown = recipes.filter((r) => matches(r) && (!activeTag || tagsOf(r).includes(activeTag)))

  return (
    <>
      <header className="bar">
        <h1>Recipes</h1>
        <button className="link strong" onClick={() => onOpen(null)}>+ New</button>
      </header>
      <div className="content">
        {recipes.length > 4 && (
          <input className="search" type="search" placeholder="Search recipes or ingredients" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}

        {allTags.length > 0 && (
          <div className="tag-filter" role="group" aria-label="Filter by tag">
            {allTags.map((t) => (
              <button key={t} className="tag" aria-pressed={activeTag === t} onClick={() => setTag(activeTag === t ? null : t)}>
                {t}
              </button>
            ))}
          </div>
        )}

        {recipes.length === 0 ? (
          <div className="empty">
            <p>No recipes yet.</p>
            <button className="btn" onClick={() => onOpen(null)}>Add your first recipe</button>
          </div>
        ) : (
          <>
            <p className="hint">Tick the recipes you're cooking, then make a shopping list.</p>
            {shown.length === 0 && <p className="muted">No recipes match.</p>}
            <ul className="cards">
              {shown.map((r) => (
                <li key={r.id} className={selected.has(r.id) ? 'card selected' : 'card'}>
                  <label className="check">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </label>
                  <button className="card-body" onClick={() => onOpen(r)}>
                    <strong>{r.title}</strong>
                    <span className="muted">
                      {r.ingredients.length} ingredient{r.ingredients.length === 1 ? '' : 's'}
                      {r.servings ? ` · serves ${r.servings}` : ''}
                    </span>
                    {tagsOf(r).length > 0 && <span className="card-tags">{tagsOf(r).join(' · ')}</span>}
                  </button>
                  {safeHref(r.link) && (
                    <a
                      className="card-link"
                      href={safeHref(r.link)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open the ${r.title} recipe page`}
                    >
                      ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {selected.size > 0 && (
        <div className="action-bar">
          {hasList && (
            <button className="btn secondary" disabled={busy} onClick={() => make('append')}>
              Add to list
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => make('replace')}>
            {hasList ? 'New list' : 'Make list'} ({selected.size})
          </button>
        </div>
      )}
    </>
  )
}
