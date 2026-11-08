"""Claude adapter: Claude reads the page with Anthropic's web fetch tool and answers in RECIPE_SCHEMA.

The page is fetched on Anthropic's side, so this function never downloads arbitrary URLs itself.
Two ways to reach Claude, same requests:
  - from_aws():           Claude Platform on AWS. Signed with the function's AWS role: no key to store,
                          and usage is billed on the AWS bill (so the AWS budget alert covers it).
  - from_environment():   the Claude API with an API key kept in Secrets Manager.
"""

from __future__ import annotations

import json
import logging
import os
import time

import anthropic
import boto3
from botocore.exceptions import BotoCoreError, ClientError

from .recipe import RECIPE_INSTRUCTIONS, RECIPE_SCHEMA, ExtractionError, request_text, to_draft

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_EFFORT = "low"  # reading one page doesn't need deep reasoning; keeps it fast and cheap
_MAX_PAUSES = 2  # a server-tool turn can pause; resume it a couple of times at most
# Runs in the background import worker (not inside an API request), so a slow page has time; the worker's
# own limit (200 s) covers the worst case of three requests.
_TIMEOUT_SECONDS = 60.0


# List prices in USD per million tokens (input, output, cache read), for the cost estimate in the log.
# The bill itself is the source of truth; an unknown model is logged without an estimate.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00, 0.20),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
}


def _usage_log(model: str, responses: list, seconds: float) -> dict:
    """One import's usage, summed over every request it made (a paused turn means more than one)."""
    def total(field: str) -> int:
        return sum(getattr(r.usage, field, None) or 0 for r in responses)

    entry = {
        "event": "recipe_import",
        "model": model,
        "requests": len(responses),
        "input_tokens": total("input_tokens"),
        "output_tokens": total("output_tokens"),
        "cache_read_tokens": total("cache_read_input_tokens"),
        "cache_write_tokens": total("cache_creation_input_tokens"),
        "seconds": round(seconds, 1),
        "stop": responses[-1].stop_reason,
        "request_id": responses[-1]._request_id,
    }
    if model in PRICES:
        inp, out, read = PRICES[model]
        cost = (entry["input_tokens"] + entry["cache_write_tokens"] * 1.25) * inp + entry["output_tokens"] * out
        entry["estimated_usd"] = round((cost + entry["cache_read_tokens"] * read) / 1_000_000, 4)
    return entry


def _api_key_from_secret(name: str) -> str:
    return boto3.client("secretsmanager").get_secret_value(SecretId=name)["SecretString"].strip()


class AnthropicExtractor:
    def __init__(self, client: anthropic.Anthropic, model: str = DEFAULT_MODEL, effort: str = DEFAULT_EFFORT):
        self.client = client
        self.model = model
        self.effort = effort

    @classmethod
    def _configured(cls, client: anthropic.Anthropic) -> "AnthropicExtractor":
        return cls(client, os.environ.get("AI_MODEL") or DEFAULT_MODEL, os.environ.get("AI_EFFORT") or DEFAULT_EFFORT)

    @classmethod
    def from_aws(cls) -> "AnthropicExtractor":
        # Lambda sets AWS_REGION; credentials come from the function's role (boto3 is in the Lambda runtime).
        client = anthropic.AnthropicAWS(
            aws_region=os.environ["AWS_REGION"],
            workspace_id=os.environ["ANTHROPIC_AWS_WORKSPACE_ID"],
            timeout=_TIMEOUT_SECONDS,
            max_retries=0,
        )
        return cls._configured(client)

    @classmethod
    def from_environment(cls) -> "AnthropicExtractor":
        try:
            key = _api_key_from_secret(os.environ["ANTHROPIC_SECRET_NAME"])
        except (ClientError, BotoCoreError) as exc:  # e.g. the key hasn't been stored yet
            log.error("Couldn't read the Anthropic API key: %s", exc)
            raise ExtractionError("import_setup", "Recipe import isn't working right now (server setup). Add the recipe by hand.") from exc
        return cls._configured(anthropic.Anthropic(api_key=key, timeout=_TIMEOUT_SECONDS, max_retries=0))

    def extract(self, link: str, known_tags: list[str], language: str = "en") -> dict:
        messages: list = [{"role": "user", "content": request_text(link, known_tags, language)}]
        responses: list = []
        started = time.monotonic()
        try:
            for _ in range(_MAX_PAUSES + 1):
                response = self.client.beta.messages.create(
                    model=self.model,
                    max_tokens=16000,
                    system=RECIPE_INSTRUCTIONS,
                    messages=messages,
                    tools=[{"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 2, "max_content_tokens": 30000}],
                    output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": RECIPE_SCHEMA}},
                    # If a safety check declines the request, the API retries it on a suitable model itself.
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                )
                responses.append(response)
                if response.stop_reason != "pause_turn":
                    break
                messages.append({"role": "assistant", "content": response.content})
        except anthropic.APITimeoutError as exc:
            raise ExtractionError("import_timeout", "Reading that page took too long. Try again, or add the recipe by hand.") from exc
        except anthropic.RateLimitError as exc:
            raise ExtractionError("import_busy", "Recipe import is busy right now. Try again in a minute.") from exc
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
            log.error("Anthropic rejected the API key: %s", exc)
            raise ExtractionError("import_setup", "Recipe import isn't working right now (server setup). Add the recipe by hand.") from exc
        except anthropic.APIError as exc:
            log.error("Anthropic request failed: %s", exc)
            raise ExtractionError("import_unavailable", "Couldn't read that page right now. Try again, or add the recipe by hand.") from exc

        log.info(json.dumps(_usage_log(self.model, responses, time.monotonic() - started)))
        if response.stop_reason == "refusal":
            raise ExtractionError("unreadable", "Couldn't read a recipe from that page.")
        if response.stop_reason != "end_turn":  # still paused, or ran out of room
            raise ExtractionError("incomplete", "Couldn't finish reading that page. Try again, or add the recipe by hand.")
        texts = [b.text for b in response.content if b.type == "text" and b.text.strip()]
        try:
            answer = json.loads(texts[-1])
        except (IndexError, ValueError) as exc:
            raise ExtractionError("unreadable", "Couldn't read a recipe from that page.") from exc
        return to_draft(answer, link)
