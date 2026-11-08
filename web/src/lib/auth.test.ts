import { describe, expect, it, vi } from 'vitest'
import { CFG, fakeFetch, fakeLocation, json, jwt, saveTokens } from '../test/fakes'
import { completeSignIn, currentEmail, forgetSession, getAccessToken, hasSession, SignInNotice, signIn, signOut } from './auth'

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
  const REVOKE_URL = 'POST https://auth.example.com/oauth2/revoke'

  it('revokes the session, forgets tokens and redirects to the hosted logout', async () => {
    const { assign } = fakeLocation()
    saveTokens({ refreshToken: 'refresh-9' })
    const { calls } = fakeFetch({ [REVOKE_URL]: () => new Response(null, { status: 200 }) })
    await signOut(CFG)
    expect(calls[0].body).toEqual({ token: 'refresh-9', client_id: 'client-123' })
    expect(localStorage.getItem('gg.tokens')).toBeNull()
    const url = new URL(assign.mock.calls[0][0])
    expect(url.pathname).toBe('/logout')
    expect(url.searchParams.get('logout_uri')).toBe('http://localhost/')
    expect(url.searchParams.get('client_id')).toBe('client-123')
  })

  it('still signs out when revoking fails (offline), and skips it without a refresh token', async () => {
    const { assign } = fakeLocation()
    saveTokens()
    fakeFetch({ [REVOKE_URL]: () => Promise.reject(new TypeError('offline')) })
    await signOut(CFG)
    expect(assign).toHaveBeenCalledTimes(1)

    saveTokens({ refreshToken: undefined })
    const { fn } = fakeFetch({})
    await signOut(CFG)
    expect(fn).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledTimes(2)
  })
})

describe('forgetSession', () => {
  it('drops the stored session without going anywhere', async () => {
    const { assign } = fakeLocation()
    saveTokens()
    forgetSession()
    expect(await getAccessToken(CFG)).toBeNull()
    expect(assign).not.toHaveBeenCalled()
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
    expect(sessionStorage.getItem('gg.pkce')).toBeNull() // used once
    expect(await getAccessToken(CFG)).toBe('access-new')
    expect(currentEmail()).toBe('a@b.c')
  })

  it('sends an empty verifier if the session lost it (Cognito will reject it)', async () => {
    fakeLocation('http://localhost/?code=abc')
    const { calls } = fakeFetch({ [TOKEN_URL]: () => tokenResponse() })
    await completeSignIn(CFG)
    expect((calls[0].body as Record<string, string>).code_verifier).toBe('')
  })

  describe('when Cognito sends back an error', () => {
    const back = (query: string) => fakeLocation(`http://localhost/?${query}`)

    it.each([
      ['ACCESS_PENDING', "Thanks! Your request to join has been sent. You'll be able to sign in once it's approved."],
      ['ACCESS_DECLINED', "This Google account hasn't been approved for Grub Grab."],
    ])('turns the approval trigger code %s into a friendly notice', async (code, message) => {
      back(`error_description=PreSignUp+failed+with+error+${code}.+&error=invalid_request`)
      const { fn } = fakeFetch({})
      const err = await completeSignIn(CFG).catch((e) => e)
      expect(err).toBeInstanceOf(SignInNotice)
      expect(err.message).toBe(message)
      expect(window.history.replaceState).toHaveBeenCalledWith({}, '', '/')
      expect(fn).not.toHaveBeenCalled()
    })

    it('reports any other error as a failure, by its standard code only', async () => {
      back('error=access_denied&error_description=User+cancelled')
      const err = await completeSignIn(CFG).catch((e) => e)
      expect(err).not.toBeInstanceOf(SignInNotice)
      expect(err.message).toBe('Sign-in failed: access_denied')
      expect(err.params).toEqual({ detail: 'access_denied' })
      back('error=server_error')
      await expect(completeSignIn(CFG)).rejects.toThrow('Sign-in failed: server_error')
    })

    it('never shows text someone put in a link', async () => {
      back('error=Your+account+is+locked.+Call+0800+123&error_description=Visit+evil.example+now')
      const err = await completeSignIn(CFG).catch((e) => e)
      expect(err.message).toBe('Sign-in failed: unknown')
      expect(JSON.stringify(err.params)).not.toContain('evil')
    })
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

  it.each([400, 401])('signs out when Cognito rejects the refresh (%i)', async (status) => {
    saveTokens({ expiresAt: Date.now() - 1 })
    fakeFetch({ [TOKEN_URL]: () => json({ error: 'invalid_grant' }, status) })
    expect(await getAccessToken(CFG)).toBeNull()
    expect(localStorage.getItem('gg.tokens')).toBeNull()
    expect(hasSession()).toBe(false)
  })

  it('stays signed in when the refresh can\'t get through (offline, or Cognito having a moment)', async () => {
    saveTokens({ expiresAt: Date.now() - 1, refreshToken: 'refresh-1' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(getAccessToken(CFG)).rejects.toThrow('Failed to fetch')
    expect(hasSession()).toBe(true)
    fakeFetch({ [TOKEN_URL]: () => json({ error: 'internal' }, 503) })
    await expect(getAccessToken(CFG)).rejects.toThrow('Sign-in failed (503)')
    expect(hasSession()).toBe(true)
    fakeFetch({ [TOKEN_URL]: () => tokenResponse() }) // back online
    expect(await getAccessToken(CFG)).toBe('access-new')
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
