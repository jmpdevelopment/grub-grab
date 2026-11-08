import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AccessRequest } from '../types'
import { AccessRequests } from './AccessRequests'

const ANNA: AccessRequest = { username: 'Google_1', email: 'anna@example.com', name: 'Anna', requestedAt: 1_794_130_000 }
const BOT: AccessRequest = { username: 'Google_2', email: 'bot@spam.example', name: '', requestedAt: 1_794_131_000 }
const BLANK: AccessRequest = { username: 'Google_3', email: '', name: '', requestedAt: 1_794_132_000 }

function setup(requests: AccessRequest[] | Error, over: Partial<Parameters<typeof AccessRequests>[0]> = {}) {
  const props = {
    load: vi.fn(() => (requests instanceof Error ? Promise.reject(requests) : Promise.resolve(requests))),
    decide: vi.fn().mockResolvedValue(undefined),
    declineAll: vi.fn().mockResolvedValue(2),
    onCount: vi.fn(),
    ...over,
  }
  const view = render(<AccessRequests {...props} />)
  return { user: userEvent.setup(), ...props, ...view }
}

describe('AccessRequests', () => {
  it('lists who is waiting and reports the count', async () => {
    const { onCount } = setup([ANNA, BOT, BLANK])
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(await screen.findByText('Anna')).toBeInTheDocument()
    expect(screen.getByText('anna@example.com')).toBeInTheDocument() // name, then email underneath
    expect(screen.getByText('bot@spam.example')).toBeInTheDocument() // no name: email as the heading
    expect(screen.getByText('Google_3')).toBeInTheDocument() // nothing else known
    expect(screen.getAllByText(/^asked /)).toHaveLength(3)
    expect(onCount).toHaveBeenCalledWith(3)
  })

  it('reloads when the app refreshes, so new requests appear while Settings is open', async () => {
    const load = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ANNA])
    const props = { load, decide: vi.fn(), declineAll: vi.fn(), onCount: vi.fn() }
    const { rerender } = render(<AccessRequests {...props} reloadKey={1} />)
    expect(await screen.findByText(/No one is waiting/)).toBeInTheDocument()
    rerender(<AccessRequests {...props} reloadKey={2} />)
    expect(await screen.findByText('Anna')).toBeInTheDocument()
    expect(props.onCount).toHaveBeenLastCalledWith(1)
  })

  it('says when no one is waiting', async () => {
    setup([])
    expect(await screen.findByText(/No one is waiting/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Decline all' })).not.toBeInTheDocument()
  })

  it('approves and declines one at a time', async () => {
    const { user, decide, onCount } = setup([ANNA, BOT])
    await user.click(await screen.findByRole('button', { name: 'Approve Anna' }))
    expect(decide).toHaveBeenCalledWith('Google_1', true)
    expect(screen.queryByText('Anna')).not.toBeInTheDocument()
    expect(screen.getByText('Approved. Anna can now sign in and join with your invite code.')).toBeInTheDocument()
    expect(onCount).toHaveBeenLastCalledWith(1)

    await user.click(screen.getByRole('button', { name: 'Decline bot@spam.example' }))
    expect(decide).toHaveBeenLastCalledWith('Google_2', false)
    expect(screen.getByText('Declined bot@spam.example.')).toBeInTheDocument()
    expect(onCount).toHaveBeenLastCalledWith(0)
  })

  it('declines everyone at once, after asking', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { user, declineAll, onCount } = setup([ANNA, BOT])
    await user.click(await screen.findByRole('button', { name: 'Decline all' }))
    expect(confirm).toHaveBeenCalledWith('Decline all 2 requests?')
    expect(declineAll).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Decline all' }))
    expect(declineAll).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Declined everyone who was waiting.')).toBeInTheDocument()
    expect(onCount).toHaveBeenLastCalledWith(0)
  })

  it('names people by email when Google gave no name', async () => {
    const { user } = setup([{ ...BOT }])
    await user.click(await screen.findByRole('button', { name: 'Approve bot@spam.example' }))
    expect(screen.getByText('Approved. bot@spam.example can now sign in and join with your invite code.')).toBeInTheDocument()
  })

  it('shows errors and keeps the request', async () => {
    const { user } = setup([ANNA], { decide: vi.fn().mockRejectedValue(new Error('Only admins can do that')) })
    await user.click(await screen.findByRole('button', { name: 'Decline Anna' }))
    expect(screen.getByText('Only admins can do that')).toBeInTheDocument()
    expect(screen.getByText('Anna')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve Anna' })).toBeEnabled()
  })

  it('shows a load error', async () => {
    setup(new Error('Service unavailable'))
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument()
  })

  it('ignores answers that arrive after leaving the screen', async () => {
    let finish!: (r: AccessRequest[]) => void
    let fail!: (e: Error) => void
    const ok = setup([], { load: () => new Promise((r) => (finish = r)) })
    ok.unmount()
    finish([ANNA])
    const bad = setup([], { load: () => new Promise((_, r) => (fail = r)) })
    bad.unmount()
    fail(new Error('late'))
    await Promise.resolve()
    expect(ok.onCount).not.toHaveBeenCalled()
  })
})
