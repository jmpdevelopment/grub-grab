import { act, render, screen, waitFor, within } from '@testing-library/react'
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

  it('shows local mode in settings', async () => {
    const user = await renderApp()
    await user.click(await screen.findByRole('button', { name: /Settings/ }))
    expect(screen.getByText('Local mode')).toBeInTheDocument()
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
    it('asks you to sign in, then redirects to Cognito', async () => {
      const { calls } = fakeApi()
      const user = await renderApp()
      await user.click(await screen.findByRole('button', { name: 'Sign in' }))
      expect(window.location.assign).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/auth\.example\.com\/oauth2\/authorize\?/))
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

    it('shows why sign-in failed', async () => {
      fakeLocation('http://localhost/?code=bad')
      fakeApi({}, { [`POST ${CFG.cognitoDomain}/oauth2/token`]: fail(400) })
      await renderApp()
      expect(await screen.findByText('Sign-in failed (400)')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    })

    it('goes back to sign-in when the API rejects the session', async () => {
      saveTokens()
      fakeApi({}, { [`GET ${CFG.apiUrl}recipes`]: () => json({ message: 'Unauthorized' }, 401) })
      await renderApp()
      expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
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
      expect(screen.getByText('ABC234')).toBeInTheDocument()

      await user.type(screen.getByPlaceholderText('ABC234'), 'xyz234')
      await user.click(screen.getByRole('button', { name: 'Join' }))
      expect(await screen.findByText('XYZ234')).toBeInTheDocument()
      expect(calls.find((c) => c.url.pathname === '/household/join')!.body).toEqual({ code: 'XYZ234' })
      await user.click(tab(/Recipes/))
      expect(screen.getByText('Shared stew')).toBeInTheDocument()

      await user.click(tab(/Settings/))
      await user.click(screen.getByRole('button', { name: 'Sign out' }))
      expect(window.location.assign).toHaveBeenCalledWith(expect.stringContaining('https://auth.example.com/logout?'))
      expect(localStorage.getItem('gg.tokens')).toBeNull()
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
