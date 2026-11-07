import { useState } from 'react'
import type { Recipe } from '../types'

interface Props {
  recipes: Recipe[]
  onOpen: (r: Recipe | null) => void
  onMakeList: (ids: string[], mode: 'replace' | 'append') => Promise<void>
  hasList: boolean
}

export function RecipesView({ recipes, onOpen, onMakeList, hasList }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
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

  const q = query.trim().toLowerCase()
  const shown = q
    ? recipes.filter((r) => r.title.toLowerCase().includes(q) || r.ingredients.some((i) => i.name.toLowerCase().includes(q)))
    : recipes

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

        {recipes.length === 0 ? (
          <div className="empty">
            <p>No recipes yet.</p>
            <button className="btn" onClick={() => onOpen(null)}>Add your first recipe</button>
          </div>
        ) : (
          <>
            <p className="hint">Tick the recipes you're cooking, then make a shopping list.</p>
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
                  </button>
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
