import { useEffect, useState } from 'react'
import type { AccessRequest } from '../types'

interface Props {
  load: () => Promise<AccessRequest[]>
  decide: (username: string, approve: boolean) => Promise<void>
  declineAll: () => Promise<number>
  /** Keeps the count on the Settings tab in step. */
  onCount: (pending: number) => void
}

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Admins only: people who signed in with Google and are waiting to be let in. */
export function AccessRequests({ load, decide, declineAll, onCount }: Props) {
  const [requests, setRequests] = useState<AccessRequest[] | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    load().then(
      (r) => {
        if (!live) return
        setRequests(r)
        onCount(r.length)
      },
      (e: Error) => live && setMsg(e.message),
    )
    return () => {
      live = false
    }
  }, [load, onCount])

  const run = async (work: () => Promise<AccessRequest[]>, done: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const next = await work()
      setRequests(next)
      onCount(next.length)
      setMsg(done)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const answer = (r: AccessRequest, approve: boolean) =>
    run(
      async () => {
        await decide(r.username, approve)
        return requests!.filter((x) => x.username !== r.username)
      },
      approve
        ? `Approved. ${r.name || r.email} can now sign in and join with your invite code.`
        : `Declined ${r.name || r.email}.`,
    )

  const rejectAll = () => {
    if (!confirm(`Decline all ${requests!.length} requests?`)) return
    run(async () => {
      await declineAll()
      return []
    }, 'Declined everyone who was waiting.')
  }

  return (
    <section className="panel">
      <h3>Sign-up requests</h3>
      {requests === null ? (
        <p className="muted">{msg ?? 'Loading…'}</p>
      ) : (
        <>
          {requests.length === 0 ? (
            <p className="muted">No one is waiting. New people who sign in with Google show up here for you to approve.</p>
          ) : (
            <ul className="requests">
              {requests.map((r) => {
                const who = r.name || r.email || r.username
                return (
                  <li key={r.username}>
                    <div className="request-who">
                      <strong>{who}</strong>
                      {r.name && r.email && <span className="muted">{r.email}</span>}
                      <span className="muted">asked {when(r.requestedAt)}</span>
                    </div>
                    <div className="request-actions">
                      <button className="btn" disabled={busy} aria-label={`Approve ${who}`} onClick={() => answer(r, true)}>
                        Approve
                      </button>
                      <button className="btn secondary" disabled={busy} aria-label={`Decline ${who}`} onClick={() => answer(r, false)}>
                        Decline
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {requests.length > 1 && (
            <button className="btn danger subtle" disabled={busy} onClick={rejectAll}>
              Decline all
            </button>
          )}
          {msg && <p className="hint">{msg}</p>}
        </>
      )}
    </section>
  )
}
