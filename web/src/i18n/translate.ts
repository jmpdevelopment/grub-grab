import { AppError } from './errors'
import { DEFAULT_LANG, detectLanguage, type Lang } from './languages'
import type { Plural } from './messages'
import { en, type MessageKey, type Messages } from './locales/en'
import { lt } from './locales/lt'
import { pl } from './locales/pl'

export const DICTIONARIES: Record<Lang, Messages> = { en, pl, lt }
export const STORAGE_KEY = 'gg.lang'

export type Params = Record<string, string | number>

// One set of plural rules per language, built on first use (a list redraw asks for one per card).
const pluralRules = new Map<Lang, Intl.PluralRules>()
const pluralFor = (lang: Lang) => pluralRules.get(lang) ?? pluralRules.set(lang, new Intl.PluralRules(lang)).get(lang)!

/** Look up a message in a language, choose its plural form from {count}, and fill in {placeholders}. */
export function translate(lang: Lang, key: MessageKey, params: Params = {}): string {
  const message = DICTIONARIES[lang][key]
  const text =
    typeof message === 'string'
      ? message
      : (message[pluralFor(lang).select(Number(params.count)) as keyof Plural] ?? message.other)
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in params ? String(params[name]) : placeholder))
}

const isKey = (key: string): key is MessageKey => key in en

/** What to show for an error: coded errors in the person's language, anything else as best we can. */
export function errorText(lang: Lang, error: unknown): string {
  if (error instanceof AppError && isKey(`error.${error.code}`)) {
    const params = { ...error.params }
    const fieldKey = `field.${params.field}`
    if (isKey(fieldKey)) params.field = translate(lang, fieldKey)
    return translate(lang, `error.${error.code}` as MessageKey, params)
  }
  return (error instanceof Error && error.message) || translate(lang, 'error.unexpected')
}

export interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: MessageKey, params?: Params) => string
  errorText: (error: unknown) => string
  /** "8 Nov, 10:22" in the person's language. */
  formatDate: (seconds: number) => string
  /** Starter tags offered in the editor, in the person's language. */
  suggestedTags: string[]
}

export function i18nFor(lang: Lang, setLang: (lang: Lang) => void): I18n {
  return {
    lang,
    setLang,
    t: (key, params) => translate(lang, key, params),
    errorText: (error) => errorText(lang, error),
    formatDate: (seconds) =>
      new Date(seconds * 1000).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    suggestedTags: translate(lang, 'tags.suggested').split(',').map((t) => t.trim()),
  }
}

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null // storage blocked (private mode): fall back to detection
  }
}

/** The language to start in: this device's earlier choice, else detected (see detectLanguage). */
export function initialLanguage(): Lang {
  return detectLanguage(stored(), navigator.languages ?? [], Intl.DateTimeFormat().resolvedOptions().timeZone)
}

export { DEFAULT_LANG }
