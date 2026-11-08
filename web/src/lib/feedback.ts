// Sending problem reports, automatic error reports and import outcomes (POST /feedback; see
// api/src/grubgrab/feedback.py for what's kept). Reports made offline wait on this device and go when the
// connection is back. Unexpected errors are reported by themselves, once per kind per session.
import { AppError } from '../i18n/errors'
import type { FeedbackBody } from '../types'
import { journey, record } from './journey'

declare const __APP_VERSION__: string

export type Report = Omit<FeedbackBody, 'client' | 'journey'>
export type SendResult = 'sent' | 'queued'

/** Where a report goes: the backend's sendFeedback. */
export interface Sender {
  sendFeedback(body: FeedbackBody): Promise<void>
}

/** What the app knows about where the person is, added to every report. */
export interface ReportContext {
  language: string
  recipeLanguage?: string
  screen: string
}

const QUEUE = 'gg.feedbackQueue'
const MAX_QUEUED = 20
const MAX_AUTO_REPORTS = 10 // per session, so a loop of errors can't flood anything

export function clientInfo(context: ReportContext): Record<string, string | boolean> {
  return {
    appVersion: __APP_VERSION__,
    language: context.language,
    recipeLanguage: context.recipeLanguage ?? '',
    screen: context.screen,
    userAgent: navigator.userAgent.slice(0, 300),
    online: navigator.onLine,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    installed: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
  }
}

/** No connection (rather than the server saying no): worth keeping the report and trying again later. */
const isOffline = (e: unknown) => !navigator.onLine || e instanceof TypeError || (e as Error)?.name === 'AuthRequiredError'

function queued(): FeedbackBody[] {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE) ?? '[]')
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

function saveQueue(list: FeedbackBody[]) {
  try {
    if (list.length) localStorage.setItem(QUEUE, JSON.stringify(list.slice(-MAX_QUEUED)))
    else localStorage.removeItem(QUEUE)
  } catch {
    // Storage full or blocked: the report is lost, which is better than breaking the app.
  }
}

/** Send a report with the device details and recent steps (outcomes are counts only: no steps). */
export async function sendReport(sender: Sender, report: Report, context: ReportContext): Promise<SendResult> {
  const body: FeedbackBody = { ...report, client: clientInfo(context), ...(report.kind === 'outcome' ? {} : { journey: journey() }) }
  try {
    await sender.sendFeedback(body)
    return 'sent'
  } catch (e) {
    if (!isOffline(e)) throw e
    saveQueue([...queued(), body])
    return 'queued'
  }
}

/** Send reports kept while offline. Stops at the first connection problem; drops any the server refuses. */
export async function flushQueue(sender: Sender): Promise<void> {
  let list = queued()
  while (list.length) {
    try {
      await sender.sendFeedback(list[0])
    } catch (e) {
      if (isOffline(e)) return
    }
    list = list.slice(1)
    saveQueue(list)
  }
}

// ---- unexpected errors, reported automatically ----------------------------------------------------

let reporting: { sender: Sender; context: () => ReportContext } | null = null
const reported = new Set<string>()

/** Called by the app once it can reach the server; until then errors are only kept in the journey. */
export function configureReporting(sender: Sender | null, context?: () => ReportContext) {
  reporting = sender && context ? { sender, context } : null
}

/** For reports sent in the background: a failure must never get in the person's way. */
export const ignoreFailure = () => {}

const codeOf = (error: unknown) =>
  error instanceof AppError ? error.code : error instanceof Error ? error.name || 'Error' : 'unknown'

/** Errors worth a report without anyone asking: crashes and server failures, not "that code is wrong". */
export function isUnexpected(error: unknown): boolean {
  if (error instanceof AppError) {
    const status = Number(error.params.status)
    return ['request_failed', 'import_unavailable', 'unexpected'].includes(error.code) && !(status > 0 && status < 500)
  }
  if ((error as Error)?.name === 'AuthRequiredError') return false
  return !(error instanceof TypeError && !navigator.onLine) // being offline isn't a bug
}

/** Note an error in the journey, and report it if it's unexpected (once per kind and place per session). */
export function noteError(error: unknown, where: string) {
  const code = codeOf(error)
  record({ type: 'error', code, where })
  const key = `${code}:${where}`
  if (!reporting || !isUnexpected(error) || reported.has(key) || reported.size >= MAX_AUTO_REPORTS) return
  reported.add(key)
  const err = error as Error | undefined
  const report: Report = {
    kind: 'error',
    error: { code, where, message: String(err?.message ?? error).slice(0, 500), stack: String(err?.stack ?? '').slice(0, 4000) },
  }
  sendReport(reporting.sender, report, reporting.context()).catch(ignoreFailure) // reporting must never cause more errors
}

/** For tests. */
export function resetReporting() {
  reporting = null
  reported.clear()
  localStorage.removeItem(QUEUE)
}
