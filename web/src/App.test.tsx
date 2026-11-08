import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL_MS } from './App'
import { fail, fakeApi } from './test/fakeApi'
import { CFG, fakeFetch, fakeLocation, json, jwt, saveTokens } from './test/fakes'
import type { Recipe } from './types'

// config.ts caches the config per page load; give every test a fresh page.
beforeEach(() => vi.resetModules())

async function renderApp() {
  const { default: FreshApp } = await import('./App')
  const user = userEvent.setup()
  render(<FreshApp />)
  return user
}

const tab = (name: RegExp) => within(screen.getByRole('navigation')).getByRole('button', { name })

const PASTA: Recipe = {
  id: 'p',
  title: 'Pasta',
  servings: 2,
  notes: '',
  ingredients: [
    { name: 'Spaghetti', quantity: 500, unit: 'g' },
    { name: 'Garlic', quantity: 3, unit: 'cloves' },
  ],
}

describe('local mode (no config.json)', () => {
  beforeEach(() => {
    fakeFetch({ 'GET /config.json': () => new Response('', { status: 404 }) })
  })

  it('shows a loading screen, then recipes', async () => {
    const { default: FreshApp } = await import('./App')
    render(<FreshApp />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(await screen.findByText('No recipes yet.')).toBeInTheDocument()
  })

  it('runs the whole flow: add, edit, list, shop, clear', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = await renderApp()

    // Add two recipes.
    await user.click(await screen.findByRole('button', { name: 'Add your first recipe' }))
    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Pasta')
    await user.type(screen.getAllByPlaceholderText('Ingredient')[0], 'Garlic')
    await user.type(screen.getAllByPlaceholderText('Qty')[0], '3')
    await user.type(screen.getAllByPlaceholderText('Unit')[0], 'cloves')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await user.click(screen.getByRole('button', { name: '+ New' }))
    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Curry')
    await user.click(screen.getByRole('button', { name: 'Paste a list' }))
    await user.type(screen.getByPlaceholderText(/One per line/), '4 cloves garlic{enter}1 kg rice')
    await user.click(screen.getByRole('button', { name: 'Add these' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Curry'),
      expect.stringContaining('Pasta'),
    ])

    // Rename one; it re-sorts.
    await user.click(screen.getByText('Pasta'))
    await user.clear(screen.getByPlaceholderText('e.g. Chicken curry'))
    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Aglio')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Aglio')

    // Build the list from both.
    for (const box of screen.getAllByRole('checkbox')) await user.click(box)
    await user.click(screen.getByRole('button', { name: 'Make list (2)' }))
    expect(screen.getByRole('heading', { name: 'Shopping list' })).toBeInTheDocument()
    expect(tab(/List/)).toHaveTextContent('List (2)')
    expect(screen.getByText('7 cloves')).toBeInTheDocument()

    // Shop.
    await user.click(screen.getByText('Garlic'))
    expect(screen.getByText('1 to buy · 1 in the basket')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Add an item, e.g. 2 lemons'), '2 lemons{enter}')
    expect(screen.getByText('lemons')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove lemons' }))
    expect(screen.queryByText('lemons')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear ticked' }))
    expect(screen.queryByText('Garlic')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.getByText('rice')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear whole list' }))
    expect(screen.getByText('Your list is empty.')).toBeInTheDocument()
    expect(tab(/List/)).toHaveTextContent(/^.?List$/u)

    // Delete a recipe.
    await user.click(tab(/Recipes/))
    await user.click(screen.getByText('Curry'))
    await user.click(screen.getByRole('button', { name: 'Delete recipe' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)

    // Data survives a reload.
    expect(JSON.parse(localStorage.getItem('gg.local')!).recipes.map((r: Recipe) => r.title)).toEqual(['Aglio'])
  })

  it('keeps the selection screen if making a list fails', async () => {
    localStorage.setItem('gg.local', JSON.stringify({ recipes: [PASTA], items: [] }))
    const user = await renderApp()
    await user.click(await screen.findByRole('checkbox'))
    // The recipe disappears from storage behind the app's back (e.g. another tab deleted it).
    localStorage.setItem('gg.local', JSON.stringify({ recipes: [], items: [] }))
    await user.click(screen.getByRole('button', { name: 'Make list (1)' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Recipe p not found')
    expect(screen.getByRole('heading', { name: 'Recipes' })).toBeInTheDocument()
    await user.click(screen.getByRole('alert'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cancels editing without saving', async () => {
    const user = await renderApp()
    await user.click(await screen.findByRole('button', { name: '+ New' }))
    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Draft')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('No recipes yet.')).toBeInTheDocument()
  })

  it('has no account to delete in local mode', async () => {
    const user = await renderApp()
    await user.click(await screen.findByRole('button', { name: /Settings/ }))
    expect(screen.queryByRole('button', { name: 'Delete my account' })).not.toBeInTheDocument()
  })

  it('shows local mode in settings', async () => {
    const user = await renderApp()
    await user.click(await screen.findByRole('button', { name: /Settings/ }))
    expect(screen.getByText('Local mode')).toBeInTheDocument()
  })

  it('pull to refresh switches to a newly deployed version instead of reloading data', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    // The browser's service worker objects (jsdom has none): a new version has finished installing.
    const newVersion = { state: 'activated', addEventListener: vi.fn() }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: {},
        addEventListener: vi.fn(),
        getRegistration: async () => ({ update: async () => {}, installing: null, waiting: newVersion }),
      },
    })
    try {
      await renderApp()
      await screen.findByText('No recipes yet.')
      await act(async () => {
        fireEvent.touchStart(window, { touches: [{ clientY: 0 }] })
        fireEvent.touchMove(window, { touches: [{ clientY: 400 }] })
        fireEvent.touchEnd(window, { touches: [] })
      })
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    } finally {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
      vi.unstubAllGlobals()
    }
  })

  it('does not poll in local mode', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { fn } = fakeFetch({ 'GET /config.json': () => new Response('', { status: 404 }) })
      const user = await renderApp()
      await user.click(await screen.findByRole('button', { name: /List/ }))
      act(() => vi.advanceTimersByTime(POLL_MS * 3))
      expect(fn).toHaveBeenCalledTimes(1) // just the config
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cloud mode', () => {
  beforeEach(() => {
    fakeLocation('http://localhost/')
  })

  describe('signing in', () => {
    it('asks you to sign in, then redirects to Google via Cognito', async () => {
      const { calls } = fakeApi()
      const user = await renderApp()
      await user.click(await screen.findByRole('button', { name: 'Continue with Google' }))
      // Sign-in hashes the PKCE verifier asynchronously before redirecting.
      await waitFor(() => expect(window.location.assign).toHaveBeenCalled())
      const url = new URL((window.location.assign as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])
      expect(url.origin + url.pathname).toBe('https://auth.example.com/oauth2/authorize')
      expect(url.searchParams.get('identity_provider')).toBe('Google')
      expect(calls.map((c) => c.url.pathname)).toEqual(['/config.json'])
    })

    it('completes the redirect back from Cognito and loads data', async () => {
      fakeLocation('http://localhost/?code=xyz')
      sessionStorage.setItem('gg.pkce', 'v')
      fakeApi(
        { recipes: [PASTA] },
        {
          [`POST ${CFG.cognitoDomain}/oauth2/token`]: () =>
            json({ id_token: jwt({ email: 'a@b.c' }), access_token: 'tok', refresh_token: 'r', expires_in: 3600 }),
        },
      )
      await renderApp()
      expect(await screen.findByText('Pasta')).toBeInTheDocument()
    })

    it('tells someone their sign-up request is waiting for approval', async () => {
      fakeLocation('http://localhost/?error_description=PreSignUp+failed+with+error+ACCESS_PENDING.+&error=invalid_request')
      fakeApi()
      await renderApp()
      expect(await screen.findByText(/Your request to join has been sent/)).toHaveClass('notice')
      expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    })

    it('links to the privacy policy from the sign-in screen', async () => {
      fakeApi()
      await renderApp()
      expect(await screen.findByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy.html')
    })

    it('shows why sign-in failed', async () => {
      fakeLocation('http://localhost/?code=bad')
      fakeApi({}, { [`POST ${CFG.cognitoDomain}/oauth2/token`]: fail(400) })
      await renderApp()
      expect(await screen.findByText('Sign-in failed (400)')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    })

    it('goes back to sign-in when the API rejects the session', async () => {
      saveTokens()
      fakeApi({}, { [`GET ${CFG.apiUrl}recipes`]: () => json({ message: 'Unauthorized' }, 401) })
      await renderApp()
      expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    })
  })

  describe('signed in', () => {
    beforeEach(() => saveTokens({ idToken: jwt({ email: 'me@example.com' }) }))

    it('shows the account, invite code, signs out and joins a household', async () => {
      const { calls } = fakeApi({ recipes: [PASTA] })
      const user = await renderApp()
      await screen.findByText('Pasta')
      await user.click(tab(/Settings/))
      expect(screen.getByText('me@example.com')).toBeInTheDocument()
      expect(screen.getByText('ABCDE-FGH23')).toBeInTheDocument()

      vi.spyOn(window, 'confirm').mockReturnValue(true)
      await user.click(screen.getByRole('button', { name: 'New code' }))
      expect(await screen.findByText('ROTAT-ED234')).toBeInTheDocument()

      await user.type(screen.getByPlaceholderText('ABCDE-FGH23'), 'xyz23-abcde')
      await user.click(screen.getByRole('button', { name: 'Join' }))
      expect(await screen.findByText('XYZ23-ABCDE')).toBeInTheDocument()
      expect(calls.find((c) => c.url.pathname === '/household/join')!.body).toEqual({ code: 'XYZ23ABCDE' })
      await user.click(tab(/Recipes/))
      expect(screen.getByText('Shared stew')).toBeInTheDocument()

      await user.click(tab(/Settings/))
      await user.click(screen.getByRole('button', { name: 'Sign out' }))
      expect(window.location.assign).toHaveBeenCalledWith(expect.stringContaining('https://auth.example.com/logout?'))
      expect(localStorage.getItem('gg.tokens')).toBeNull()
    })

    describe('first sign-in: start or join a household', () => {
      const NEW_USER = { household: { householdId: null, inviteCode: null } }
      const paths = (calls: { method: string; url: URL }[]) => calls.map((c) => `${c.method} ${c.url.pathname}`)

      it('welcomes a new user without loading any household data', async () => {
        const { calls } = fakeApi(NEW_USER)
        await renderApp()
        expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument()
        expect(screen.getByText(/Signed in as me@example.com/)).toBeInTheDocument()
        expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
        expect(paths(calls)).toEqual(['GET /config.json', 'GET /me'])
      })

      it('starts a new household and lands on its empty recipe book', async () => {
        const { calls } = fakeApi(NEW_USER)
        const user = await renderApp()
        await user.click(await screen.findByRole('button', { name: 'Start a household' }))
        expect(await screen.findByText('No recipes yet.')).toBeInTheDocument()
        expect(paths(calls).filter((p) => p === 'POST /household')).toHaveLength(1)
        await user.click(tab(/Settings/))
        expect(screen.getByText('NEWHO-ME234')).toBeInTheDocument()
      })

      it("joins someone else's household instead, without creating one", async () => {
        const { calls } = fakeApi(NEW_USER)
        const user = await renderApp()
        await user.type(await screen.findByLabelText('Invite code'), 'xyz23 abcde')
        await user.click(screen.getByRole('button', { name: 'Join' }))
        expect(await screen.findByText('Shared stew')).toBeInTheDocument()
        expect(calls.find((c) => c.url.pathname === '/household/join')!.body).toEqual({ code: 'XYZ23ABCDE' })
        expect(paths(calls)).not.toContain('POST /household')
      })

      it('shows why starting or joining failed, and stays on the welcome screen', async () => {
        fakeApi(NEW_USER, {
          [`POST ${CFG.apiUrl}household`]: fail(503, 'Try again shortly'),
          [`POST ${CFG.apiUrl}household/join`]: fail(404, 'Invite code not found'),
        })
        const user = await renderApp()
        await user.click(await screen.findByRole('button', { name: 'Start a household' }))
        expect(await screen.findByText('Try again shortly')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Start a household' })).toBeEnabled()

        await user.type(screen.getByLabelText('Invite code'), 'NOPEN-OPE23')
        await user.click(screen.getByRole('button', { name: 'Join' }))
        expect(await screen.findByText('Invite code not found')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument()
      })

      it('can sign out from the welcome screen', async () => {
        fakeApi(NEW_USER)
        const user = await renderApp()
        await user.click(await screen.findByRole('button', { name: 'Not you? Sign out' }))
        expect(window.location.assign).toHaveBeenCalledWith(expect.stringContaining('https://auth.example.com/logout?'))
      })
    })

    it("pull to refresh brings in the other person's changes", async () => {
      const { state } = fakeApi({ recipes: [PASTA] })
      await renderApp()
      await screen.findByText('Pasta')
      state.recipes = [...state.recipes, { id: 'n', title: 'Added on the other phone', servings: null, notes: '', ingredients: [] }]
      await act(async () => {
        fireEvent.touchStart(window, { touches: [{ clientY: 0 }] })
        fireEvent.touchMove(window, { touches: [{ clientY: 400 }] })
        fireEvent.touchEnd(window, { touches: [] })
      })
      expect(await screen.findByText('Added on the other phone')).toBeInTheDocument()
    })

    describe('sign-up approval (admins)', () => {
      const ADMIN = { householdId: 'h1', inviteCode: 'ABCDEFGH23', admin: true, pendingRequests: 2 }
      const WAITING = [
        { username: 'Google_1', email: 'anna@example.com', name: 'Anna', requestedAt: 1_794_130_000 },
        { username: 'Google_2', email: 'bot@spam.example', name: '', requestedAt: 1_794_131_000 },
      ]

      it('shows the count on the Settings tab and lets the admin approve people', async () => {
        const { calls } = fakeApi({ household: ADMIN, requests: WAITING })
        const user = await renderApp()
        expect(await screen.findByText('No recipes yet.')).toBeInTheDocument()
        expect(tab(/Settings/)).toHaveTextContent('Settings (2)')
        await user.click(tab(/Settings/))
        await user.click(await screen.findByRole('button', { name: 'Approve Anna' }))
        expect(calls.some((c) => c.method === 'POST' && c.url.pathname === '/admin/requests/Google_1/approve')).toBe(true)
        expect(tab(/Settings/)).toHaveTextContent('Settings (1)')
        await user.click(screen.getByRole('button', { name: 'Decline bot@spam.example' }))
        expect(tab(/Settings/)).toHaveTextContent(/^⚙️Settings$/)
      })

      it('admins can decline everyone at once', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true)
        fakeApi({ household: ADMIN, requests: WAITING })
        const user = await renderApp()
        await user.click(await screen.findByRole('button', { name: /Settings/ }))
        await user.click(await screen.findByRole('button', { name: 'Decline all' }))
        expect(await screen.findByText(/No one is waiting/)).toBeInTheDocument()
      })

      it('is not shown to anyone else', async () => {
        const { calls } = fakeApi({ requests: WAITING })
        const user = await renderApp()
        await user.click(await screen.findByRole('button', { name: /Settings/ }))
        expect(screen.queryByText('Sign-up requests')).not.toBeInTheDocument()
        expect(calls.some((c) => c.url.pathname.startsWith('/admin'))).toBe(false)
      })
    })

    it('shows placeholders while recipes load, never a false "No recipes yet"', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      // The recipes request is held back until we release it.
      fakeApi({ recipes: [PASTA] }, { [`GET ${CFG.apiUrl}recipes`]: async () => (await gate, json([PASTA])) })
      const user = await renderApp()
      expect(await screen.findByText('Loading recipes…')).toBeInTheDocument()
      expect(screen.queryByText('No recipes yet.')).not.toBeInTheDocument()
      await user.click(tab(/List/))
      expect(screen.getByText('Loading your list…')).toBeInTheDocument()
      expect(screen.queryByText('Your list is empty.')).not.toBeInTheDocument()
      await act(async () => release())
      expect(await screen.findByText('Your list is empty.')).toBeInTheDocument()
      await user.click(tab(/Recipes/))
      expect(screen.getByText('Pasta')).toBeInTheDocument()
      expect(screen.queryByText('Loading recipes…')).not.toBeInTheDocument()
    })

    it('deletes the account and returns to the sign-in screen, signed out', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { calls } = fakeApi({ recipes: [PASTA] })
      const user = await renderApp()
      await screen.findByText('Pasta')
      await user.click(tab(/Settings/))
      await user.click(screen.getByRole('button', { name: 'Delete my account' }))
      expect(await screen.findByText('Your account and its data have been deleted.')).toHaveClass('notice')
      expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
      expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/me')).toBe(true)
      expect(localStorage.getItem('gg.tokens')).toBeNull()
    })

    it('shows the app with an error banner if the account cannot be loaded', async () => {
      fakeApi({}, { [`GET ${CFG.apiUrl}me`]: fail(503, 'Service unavailable') })
      await renderApp()
      expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable')
      expect(screen.getByRole('navigation')).toBeInTheDocument()
    })

    it('shows a load error as a dismissable banner', async () => {
      fakeApi({}, { [`GET ${CFG.apiUrl}list`]: fail(503, 'Service unavailable') })
      const user = await renderApp()
      const banner = await screen.findByRole('alert')
      expect(banner).toHaveTextContent('Service unavailable')
      await user.click(banner)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('shows delete errors inside the editor and keeps the recipe', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      fakeApi({ recipes: [PASTA] }, { [`DELETE ${CFG.apiUrl}recipes/:id`]: fail(500, 'Could not delete') })
      const user = await renderApp()
      await user.click(await screen.findByText('Pasta'))
      await user.click(screen.getByRole('button', { name: 'Delete recipe' }))
      expect(await screen.findByText('Could not delete')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByText('Pasta')).toBeInTheDocument()
    })

    describe('list changes roll back when the server fails', () => {
      const ITEMS = [
        { id: 'i1', name: 'Garlic', quantity: 7, unit: 'cloves', checked: false, recipes: [] },
        { id: 'i2', name: 'Rice', quantity: 1, unit: 'kg', checked: true, recipes: [] },
      ]

      async function openList(overrides: Parameters<typeof fakeApi>[1]) {
        fakeApi({ items: structuredClone(ITEMS) }, overrides)
        const user = await renderApp()
        await screen.findByText('No recipes yet.')
        await user.click(tab(/List/))
        return user
      }

      it('untick', async () => {
        const user = await openList({ [`PATCH ${CFG.apiUrl}list/items/:id`]: fail() })
        await user.click(screen.getByText('Garlic'))
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        expect(screen.getByText('1 to buy · 1 in the basket')).toBeInTheDocument()
        expect(within(screen.getAllByRole('list')[0]).getByText('Garlic')).toBeInTheDocument()
      })

      it('add', async () => {
        const user = await openList({ [`POST ${CFG.apiUrl}list/items`]: fail() })
        await user.type(screen.getByPlaceholderText('Add an item, e.g. 2 lemons'), 'Lemons{enter}')
        await screen.findByRole('alert')
        expect(screen.queryByText('Lemons')).not.toBeInTheDocument()
      })

      it('delete', async () => {
        const user = await openList({ [`DELETE ${CFG.apiUrl}list/items/:id`]: fail() })
        await user.click(screen.getByRole('button', { name: 'Remove Garlic' }))
        await screen.findByRole('alert')
        expect(screen.getByText('Garlic')).toBeInTheDocument()
      })

      it('clear', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true)
        const user = await openList({ [`DELETE ${CFG.apiUrl}list`]: fail() })
        await user.click(screen.getByRole('button', { name: 'Clear ticked' }))
        await screen.findByRole('alert')
        expect(screen.getByText('Rice')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Clear whole list' }))
        expect(screen.getByText('Garlic')).toBeInTheDocument()
      })

      it('successful changes stick', async () => {
        const user = await openList({})
        await user.click(screen.getByText('Rice')) // untick
        await waitFor(() => expect(screen.getByText('2 to buy')).toBeInTheDocument())
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
    })

    describe('syncing with the other phone', () => {
      beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
      afterEach(() => vi.useRealTimers())

      const listCalls = (calls: { method: string; url: URL }[]) =>
        calls.filter((c) => c.method === 'GET' && c.url.pathname === '/list').length

      it('polls while the list is open and visible', async () => {
        const { state, calls } = fakeApi()
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
        const { default: FreshApp } = await import('./App')
        render(<FreshApp />)
        await screen.findByText('No recipes yet.')
        await user.click(tab(/List/))
        const before = listCalls(calls)

        state.items = [{ id: 'x', name: 'Bread', quantity: null, unit: '', checked: false, recipes: [] }]
        await act(async () => vi.advanceTimersByTime(POLL_MS))
        expect(await screen.findByText('Bread')).toBeInTheDocument()
        expect(listCalls(calls)).toBe(before + 1)

        // Hidden tab: no polling.
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        await act(async () => vi.advanceTimersByTime(POLL_MS * 2))
        expect(listCalls(calls)).toBe(before + 1)

        // Coming back to the app syncs immediately.
        visibility.mockReturnValue('visible')
        state.items = []
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await waitFor(() => expect(screen.getByText('Your list is empty.')).toBeInTheDocument())

        // Leaving the list tab stops polling.
        await user.click(tab(/Recipes/))
        const after = listCalls(calls)
        await act(async () => vi.advanceTimersByTime(POLL_MS * 3))
        expect(listCalls(calls)).toBe(after)
      })

      it('ignores polling errors quietly', async () => {
        let failNow = false
        const { state } = fakeApi(
          { items: [{ id: 'x', name: 'Bread', quantity: null, unit: '', checked: false, recipes: [] }] },
          { [`GET ${CFG.apiUrl}list`]: () => (failNow ? json({ error: 'down' }, 500) : json(state.items)) },
        )
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
        const { default: FreshApp } = await import('./App')
        render(<FreshApp />)
        await screen.findByText('No recipes yet.')
        await user.click(tab(/List/))
        failNow = true
        await act(async () => vi.advanceTimersByTime(POLL_MS))
        expect(screen.getByText('Bread')).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
    })
  })
})
