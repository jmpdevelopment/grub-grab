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
    await user.type(screen.getByPlaceholderText('Method, link, tips…'), 'Toast it')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({
      title: 'Toast',
      servings: 2,
      notes: 'Toast it',
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
    expect(screen.getByPlaceholderText('Method, link, tips…')).toHaveValue('Boil it')
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
      ingredients: [{ name: 'Salt', quantity: null, unit: '' }],
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
