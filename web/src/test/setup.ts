import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import { resetReporting } from '../lib/feedback'
import { resetJourney } from '../lib/journey'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetJourney()
  resetReporting()
})

afterEach(() => {
  cleanup()
})
