import { useState } from 'react'

interface Props {
  admin: boolean
  onDelete: () => Promise<void>
}

/** Settings: permanently delete your account and the data that goes with it. */
export function DeleteAccount({ admin, onDelete }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    const warning =
      'Delete your account? This can’t be undone.\n\n' +
      'Your sign-in and profile are removed. If no one else is in your household, its recipes and shopping list are deleted too.' +
      (admin ? '\n\nYou’re the admin: nobody will be able to approve new sign-ups until another admin is added.' : '')
    if (!confirm(warning)) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h3>Delete account</h3>
      <p className="muted">
        Removes your account and everything stored about you. Your household’s recipes and list are deleted too, unless
        someone else is still in it.
      </p>
      <button className="btn danger" disabled={busy} onClick={remove}>
        {busy ? 'Deleting…' : 'Delete my account'}
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
