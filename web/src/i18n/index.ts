// The app's translations: import everything from here.
export { useI18n } from './context'
export { AppError } from './errors'
export { I18nProvider } from './I18nProvider'
export { detectLanguage, isLang, LANGUAGES, type Lang } from './languages'
export type { MessageKey } from './locales/en'
export { DICTIONARIES, errorText, translate, type I18n, type Params } from './translate'
