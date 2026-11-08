/** A message is text with {placeholders}, or plural forms picked by Intl.PluralRules from {count}. */
export type Plural = { one: string; few?: string; many?: string; other: string }
export type Message = string | Plural
