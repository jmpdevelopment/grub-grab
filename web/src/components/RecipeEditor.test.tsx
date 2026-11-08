import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../i18n/errors'
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
  return { user: userEvent.setup(), onSave: (props.onSave ?? onSave) as typeof onSave, onCancel }
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

  it('keeps the aisles imported ingredients came with', async () => {
    const recipe = { ...PASTA, ingredients: [{ name: 'Spaghetti', quantity: 500, unit: 'g', aisle: 'pantry' }, { name: 'Salt', quantity: null, unit: '' }] }
    const { user, onSave } = setup({ recipe })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredients: [
          { name: 'Spaghetti', quantity: 500, unit: 'g', aisle: 'pantry' },
          { name: 'Salt', quantity: null, unit: '' },
        ],
      }),
    )
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

  describe('fill from link (AI)', () => {
    const DRAFT = {
      recipe: {
        title: 'Green bean soup',
        servings: 4,
        link: 'https://kwestiasmaku.com/zupa',
        ingredients: [
          { name: 'potatoes', quantity: 3, unit: '' },
          { name: 'dill', quantity: null, unit: '' },
        ],
      },
      remaining: 19,
    }
    const fill = () => screen.queryByRole('button', { name: '✨ Fill from link' })

    it('is only offered when switched on, and once there is a link', async () => {
      setup()
      expect(fill()).not.toBeInTheDocument()
      expect(screen.queryByText(/AI fills in the title, servings, ingredients and tags/)).not.toBeInTheDocument()
    })

    it('fills an empty form for review, without saving', async () => {
      const onImport = vi.fn().mockResolvedValue(DRAFT)
      const { user, onSave } = setup({ onImport })
      expect(screen.getByText(/AI fills in the title, servings, ingredients and tags/)).toBeInTheDocument()
      expect(screen.getByLabelText('Link')).toHaveFocus() // the link comes first: it can fill in everything else
      const fields = screen.getAllByRole('textbox')
      expect(fields.indexOf(screen.getByLabelText('Link'))).toBeLessThan(fields.indexOf(screen.getByPlaceholderText('e.g. Chicken curry')))
      await user.type(screen.getByLabelText('Link'), 'kwestiasmaku.com/zupa')
      await user.click(fill()!)
      expect(onImport).toHaveBeenCalledWith('https://kwestiasmaku.com/zupa')
      expect(screen.getByPlaceholderText('e.g. Chicken curry')).toHaveValue('Green bean soup')
      expect(screen.getByPlaceholderText('4')).toHaveValue('4')
      expect(names().map((i) => i.value)).toEqual(['potatoes', 'dill', ''])
      expect(screen.getAllByPlaceholderText('Qty').map((i) => (i as HTMLInputElement).value)).toEqual(['3', '', ''])
      expect(screen.getByText('Filled in from the page — check it, then Save. 19 imports left this month.')).toBeInTheDocument()
      expect(onSave).not.toHaveBeenCalled() // nothing saved until you tap Save

      await user.clear(names()[1])
      await user.type(names()[1], 'fresh dill') // reviewing: fix anything before saving
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Green bean soup',
          servings: 4,
          link: 'https://kwestiasmaku.com/zupa',
          ingredients: [
            { name: 'potatoes', quantity: 3, unit: '' },
            { name: 'fresh dill', quantity: null, unit: '' },
          ],
        }),
      )
    })

    it('keeps what you typed, and asks before replacing ingredients', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
      const onImport = vi.fn().mockResolvedValue({ ...DRAFT, recipe: { ...DRAFT.recipe, servings: null }, remaining: 1 })
      const { user } = setup({ recipe: { ...PASTA, servings: null, link: 'https://example.com/pasta' }, onImport })
      await user.click(fill()!)
      expect(confirm).toHaveBeenCalledWith('Replace the ingredients you’ve entered with the ones from the page?')
      expect(onImport).not.toHaveBeenCalled()

      await user.click(fill()!)
      expect(screen.getByPlaceholderText('e.g. Chicken curry')).toHaveValue('Pasta') // your title stays
      expect(screen.getByPlaceholderText('4')).toHaveValue('')
      expect(names().map((i) => i.value)).toEqual(['potatoes', 'dill', ''])
      expect(screen.getByText(/1 import left this month/)).toBeInTheDocument()
    })

    it('adds the suggested tags to any you already chose', async () => {
      const onImport = vi.fn().mockResolvedValue({ ...DRAFT, recipe: { ...DRAFT.recipe, tags: ['Soup', 'vegetarian'] } })
      const { user } = setup({ recipe: { ...PASTA, ingredients: [], tags: ['quick', 'soup'], link: 'https://e.com/x' }, onImport })
      await user.click(fill()!)
      const chips = within(screen.getByRole('group', { name: 'Tags' })).getAllByRole('button').map((b) => b.textContent)
      expect(chips).toEqual(['quick ×', 'soup ×', 'vegetarian ×'])
    })

    it('keeps servings you entered', async () => {
      const { user } = setup({ recipe: { ...PASTA, ingredients: [], link: 'https://e.com/x' }, onImport: vi.fn().mockResolvedValue(DRAFT) })
      await user.click(fill()!)
      expect(screen.getByPlaceholderText('4')).toHaveValue('2')
    })

    it('shows progress, then any problem, and lets you try again', async () => {
      let fail!: (e: Error) => void
      const onImport = vi.fn(() => new Promise<never>((_, reject) => (fail = reject)))
      const { user } = setup({ recipe: { ...PASTA, ingredients: [], link: 'https://e.com/x' }, onImport })
      await user.click(fill()!)
      expect(screen.getByRole('button', { name: 'Reading recipe…' })).toBeDisabled()
      fail(new Error("Couldn't find a recipe on that page."))
      expect(await screen.findByText("Couldn't find a recipe on that page.")).toBeInTheDocument()
      expect(fill()).toBeEnabled()
    })
  })

  describe('reporting a problem with an import', () => {
    const DRAFT = {
      recipe: {
        title: 'Curry',
        servings: 4,
        link: 'https://e.com/curry',
        tags: ['chicken'],
        ingredients: [
          { name: 'chicken', quantity: 6, unit: '', aisle: 'meat' },
          { name: 'onion', quantity: 1, unit: '', aisle: 'produce' },
        ],
      },
      remaining: 9,
      jobId: 'job1',
    }
    const reportLink = () => screen.queryByRole('button', { name: 'Something wrong? Report it' })

    async function imported(extra: Partial<Parameters<typeof RecipeEditor>[0]> = {}) {
      const onFeedback = vi.fn().mockResolvedValue('sent')
      const onImportOutcome = vi.fn()
      const ctx = setup({ recipe: { ...PASTA, title: '', servings: null, ingredients: [], link: 'https://e.com/curry' }, onImport: vi.fn().mockResolvedValue(DRAFT), onFeedback, onImportOutcome, ...extra })
      await ctx.user.click(screen.getByRole('button', { name: '✨ Fill from link' }))
      await screen.findByText(/Filled in from the page/)
      return { ...ctx, onFeedback, onImportOutcome }
    }

    it('fix it, tap Report: what was fixed is already ticked and marked', async () => {
      const { user, onFeedback } = await imported()
      await user.clear(screen.getAllByPlaceholderText('Qty')[0])
      await user.type(screen.getAllByPlaceholderText('Qty')[0], '8')
      await user.click(reportLink()!)
      expect(screen.getByRole('button', { name: 'Wrong amounts' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('checkbox', { name: 'chicken' })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'onion' })).not.toBeChecked()
      await user.click(screen.getByRole('button', { name: 'Send' }))
      expect(onFeedback).toHaveBeenCalledWith({
        kind: 'import',
        jobId: 'job1',
        problems: ['amounts'],
        marked: ['chicken'],
        note: '',
        edits: expect.objectContaining({ amounts: ['chicken'], renamed: [], added: [] }),
      })
      await user.click(await screen.findByRole('button', { name: 'Close' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('a failed import can be reported too, with its error', async () => {
      const onFeedback = vi.fn().mockResolvedValue('sent')
      const failure = Object.assign(new AppError('no_recipe', {}, "Couldn't find a recipe on that page."), { jobId: 'job2' })
      const { user } = setup({ recipe: { ...PASTA, ingredients: [], link: 'https://e.com/x' }, onImport: vi.fn().mockRejectedValue(failure), onFeedback })
      await user.click(screen.getByRole('button', { name: '✨ Fill from link' }))
      await user.click(await screen.findByRole('button', { name: 'Something wrong? Report it' }))
      await user.click(screen.getByRole('button', { name: 'Didn’t read the page' }))
      await user.click(screen.getByRole('button', { name: 'Send' }))
      expect(onFeedback).toHaveBeenCalledWith({ kind: 'import', jobId: 'job2', problems: ['unread'], note: '', errorCode: 'no_recipe' })
    })

    it('an import that never started can be reported without a job', async () => {
      const onFeedback = vi.fn().mockResolvedValue('sent')
      const { user } = setup({ recipe: { ...PASTA, ingredients: [], link: 'https://e.com/x' }, onImport: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), onFeedback })
      await user.click(screen.getByRole('button', { name: '✨ Fill from link' }))
      await user.click(await screen.findByRole('button', { name: 'Something wrong? Report it' }))
      await user.click(screen.getByRole('button', { name: 'Something else' }))
      await user.click(screen.getByRole('button', { name: 'Send' }))
      expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ jobId: undefined, errorCode: 'unknown' }))
    })

    it('no report links without somewhere to send them, or for other errors', async () => {
      await imported({ onFeedback: undefined })
      expect(reportLink()).not.toBeInTheDocument()
    })

    it('saving records the outcome: unchanged', async () => {
      const recipe = { ...DRAFT.recipe, servings: null, ingredients: [...DRAFT.recipe.ingredients, { name: 'salt', quantity: null, unit: '' }] }
      const { user, onImportOutcome, onSave } = await imported({ onImport: vi.fn().mockResolvedValue({ ...DRAFT, recipe }) })
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onSave).toHaveBeenCalled()
      expect(onImportOutcome).toHaveBeenCalledWith('job1', 'unchanged', {})
    })

    it('saving records the outcome: edited, as counts', async () => {
      const { user, onImportOutcome } = await imported()
      await user.clear(screen.getByPlaceholderText('e.g. Chicken curry'))
      await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Chicken curry')
      await user.click(screen.getByRole('button', { name: 'Remove onion' }))
      await user.type(screen.getByPlaceholderText('Add a tag'), 'quick')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onImportOutcome).toHaveBeenCalledWith('job1', 'edited', { title: 1, tagsAdded: 1, removed: 1 })
    })

    it('a failed save records nothing yet', async () => {
      const { user, onImportOutcome } = await imported({ onSave: vi.fn().mockRejectedValue(new Error('Server down')) })
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await screen.findByText('Server down')
      expect(onImportOutcome).not.toHaveBeenCalled()
    })

    it('leaving without saving, or importing again, abandons it', async () => {
      const { user, onImportOutcome, onCancel } = await imported()
      vi.spyOn(window, 'confirm').mockReturnValue(true) // "replace the ingredients?"
      await user.click(screen.getByRole('button', { name: '✨ Fill from link' })) // again: replaces the first
      await screen.findByText(/Filled in from the page/)
      expect(onImportOutcome).toHaveBeenCalledWith('job1', 'abandoned', {})
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onImportOutcome).toHaveBeenCalledTimes(2)
      expect(onCancel).toHaveBeenCalled()
    })

    it('typed recipes have no outcome', async () => {
      const onImportOutcome = vi.fn()
      const { user } = setup({ onImportOutcome })
      await user.type(screen.getByPlaceholderText('e.g. Chicken curry'), 'Toast')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onImportOutcome).not.toHaveBeenCalled()
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
