import { useState } from 'react'
import { useI18n, type MessageKey } from '../i18n'
import type { SendResult } from '../lib/feedback'

// The choices (same codes as PROBLEMS in api/src/grubgrab/feedback.py).
const PROBLEMS = {
  import: ['missing', 'extra', 'amounts', 'names', 'aisles', 'tags', 'title', 'unread', 'other'],
  importFailed: ['unread', 'other'],
  general: ['broke', 'data', 'slow', 'idea', 'other'],
} as const
export type SheetKind = keyof typeof PROBLEMS

// Choices about particular ingredients: picking one asks which (missing ones aren't in the AI's list to mark).
const ABOUT_INGREDIENTS = new Set(['extra', 'amounts', 'names', 'aisles'])

export interface SheetAnswer {
  problems: string[]
  marked: string[]
  note: string
}

interface Props {
  kind: SheetKind
  /** The AI's ingredients, to mark the wrong ones (import reports). */
  ingredients?: string[]
  /** Pre-ticked from what the person already fixed. */
  suggested?: string[]
  premarked?: string[]
  onSend: (answer: SheetAnswer) => Promise<SendResult>
  onClose: () => void
}

/** A quick problem report: tap what was wrong (often already ticked), optionally mark items or add a note. */
export function FeedbackSheet({ kind, ingredients = [], suggested = [], premarked = [], onSend, onClose }: Props) {
  const { t, errorText } = useI18n()
  const [problems, setProblems] = useState<string[]>(suggested)
  const [marked, setMarked] = useState<string[]>(premarked)
  const [note, setNote] = useState('')
  const [noting, setNoting] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SendResult | null>(null)
  const [error, setError] = useState<unknown>(null)

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
  const asksWhich = ingredients.length > 0 && problems.some((p) => ABOUT_INGREDIENTS.has(p))

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      setResult(await onSend({ problems, marked: asksWhich ? marked : [], note: note.trim() }))
    } catch (e) {
      setError(e)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        {result ? (
          <div className="sheet-done" role="status">
            <p>{t(result === 'sent' ? 'feedback.sent' : 'feedback.queued')}</p>
            <button className="btn" onClick={onClose} autoFocus>{t('feedback.close')}</button>
          </div>
        ) : (
          <>
            <h2 id="feedback-title">{t(`feedback.title.${kind}`)}</h2>
            <div className="chips" role="group" aria-labelledby="feedback-title">
              {PROBLEMS[kind].map((p) => (
                <button
                  key={p}
                  className={problems.includes(p) ? 'chip on' : 'chip'}
                  aria-pressed={problems.includes(p)}
                  onClick={() => setProblems((prev) => toggle(prev, p))}
                >
                  {t(`feedback.problem.${p}` as MessageKey)}
                </button>
              ))}
            </div>

            {asksWhich && (
              <fieldset className="mark">
                <legend>{t('feedback.which')}</legend>
                {ingredients.map((name) => (
                  <label key={name}>
                    <input type="checkbox" checked={marked.includes(name)} onChange={() => setMarked((prev) => toggle(prev, name))} />
                    {name}
                  </label>
                ))}
              </fieldset>
            )}

            {noting ? (
              <textarea
                aria-label={t('feedback.noteLabel')}
                placeholder={t('feedback.notePlaceholder')}
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
                autoFocus
              />
            ) : (
              <button className="link" onClick={() => setNoting(true)}>{t('feedback.addNote')}</button>
            )}

            <details className="included">
              <summary>{t('feedback.included')}</summary>
              <ul>
                <li>{t('feedback.inc.choices')}</li>
                {kind !== 'general' && <li>{t('feedback.inc.import')}</li>}
                <li>{t('feedback.inc.journey')}</li>
                <li>{t('feedback.inc.device')}</li>
                <li>{t('feedback.inc.never')}</li>
              </ul>
            </details>

            {error !== null && <p className="error">{errorText(error)}</p>}
            <div className="sheet-actions">
              <button className="btn secondary" onClick={onClose}>{t('feedback.cancel')}</button>
              <button className="btn" disabled={problems.length === 0 || sending} onClick={send}>
                {sending ? t('feedback.sending') : t('feedback.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
