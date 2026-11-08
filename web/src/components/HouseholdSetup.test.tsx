import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HouseholdSetup } from './HouseholdSetup'

describe('HouseholdSetup', () => {
  it('works without a known email', () => {
    render(<HouseholdSetup email={null} onStart={vi.fn()} onJoin={vi.fn()} onSignOut={vi.fn()} />)
    expect(screen.getByText(/Signed in as your Google account/)).toBeInTheDocument()
  })
})
