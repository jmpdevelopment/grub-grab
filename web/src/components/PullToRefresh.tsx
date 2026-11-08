import { useEffect, useRef, useState } from 'react'

export const PULL_THRESHOLD = 70 // px of (damped) pull needed to trigger a refresh
const MAX_PULL = 110
const DAMPING = 0.5 // the indicator moves at half the finger's speed, like native pull-to-refresh

interface Props {
  onRefresh: () => Promise<void>
}

/**
 * Pull down from the top of the page to refresh. Installed web apps on iPhone have no browser reload,
 * so this is the way to fetch the other person's changes or a newly deployed version.
 */
export function PullToRefresh({ onRefresh }: Props) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // Read inside the listeners without re-subscribing on every render.
  const latest = useRef({ onRefresh, refreshing })
  useEffect(() => {
    latest.current = { onRefresh, refreshing }
  })

  useEffect(() => {
    let startY: number | null = null
    let distance = 0

    const start = (e: TouchEvent) => {
      // Only a pull that starts at the very top of the page, and not while already refreshing.
      startY = window.scrollY <= 0 && !latest.current.refreshing ? e.touches[0].clientY : null
      distance = 0
    }
    const move = (e: TouchEvent) => {
      if (startY === null) return
      distance = Math.min(Math.max(0, (e.touches[0].clientY - startY) * DAMPING), MAX_PULL)
      setPull(distance)
    }
    const end = async () => {
      if (startY === null) return
      startY = null
      setPull(0)
      if (distance < PULL_THRESHOLD) return
      setRefreshing(true)
      try {
        await latest.current.onRefresh()
      } catch {
        // The app reports its own load errors; the indicator just needs to go away.
      } finally {
        setRefreshing(false)
      }
    }

    window.addEventListener('touchstart', start, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
    return () => {
      window.removeEventListener('touchstart', start)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
    }
  }, [])

  if (!pull && !refreshing) return null
  const label = refreshing ? 'Refreshing…' : pull >= PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh'
  return (
    <div className="ptr" role="status" style={{ transform: `translate(-50%, ${refreshing ? PULL_THRESHOLD / 2 : pull / 2}px)` }}>
      <span className={refreshing ? 'ptr-icon spin' : 'ptr-icon'} aria-hidden style={{ rotate: `${pull * 3}deg` }}>
        ↻
      </span>
      {label}
    </div>
  )
}
