import { LANGUAGES, useI18n, type Lang } from '../i18n'

interface Props {
  /** Defaults to the app language; pass these to pick something else (e.g. the household's recipe language). */
  value?: string
  onChange?: (lang: Lang) => void
  label?: string
}

/** Flag + name drop-down. */
export function LanguagePicker({ value, onChange, label }: Props) {
  const { lang, setLang, t } = useI18n()
  return (
    <select
      className="lang-picker"
      aria-label={label ?? t('language.label')}
      value={value ?? lang}
      onChange={(e) => (onChange ?? setLang)(e.target.value as Lang)}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.flag} {l.name}
        </option>
      ))}
    </select>
  )
}
