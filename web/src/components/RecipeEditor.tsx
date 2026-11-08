import { useState } from 'react'
import { parseIngredientLine } from '../lib/aggregate'
import { cleanTag, SUGGESTED_TAGS } from '../lib/tags'
import type { Ingredient, Recipe, RecipeInput } from '../types'

interface Props {
  recipe: Recipe | null
  /** Tags already used on other recipes, suggested first. */
  knownTags?: string[]
  onSave: (r: RecipeInput) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
}

type Row = { name: string; quantity: string; unit: string }
const toRow = (i: Ingredient): Row => ({ name: i.name, quantity: i.quantity === null ? '' : String(i.quantity), unit: i.unit })
const emptyRow = (): Row => ({ name: '', quantity: '', unit: '' })

export function RecipeEditor({ recipe, knownTags = [], onSave, onDelete, onCancel }: Props) {
  const [title, setTitle] = useState(recipe?.title ?? '')
  const [servings, setServings] = useState(recipe?.servings ? String(recipe.servings) : '')
  const [notes, setNotes] = useState(recipe?.notes ?? '')
  const [tags, setTags] = useState<string[]>(recipe?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [rows, setRows] = useState<Row[]>(recipe ? [...recipe.ingredients.map(toRow), emptyRow()] : [emptyRow()])
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateRow = (idx: number, patch: Partial<Row>) => {
    setRows((prev) => {
      const next = prev.map((r, i) => (i === idx ? { ...r, ...patch } : r))
      // Always keep one blank row at the end for quick entry.
      if (next[next.length - 1].name.trim()) next.push(emptyRow())
      return next
    })
  }

  // Only named rows can be removed, and a blank row always trails them, so at least one row remains.
  const removeRow = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx))

  const applyPaste = () => {
    const parsed = paste.split('\n').map(parseIngredientLine).filter((x): x is Ingredient => x !== null)
    setRows((prev) => [...prev.filter((r) => r.name.trim()), ...parsed.map(toRow), emptyRow()])
    setPaste('')
    setShowPaste(false)
  }

  const withTag = (list: string[], raw: string) => {
    const tag = cleanTag(raw)
    return tag && !list.includes(tag) ? [...list, tag] : list
  }
  const addTag = (raw: string) => {
    setTags((prev) => withTag(prev, raw))
    setTagDraft('')
  }
  const suggestions = [...new Set([...knownTags, ...SUGGESTED_TAGS])].filter((t) => !tags.includes(t))

  const save = async () => {
    if (!title.trim()) return setError('Give the recipe a title')
    const ingredients: Ingredient[] = []
    for (const r of rows) {
      if (!r.name.trim()) continue
      const q = r.quantity.trim().replace(',', '.')
      if (q && Number.isNaN(Number(q))) return setError(`"${r.quantity}" isn't a number (${r.name})`)
      ingredients.push({ name: r.name.trim(), quantity: q ? Number(q) : null, unit: r.unit.trim() })
    }
    setBusy(true)
    setError(null)
    try {
      // A tag still being typed counts, so it isn't lost by tapping Save straight away.
      const allTags = withTag(tags, tagDraft)
      await onSave({ title: title.trim(), servings: servings ? Number(servings) : null, notes, tags: allTags, ingredients })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="editor">
      <header className="bar">
        <button className="link" onClick={onCancel}>Cancel</button>
        <h2>{recipe ? 'Edit recipe' : 'New recipe'}</h2>
        <button className="link strong" onClick={save} disabled={busy}>Save</button>
      </header>

      <div className="content">
        {error && <p className="error">{error}</p>}
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Chicken curry" autoFocus={!recipe} />
        </label>
        <label className="field narrow">
          <span>Serves</span>
          <input inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value.replace(/\D/g, ''))} placeholder="4" />
        </label>

        <div className="field">
          <span id="tags-label">Tags</span>
          <div className="tags" role="group" aria-labelledby="tags-label">
            {tags.map((t) => (
              <button key={t} className="tag on" aria-label={`Remove tag ${t}`} onClick={() => setTags((prev) => prev.filter((x) => x !== t))}>
                {t} ×
              </button>
            ))}
            <input
              className="tag-input"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addTag(tagDraft)
                }
              }}
              onBlur={() => addTag(tagDraft)}
              placeholder="Add a tag"
              aria-label="New tag"
              enterKeyHint="done"
            />
          </div>
          {suggestions.length > 0 && (
            <div className="tags suggestions">
              {suggestions.map((t) => (
                <button key={t} className="tag" onClick={() => addTag(t)}>
                  + {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="section-head">
          <h3>Ingredients</h3>
          <button className="link" onClick={() => setShowPaste((s) => !s)}>{showPaste ? 'Close' : 'Paste a list'}</button>
        </div>

        {showPaste && (
          <div className="paste">
            <textarea
              rows={6}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'One per line, e.g.\n500 g spaghetti\n3 cloves garlic\n2 tbsp olive oil\nsalt'}
            />
            <button className="btn" onClick={applyPaste} disabled={!paste.trim()}>Add these</button>
          </div>
        )}

        <div className="ing-rows">
          {rows.map((r, i) => (
            <div className="ing-row" key={i}>
              <input className="qty" inputMode="decimal" value={r.quantity} onChange={(e) => updateRow(i, { quantity: e.target.value })} placeholder="Qty" />
              <input className="unit" value={r.unit} onChange={(e) => updateRow(i, { unit: e.target.value })} placeholder="Unit" />
              <input className="name" value={r.name} onChange={(e) => updateRow(i, { name: e.target.value })} placeholder="Ingredient" />
              {r.name.trim() && <button className="icon" aria-label={`Remove ${r.name}`} onClick={() => removeRow(i)}>×</button>}
            </div>
          ))}
        </div>

        <label className="field">
          <span>Notes</span>
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Method, link, tips…" />
        </label>

        {onDelete && (
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Delete "${title}"?`)) return
              setBusy(true)
              setError(null)
              try {
                await onDelete()
              } catch (e) {
                setError((e as Error).message)
                setBusy(false)
              }
            }}
          >
            Delete recipe
          </button>
        )}
      </div>
    </div>
  )
}
