import { useState } from 'react'
import { useI18n } from '../i18n'
import { INVITE_LENGTH, normaliseInviteCode } from '../lib/invite'

interface Props {
  onJoin: (code: string) => Promise<void>
  /** Shown after a successful join, when the screen stays put (Settings). */
  joinedMessage?: string
  /** Asked before joining (Settings: leaving a household nobody else is in deletes it). */
  confirmText?: string
}

/** Invite-code box and Join button. Accepts codes typed in any format ("abcde fgh23"). */
export function JoinForm({ onJoin, joinedMessage, confirmText }: Props) {
  const { t, errorText } = useI18n()
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const join = async () => {
    if (confirmText && !confirm(confirmText)) return
    setBusy(true)
    setMsg(null)
    try {
      await onJoin(normaliseInviteCode(code))
      setCode('')
      if (joinedMessage) setMsg(joinedMessage)
    } catch (e) {
      setMsg(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="add-item">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCDE-FGH23"
          aria-label={t('join.codeLabel')}
          maxLength={INVITE_LENGTH + 4}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn" disabled={normaliseInviteCode(code).length !== INVITE_LENGTH || busy} onClick={join}>
          {t('join.button')}
        </button>
      </div>
      {msg && <p className="hint">{msg}</p>}
    </>
  )
}
