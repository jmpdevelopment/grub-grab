import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { I18nContext } from './context'
import type { Lang } from './languages'
import { i18nFor, initialLanguage, STORAGE_KEY } from './translate'

/** Holds the chosen language, remembers it on this device, and keeps <html lang> in step. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLanguage)
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const setLang = useCallback((next: Lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // can't remember it on this device; it still applies until the page closes
    }
    setLangState(next)
  }, [])
  const value = useMemo(() => i18nFor(lang, setLang), [lang, setLang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
