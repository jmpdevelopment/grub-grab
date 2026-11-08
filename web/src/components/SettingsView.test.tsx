import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'

function setup(props: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const onJoin = vi.fn().mockResolvedValue(undefined)
  const onSignOut = vi.fn()
  render(
    <SettingsView
      mode="cloud"
      household={{ householdId: 'h', inviteCode: 'ABC234' }}
      email="me@example.com"
      onJoin={onJoin}
      onSignOut={onSignOut}
      {...props}
    />,
  )
  return { user: userEvent.setup(), onJoin, onSignOut }
}

describe('SettingsView', () => {
  it('explains local mode and hides account features', () => {
    setup({ mode: 'local', household: { householdId: 'local', inviteCode: null }, email: null })
    expect(screen.getByText('Local mode')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(screen.queryByText('Share with someone')).not.toBeInTheDocument()
  })

  it('shows the account and invite code, and signs out', async () => {
    const { user, onSignOut } = setup()
    expect(screen.getByText('me@example.com')).toBeInTheDocument()
    expect(screen.getByText('ABC234')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalled()
  })

  it('has placeholders while details are unknown', () => {
    setup({ household: null, email: null })
    expect(screen.getByText('Signed in')).toBeInTheDocument()
    expect(screen.getByText('…')).toBeInTheDocument()
  })

  it('joins with an upper-cased 6-character code', async () => {
    const { user, onJoin } = setup()
    const box = screen.getByPlaceholderText('ABC234')
    const join = screen.getByRole('button', { name: 'Join' })
    await user.type(box, 'xyz23')
    expect(box).toHaveValue('XYZ23')
    expect(join).toBeDisabled()
    await user.type(box, '45') // maxLength stops at 6
    expect(box).toHaveValue('XYZ234')

    await user.click(join)
    expect(onJoin).toHaveBeenCalledWith('XYZ234')
    expect(await screen.findByText('Joined! You now share recipes and the list.')).toBeInTheDocument()
    expect(box).toHaveValue('')
  })

  it('shows join errors and keeps the code for another try', async () => {
    const onJoin = vi.fn().mockRejectedValue(new Error('Invite code not found'))
    const { user } = setup({ onJoin })
    await user.type(screen.getByPlaceholderText('ABC234'), 'nope00')
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByText('Invite code not found')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('ABC234')).toHaveValue('NOPE00')
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled()
  })

  it('disables Join while joining', async () => {
    let finish!: () => void
    const onJoin = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const { user } = setup({ onJoin })
    await user.type(screen.getByPlaceholderText('ABC234'), 'ABC234')
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()
    finish()
    expect(await screen.findByText(/Joined!/)).toBeInTheDocument()
  })
})
