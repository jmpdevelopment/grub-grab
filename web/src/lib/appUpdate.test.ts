import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAppUpdateState, updateApp, watchForAppUpdates } from './appUpdate'

/** A stand-in for the browser's service worker objects (a browser boundary jsdom doesn't provide). */
function fakeWorker(state: ServiceWorkerState = 'installing') {
  const listeners: (() => void)[] = []
  const worker = {
    state,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    become(next: ServiceWorkerState) {
      worker.state = next
      listeners.forEach((fn) => fn())
    },
  }
  return worker
}

function fakeContainer({ controller = {}, reg }: { controller?: object | null; reg?: object | null } = {}) {
  const listeners: (() => void)[] = []
  return {
    controller,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    getRegistration: vi.fn(async () => reg ?? undefined),
    takeOver: () => listeners.forEach((fn) => fn()),
  }
}
const asSW = (c: object) => c as unknown as ServiceWorkerContainer

afterEach(() => resetAppUpdateState())

describe('updateApp', () => {
  it('does nothing without service workers or a registration', async () => {
    const reload = vi.fn()
    expect(await updateApp(undefined, reload)).toBe(false)
    expect(await updateApp(asSW(fakeContainer({ reg: null })), reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('stays on the current version when nothing new is deployed', async () => {
    const reg = { update: vi.fn().mockResolvedValue(undefined), installing: null, waiting: null }
    const reload = vi.fn()
    expect(await updateApp(asSW(fakeContainer({ reg })), reload)).toBe(false)
    expect(reg.update).toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('waits for a new version to activate, then reloads into it', async () => {
    const worker = fakeWorker()
    const reg = { update: vi.fn().mockResolvedValue(undefined), installing: worker, waiting: null }
    const reload = vi.fn()
    const result = updateApp(asSW(fakeContainer({ reg })), reload)
    await vi.waitFor(() => expect(reg.update).toHaveBeenCalled())
    worker.become('installed')
    expect(reload).not.toHaveBeenCalled()
    worker.become('activated')
    expect(await result).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads for a waiting version even if it never reports activating (timeout)', async () => {
    const reg = { update: vi.fn().mockResolvedValue(undefined), installing: null, waiting: fakeWorker('installed') }
    const reload = vi.fn()
    expect(await updateApp(asSW(fakeContainer({ reg })), reload, 5)).toBe(true)
    expect(reload).toHaveBeenCalled()
  })

  it('stops waiting if the new version fails to install', async () => {
    const reg = { update: vi.fn().mockResolvedValue(undefined), installing: fakeWorker('redundant'), waiting: null }
    expect(await updateApp(asSW(fakeContainer({ reg })), vi.fn())).toBe(true)
  })

  it('carries on quietly when the update check fails (offline)', async () => {
    const reg = { update: vi.fn().mockRejectedValue(new Error('offline')) }
    const reload = vi.fn()
    expect(await updateApp(asSW(fakeContainer({ reg })), reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads with the real page reload by default', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    const container = fakeContainer({ reg: null })
    watchForAppUpdates(asSW(container))
    container.takeOver()
    expect(await updateApp(asSW(container))).toBe(true)
    expect(reload).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('watchForAppUpdates', () => {
  it('reloads on the next pull once a newer version took over in the background', async () => {
    const container = fakeContainer({ reg: null })
    watchForAppUpdates(asSW(container))
    container.takeOver()
    const reload = vi.fn()
    expect(await updateApp(asSW(container), reload)).toBe(true)
    expect(reload).toHaveBeenCalled()
  })

  it("ignores the first install taking over, which isn't an update", async () => {
    const container = fakeContainer({ controller: null, reg: null })
    watchForAppUpdates(asSW(container))
    container.takeOver()
    expect(await updateApp(asSW(container), vi.fn())).toBe(false)
  })

  it('does nothing without service workers', () => {
    expect(() => watchForAppUpdates(undefined)).not.toThrow()
  })
})
