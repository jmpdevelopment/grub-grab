import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ListItem } from '../types'
import { ListView } from './ListView'

const item = (id: string, name: string, over: Partial<ListItem> = {}): ListItem => ({
  id,
  name,
  quantity: null,
  unit: '',
  checked: false,
  recipes: [],
  ...over,
})

const GARLIC = item('g', 'Garlic', { quantity: 7, unit: 'cloves', recipes: ['Pasta', 'Curry'] })
const SALT = item('s', 'Salt')
const RICE = item('r', 'Rice', { quantity: 1, unit: 'kg', checked: true })

function setup(items: ListItem[], loading = false) {
  const props = {
    onToggle: vi.fn(),
    onAdd: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    onClear: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn(),
  }
  render(<ListView items={items} loading={loading} {...props} />)
  return { user: userEvent.setup(), ...props }
}

/** navigator.share is a browser/OS boundary; jsdom doesn't have it. */
function withShare(impl: (data: ShareData) => Promise<void>, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)') {
  const share = vi.fn(impl)
  Object.defineProperty(navigator, 'share', { value: share, configurable: true })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
  return share
}

afterEach(() => {
  delete (navigator as { share?: unknown }).share
})

describe('ListView', () => {
  it('shows placeholders, not "Your list is empty", while loading', () => {
    setup([], true)
    expect(screen.getByRole('status')).toHaveTextContent('Loading your list…')
    expect(screen.queryByText('Your list is empty.')).not.toBeInTheDocument()
  })

  it('shows an empty state', () => {
    setup([])
    expect(screen.getByText('Your list is empty.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear whole list' })).not.toBeInTheDocument()
  })

  it('splits items into to-buy and basket, with quantities and sources', () => {
    setup([GARLIC, SALT, RICE])
    expect(screen.getByText('2 to buy · 1 in the basket')).toBeInTheDocument()
    const [todo, basket] = screen.getAllByRole('list')
    expect(within(todo).getAllByRole('listitem').map((li) => li.className)).toEqual(['item', 'item'])
    expect(within(todo).getByText('7 cloves')).toBeInTheDocument()
    expect(within(todo).getByText('Pasta, Curry')).toBeInTheDocument()
    expect(within(basket).getByRole('listitem')).toHaveClass('item done')
    expect(within(basket).getByRole('checkbox')).toBeChecked()
  })

  it('omits the basket section when nothing is ticked', () => {
    setup([SALT])
    expect(screen.getByText('1 to buy')).toBeInTheDocument()
    expect(screen.queryByText('In the basket')).not.toBeInTheDocument()
  })

  it('toggles, deletes and refreshes', async () => {
    const { user, onToggle, onDelete, onRefresh } = setup([GARLIC, RICE])
    await user.click(screen.getByText('Garlic'))
    expect(onToggle).toHaveBeenCalledWith(GARLIC)
    await user.click(screen.getByRole('button', { name: 'Remove Rice' }))
    expect(onDelete).toHaveBeenCalledWith(RICE)
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalled()
  })

  it('adds a parsed item and clears the box', async () => {
    const { user, onAdd } = setup([])
    const box = screen.getByPlaceholderText('Add an item, e.g. 2 lemons')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    await user.type(box, '500 g mince{enter}')
    expect(onAdd).toHaveBeenCalledWith({ name: 'mince', quantity: 500, unit: 'g' })
    expect(box).toHaveValue('')
  })

  it('ignores a whitespace-only item, even if the form is submitted directly', async () => {
    const { user, onAdd } = setup([])
    const box = screen.getByPlaceholderText('Add an item, e.g. 2 lemons')
    await user.type(box, '   {enter}')
    fireEvent.submit(box.closest('form')!) // bypasses the disabled button, as some keyboards' "Go" key can
    expect(onAdd).not.toHaveBeenCalled()
    expect(box).toHaveValue('   ')
  })

  it('clears ticked items, and the whole list only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { user, onClear } = setup([GARLIC, RICE])
    await user.click(screen.getByRole('button', { name: 'Clear ticked' }))
    expect(onClear).toHaveBeenLastCalledWith(true)

    await user.click(screen.getByRole('button', { name: 'Clear whole list' }))
    expect(confirm).toHaveBeenCalledWith('Clear the whole list?')
    expect(onClear).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Clear whole list' }))
    expect(onClear).toHaveBeenLastCalledWith(false)
  })

  describe('Share', () => {
    it('opens the share sheet on phones', async () => {
      const share = withShare(async () => {})
      const { user } = setup([GARLIC, SALT, RICE])
      await user.click(screen.getByRole('button', { name: 'Share' }))
      expect(share).toHaveBeenCalledWith({ title: 'Shopping list', text: '- Garlic (7 cloves)\n- Salt' })
      expect(screen.queryByText('List copied')).not.toBeInTheDocument()
    })

    it('copies to the clipboard on desktop even if share exists', async () => {
      const share = withShare(async () => {}, 'Mozilla/5.0 (Macintosh)')
      const { user } = setup([GARLIC])
      await user.click(screen.getByRole('button', { name: 'Share' }))
      expect(share).not.toHaveBeenCalled()
      expect(await navigator.clipboard.readText()).toBe('- Garlic (7 cloves)')
      expect(screen.getByText('List copied')).toBeInTheDocument()
    })

    it('copies when share is unavailable', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android')
      const { user } = setup([SALT])
      await user.click(screen.getByRole('button', { name: 'Share' }))
      expect(await navigator.clipboard.readText()).toBe('- Salt')
    })

    it('says so when there is nothing left to buy', async () => {
      const share = withShare(async () => {})
      const { user } = setup([RICE])
      await user.click(screen.getByRole('button', { name: 'Share' }))
      expect(share).not.toHaveBeenCalled()
      expect(screen.getByText('Nothing left to buy')).toBeInTheDocument()
    })

    it('stays quiet when the user cancels the share sheet', async () => {
      withShare(() => Promise.reject(new DOMException('cancelled', 'AbortError')))
      const { user } = setup([SALT])
      await user.click(screen.getByRole('button', { name: 'Share' }))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(screen.queryByText(/Couldn't copy/)).not.toBeInTheDocument()
    })

    it('reports other failures', async () => {
      withShare(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
      const { user } = setup([SALT])
      await user.click(screen.getByRole('button', { name: 'Share' }))
      expect(screen.getByText("Couldn't copy — try again")).toBeInTheDocument()
    })

    it('hides the toast after a moment', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { user } = setup([RICE])
        await user.click(screen.getByRole('button', { name: 'Share' }))
        expect(screen.getByText('Nothing left to buy')).toBeInTheDocument()
        act(() => vi.advanceTimersByTime(1800))
        expect(screen.queryByText('Nothing left to buy')).not.toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
