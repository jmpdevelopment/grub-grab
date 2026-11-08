import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../i18n/errors'
import type { FeedbackBody } from '../types'
import { AuthRequiredError } from './backend'
import { clientInfo, configureReporting, flushQueue, isUnexpected, noteError, sendReport, type ReportContext } from './feedback'
import { journey, record } from './journey'

const CONTEXT: ReportContext = { language: 'lt', recipeLanguage: 'pl', screen: 'list' }
const sender = (impl: (body: FeedbackBody) => Promise<void> = async () => {}) => ({ sendFeedback: vi.fn(impl) })
const queue = () => JSON.parse(localStorage.getItem('gg.feedbackQueue') ?? '[]')
const offline = () => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

afterEach(() => configureReporting(null))

describe('sendReport', () => {
  it('adds the device details and recent steps', async () => {
    record({ type: 'screen', name: 'list' })
    const s = sender()
    expect(await sendReport(s, { kind: 'general', problems: ['slow'], note: '' }, CONTEXT)).toBe('sent')
    const body = s.sendFeedback.mock.calls[0][0]
    expect(body).toMatchObject({ kind: 'general', problems: ['slow'], client: { appVersion: 'test-version', language: 'lt', recipeLanguage: 'pl', screen: 'list', online: true } })
    expect(body.client!.userAgent).toContain('jsdom')
    expect(body.client!.viewport).toMatch(/^\d+x\d+$/)
    expect(body.journey).toEqual([expect.objectContaining({ type: 'screen', name: 'list' })])
  })

  it('outcomes are counts only: no steps', async () => {
    const s = sender()
    await sendReport(s, { kind: 'outcome', jobId: 'j1', outcome: 'unchanged', changes: {} }, { language: 'en', screen: 'editor:new' })
    expect(s.sendFeedback.mock.calls[0][0]).not.toHaveProperty('journey')
    expect(s.sendFeedback.mock.calls[0][0].client!.recipeLanguage).toBe('')
  })

  it('keeps a report made offline and sends it later, in order', async () => {
    const down = sender(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await sendReport(down, { kind: 'general', problems: ['broke'] }, CONTEXT)).toBe('queued')
    expect(await sendReport(sender(async () => { throw new AuthRequiredError('sign in') }), { kind: 'general', problems: ['idea'] }, CONTEXT)).toBe('queued')
    expect(queue().map((r: { problems: string[] }) => r.problems[0])).toEqual(['broke', 'idea'])

    await flushQueue(down) // still offline: nothing lost
    expect(queue()).toHaveLength(2)

    const up = sender()
    await flushQueue(up)
    expect(up.sendFeedback.mock.calls.map((c) => c[0].problems![0])).toEqual(['broke', 'idea'])
    expect(localStorage.getItem('gg.feedbackQueue')).toBeNull()
  })

  it('drops a queued report the server refuses, rather than retrying it forever', async () => {
    localStorage.setItem('gg.feedbackQueue', JSON.stringify([{ kind: 'general' }, { kind: 'error' }]))
    const s = sender(async () => {
      throw new AppError('feedback_invalid')
    })
    await flushQueue(s)
    expect(s.sendFeedback).toHaveBeenCalledTimes(2)
    expect(queue()).toEqual([])
  })

  it('a refused report is an error for the person to see', async () => {
    await expect(sendReport(sender(async () => { throw new AppError('feedback_limit') }), { kind: 'general' }, CONTEXT)).rejects.toThrow('feedback_limit')
  })

  it('copes with a broken or blocked store', async () => {
    localStorage.setItem('gg.feedbackQueue', '{oops')
    await flushQueue(sender())
    localStorage.setItem('gg.feedbackQueue', '{"a":1}')
    await flushQueue(sender())
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      offline()
      expect(await sendReport(sender(async () => { throw new Error('x') }), { kind: 'general' }, CONTEXT)).toBe('queued')
    } finally {
      Storage.prototype.setItem = setItem
    }
  })

  it('clientInfo without matchMedia', () => {
    const original = window.matchMedia
    // @ts-expect-error: older browsers
    delete window.matchMedia
    try {
      expect(clientInfo(CONTEXT).installed).toBe(false)
    } finally {
      window.matchMedia = original
    }
  })
})

describe('automatic error reports', () => {
  it.each([
    [new AppError('request_failed', { status: 502 }), true],
    [new AppError('request_failed', { status: 404 }), false],
    [new AppError('import_unavailable'), true],
    [new AppError('invite_code_length', { length: 10 }), false], // the person's mistake, not a bug
    [new AuthRequiredError('sign in'), false],
    [new TypeError('x is undefined'), true],
    ['a thrown string', true],
  ])('%s unexpected: %s', (error, expected) => expect(isUnexpected(error)).toBe(expected))

  it('being offline is not a bug', () => {
    offline()
    expect(isUnexpected(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('reports each kind of error once per place, and notes every error in the journey', async () => {
    const s = sender()
    configureReporting(s, () => CONTEXT)
    noteError(new TypeError('x is undefined'), 'list')
    noteError(new TypeError('y is undefined'), 'list') // same kind, same place
    noteError(new TypeError('x is undefined'), 'editor:new')
    noteError(new AppError('invite_code_length'), 'settings') // expected: not reported
    await vi.waitFor(() => expect(s.sendFeedback).toHaveBeenCalledTimes(2))
    expect(s.sendFeedback.mock.calls[0][0]).toMatchObject({
      kind: 'error',
      error: { code: 'TypeError', where: 'list', message: 'x is undefined', stack: expect.stringContaining('TypeError') },
    })
    expect(journey().filter((step) => step.type === 'error')).toHaveLength(4)
  })

  it('at most 10 reports per session', async () => {
    const s = sender()
    configureReporting(s, () => CONTEXT)
    for (let n = 0; n < 15; n++) noteError(new Error(`e${n}`), `place${n}`)
    await vi.waitFor(() => expect(s.sendFeedback).toHaveBeenCalledTimes(10))
  })

  it('odd things thrown, and reporting that fails, never cause more trouble', async () => {
    const s = sender(async () => {
      throw new AppError('feedback_limit')
    })
    configureReporting(s, () => CONTEXT)
    noteError(undefined, 'a')
    noteError(Object.assign(new Error('no name'), { name: '' }), 'b')
    await vi.waitFor(() => expect(s.sendFeedback).toHaveBeenCalledTimes(2))
    expect(s.sendFeedback.mock.calls.map((c) => c[0].error!.code)).toEqual(['unknown', 'Error'])
    expect(s.sendFeedback.mock.calls[0][0].error).toMatchObject({ message: 'undefined', stack: '' })
  })

  it('before the app can reach the server, errors are only noted', () => {
    noteError(new TypeError('early'), 'signin')
    expect(journey()).toEqual([expect.objectContaining({ type: 'error', code: 'TypeError', where: 'signin' })])
  })
})
