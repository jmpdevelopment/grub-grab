/**
 * The languages the app speaks. To add one: write locales/<code>.ts (TypeScript makes sure it has every
 * message) and add a line here. Nothing else changes.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇬🇧', timeZones: [] as string[] },
  { code: 'pl', name: 'Polski', flag: '🇵🇱', timeZones: ['Europe/Warsaw'] },
  { code: 'lt', name: 'Lietuvių', flag: '🇱🇹', timeZones: ['Europe/Vilnius'] },
] as const

export type Lang = (typeof LANGUAGES)[number]['code']
export const DEFAULT_LANG: Lang = 'en'

export const isLang = (value: unknown): value is Lang => LANGUAGES.some((l) => l.code === value)

/**
 * Pick a language for someone who hasn't chosen one: their own choice on this device, else the first
 * language their browser/phone asks for that we speak, else their time zone, else English.
 */
export function detectLanguage(stored: string | null, browserLanguages: readonly string[], timeZone: string | undefined): Lang {
  if (isLang(stored)) return stored
  for (const tag of browserLanguages) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLang(base)) return base
  }
  const byZone = LANGUAGES.find((l) => timeZone && (l.timeZones as readonly string[]).includes(timeZone))
  return byZone?.code ?? DEFAULT_LANG
}
