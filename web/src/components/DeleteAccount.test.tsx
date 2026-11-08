import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DeleteAccount } from './DeleteAccount'

describe('DeleteAccount', () => {
  it('only deletes after you confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    let finish!: () => void
    const onDelete = vi.fn(() => new Promise<void>((r) => (finish = r)))
    render(<DeleteAccount admin={false} onDelete={onDelete} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete my account' }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0][0]).toContain('can’t be undone')
    expect(confirm.mock.calls[0][0]).not.toContain('admin')

    await user.click(screen.getByRole('button', { name: 'Delete my account' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    finish()
  })

  it('warns an admin that nobody will be left to approve sign-ups', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<DeleteAccount admin onDelete={vi.fn()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete my account' }))
    expect(confirm.mock.calls[0][0]).toContain('You’re the admin')
  })

  it('shows what went wrong and lets you try again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<DeleteAccount admin={false} onDelete={vi.fn().mockRejectedValue(new Error('Server error'))} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete my account' }))
    expect(await screen.findByText('Server error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeEnabled()
  })
})
