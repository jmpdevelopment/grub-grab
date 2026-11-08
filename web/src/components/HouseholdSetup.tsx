import { useState } from 'react'
import { JoinForm } from './JoinForm'

interface Props {
  email: string | null
  onStart: () => Promise<void>
  onJoin: (code: string) => Promise<void>
  onSignOut: () => void
}

/** First sign-in: start a new household, or join someone else's with their invite code. */
export function HouseholdSetup({ email, onStart, onJoin, onSignOut }: Props) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await onStart()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="bar">
        <h1>Welcome</h1>
      </header>
      <div className="content">
        <p className="muted setup-intro">
          Signed in as {email ?? 'your Google account'}. A household shares one recipe book and one shopping list.
        </p>

        <section className="panel">
          <h3>Join a household</h3>
          <p className="muted">Someone already using Grub Grab? Enter the code from their Settings.</p>
          <JoinForm onJoin={onJoin} />
        </section>

        <section className="panel">
          <h3>Start a new household</h3>
          <p className="muted">Begin with an empty recipe book. You'll get a code to invite others.</p>
          <button className="btn" disabled={busy} onClick={start}>
            Start a household
          </button>
          {msg && <p className="hint">{msg}</p>}
        </section>

        <button className="link" onClick={onSignOut}>
          Not you? Sign out
        </button>
      </div>
    </>
  )
}
