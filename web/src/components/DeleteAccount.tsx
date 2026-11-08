import { useState } from 'react'
import { useI18n } from '../i18n'

interface Props {
  admin: boolean
  onDelete: () => Promise<void>
}

/** Settings: permanently delete your account and the data that goes with it. */
export function DeleteAccount({ admin, onDelete }: Props) {
  const { t, errorText } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    if (!confirm(t('delete.confirm') + (admin ? t('delete.confirmAdmin') : ''))) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h3>{t('delete.title')}</h3>
      <p className="muted">{t('delete.text')}</p>
      <button className="btn danger" disabled={busy} onClick={remove}>
        {busy ? t('delete.busy') : t('delete.button')}
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
