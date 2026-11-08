// The service worker (vite-plugin-pwa, autoUpdate) installs new versions in the background and takes over,
// but an open page keeps running the old code until it reloads. Pull-to-refresh uses this to switch over.

let updateReady = false

/** Call once at startup: remember when a newer version takes over while this page is open. */
export function watchForAppUpdates(sw: ServiceWorkerContainer | undefined = navigator.serviceWorker) {
  if (!sw) return
  const hadController = Boolean(sw.controller) // the very first install also "takes over", but isn't an update
  sw.addEventListener('controllerchange', () => {
    if (hadController) updateReady = true
  })
}

/** Resolve once a freshly found worker has finished activating (or given up), or after `timeoutMs`. */
function settled(worker: ServiceWorker, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') resolve()
    }
    worker.addEventListener('statechange', done)
    setTimeout(resolve, timeoutMs)
    done()
  })
}

/**
 * Look for a newer version of the app. Returns true (and reloads into it) if there is one, false otherwise.
 * Never throws: being offline just means there's nothing new to load.
 */
export async function updateApp(
  sw: ServiceWorkerContainer | undefined = navigator.serviceWorker,
  reload: () => void = () => window.location.reload(),
  timeoutMs = 10_000,
): Promise<boolean> {
  if (!sw) return false
  try {
    const reg = await sw.getRegistration()
    if (reg) {
      await reg.update()
      const next = reg.installing ?? reg.waiting
      if (next) {
        await settled(next, timeoutMs)
        updateReady = true
      }
    }
  } catch {
    // Offline or the update check failed: carry on with the version we have.
  }
  if (!updateReady) return false
  reload()
  return true
}

/** Test hook: forget any update noticed by an earlier test. */
export function resetAppUpdateState() {
  updateReady = false
}
