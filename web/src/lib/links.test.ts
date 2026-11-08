import { describe, expect, it } from 'vitest'
import { normaliseLink, safeHref } from './links'

describe('safeHref', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['https://www.kwestiasmaku.com/przepis/zurek', 'https://www.kwestiasmaku.com/przepis/zurek'],
    ['http://example.com', 'http://example.com'],
    ['javascript:alert(1)', undefined],
    ['data:text/html,hi', undefined],
    ['not a url', undefined],
  ])('%s -> %s', (input, expected) => {
    expect(safeHref(input)).toBe(expected)
  })
})

describe('normaliseLink', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['  https://example.com/a?b=1  ', 'https://example.com/a?b=1'],
    ['kwestiasmaku.com/przepis/zurek', 'https://kwestiasmaku.com/przepis/zurek'],
    ['HTTP://Example.com', 'HTTP://Example.com'],
    ['javascript:alert(1)', null],
    ['ftp://example.com/file', null],
    ['zurek soup', null],
    ['localhost', null],
  ])('%j -> %j', (input, expected) => {
    expect(normaliseLink(input)).toBe(expected)
  })
})
