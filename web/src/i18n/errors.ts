/**
 * An error the person should see, carried as a message code (plus values) so it can be shown in their
 * language. `message` keeps the English text for logs and as a fallback.
 */
export class AppError extends Error {
  readonly code: string
  readonly params: Record<string, string | number>

  constructor(code: string, params: Record<string, string | number> = {}, message = code) {
    super(message)
    this.code = code
    this.params = params
  }
}
