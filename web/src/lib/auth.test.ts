import { describe, expect, it } from 'vitest'
import { CFG, fakeFetch, fakeLocation, json, jwt, saveTokens } from '../test/fakes'
import { completeSignIn, currentEmail, getAccessToken, signIn, signOut } from './auth'

const TOKEN_URL = 'POST https://auth.example.com/oauth2/token'
const tokenResponse = (over = {}) =>
  json({ id_token: jwt({ email: 'a@b.c' }), access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, ...over })

describe('signIn', () => {
  it('redirects straight to Google via Cognito, with a PKCE challenge matching the stored verifier', async () => {
    const { assign } = fakeLocation('http://localhost/')
    await signIn(CFG)

    const url = new URL(assign.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://auth.example.com/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-123',
      identity_provider: 'Google',
      redirect_uri: 'http://localhost/',
      scope: 'openid email',
      code_challenge_method: 'S256',
    })

    const verifier = sessionStorage.getItem('gg.pkce')!
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(url.searchParams.get('code_challenge')).toBe(expected)
  })
})

describe('signOut', () => {
  it('forgets tokens and redirects to the hosted logout', () => {
    const { assign } = fakeLocation()
    saveTokens()
    signOut(CFG)
    expect(localStorage.getItem('gg.tokens')).toBeNull()
    const url = new URL(assign.mock.calls[0][0])
    expect(url.pathname).toBe('/logout')
    expect(url.searchParams.get('logout_uri')).toBe('http://localhost/')
    expect(url.searchParams.get('client_id')).toBe('client-123')
  })
})

describe('completeSignIn', () => {
  it('does nothing without a code in the URL', async () => {
    fakeLocation('http://localhost/')
    const { fn } = fakeFetch({})
    await completeSignIn(CFG)
    expect(fn).not.toHaveBeenCalled()
  })

  it('exchanges the code, stores tokens and cleans the URL', async () => {
    fakeLocation('http://localhost/?code=abc&state=x')
    sessionStorage.setItem('gg.pkce', 'verifier-1')
    const { calls } = fakeFetch({ [TOKEN_URL]: () => tokenResponse() })

    await completeSignIn(CFG)

    expect(calls[0].body).toEqual({
      client_id: 'client-123',
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'http://localhost/',
      code_verifier: 'verifier-1',
    })
    expect(window.history.replaceState).toHaveBeenCalledWith({}, '', '/')
    expect(await getAccessToken(CFG)).toBe('access-new')
    expect(currentEmail()).toBe('a@b.c')
  })

  it('sends an empty verifier if the session lost it (Cognito will reject it)', async () => {
    fakeLocation('http://localhost/?code=abc')
    const { calls } = fakeFetch({ [TOKEN_URL]: () => tokenResponse() })
    await completeSignIn(CFG)
    expect((calls[0].body as Record<string, string>).code_verifier).toBe('')
  })

  it('throws a readable error when the exchange fails', async () => {
    fakeLocation('http://localhost/?code=bad')
    fakeFetch({ [TOKEN_URL]: () => json({ error: 'invalid_grant' }, 400) })
    await expect(completeSignIn(CFG)).rejects.toThrow('Sign-in failed (400)')
    expect(localStorage.getItem('gg.tokens')).toBeNull()
  })
})

describe('getAccessToken', () => {
  it('is null when signed out', async () => {
    expect(await getAccessToken(CFG)).toBeNull()
  })

  it('is null when stored tokens are corrupt', async () => {
    localStorage.setItem('gg.tokens', '{oops')
    expect(await getAccessToken(CFG)).toBeNull()
  })

  it('returns a token that has not expired', async () => {
    saveTokens({ accessToken: 'still-good' })
    expect(await getAccessToken(CFG)).toBe('still-good')
  })

  it('refreshes an expired token, keeping the old refresh token if none is returned', async () => {
    saveTokens({ expiresAt: Date.now() - 1, refreshToken: 'refresh-1' })
    const { calls } = fakeFetch({ [TOKEN_URL]: () => tokenResponse({ refresh_token: undefined }) })

    expect(await getAccessToken(CFG)).toBe('access-new')
    expect(calls[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-1' })
    const stored = JSON.parse(localStorage.getItem('gg.tokens')!)
    expect(stored.refreshToken).toBe('refresh-1')
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 3000 * 1000)
  })

  it('signs out when the token expired and there is no refresh token', async () => {
    saveTokens({ expiresAt: Date.now() - 1, refreshToken: undefined })
    expect(await getAccessToken(CFG)).toBeNull()
  })

  it('signs out when the refresh is rejected', async () => {
    saveTokens({ expiresAt: Date.now() - 1 })
    fakeFetch({ [TOKEN_URL]: () => json({ error: 'invalid_grant' }, 400) })
    expect(await getAccessToken(CFG)).toBeNull()
    expect(localStorage.getItem('gg.tokens')).toBeNull()
  })
})

describe('currentEmail', () => {
  it('reads the email claim from the id token', () => {
    saveTokens({ idToken: jwt({ email: 'me@example.com' }) })
    expect(currentEmail()).toBe('me@example.com')
  })

  it('handles base64url characters in the payload', () => {
    // "~~~" encodes to "fn5-" in base64url (contains '-'), "???" to "Pz8_" (contains '_').
    saveTokens({ idToken: jwt({ email: '~~~???@x.y' }) })
    expect(currentEmail()).toBe('~~~???@x.y')
  })

  it('is null when signed out, when the claim is missing, or the token is malformed', () => {
    expect(currentEmail()).toBeNull()
    saveTokens({ idToken: jwt({ sub: '123' }) })
    expect(currentEmail()).toBeNull()
    saveTokens({ idToken: 'not-a-jwt' })
    expect(currentEmail()).toBeNull()
  })
})
