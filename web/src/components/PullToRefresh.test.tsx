import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PullToRefresh } from './PullToRefresh'

const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', clientY = 0) =>
  act(() => {
    fireEvent[type](window, { touches: [{ clientY }] })
  })

/** Drag a finger down the screen from y=0 to `to` (the indicator moves at half that distance). */
const drag = (to: number) => {
  touch('touchStart', 0)
  touch('touchMove', to)
}

afterEach(() => {
  window.scrollY = 0
})

describe('PullToRefresh', () => {
  it('shows nothing until you pull', () => {
    render(<PullToRefresh onRefresh={vi.fn()} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a short pull just springs back', async () => {
    const onRefresh = vi.fn()
    render(<PullToRefresh onRefresh={onRefresh} />)
    drag(100) // 50px of pull: under the 70px threshold
    expect(screen.getByRole('status')).toHaveTextContent('Pull to refresh')
    touch('touchEnd')
    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a long pull refreshes, showing progress until done', async () => {
    let finish!: () => void
    const onRefresh = vi.fn(() => new Promise<void>((r) => (finish = r)))
    render(<PullToRefresh onRefresh={onRefresh} />)
    drag(500) // capped, well past the threshold
    expect(screen.getByRole('status')).toHaveTextContent('Release to refresh')
    touch('touchEnd')
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing…')

    drag(500) // pulling again mid-refresh is ignored
    touch('touchEnd')
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await act(async () => finish())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('clears the indicator even if the refresh fails', async () => {
    render(<PullToRefresh onRefresh={vi.fn().mockRejectedValue(new Error('offline'))} />)
    drag(300)
    await act(async () => fireEvent.touchCancel(window, { touches: [] }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ignores pulls that start part-way down the page, upward swipes, and stray events', () => {
    const onRefresh = vi.fn()
    render(<PullToRefresh onRefresh={onRefresh} />)
    touch('touchMove', 300) // no touchstart
    touch('touchEnd')
    window.scrollY = 120
    drag(400)
    touch('touchEnd')
    window.scrollY = 0
    touch('touchStart', 300)
    touch('touchMove', 0) // finger moves up: no pull
    touch('touchEnd')
    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
