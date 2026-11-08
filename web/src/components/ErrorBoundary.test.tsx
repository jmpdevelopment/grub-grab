import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { configureReporting } from '../lib/feedback'
import { journey } from '../lib/journey'
import { ErrorBoundary } from './ErrorBoundary'

function Broken(): never {
  throw new TypeError('x is undefined')
}

describe('ErrorBoundary', () => {
  it('shows what happened instead of a blank page, and reports it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}) // React logs the crash too
    const sendFeedback = vi.fn().mockResolvedValue(undefined)
    configureReporting({ sendFeedback }, () => ({ language: 'en', screen: 'list' }))
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    render(
      <I18nProvider>
        <ErrorBoundary>
          <Broken />
        </ErrorBoundary>
      </I18nProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    expect(screen.getByText(/reported automatically/)).toBeInTheDocument()
    expect(journey()).toEqual([expect.objectContaining({ type: 'error', code: 'TypeError', where: 'crash' })])
    await vi.waitFor(() => expect(sendFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', error: expect.objectContaining({ where: 'crash' }) })))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalled()
    configureReporting(null)
  })

  it('shows the app when nothing is wrong', () => {
    render(
      <I18nProvider>
        <ErrorBoundary>
          <p>Fine</p>
        </ErrorBoundary>
      </I18nProvider>,
    )
    expect(screen.getByText('Fine')).toBeInTheDocument()
  })
})
