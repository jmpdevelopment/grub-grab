import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { AppError } from '../i18n/errors'
import { FeedbackSheet } from './FeedbackSheet'

function setup(props: Partial<Parameters<typeof FeedbackSheet>[0]> = {}) {
  const onSend = vi.fn().mockResolvedValue('sent')
  const onClose = vi.fn()
  render(
    <I18nProvider>
      <FeedbackSheet kind="import" onSend={onSend} onClose={onClose} {...props} />
    </I18nProvider>,
  )
  return { user: userEvent.setup(), onSend, onClose, ...props }
}

const chip = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}$`) })
const send = () => screen.getByRole('button', { name: 'Send' })

describe('FeedbackSheet', () => {
  it('import reports are taps: what was wrong, which items, done', async () => {
    const { user, onSend } = setup({ ingredients: ['chicken', 'onion', 'rice'], suggested: ['amounts'], premarked: ['chicken'] })
    const dialog = screen.getByRole('dialog', { name: 'What was wrong with this import?' })
    expect(within(dialog).getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual([
      'Missing items', 'Extra items', 'Wrong names', 'Wrong aisles', 'Wrong tags', 'Wrong title or servings', 'Didn’t read the page', 'Something else',
    ])
    expect(chip('Wrong amounts')).toHaveAttribute('aria-pressed', 'true') // ticked from what they fixed
    expect(screen.getByRole('group', { name: 'Which ones? Tap to mark' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'chicken' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'onion' }))
    await user.click(screen.getByRole('checkbox', { name: 'chicken' }))
    await user.click(chip('Wrong aisles'))
    await user.click(send())
    expect(onSend).toHaveBeenCalledWith({ problems: ['amounts', 'aisles'], marked: ['onion'], note: '' })
    expect(await screen.findByRole('status')).toHaveTextContent('Thanks, your report was sent.')
  })

  it('only asks which items for problems about items', async () => {
    const { user, onSend } = setup({ ingredients: ['chicken'], premarked: ['chicken'] })
    expect(screen.queryByRole('group', { name: /Which ones/ })).not.toBeInTheDocument()
    expect(send()).toBeDisabled() // pick something first
    await user.click(chip('Wrong tags'))
    expect(screen.queryByRole('group', { name: /Which ones/ })).not.toBeInTheDocument()
    await user.click(chip('Wrong names'))
    await user.click(chip('Wrong names')) // and untick again
    expect(screen.queryByRole('group', { name: /Which ones/ })).not.toBeInTheDocument()
    await user.click(send())
    expect(onSend).toHaveBeenCalledWith({ problems: ['tags'], marked: [], note: '' }) // premarked items only count when asked
  })

  it('a note is optional and tucked away', async () => {
    const { user, onSend } = setup({ kind: 'general' })
    expect(screen.getByRole('dialog', { name: 'What went wrong?' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Add a note (optional)' }))
    await user.type(screen.getByRole('textbox', { name: 'Note' }), '  The list was slow  ')
    await user.click(chip('Slow'))
    await user.click(send())
    expect(onSend).toHaveBeenCalledWith({ problems: ['slow'], marked: [], note: 'The list was slow' })
  })

  it('says what is included', async () => {
    setup({ kind: 'importFailed' })
    expect(screen.getByRole('dialog', { name: 'What happened?' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual(['Didn’t read the page', 'Something else'])
    expect(screen.getByText('What’s included')).toBeInTheDocument()
    expect(screen.getByText(/Never your email/)).toBeInTheDocument()
    expect(screen.getByText(/This import: the link/)).toBeInTheDocument()
  })

  it('general reports do not mention an import', () => {
    setup({ kind: 'general' })
    expect(screen.queryByText(/This import/)).not.toBeInTheDocument()
  })

  it('offline: kept to send later', async () => {
    const { user } = setup({ kind: 'general', onSend: vi.fn().mockResolvedValue('queued') })
    await user.click(chip('Something broke'))
    await user.click(send())
    expect(await screen.findByRole('status')).toHaveTextContent('sent when you’re back online')
  })

  it('a refused report says why and can be tried again', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new AppError('feedback_limit')).mockResolvedValueOnce('sent')
    const { user, onClose } = setup({ kind: 'general', onSend })
    await user.click(chip('An idea'))
    await user.click(send())
    expect(await screen.findByText('Too many reports today. Try again tomorrow.')).toBeInTheDocument()
    await user.click(send())
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('cancel, or tap outside, closes it', async () => {
    const { user, onClose } = setup({ kind: 'general' })
    await user.click(screen.getByRole('dialog')) // inside: stays
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByRole('dialog').parentElement!)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
