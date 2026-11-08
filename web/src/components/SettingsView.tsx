import { useState } from 'react'
import { formatInviteCode, INVITE_LENGTH, normaliseInviteCode } from '../lib/invite'
import type { Household } from '../types'

interface Props {
  mode: 'local' | 'cloud'
  household: Household | null
  email: string | null
  onJoin: (code: string) => Promise<void>
  onRotate: () => Promise<void>
  onSignOut: () => void
}

export function SettingsView({ mode, household, email, onJoin, onRotate, onSignOut }: Props) {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [shareMsg, setShareMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const join = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await onJoin(normaliseInviteCode(code))
      setMsg('Joined! You now share recipes and the list.')
      setCode('')
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    if (!confirm('Make a new code? The current one will stop working. People who already joined stay in.')) return
    setBusy(true)
    setShareMsg(null)
    try {
      await onRotate()
      setShareMsg('New code ready.')
    } catch (e) {
      setShareMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="bar">
        <h1>Settings</h1>
      </header>
      <div className="content">
        {mode === 'local' ? (
          <section className="panel">
            <h3>Local mode</h3>
            <p className="muted">
              Recipes and lists are saved on this device only. Deploy the cloud version (see README) to sync between
              phones.
            </p>
          </section>
        ) : (
          <>
            <section className="panel">
              <h3>Account</h3>
              <p>{email ?? 'Signed in'}</p>
              <button className="btn secondary" onClick={onSignOut}>
                Sign out
              </button>
            </section>

            <section className="panel">
              <h3>Share with someone</h3>
              <p className="muted">Give them this code. Once they enter it, you'll both see the same recipes and list.</p>
              <p className="invite">{household?.inviteCode ? formatInviteCode(household.inviteCode) : '…'}</p>
              <button className="btn secondary" disabled={busy || !household} onClick={rotate}>
                New code
              </button>
              {shareMsg && <p className="hint">{shareMsg}</p>}
            </section>

            <section className="panel">
              <h3>Join a household</h3>
              <p className="muted">Got a code? Joining switches you to their recipes and list.</p>
              <div className="add-item">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABCDE-FGH23"
                  maxLength={INVITE_LENGTH + 4}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="btn" disabled={normaliseInviteCode(code).length !== INVITE_LENGTH || busy} onClick={join}>
                  Join
                </button>
              </div>
              {msg && <p className="hint">{msg}</p>}
            </section>
          </>
        )}
      </div>
    </>
  )
}
