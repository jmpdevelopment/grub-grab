// The person's recent steps in the app: screens, actions, server requests and errors. Kept on this device
// only (sessionStorage, so a reload after a crash still has it) and sent only with a problem report.
// Steps hold ids, codes and screen names, never what someone typed.

export type Step =
  | { type: 'screen'; name: string }
  | { type: 'action'; name: string; [detail: string]: string | number | boolean }
  | { type: 'api'; route: string; status: number; ms: number; requestId?: string }
  | { type: 'error'; code: string; where: string }

export type Recorded = Step & { t: number }

const KEY = 'gg.journey'
export const MAX_STEPS = 100
export const MAX_AGE_MS = 30 * 60 * 1000

let steps: Recorded[] | null = null

function load(): Recorded[] {
  if (steps) return steps
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '[]')
    steps = Array.isArray(saved) ? saved : []
  } catch {
    steps = []
  }
  return steps
}

/** The recent steps, oldest first (at most MAX_STEPS from the last MAX_AGE_MS). */
export function journey(now = Date.now()): Recorded[] {
  return load().filter((s) => now - s.t <= MAX_AGE_MS)
}

export function record(step: Step, now = Date.now()) {
  steps = [...journey(now), { ...step, t: now } as Recorded].slice(-MAX_STEPS)
  try {
    sessionStorage.setItem(KEY, JSON.stringify(steps))
  } catch {
    // Storage full or blocked: keep it in memory only.
  }
}

/** "/recipes/import/3f2a…" -> "/recipes/import/:id": ids say nothing useful and make routes hard to group. */
export function routeOf(path: string): string {
  const [pathname, query] = path.split('?')
  const route = pathname
    .split('/')
    .map((part) => (/\d/.test(part) && part.length >= 8 ? ':id' : part))
    .join('/')
    .replace(/(\/admin\/requests\/)[^/]+(\/(approve|decline))$/, '$1:user$2')
  return query ? `${route}?${query}` : route
}

/** For tests: forget everything. */
export function resetJourney() {
  steps = null
  sessionStorage.removeItem(KEY)
}
