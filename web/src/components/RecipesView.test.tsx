import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Recipe } from '../types'
import { RecipesView } from './RecipesView'

const recipe = (id: string, title: string, ingredients: string[] = [], servings: number | null = null): Recipe => ({
  id,
  title,
  servings,
  notes: '',
  ingredients: ingredients.map((name) => ({ name, quantity: null, unit: '' })),
})

const PASTA = recipe('p', 'Pasta', ['Spaghetti', 'Garlic'], 2)
const SOUP = recipe('s', 'Soup', ['Leek'])

function setup(recipes: Recipe[], hasList = false) {
  const onOpen = vi.fn()
  const onMakeList = vi.fn().mockResolvedValue(undefined)
  render(<RecipesView recipes={recipes} hasList={hasList} onOpen={onOpen} onMakeList={onMakeList} />)
  return { user: userEvent.setup(), onOpen, onMakeList }
}

const tagged = (r: Recipe, ...tags: string[]): Recipe => ({ ...r, tags })

describe('RecipesView', () => {
  it('has a one-tap link to the recipe page, only for safe web links', () => {
    setup([
      { ...PASTA, link: 'https://www.kwestiasmaku.com/przepis/pasta' },
      { ...SOUP, link: 'javascript:alert(1)' },
      recipe('c', 'Curry'),
    ])
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName('Open the Pasta recipe page')
    expect(links[0]).toHaveAttribute('href', 'https://www.kwestiasmaku.com/przepis/pasta')
    expect(links[0]).toHaveAttribute('target', '_blank')
  })

  describe('tags', () => {
    const titles = () => screen.getAllByRole('listitem').map((li) => li.querySelector('strong')!.textContent)
    const chip = (name: string) => within(screen.getByRole('group', { name: 'Filter by tag' })).getByRole('button', { name })

    it('has no tag filter when no recipe is tagged', () => {
      setup([PASTA, SOUP])
      expect(screen.queryByRole('group', { name: 'Filter by tag' })).not.toBeInTheDocument()
    })

    it('shows tags on cards and filters by one tag at a time, most-used tags first', async () => {
      const { user } = setup([tagged(PASTA, 'pasta', 'quick'), tagged(SOUP, 'soup', 'quick'), tagged(recipe('f', 'Fish pie'), 'fish')])
      expect(screen.getByText('pasta · quick')).toBeInTheDocument()
      const group = screen.getByRole('group', { name: 'Filter by tag' })
      expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['quick', 'fish', 'pasta', 'soup'])

      await user.click(chip('quick'))
      expect(chip('quick')).toHaveAttribute('aria-pressed', 'true')
      expect(titles()).toEqual(['Pasta', 'Soup'])
      await user.click(chip('soup')) // switching tag replaces the filter
      expect(titles()).toEqual(['Soup'])
      expect(chip('quick')).toHaveAttribute('aria-pressed', 'false')
      await user.click(chip('soup')) // tapping again clears it
      expect(titles()).toEqual(['Pasta', 'Soup', 'Fish pie'])
    })

    it('forgets a filter once no recipe has that tag any more', async () => {
      const onOpen = vi.fn()
      const props = { hasList: false, onOpen, onMakeList: vi.fn() }
      const { rerender } = render(<RecipesView recipes={[tagged(SOUP, 'soup'), tagged(PASTA, 'pasta')]} {...props} />)
      await userEvent.setup().click(chip('soup'))
      expect(titles()).toEqual(['Soup'])
      rerender(<RecipesView recipes={[SOUP, tagged(PASTA, 'pasta')]} {...props} />)
      expect(titles()).toEqual(['Soup', 'Pasta'])
    })

    it('finds tags with search too, and says when nothing matches', async () => {
      const { user } = setup([PASTA, SOUP, recipe('a', 'A'), recipe('b', 'B'), tagged(recipe('c', 'Curry'), 'vegetarian')])
      await user.type(screen.getByRole('searchbox'), 'veg')
      expect(titles()).toEqual(['Curry'])
      await user.type(screen.getByRole('searchbox'), 'xyz')
      expect(screen.queryAllByRole('listitem')).toHaveLength(0)
      expect(screen.getByText('No recipes match.')).toBeInTheDocument()
    })
  })

  it('shows placeholders, not "No recipes yet", while loading', () => {
    render(<RecipesView recipes={[]} loading hasList={false} onOpen={vi.fn()} onMakeList={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading recipes…')
    expect(screen.queryByText('No recipes yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ New' })).toBeInTheDocument() // can still add one
  })

  it('invites you to add the first recipe when empty', async () => {
    const { user, onOpen } = setup([])
    expect(screen.getByText('No recipes yet.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add your first recipe' }))
    expect(onOpen).toHaveBeenCalledWith(null)
  })

  it('lists recipes with counts and servings, and opens them', async () => {
    const { user, onOpen } = setup([PASTA, SOUP])
    expect(screen.getByText('2 ingredients · serves 2')).toBeInTheDocument()
    expect(screen.getByText('1 ingredient')).toBeInTheDocument()
    await user.click(screen.getByText('Soup'))
    expect(onOpen).toHaveBeenCalledWith(SOUP)
    await user.click(screen.getByRole('button', { name: '+ New' }))
    expect(onOpen).toHaveBeenLastCalledWith(null)
  })

  it('only shows search once there are more than four recipes', async () => {
    setup([PASTA, SOUP, recipe('a', 'A'), recipe('b', 'B')])
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('searches by title or ingredient, case-insensitively', async () => {
    const { user } = setup([PASTA, SOUP, recipe('a', 'Apple pie', ['Apples']), recipe('b', 'Bread'), recipe('c', 'Curry', ['Garlic'])])
    const search = screen.getByRole('searchbox')
    await user.type(search, '  GARLIC ')
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Pasta'),
      expect.stringContaining('Curry'),
    ])
    await user.clear(search)
    await user.type(search, 'bread')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('makes a new list from the ticked recipes without asking when there is no list', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { user, onMakeList } = setup([PASTA, SOUP])
    expect(screen.queryByRole('button', { name: /Make list/ })).not.toBeInTheDocument()

    const [pastaBox, soupBox] = screen.getAllByRole('checkbox')
    await user.click(pastaBox)
    await user.click(soupBox)
    await user.click(soupBox) // untick
    expect(screen.getAllByRole('listitem').map((li) => li.className)).toEqual(['card selected', 'card'])
    expect(screen.queryByRole('button', { name: 'Add to list' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Make list (1)' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(onMakeList).toHaveBeenCalledWith(['p'], 'replace')
    // Selection resets afterwards.
    expect(screen.queryByRole('button', { name: /Make list/ })).not.toBeInTheDocument()
  })

  it('asks before replacing an existing list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { user, onMakeList } = setup([PASTA], true)
    await user.click(screen.getByRole('checkbox'))

    await user.click(screen.getByRole('button', { name: 'New list (1)' }))
    expect(confirm).toHaveBeenCalledWith('Replace the current shopping list?')
    expect(onMakeList).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox')).toBeChecked() // selection kept when cancelled

    await user.click(screen.getByRole('button', { name: 'New list (1)' }))
    expect(onMakeList).toHaveBeenCalledWith(['p'], 'replace')
  })

  it('adds to an existing list without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { user, onMakeList } = setup([PASTA, SOUP], true)
    await user.click(screen.getAllByRole('checkbox')[1])
    await user.click(screen.getByRole('button', { name: 'Add to list' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(onMakeList).toHaveBeenCalledWith(['s'], 'append')
  })

  it('disables the buttons while a list is being made', async () => {
    let finish!: () => void
    const { user, onMakeList } = setup([PASTA], true)
    onMakeList.mockReturnValue(new Promise<void>((r) => (finish = r)))
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Add to list' }))
    expect(screen.getByRole('button', { name: 'Add to list' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New list (1)' })).toBeDisabled()
    finish()
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Add to list' })).not.toBeInTheDocument())
  })
})
