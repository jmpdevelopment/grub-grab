import { useState } from 'react'
import { parseIngredientLine } from '../lib/aggregate'
import { normaliseLink, safeHref } from '../lib/links'
import { translate, useI18n, type Lang } from '../i18n'
import { cleanTag } from '../lib/tags'
import type { ImportedRecipe, Ingredient, Recipe, RecipeInput } from '../types'

interface Props {
  recipe: Recipe | null
  /** Tags already used on other recipes, suggested first. */
  knownTags?: string[]
  onSave: (r: RecipeInput) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  /** The household's recipe language: starter tag suggestions come in it. Defaults to the app language. */
  recipeLanguage?: Lang
  /** "Fill from link": AI reads the page and fills the form for review. Absent when it's switched off. */
  onImport?: (link: string) => Promise<ImportedRecipe>
}

// aisle isn't shown: it comes from "Fill from link" and is kept so the shopping list can group by it.
type Row = { name: string; quantity: string; unit: string; aisle?: string }
const toRow = (i: Ingredient): Row => ({
  name: i.name,
  quantity: i.quantity === null ? '' : String(i.quantity),
  unit: i.unit,
  ...(i.aisle ? { aisle: i.aisle } : {}),
})
const emptyRow = (): Row => ({ name: '', quantity: '', unit: '' })

