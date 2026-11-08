import { describe, expect, it } from 'vitest'
import { formatInviteCode, INVITE_LENGTH, normaliseInviteCode } from './invite'

describe('invite codes', () => {
  it('are 10 characters, matching the API', () => expect(INVITE_LENGTH).toBe(10))

  it.each([
    ['abcde-fgh23', 'ABCDEFGH23'],
    ['  ABCDE FGH23 ', 'ABCDEFGH23'],
    ['a.b_c', 'ABC'],
    ['', ''],
  ])('normalise %j -> %j', (raw, expected) => expect(normaliseInviteCode(raw)).toBe(expected))

  it('formats as two halves', () => {
    expect(formatInviteCode('ABCDEFGH23')).toBe('ABCDE-FGH23')
  })
})
