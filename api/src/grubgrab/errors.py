"""Errors the API sends to the app."""


class ApiError(Exception):
    """An error for the app. `code` (with `params`) lets the app show it in the person's language
    (web/src/i18n/locales/*.ts, key "error.<code>"); `message` is the English text."""

    def __init__(self, status: int, code: str, message: str, **params):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.params = params
