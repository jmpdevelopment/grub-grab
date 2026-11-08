"""AI recipe import. Pick a provider by name; each one turns a link into a recipe draft.

To add a provider (say Gemini or OpenAI): write a module with a class that has
    extract(self, link, known_tags, language, page_data=None) -> tuple[dict, dict]   # (recipe.to_draft(...), details)
using recipe.RECIPE_INSTRUCTIONS, recipe.request_text(...) and RECIPE_SCHEMA, add it to _PROVIDERS below, and set aiProvider (and
aiModel) in infra/settings.local.json. Nothing else in the app changes. When page_data (the page's own recipe data,
see grubgrab.page) is given, everything needed is in the request: send it without a page-reading tool.
`details` describes the request for problem reports: model, source, tokens, cost, request id, promptVersion
(set the same on ExtractionError.details when a request was made but its answer was unusable).
"""

from __future__ import annotations

import os
from typing import Callable, Protocol

from .recipe import ExtractionError


class RecipeExtractor(Protocol):
    def extract(self, link: str, known_tags: list[str], language: str = "en", page_data: dict | None = None) -> tuple[dict, dict]: ...


def _anthropic() -> RecipeExtractor:
    from .anthropic_provider import AnthropicExtractor  # imported only when used

    return AnthropicExtractor.from_environment()


def _anthropic_aws() -> RecipeExtractor:
    from .anthropic_provider import AnthropicExtractor

    return AnthropicExtractor.from_aws()


_PROVIDERS: dict[str, Callable[[], RecipeExtractor]] = {
    "anthropic": _anthropic,  # Claude API, key in Secrets Manager
    "anthropic-aws": _anthropic_aws,  # Claude Platform on AWS, no key (the function's AWS role)
}


def enabled() -> bool:
    return bool(os.environ.get("AI_PROVIDER"))


def get_extractor() -> RecipeExtractor:
    name = os.environ.get("AI_PROVIDER", "")
    if name not in _PROVIDERS:
        raise ExtractionError("import_off", "Recipe import isn't set up on this server.")
    return _PROVIDERS[name]()


__all__ = ["ExtractionError", "RecipeExtractor", "enabled", "get_extractor"]
