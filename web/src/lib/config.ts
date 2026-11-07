// Runtime config is served as /config.json by the CDK deployment.
// If it's missing, the app runs in local mode (data stays on this device).
export interface AppConfig {
  apiUrl: string
  cognitoDomain: string // e.g. https://grubgrab-abc123.auth.eu-west-2.amazoncognito.com
  clientId: string
}

let cached: AppConfig | null | undefined

export async function loadConfig(): Promise<AppConfig | null> {
  if (cached !== undefined) return cached
  try {
    const res = await fetch('/config.json', { cache: 'no-store' })
    const data = res.ok ? await res.json() : null
    cached = data?.apiUrl ? (data as AppConfig) : null
  } catch {
    cached = null
  }
  return cached
}
