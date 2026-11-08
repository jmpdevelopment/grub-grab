import { createContext, useContext } from 'react'
import { DEFAULT_LANG } from './languages'
import { i18nFor, type I18n } from './translate'

// Without a provider (e.g. a component rendered on its own in a test) everything is English.
export const I18nContext = createContext<I18n>(i18nFor(DEFAULT_LANG, () => {}))

export const useI18n = () => useContext(I18nContext)