export function RecipeEditor({ recipe, knownTags = [], onSave, onDelete, onCancel, onImport, recipeLanguage }: Props) {
  const { t, errorText, suggestedTags: appLanguageTags } = useI18n()
  const suggestedTags = recipeLanguage ? translate(recipeLanguage, 'tags.suggested').split(', ') : appLanguageTags
  const [title, setTitle] = useState(recipe?.title ?? '')
  const [servings, setServings] = useState(recipe?.servings ? String(recipe.servings) : '')
  const [notes, setNotes] = useState(recipe?.notes ?? '')
  const [link, setLink] = useState(recipe?.link ?? '')
  const [tags, setTags] = useState<string[]>(recipe?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [rows, setRows] = useState<Row[]>(recipe ? [...recipe.ingredients.map(toRow), emptyRow()] : [emptyRow()])
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<number | null>(null) // imports left this month, after a fill
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
  const openHref = safeHref(normaliseLink(link) ?? undefined) // only once it's a usable web address
  const suggestions = [...new Set([...knownTags, ...suggestedTags])].filter((tag) => !tags.includes(tag))

  // Fills the form from the page; the person checks it and taps Save. Typed ingredients are only replaced
  // after asking, and a title or servings already entered are kept.
  const fillFromLink = async () => {
    if (rows.some((r) => r.name.trim()) && !confirm(t('editor.confirmReplaceIngredients'))) return
    setImporting(true)
    setError(null)
    setImported(null)
    try {
      const { recipe: draft, remaining } = await onImport!(openHref!)
      setTitle((current) => current.trim() || draft.title)
      setServings((current) => current || (draft.servings ? String(draft.servings) : ''))
      setLink(draft.link)
      setTags((current) => (draft.tags ?? []).reduce(withTag, current)) // suggestions join yours
      setRows([...draft.ingredients.map(toRow), emptyRow()])
      setImported(remaining)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setImporting(false)
    }
  }

  const save = async () => {
    if (!title.trim()) return setError(t('editor.needTitle'))
    const cleanLink = normaliseLink(link)
    if (cleanLink === null) return setError(t('editor.badLink'))
    const ingredients: Ingredient[] = []
    for (const r of rows) {
      if (!r.name.trim()) continue
      const q = r.quantity.trim().replace(',', '.')
      if (q && Number.isNaN(Number(q))) return setError(t('editor.notANumber', { value: r.quantity, name: r.name }))
      ingredients.push({ name: r.name.trim(), quantity: q ? Number(q) : null, unit: r.unit.trim(), ...(r.aisle ? { aisle: r.aisle } : {}) })
    }
    setBusy(true)
    setError(null)
    try {
      // A tag still being typed counts, so it isn't lost by tapping Save straight away.
      const allTags = withTag(tags, tagDraft)
      await onSave({ title: title.trim(), servings: servings ? Number(servings) : null, notes, link: cleanLink, tags: allTags, ingredients })
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <div className="editor">
      <header className="bar">
        <button className="link" onClick={onCancel}>{t('editor.cancel')}</button>
        <h2>{recipe ? t('editor.edit') : t('editor.new')}</h2>
        <button className="link strong" onClick={save} disabled={busy}>{t('editor.save')}</button>
      </header>

      <div className="content">
        {error && <p className="error">{error}</p>}
        <div className="field">
          <label htmlFor="recipe-link">{t('editor.linkLabel')}</label>
          <div className="link-row">
            <input
              id="recipe-link"
              autoFocus={!recipe && Boolean(onImport)}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder={t('editor.linkPlaceholder')}
            />
            {openHref && (
              <a className="btn secondary" href={openHref} target="_blank" rel="noopener noreferrer">
                {t('editor.open')}
              </a>
            )}
          </div>
          {onImport &&
            (openHref ? (
              <button className="btn import" disabled={importing || busy} onClick={fillFromLink}>
                {importing ? t('editor.reading') : t('editor.fill')}
              </button>
            ) : (
              <p className="hint">{t('editor.fillHint')}</p>
            ))}
          {imported !== null && <p className="hint">{t('editor.filled', { count: imported })}</p>}
        </div>
        <label className="field">
          <span>{t('editor.titleLabel')}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('editor.titlePlaceholder')} autoFocus={!recipe && !onImport} />
        </label>
        <label className="field narrow">
          <span>{t('editor.servesLabel')}</span>
          <input inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value.replace(/\D/g, ''))} placeholder="4" />
        </label>

        <div className="field">
          <span id="tags-label">{t('editor.tagsLabel')}</span>
          <div className="tags" role="group" aria-labelledby="tags-label">
            {tags.map((tag) => (
              <button key={tag} className="tag on" aria-label={t('editor.removeTag', { tag })} onClick={() => setTags((prev) => prev.filter((x) => x !== tag))}>
                {tag} ×
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
              placeholder={t('editor.addTag')}
              aria-label={t('editor.newTag')}
              enterKeyHint="done"
            />
          </div>
          {suggestions.length > 0 && (
            <div className="tags suggestions">
              {suggestions.map((tag) => (
                <button key={tag} className="tag" onClick={() => addTag(tag)}>
                  + {tag}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="section-head">
          <h3>{t('editor.ingredients')}</h3>
          <button className="link" onClick={() => setShowPaste((s) => !s)}>{showPaste ? t('editor.closePaste') : t('editor.pasteList')}</button>
        </div>

        {showPaste && (
          <div className="paste">
            <textarea
              rows={6}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={t('editor.pastePlaceholder')}
            />
            <button className="btn" onClick={applyPaste} disabled={!paste.trim()}>{t('editor.addThese')}</button>
          </div>
        )}

        <div className="ing-rows">
          {rows.map((r, i) => (
            <div className="ing-row" key={i}>
              <input className="qty" inputMode="decimal" value={r.quantity} onChange={(e) => updateRow(i, { quantity: e.target.value })} placeholder={t('editor.qty')} />
              <input className="unit" value={r.unit} onChange={(e) => updateRow(i, { unit: e.target.value })} placeholder={t('editor.unit')} />
              <input className="name" value={r.name} onChange={(e) => updateRow(i, { name: e.target.value })} placeholder={t('editor.ingredient')} />
              {r.name.trim() && <button className="icon" aria-label={t('editor.removeIngredient', { name: r.name })} onClick={() => removeRow(i)}>×</button>}
            </div>
          ))}
        </div>

        <label className="field">
          <span>{t('editor.notesLabel')}</span>
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('editor.notesPlaceholder')} />
        </label>

        {onDelete && (
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(t('editor.confirmDelete', { title }))) return
              setBusy(true)
              setError(null)
              try {
                await onDelete()
              } catch (e) {
                setError(errorText(e))
                setBusy(false)
              }
            }}
          >
            {t('editor.delete')}
          </button>
        )}
      </div>
    </div>
  )
}
