import { type ReactNode, useState } from 'react'
import { formatInviteCode } from '../lib/invite'
import type { Household } from '../types'
import { DeleteAccount } from './DeleteAccount'
import { JoinForm } from './JoinForm'

interface Props {
  mode: 'local' | 'cloud'
  household: Household | null
  email: string | null
  onJoin: (code: string) => Promise<void>
  onRotate: () => Promise<void>
  onSignOut: () => void
  /** Shown to admins only: the sign-up requests panel. */
  adminPanel?: ReactNode
  onDeleteAccount?: () => Promise<void>
}

export function SettingsView({ mode, household, email, onJoin, onRotate, onSignOut, adminPanel, onDeleteAccount }: Props) {
  const [shareMsg, setShareMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
            {adminPanel}
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
              <JoinForm onJoin={onJoin} joinedMessage="Joined! You now share recipes and the list." />
            </section>

            {onDeleteAccount && <DeleteAccount admin={Boolean(household?.admin)} onDelete={onDeleteAccount} />}
          </>
        )}
        <p className="legal">
          <a href="/privacy.html" target="_blank" rel="noopener">
            Privacy policy
          </a>
        </p>
      </div>
    </>
  )
}
