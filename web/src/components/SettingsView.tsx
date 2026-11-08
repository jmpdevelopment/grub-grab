import { type ReactNode, useState } from 'react'
import { useI18n, type Lang } from '../i18n'
import { formatInviteCode } from '../lib/invite'
import type { Household } from '../types'
import { DeleteAccount } from './DeleteAccount'
import { JoinForm } from './JoinForm'
import { LanguagePicker } from './LanguagePicker'

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
  /** Change what "Fill from link" writes in, for the whole household (cloud only). */
  onRecipeLanguage?: (language: Lang) => Promise<void>
}

export function SettingsView({
  mode,
  household,
  email,
  onJoin,
  onRotate,
  onSignOut,
  adminPanel,
  onDeleteAccount,
  onRecipeLanguage,
}: Props) {
  const { t, errorText } = useI18n()
  const [shareMsg, setShareMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rotate = async () => {
    if (!confirm(t('settings.confirmNewCode'))) return
    setBusy(true)
    setShareMsg(null)
    try {
      await onRotate()
      setShareMsg(t('settings.newCodeReady'))
    } catch (e) {
      setShareMsg(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="bar">
        <h1>{t('settings.title')}</h1>
      </header>
      <div className="content">
        <section className="panel">
          <h3>{t('language.label')}</h3>
          <p className="muted">{t('settings.languageHint')}</p>
          <LanguagePicker />
        </section>
        {onRecipeLanguage && household?.recipeLanguage && (
          <section className="panel">
            <h3>{t('settings.recipeLanguage')}</h3>
            <p className="muted">{t('settings.recipeLanguageHint')}</p>
            <LanguagePicker value={household.recipeLanguage} onChange={onRecipeLanguage} label={t('settings.recipeLanguage')} />
          </section>
        )}
        {mode === 'local' ? (
          <section className="panel">
            <h3>{t('settings.localTitle')}</h3>
            <p className="muted">{t('settings.localText')}</p>
          </section>
        ) : (
          <>
            {adminPanel}
            <section className="panel">
              <h3>{t('settings.account')}</h3>
              <p>{email ?? t('settings.signedIn')}</p>
              <button className="btn secondary" onClick={onSignOut}>
                {t('settings.signOut')}
              </button>
            </section>

            <section className="panel">
              <h3>{t('settings.shareTitle')}</h3>
              <p className="muted">{t('settings.shareText')}</p>
              <p className="invite">{household?.inviteCode ? formatInviteCode(household.inviteCode) : '…'}</p>
              <button className="btn secondary" disabled={busy || !household} onClick={rotate}>
                {t('settings.newCode')}
              </button>
              {shareMsg && <p className="hint">{shareMsg}</p>}
            </section>

            <section className="panel">
              <h3>{t('settings.joinTitle')}</h3>
              <p className="muted">{t('settings.joinText')}</p>
              <JoinForm onJoin={onJoin} joinedMessage={t('settings.joined')} />
            </section>

            {onDeleteAccount && <DeleteAccount admin={Boolean(household?.admin)} onDelete={onDeleteAccount} />}
          </>
        )}
        <p className="legal">
          <a href="/privacy.html" target="_blank" rel="noopener">
            {t('app.privacy')}
          </a>
        </p>
      </div>
    </>
  )
}
