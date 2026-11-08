// Test doubles for EXTERNAL boundaries only: the network (fetch) and browser navigation.
import { vi } from 'vitest'

export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

export const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Install a fake fetch that routes by "METHOD path" (or full URL for other hosts). Unmatched calls fail loudly. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown; headers: Record<string, string> }[] = []
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init.method ?? 'GET').toUpperCase()
    let body: unknown = init.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        // form-encoded or plain text: keep as string
      }
    } else if (body instanceof URLSearchParams) body = Object.fromEntries(body)
    calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> })
    const key = `${method} ${url.origin === 'http://localhost' ? url.pathname : url.origin + url.pathname}`
    const handler = routes[key]
    if (!handler) throw new Error(`Unexpected fetch: ${key}`)
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

/** Replace window.location so redirects can be observed instead of performed. */
export function fakeLocation(href = 'http://localhost/') {
  const current = new URL(href)
  const assign = vi.fn()
  const loc = {
    get origin() {
      return current.origin
    },
    get search() {
      return current.search
    },
    get href() {
      return current.href
    },
    assign,
  }
  Object.defineProperty(window, 'location', { value: loc, configurable: true })
  vi.spyOn(window.history, 'replaceState').mockImplementation((_s, _t, url) => {
    const next = new URL(String(url), current)
    current.search = next.search
  })
  return { assign }
}

export function jwt(payload: object) {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

export function saveTokens(over: Partial<{ idToken: string; accessToken: string; refreshToken?: string; expiresAt: number }> = {}) {
  localStorage.setItem(
    'gg.tokens',
    JSON.stringify({
      idToken: jwt({ email: 'me@example.com' }),
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 60_000,
      ...over,
    }),
  )
}

export const CFG = {
  apiUrl: 'https://api.example.com/',
  cognitoDomain: 'https://auth.example.com',
  clientId: 'client-123',
}
