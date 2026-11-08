import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import type { AccessRequest } from '../types'

interface Props {
  load: () => Promise<AccessRequest[]>
  decide: (username: string, approve: boolean) => Promise<void>
  declineAll: () => Promise<number>
  /** Keeps the count on the Settings tab in step. */
  onCount: (pending: number) => void
  /** Changes on every app refresh (e.g. pull to refresh), so new requests show up while Settings is open. */
  reloadKey?: number
}

/** Admins only: people who signed in with Google and are waiting to be let in. */
export function AccessRequests({ load, decide, declineAll, onCount, reloadKey = 0 }: Props) {
  const { t, errorText, formatDate } = useI18n()
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
      (e: Error) => live && setMsg(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [load, onCount, reloadKey, errorText])

  const run = async (work: () => Promise<AccessRequest[]>, done: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const next = await work()
      setRequests(next)
      onCount(next.length)
      setMsg(done)
    } catch (e) {
      setMsg(errorText(e))
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
      t(approve ? 'requests.approved' : 'requests.declined', { who: r.name || r.email }),
    )

  const rejectAll = () => {
    if (!confirm(t('requests.confirmDeclineAll', { count: requests!.length }))) return
    run(async () => {
      await declineAll()
      return []
    }, t('requests.declinedAll'))
  }

  return (
    <section className="panel">
      <h3>{t('requests.title')}</h3>
      {requests === null ? (
        <p className="muted">{msg ?? t('app.loading')}</p>
      ) : (
        <>
          {requests.length === 0 ? (
            <p className="muted">{t('requests.none')}</p>
          ) : (
            <ul className="requests">
              {requests.map((r) => {
                const who = r.name || r.email || r.username
                return (
                  <li key={r.username}>
                    <div className="request-who">
                      <strong>{who}</strong>
                      {r.name && r.email && <span className="muted">{r.email}</span>}
                      <span className="muted">{t('requests.asked', { when: formatDate(r.requestedAt) })}</span>
                    </div>
                    <div className="request-actions">
                      <button className="btn" disabled={busy} aria-label={t('requests.approveWho', { who })} onClick={() => answer(r, true)}>
                        {t('requests.approve')}
                      </button>
                      <button className="btn secondary" disabled={busy} aria-label={t('requests.declineWho', { who })} onClick={() => answer(r, false)}>
                        {t('requests.decline')}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {requests.length > 1 && (
            <button className="btn danger subtle" disabled={busy} onClick={rejectAll}>
              {t('requests.declineAll')}
            </button>
          )}
          {msg && <p className="hint">{msg}</p>}
        </>
      )}
    </section>
  )
}
