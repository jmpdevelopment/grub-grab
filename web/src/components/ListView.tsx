import { useState } from 'react'
import { useI18n } from '../i18n'
import { formatQty, listAsText, parseIngredientLine } from '../lib/aggregate'
import { AISLES, aisleOf, byAisle, type Aisle, type RememberedAisles } from '../lib/aisles'
import type { ListItem } from '../types'
import { LoadingCards } from './LoadingCards'

interface Props {
  items: ListItem[]
  onToggle: (item: ListItem) => void
  onAdd: (item: Pick<ListItem, 'name' | 'quantity' | 'unit'>) => Promise<void>
  onDelete: (item: ListItem) => void
  onClear: (onlyChecked: boolean) => Promise<void>
  onRefresh: () => void
  /** True until the first load has arrived: show placeholders, not "Your list is empty". */
  loading?: boolean
  /** Where the household moved items before (see lib/aisles). */
  remembered?: RememberedAisles
  /** Move an item to another aisle (remembered for the household). */
  onMove: (item: ListItem, aisle: Aisle) => void
}

export function ListView({ items, onToggle, onAdd, onDelete, onClear, onRefresh, onMove, remembered = {}, loading = false }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const todo = items.filter((i) => !i.checked)
  const done = items.filter((i) => i.checked)
  const aisles = byAisle(todo, remembered)
  // A list where nothing has an aisle yet looks as it always did, without a lone "Other" heading.
  const showAisles = !(aisles.length === 1 && aisles[0].aisle === 'other')

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
    const text = listAsText(aisles.flatMap((group) => group.items)) // in walking order
    if (!text) return flash(t('list.nothingToBuy'))
    try {
      if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ title: t('list.title'), text })
        return
      }
      await navigator.clipboard.writeText(text)
      flash(t('list.copied'))
    } catch (err) {
      if ((err as Error).name !== 'AbortError') flash(t('list.copyFailed'))
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
      {!i.checked && (
        // A native picker (works well on phones), shown as a small icon.
        <span className="aisle-pick">
          <span aria-hidden="true">⇅</span>
          <select
            aria-label={t('list.moveItem', { name: i.name })}
            value={aisleOf(i, remembered)}
            onChange={(e) => onMove(i, e.target.value as Aisle)}
          >
            {AISLES.map((a) => (
              <option key={a} value={a}>{t(`aisle.${a}`)}</option>
            ))}
          </select>
        </span>
      )}
      <button className="icon" aria-label={t('list.removeItem', { name: i.name })} onClick={() => onDelete(i)}>×</button>
    </li>
  )

  return (
    <>
      <header className="bar">
        <h1>{t('list.title')}</h1>
        <div className="bar-actions">
          <button className="link" onClick={onRefresh} aria-label={t('list.refresh')}>↻</button>
          <button className="link strong" onClick={copy}>{t('list.share')}</button>
        </div>
      </header>
      <div className="content">
        <form className="add-item" onSubmit={add}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('list.addPlaceholder')} />
          <button className="btn" disabled={!draft.trim()}>{t('list.add')}</button>
        </form>

        {loading ? (
          <LoadingCards label={t('list.loading')} />
        ) : items.length === 0 ? (
          <div className="empty">
            <p>{t('list.empty')}</p>
            <p className="muted">{t('list.emptyHint')}</p>
          </div>
        ) : (
          <>
            <p className="hint">
              {t('list.toBuy', { count: todo.length })}
              {done.length ? ` · ${t('list.inBasketCount', { count: done.length })}` : ''}
            </p>
            {showAisles ? (
              aisles.map((group) => (
                <section key={group.aisle} className="aisle">
                  <h3 className="aisle-head">{t(`aisle.${group.aisle}`)}</h3>
                  <ul className="items">{group.items.map(row)}</ul>
                </section>
              ))
            ) : (
              <ul className="items">{todo.map(row)}</ul>
            )}
            {done.length > 0 && (
              <>
                <div className="section-head">
                  <h3>{t('list.inBasket')}</h3>
                  <button className="link" onClick={() => onClear(true)}>{t('list.clearTicked')}</button>
                </div>
                <ul className="items">{done.map(row)}</ul>
              </>
            )}
            <button className="btn danger subtle" onClick={() => confirm(t('list.confirmClearAll')) && onClear(false)}>
              {t('list.clearAll')}
            </button>
          </>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
