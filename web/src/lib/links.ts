/** Only http(s) links are ever rendered or saved, so a stored link can never run code when tapped. */
export function safeHref(link: string | undefined): string | undefined {
  if (!link) return undefined
  try {
    const url = new URL(link)
    return url.protocol === 'http:' || url.protocol === 'https:' ? link : undefined
  } catch {
    return undefined
  }
}

/**
 * Tidy a link typed or pasted into the editor: '' stays '', a bare "kwestiasmaku.com/…" gets https://,
 * and anything that still isn't a web address returns null.
 */
export function normaliseLink(raw: string): string | null {
  const link = raw.trim()
  if (!link) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`
  return safeHref(withScheme) && new URL(withScheme).hostname.includes('.') ? withScheme : null
}
