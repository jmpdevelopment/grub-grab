// Invite codes are 10 characters (matches api/src/grubgrab/store.py), shown as "ABCDE-FGH23".
export const INVITE_LENGTH = 10

/** Strip spaces/dashes and upper-case, so "abcde fgh23" and "ABCDE-FGH23" are the same code. */
export const normaliseInviteCode = (raw: string) => raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

/** Split a code into two halves for reading aloud or typing. */
export function formatInviteCode(code: string): string {
  const half = Math.ceil(code.length / 2)
  return `${code.slice(0, half)}-${code.slice(half)}`
}
