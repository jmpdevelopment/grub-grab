import { useState } from 'react'
import { useI18n } from '../i18n'
import { JoinForm } from './JoinForm'

interface Props {
  email: string | null
  onStart: () => Promise<void>
  onJoin: (code: string) => Promise<void>
  onSignOut: () => void
}

/** First sign-in: start a new household, or join someone else's with their invite code. */
export function HouseholdSetup({ email, onStart, onJoin, onSignOut }: Props) {
  const { t, errorText } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await onStart()
    } catch (e) {
      setMsg(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="bar">
        <h1>{t('setup.title')}</h1>
      </header>
      <div className="content">
        <p className="muted setup-intro">
          {t('setup.intro', { email: email ?? t('setup.yourGoogleAccount') })}
        </p>

        <section className="panel">
          <h3>{t('setup.joinTitle')}</h3>
          <p className="muted">{t('setup.joinText')}</p>
          <JoinForm onJoin={onJoin} />
        </section>

        <section className="panel">
          <h3>{t('setup.startTitle')}</h3>
          <p className="muted">{t('setup.startText')}</p>
          <button className="btn" disabled={busy} onClick={start}>
            {t('setup.start')}
          </button>
          {msg && <p className="hint">{msg}</p>}
        </section>

        <button className="link" onClick={onSignOut}>
          {t('setup.notYou')}
        </button>
      </div>
    </>
  )
}
