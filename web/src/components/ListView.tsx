import { useState } from 'react'
import { formatQty, listAsText, parseIngredientLine } from '../lib/aggregate'
import type { ListItem } from '../types'

interface Props {
  items: ListItem[]
  onToggle: (item: ListItem) => void
  onAdd: (item: Pick<ListItem, 'name' | 'quantity' | 'unit'>) => Promise<void>
  onDelete: (item: ListItem) => void
  onClear: (onlyChecked: boolean) => Promise<void>
  onRefresh: () => void
}

export function ListView({ items, onToggle, onAdd, onDelete, onClear, onRefresh }: Props) {
  const [draft, setDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const todo = items.filter((i) => !i.checked)
  const done = items.filter((i) => i.checked)

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 1800)
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = parseIngredientLine(draft)
    if (!parsed) return
    setDraft('')
    await onAdd(parsed)
  }

  const copy = async () => {
    const text = listAsText(items)
    if (!text) return flash('Nothing left to buy')
    try {
      if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ title: 'Shopping list', text })
        return
      }
      await navigator.clipboard.writeText(text)
      flash('List copied')
    } catch (err) {
      if ((err as Error).name !== 'AbortError') flash("Couldn't copy — try again")
    }
  }

  const row = (i: ListItem) => (
    <li key={i.id} className={i.checked ? 'item done' : 'item'}>
      <label>
        <input type="checkbox" checked={i.checked} onChange={() => onToggle(i)} />
        <span className="item-text">
          <span className="item-name">{i.name}</span>
          {formatQty(i) && <span className="item-qty">{formatQty(i)}</span>}
          {i.recipes.length > 0 && <span className="item-from">{i.recipes.join(', ')}</span>}
        </span>
      </label>
      <button className="icon" aria-label={`Remove ${i.name}`} onClick={() => onDelete(i)}>×</button>
    </li>
  )

  return (
    <>
      <header className="bar">
        <h1>Shopping list</h1>
        <div className="bar-actions">
          <button className="link" onClick={onRefresh} aria-label="Refresh">↻</button>
          <button className="link strong" onClick={copy}>Share</button>
        </div>
      </header>
      <div className="content">
        <form className="add-item" onSubmit={add}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add an item, e.g. 2 lemons" />
          <button className="btn" disabled={!draft.trim()}>Add</button>
        </form>

        {items.length === 0 ? (
          <div className="empty">
            <p>Your list is empty.</p>
            <p className="muted">Tick some recipes on the Recipes tab to build one.</p>
          </div>
        ) : (
          <>
            <p className="hint">{todo.length} to buy{done.length ? ` · ${done.length} in the basket` : ''}</p>
            <ul className="items">{todo.map(row)}</ul>
            {done.length > 0 && (
              <>
                <div className="section-head">
                  <h3>In the basket</h3>
                  <button className="link" onClick={() => onClear(true)}>Clear ticked</button>
                </div>
                <ul className="items">{done.map(row)}</ul>
              </>
            )}
            <button className="btn danger subtle" onClick={() => confirm('Clear the whole list?') && onClear(false)}>
              Clear whole list
            </button>
          </>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
