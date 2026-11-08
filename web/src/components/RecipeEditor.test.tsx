import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Recipe } from '../types'
import { RecipeEditor } from './RecipeEditor'

const PASTA: Recipe = {
  id: 'r1',
  title: 'Pasta',
  servings: 2,
  notes: 'Boil it',
  ingredients: [
    { name: 'Spaghetti', quantity: 500, unit: 'g' },
    { name: 'Salt', quantity: null, unit: '' },
  ],
}

function setup(props: Partial<Parameters<typeof RecipeEditor>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onCancel = vi.fn()
  render(<RecipeEditor recipe={null} onSave={onSave} onCancel={onCancel} {...props} />)
  return { user: userEvent.setup(), onSave, onCancel }
}

const names = () => screen.getAllByPlaceholderText('Ingredient') as HTMLInputElement[]

describe('RecipeEditor', () => {
  it('creates a recipe from typed rows, cleaning up input', async () => {
    const { user, onSave } = setup()
    expect(screen.getByRole('heading', { name: 'New recipe' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. Chicken curry')).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Delete recipe' })).not.toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), '  Toast  ')
    await user.type(screen.getByPlaceholderText('4'), '2x')
    expect(screen.getByPlaceholderText('4')).toHaveValue('2')

    // Typing a name adds a fresh blank row underneath.
    await user.type(names()[0], 'Bread')
    expect(names()).toHaveLength(2)
    await user.type(screen.getAllByPlaceholderText('Qty')[0], '1,5')
    await user.type(screen.getAllByPlaceholderText('Unit')[0], ' slices ')
    await user.type(names()[1], 'Butter')
    await user.type(screen.getByPlaceholderText('Method, tips…'), 'Toast it')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({
      title: 'Toast',
      servings: 2,
      notes: 'Toast it',
      link: '',
      tags: [],
      ingredients: [
        { name: 'Bread', quantity: 1.5, unit: 'slices' },
        { name: 'Butter', quantity: null, unit: '' },
      ],
    })
  })

  it('requires a title', async () => {
    const { user, onSave } = setup()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Give the recipe a title')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('rejects quantities that are not numbers', async () => {
    const { user, onSave } = setup()
    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Eggs')
    await user.type(names()[0], 'Egg')
    await user.type(screen.getAllByPlaceholderText('Qty')[0], 'two')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('"two" isn\'t a number (Egg)')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows save errors and lets you try again', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce(undefined)
    const { user } = setup({ onSave })
    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Soup')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Network down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Network down')).not.toBeInTheDocument()
  })

  it('adds ingredients from a pasted list, dropping blank lines and empty rows', async () => {
    const { user, onSave } = setup()
    await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Pasta')
    await user.type(names()[0], 'Parsley')

    await user.click(screen.getByRole('button', { name: 'Paste a list' }))
    const box = screen.getByPlaceholderText(/One per line/)
    expect(screen.getByRole('button', { name: 'Add these' })).toBeDisabled()
    await user.type(box, '500 g spaghetti{enter}{enter}- 3 cloves garlic{enter}salt')
    await user.click(screen.getByRole('button', { name: 'Add these' }))

    expect(screen.queryByPlaceholderText(/One per line/)).not.toBeInTheDocument()
    expect(names().map((i) => i.value)).toEqual(['Parsley', 'spaghetti', 'garlic', 'salt', ''])
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave.mock.calls[0][0].ingredients).toEqual([
      { name: 'Parsley', quantity: null, unit: '' },
      { name: 'spaghetti', quantity: 500, unit: 'g' },
      { name: 'garlic', quantity: 3, unit: 'cloves' },
      { name: 'salt', quantity: null, unit: '' },
    ])
  })

  it('can open and close the paste box', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Paste a list' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByPlaceholderText(/One per line/)).not.toBeInTheDocument()
  })

  it('edits an existing recipe and removes rows', async () => {
    const { user, onSave } = setup({ recipe: PASTA, onDelete: vi.fn() })
    expect(screen.getByRole('heading', { name: 'Edit recipe' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. Chicken curry')).toHaveValue('Pasta')
    expect(screen.getByPlaceholderText('4')).toHaveValue('2')
    expect(screen.getByPlaceholderText('Method, tips…')).toHaveValue('Boil it')
    expect(names().map((i) => i.value)).toEqual(['Spaghetti', 'Salt', ''])
    expect(screen.getAllByPlaceholderText('Qty').map((i) => (i as HTMLInputElement).value)).toEqual(['500', '', ''])
    // Only named rows get a remove button.
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Remove Spaghetti' }))
    await user.clear(screen.getByPlaceholderText('4'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({
      title: 'Pasta',
      servings: null,
      notes: 'Boil it',
      link: '',
      tags: [],
      ingredients: [{ name: 'Salt', quantity: null, unit: '' }],
    })
  })

  describe('link', () => {
    const open = () => screen.queryByRole('link', { name: 'Open ↗' })

    it("shows an existing recipe's link with a button to open it in a new tab", () => {
      setup({ recipe: { ...PASTA, link: 'https://www.kwestiasmaku.com/przepis/pasta' } })
      expect(screen.getByLabelText('Link')).toHaveValue('https://www.kwestiasmaku.com/przepis/pasta')
      expect(open()).toHaveAttribute('href', 'https://www.kwestiasmaku.com/przepis/pasta')
      expect(open()).toHaveAttribute('target', '_blank')
      expect(open()).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('adds https:// to a bare address and saves it', async () => {
      const { user, onSave } = setup()
      await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Zurek')
      expect(open()).not.toBeInTheDocument()
      await user.type(screen.getByLabelText('Link'), '  kwestiasmaku.com/przepis/zurek ')
      expect(open()).toHaveAttribute('href', 'https://kwestiasmaku.com/przepis/zurek')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ link: 'https://kwestiasmaku.com/przepis/zurek' }))
    })

    it('refuses something that is not a web address', async () => {
      const { user, onSave } = setup()
      await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Zurek')
      await user.type(screen.getByLabelText('Link'), 'javascript:alert(1)')
      expect(open()).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(screen.getByText("That link doesn't look like a web address")).toBeInTheDocument()
      expect(onSave).not.toHaveBeenCalled()
    })
  })

  describe('tags', () => {
    const chips = () => within(screen.getByRole('group', { name: 'Tags' })).queryAllByRole('button').map((b) => b.textContent)
    const suggestions = () => screen.queryAllByRole('button', { name: /^\+ / }).map((b) => b.textContent)

    it('adds tags by Enter, comma, suggestion or leaving the box; cleans and de-duplicates them', async () => {
      const { user, onSave } = setup({ knownTags: ['polish', 'soup'] })
      expect(suggestions()).toEqual(['+ polish', '+ soup', '+ meat', '+ chicken', '+ fish', '+ vegetarian', '+ pasta', '+ salad', '+ quick'])

      const box = screen.getByLabelText('New tag')
      await user.type(box, ' Soup {enter}')
      await user.type(box, 'FISH,')
      await user.type(box, 'soup{enter}') // already there
      await user.type(box, '   {enter}') // blank
      expect(chips()).toEqual(['soup ×', 'fish ×'])
      expect(box).toHaveValue('')
      expect(suggestions()).not.toContain('+ soup') // used tags aren't suggested again

      await user.click(screen.getByRole('button', { name: '+ polish' }))
      await user.type(box, 'quick')
      await user.click(screen.getByPlaceholderText('e.g. Chicken curry')) // leaving the box keeps the tag
      expect(chips()).toEqual(['soup ×', 'fish ×', 'polish ×', 'quick ×'])

      await user.click(screen.getByRole('button', { name: 'Remove tag fish' }))
      await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Zurek')
      await user.type(box, 'Late') // typed but not confirmed: Save still keeps it
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'Zurek', tags: ['soup', 'polish', 'quick', 'late'] }))
    })

    it("shows an existing recipe's tags and hides suggestions once all are used", () => {
      setup({ recipe: { ...PASTA, tags: ['meat', 'chicken', 'fish', 'vegetarian', 'soup', 'pasta', 'salad', 'quick'] } })
      expect(chips()).toHaveLength(8)
      expect(suggestions()).toEqual([])
    })
  })

  it('handles a recipe without servings', () => {
    setup({ recipe: { ...PASTA, servings: null } })
    expect(screen.getByPlaceholderText('4')).toHaveValue('')
  })

  it('only deletes after confirmation', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { user } = setup({ recipe: PASTA, onDelete })

    await user.click(screen.getByRole('button', { name: 'Delete recipe' }))
    expect(confirm).toHaveBeenCalledWith('Delete "Pasta"?')
    expect(onDelete).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete recipe' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Delete recipe' })).toBeDisabled()
  })

  it('cancels', async () => {
    const { user, onCancel } = setup()
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
