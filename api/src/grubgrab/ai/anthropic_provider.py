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

import anthropic
import boto3
from botocore.exceptions import BotoCoreError, ClientError

from .recipe import RECIPE_INSTRUCTIONS, RECIPE_SCHEMA, ExtractionError, to_draft

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_EFFORT = "low"  # reading one page doesn't need deep reasoning; keeps it fast and cheap
_MAX_PAUSES = 3  # a server-tool turn can pause; resume it a few times at most
_TIMEOUT_SECONDS = 22.0  # must finish inside the API's 30 s limit (the function itself has 25 s)


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
            raise ExtractionError("Recipe import isn't working right now (server setup). Add the recipe by hand.") from exc
        return cls._configured(anthropic.Anthropic(api_key=key, timeout=_TIMEOUT_SECONDS, max_retries=0))

    def extract(self, link: str) -> dict:
        messages: list = [{"role": "user", "content": f"Recipe page: {link}"}]
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
                if response.stop_reason != "pause_turn":
                    break
                messages.append({"role": "assistant", "content": response.content})
        except anthropic.APITimeoutError as exc:
            raise ExtractionError("Reading that page took too long. Try again, or add the recipe by hand.") from exc
        except anthropic.RateLimitError as exc:
            raise ExtractionError("Recipe import is busy right now. Try again in a minute.") from exc
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
            log.error("Anthropic rejected the API key: %s", exc)
            raise ExtractionError("Recipe import isn't working right now (server setup). Add the recipe by hand.") from exc
        except anthropic.APIError as exc:
            log.error("Anthropic request failed: %s", exc)
            raise ExtractionError("Couldn't read that page right now. Try again, or add the recipe by hand.") from exc

        log.info("recipe import: model=%s stop=%s usage=%s request=%s", response.model, response.stop_reason,
                 response.usage.to_dict() if response.usage else None, response._request_id)
        if response.stop_reason == "refusal":
            raise ExtractionError("Couldn't read a recipe from that page.")
        if response.stop_reason != "end_turn":  # still paused, or ran out of room
            raise ExtractionError("Couldn't finish reading that page. Try again, or add the recipe by hand.")
        texts = [b.text for b in response.content if b.type == "text" and b.text.strip()]
        try:
            answer = json.loads(texts[-1])
        except (IndexError, ValueError) as exc:
            raise ExtractionError("Couldn't read a recipe from that page.") from exc
        return to_draft(answer, link)
