import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LanguagePicker } from '../components/LanguagePicker'
import { AppError, detectLanguage, DICTIONARIES, errorText, LANGUAGES, translate, type MessageKey } from '.'
import { en } from './locales/en'
import { i18nFor, initialLanguage } from './translate'

const placeholders = (message: string | object) =>
  new Set([...(typeof message === 'string' ? message : Object.values(message).join(' ')).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))

describe('every language', () => {
  it('has a dictionary for each language in the picker', () => {
    expect(Object.keys(DICTIONARIES).sort()).toEqual(LANGUAGES.map((l) => l.code).sort())
  })

  it.each(Object.entries(DICTIONARIES))('%s keeps exactly the English {placeholders}, with no blanks', (_lang, messages) => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect([key, placeholders(messages[key])]).toEqual([key, placeholders(en[key])])
      const texts = typeof messages[key] === 'string' ? [messages[key]] : Object.values(messages[key])
      for (const text of texts) expect(String(text).trim(), key).not.toBe('')
    }
  })

  it.each(Object.entries(DICTIONARIES))('%s has a plural form for every count the language uses', (lang, messages) => {
    const rules = new Intl.PluralRules(lang)
    for (const message of Object.values(messages)) {
      if (typeof message === 'string') continue
      for (const n of [0, 1, 2, 3, 5, 11, 21, 22, 25, 101, 1.5]) {
        const form = rules.select(n) as keyof typeof message
        expect(message[form] ?? message.other).toBeTruthy()
      }
    }
  })
})

describe('detectLanguage', () => {
  it.each([
    ['their choice on this device wins', 'lt', ['pl-PL'], 'Europe/Warsaw', 'lt'],
    ['an unknown saved value is ignored', 'xx', ['pl-PL'], undefined, 'pl'],
    ['the first browser language we speak', null, ['de-DE', 'pl', 'en'], undefined, 'pl'],
    ['matches on the base language', null, ['LT-lt'], undefined, 'lt'],
    ['then the time zone', null, ['de-DE'], 'Europe/Vilnius', 'lt'],
    ['Warsaw', null, [], 'Europe/Warsaw', 'pl'],
    ['otherwise English', null, ['fr-FR'], 'Europe/Paris', 'en'],
    ['no clues at all', null, [], undefined, 'en'],
  ])('%s', (_why, stored, languages, zone, expected) => {
    expect(detectLanguage(stored, languages, zone)).toBe(expected)
  })
})

describe('translate', () => {
  it('fills in placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'editor.confirmDelete', { title: 'Soup' })).toBe('Delete "Soup"?')
    expect(translate('en', 'editor.confirmDelete')).toBe('Delete "{title}"?')
  })

  it.each([
    ['en', 1, '1 ingredient'],
    ['en', 2, '2 ingredients'],
    ['pl', 1, '1 składnik'],
    ['pl', 3, '3 składniki'],
    ['pl', 5, '5 składników'],
    ['pl', 22, '22 składniki'],
    ['pl', 12, '12 składników'],
    ['pl', 1.5, '1.5 składnika'],
    ['lt', 1, '1 ingredientas'],
    ['lt', 21, '21 ingredientas'],
    ['lt', 2, '2 ingredientai'],
    ['lt', 12, '12 ingredientų'],
    ['lt', 10, '10 ingredientų'],
    ['lt', 0.5, '0.5 ingrediento'],
  ] as const)('%s %s', (lang, count, expected) => {
    expect(translate(lang, 'recipes.ingredientCount', { count })).toBe(expected)
  })
})

describe('errorText', () => {
  it('shows a coded error in the language, with its field name translated too', () => {
    expect(errorText('pl', new AppError('invite_code_not_found'))).toBe('Nie znaleziono kodu zaproszenia')
    expect(errorText('lt', new AppError('field_too_long', { field: 'title', max: 200 }))).toBe('Laukas „Pavadinimas“ per ilgas (riba: 200)')
    expect(errorText('en', new AppError('field_required', { field: 'unknown_field' }))).toBe('unknown_field is required')
  })

  it('falls back to the text it was given, then to a generic message', () => {
    expect(errorText('pl', new AppError('some_new_code', {}, 'Server says no'))).toBe('Server says no')
    expect(errorText('pl', new Error('Plain error'))).toBe('Plain error')
    expect(errorText('lt', new Error(''))).toBe('Kažkas nepavyko. Bandykite dar kartą.')
    expect(errorText('en', 'not an error')).toBe('Something went wrong. Please try again.')
  })
})

describe('i18nFor', () => {
  it('gives starter tags and dates in the language', () => {
    expect(i18nFor('pl', () => {}).suggestedTags).toContain('zupa')
    expect(i18nFor('lt', () => {}).suggestedTags).toEqual(['mėsa', 'vištiena', 'žuvis', 'vegetariška', 'sriuba', 'makaronai', 'salotos', 'greita'])
    expect(i18nFor('en', () => {}).formatDate(0)).toMatch(/Jan|Dec/)
  })
})

describe('fallbacks', () => {
  it("uses the 'other' form when a translation lacks the form a number needs", () => {
    const message = DICTIONARIES.pl['recipes.ingredientCount']
    DICTIONARIES.pl['recipes.ingredientCount'] = { one: '{count} składnik', other: '{count} składników (other)' }
    try {
      expect(translate('pl', 'recipes.ingredientCount', { count: 5 })).toBe('5 składników (other)')
    } finally {
      DICTIONARIES.pl['recipes.ingredientCount'] = message
    }
  })

  it('copes with a browser that reports no languages', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(undefined as unknown as string[])
    expect(initialLanguage()).toBe('en')
    vi.restoreAllMocks()
  })

  it('a picker outside the app (no provider) is English and changing it does nothing', async () => {
    render(createElement(LanguagePicker))
    const picker = screen.getByRole('combobox', { name: 'Language' })
    await userEvent.setup().selectOptions(picker, '🇵🇱 Polski')
    expect(picker).toHaveValue('en')
  })
})
