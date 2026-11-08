import { useState } from 'react'
import { INVITE_LENGTH, normaliseInviteCode } from '../lib/invite'

interface Props {
  onJoin: (code: string) => Promise<void>
  /** Shown after a successful join, when the screen stays put (Settings). */
  joinedMessage?: string
}

/** Invite-code box and Join button. Accepts codes typed in any format ("abcde fgh23"). */
export function JoinForm({ onJoin, joinedMessage }: Props) {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const join = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await onJoin(normaliseInviteCode(code))
      setCode('')
      if (joinedMessage) setMsg(joinedMessage)
    } catch (e) {
      setMsg((e as Error).message)
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
          aria-label="Invite code"
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
    </>
  )
}
