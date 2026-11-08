import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'

function setup(props: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const onJoin = vi.fn().mockResolvedValue(undefined)
  const onRotate = vi.fn().mockResolvedValue(undefined)
  const onSignOut = vi.fn()
  render(
    <SettingsView
      mode="cloud"
      household={{ householdId: 'h', inviteCode: 'ABCDEFGH23' }}
      email="me@example.com"
      onJoin={onJoin}
      onRotate={onRotate}
      onSignOut={onSignOut}
      {...props}
    />,
  )
  return { user: userEvent.setup(), onJoin, onRotate, onSignOut }
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
    expect(screen.getByText('ABCDE-FGH23')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalled()
  })

  it('has placeholders while details are unknown', () => {
    setup({ household: null, email: null })
    expect(screen.getByText('Signed in')).toBeInTheDocument()
    expect(screen.getByText('…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New code' })).toBeDisabled()
  })

  it('joins with a code typed in any format', async () => {
    const { user, onJoin } = setup()
    const box = screen.getByPlaceholderText('ABCDE-FGH23')
    const join = screen.getByRole('button', { name: 'Join' })
    await user.type(box, 'xyz23-')
    expect(box).toHaveValue('XYZ23-')
    expect(join).toBeDisabled()
    await user.type(box, 'abcd')
    expect(join).toBeDisabled() // 9 characters
    await user.type(box, 'e')
    expect(join).toBeEnabled()
    await user.type(box, 'f')
    expect(join).toBeDisabled() // 11 characters

    await user.type(box, '{backspace}')
    await user.click(join)
    expect(onJoin).toHaveBeenCalledWith('XYZ23ABCDE')
    expect(await screen.findByText('Joined! You now share recipes and the list.')).toBeInTheDocument()
    expect(box).toHaveValue('')
  })

  it('limits how much can be typed', () => {
    setup()
    expect(screen.getByPlaceholderText('ABCDE-FGH23')).toHaveAttribute('maxLength', '14')
  })

  it('shows join errors and keeps the code for another try', async () => {
    const onJoin = vi.fn().mockRejectedValue(new Error('Invite code not found'))
    const { user } = setup({ onJoin })
    await user.type(screen.getByPlaceholderText('ABCDE-FGH23'), 'nopen-ope22')
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByText('Invite code not found')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('ABCDE-FGH23')).toHaveValue('NOPEN-OPE22')
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled()
  })

  it('disables Join while joining', async () => {
    let finish!: () => void
    const onJoin = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const { user } = setup({ onJoin })
    await user.type(screen.getByPlaceholderText('ABCDE-FGH23'), 'ABCDEFGH23')
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()
    finish()
    expect(await screen.findByText(/Joined!/)).toBeInTheDocument()
  })

  it('makes a new code only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { user, onRotate } = setup()
    await user.click(screen.getByRole('button', { name: 'New code' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('current one will stop working'))
    expect(onRotate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'New code' }))
    expect(onRotate).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('New code ready.')).toBeInTheDocument()
  })

  it('shows rotate errors', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { user } = setup({ onRotate: vi.fn().mockRejectedValue(new Error('Server error')) })
    await user.click(screen.getByRole('button', { name: 'New code' }))
    expect(await screen.findByText('Server error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New code' })).toBeEnabled()
  })
})
