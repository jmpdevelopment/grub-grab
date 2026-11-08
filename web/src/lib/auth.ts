// Minimal Cognito sign-in using the OAuth authorization-code flow with PKCE.
// Google is the only identity provider, so we skip Cognito's page and go straight to Google.
import { AppError } from '../i18n/errors'
import { en } from '../i18n/locales/en'
import type { AppConfig } from './config'

const TOKENS_KEY = 'gg.tokens'
const VERIFIER_KEY = 'gg.pkce'

interface Tokens {
  idToken: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

const redirectUri = () => `${window.location.origin}/`

type NoticeKey = 'signin.requestSent' | 'signin.notApproved'

/** Not a failure: something to tell the person on the sign-in screen (e.g. their request is waiting). */
export class SignInNotice extends Error {
  readonly key: NoticeKey
  constructor(key: NoticeKey) {
    super(en[key]) // English for logs; the app shows `key` in the person's language
    this.key = key
  }
}

// Codes raised by the sign-up approval trigger (api/src/grubgrab/signup.py). Cognito passes them back as
// "?error=...&error_description=PreSignUp failed with error ACCESS_PENDING."
const SIGN_UP_NOTICES: Record<string, NoticeKey> = {
  ACCESS_PENDING: 'signin.requestSent',
  ACCESS_DECLINED: 'signin.notApproved',
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function readTokens(): Tokens | null {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? 'null')
  } catch {
    return null
  }
}

function saveTokens(t: Tokens) {
  localStorage.setItem(TOKENS_KEY, JSON.stringify(t))
}

async function tokenRequest(cfg: AppConfig, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
  })
  if (!res.ok) throw new AppError('signin_failed', { detail: res.status }, `Sign-in failed (${res.status})`)
  const data = await res.json()
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? params.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  }
}

export async function signIn(cfg: AppConfig) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  const url = new URL(`${cfg.cognitoDomain}/oauth2/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    identity_provider: 'Google',
    redirect_uri: redirectUri(),
    scope: 'openid email',
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString()
  window.location.assign(url.toString())
}

export async function signOut(cfg: AppConfig) {
  const refreshToken = readTokens()?.refreshToken
  localStorage.removeItem(TOKENS_KEY)
  if (refreshToken) {
    // End the session on the server too, so a copied refresh token stops working. Best effort: if this
    // fails (offline), signing out of this phone still happens.
    await fetch(`${cfg.cognitoDomain}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, client_id: cfg.clientId }),
    }).catch(() => {})
  }
  const url = new URL(`${cfg.cognitoDomain}/logout`)
  url.search = new URLSearchParams({ client_id: cfg.clientId, logout_uri: redirectUri() }).toString()
  window.location.assign(url.toString())
}

/** Call once on startup: finishes a redirect back from the Hosted UI if there is one. */
export async function completeSignIn(cfg: AppConfig): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const error = params.get('error')
  if (error) {
    window.history.replaceState({}, '', '/')
    const description = params.get('error_description') ?? ''
    const notice = SIGN_UP_NOTICES[description.match(/\bACCESS_[A-Z]+\b/)?.[0] ?? '']
    if (notice) throw new SignInNotice(notice)
    throw new AppError('signin_failed', { detail: description || error }, `Sign-in failed: ${description || error}`)
  }
  const code = params.get('code')
  if (!code) return
  const verifier = sessionStorage.getItem(VERIFIER_KEY) ?? ''
  window.history.replaceState({}, '', '/')
  saveTokens(
    await tokenRequest(cfg, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  )
}

/** Returns a valid access token, refreshing if needed, or null if signed out. */
export async function getAccessToken(cfg: AppConfig): Promise<string | null> {
  const t = readTokens()
  if (!t) return null
  if (Date.now() < t.expiresAt) return t.accessToken
  if (!t.refreshToken) return null
  try {
    const fresh = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: t.refreshToken })
    saveTokens(fresh)
    return fresh.accessToken
  } catch {
    localStorage.removeItem(TOKENS_KEY)
    return null
  }
}

/** Forget this device's session without visiting Cognito (e.g. after the account was deleted). */
export function forgetSession() {
  localStorage.removeItem(TOKENS_KEY)
}

export function currentEmail(): string | null {
  const t = readTokens()
  if (!t) return null
  try {
    const payload = JSON.parse(atob(t.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.email ?? null
  } catch {
    return null
  }
}
