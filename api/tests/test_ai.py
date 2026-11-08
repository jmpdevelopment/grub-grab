"""AI recipe import: the provider-neutral checks, the provider registry, and the Claude adapter.

The Claude adapter runs the real Anthropic SDK against a fake network transport (the external boundary),
so request building, response parsing and error mapping are all exercised without calling the API.
"""

import json

import anthropic
import boto3
import httpx2
import pytest

from grubgrab import ai
from grubgrab.ai import anthropic_provider
from grubgrab.ai.anthropic_provider import AnthropicExtractor
from grubgrab.ai.recipe import RECIPE_SCHEMA, SUGGESTED_TAGS, ExtractionError, request_text, to_draft

LINK = "https://www.kwestiasmaku.com/przepis/zupa-fasolkowa"
SOUP = {
    "found": True,
    "title": "Green bean soup",
    "servings": 4,
    "ingredients": [
        {"name": "potatoes", "quantity": 3, "unit": "", "aisle": "produce"},
        {"name": "garlic", "quantity": 2, "unit": "cloves", "aisle": "produce"},
        {"name": "dill", "quantity": None, "unit": "", "aisle": "produce"},
    ],
}


# ---- provider-neutral checks ---------------------------------------------------------------


class TestToDraft:
    def test_a_good_answer_becomes_a_draft_for_review(self):
        assert to_draft(SOUP, LINK) == {
            "title": "Green bean soup",
            "servings": 4,
            "link": LINK,
            "tags": [],
            "ingredients": [
                {"name": "potatoes", "quantity": 3.0, "unit": "", "aisle": "produce"},
                {"name": "garlic", "quantity": 2.0, "unit": "cloves", "aisle": "produce"},
                {"name": "dill", "quantity": None, "unit": "", "aisle": "produce"},
            ],
        }

    @pytest.mark.parametrize("answer", [{"found": False}, {}, None, "not json"])
    def test_no_recipe_on_the_page(self, answer):
        with pytest.raises(ExtractionError, match="Couldn't find a recipe on that page."):
            to_draft(answer, LINK)

    def test_no_usable_ingredients(self):
        with pytest.raises(ExtractionError, match="Couldn't find any ingredients"):
            to_draft({**SOUP, "ingredients": [{"name": "  "}, "garlic", None]}, LINK)

    def test_never_trusts_the_answer_blindly(self):
        draft = to_draft(
            {
                "found": True,
                "title": "  " + "T" * 300,
                "servings": True,
                "ingredients": [
                    {"name": " Flour ", "quantity": "0.3333333", "unit": " g " + "x" * 50, "aisle": "pantry"},
                    {"name": "Salt", "quantity": -1, "unit": None, "aisle": "garden centre"},
                    {"name": "Sugar", "quantity": 10_000_000, "unit": ""},
                    {"name": "Eggs", "quantity": True, "unit": ""},
                    {"name": "Milk", "quantity": "lots", "unit": ""},
                    {"name": "Water", "quantity": "NaN", "unit": ""},
                    {"name": 5},
                ],
            },
            LINK,
        )
        assert len(draft["title"]) == 200 and draft["servings"] is None
        assert draft["ingredients"][0] == {"name": "Flour", "quantity": 0.333, "unit": ("g " + "x" * 50)[:20], "aisle": "pantry"}
        assert [i["aisle"] for i in draft["ingredients"]] == ["pantry"] + ["other"] * 5  # unknown or missing
        assert [i["quantity"] for i in draft["ingredients"]] == [0.333, None, None, None, None, None]
        assert draft["ingredients"][1]["unit"] == ""

    def test_suggested_tags_are_cleaned_and_capped(self):
        draft = to_draft({**SOUP, "tags": [" Soup ", "soup", "VEGETARIAN", "", 5, None, "x" * 40, "a", "b", "c"]}, LINK)
        assert draft["tags"] == ["soup", "vegetarian", "x" * 30, "a", "b"]

    @pytest.mark.parametrize("servings, expected", [(0, None), (1001, None), ("4", None), (None, None), (1000, 1000)])
    def test_servings_must_be_sensible(self, servings, expected):
        assert to_draft({**SOUP, "servings": servings}, LINK)["servings"] == expected

    def test_untitled_and_capped(self):
        draft = to_draft({**SOUP, "title": "", "ingredients": [{"name": f"i{n}", "quantity": 1, "unit": ""} for n in range(250)]}, LINK)
        assert draft["title"] == "Untitled recipe" and len(draft["ingredients"]) == 200

    def test_asks_for_each_ingredients_aisle_from_the_apps_list(self):
        from grubgrab.aisles import AISLES

        assert RECIPE_SCHEMA["properties"]["ingredients"]["items"]["properties"]["aisle"] == {"type": "string", "enum": list(AISLES)}

    def test_schema_is_strict(self):
        assert RECIPE_SCHEMA["additionalProperties"] is False
        assert set(RECIPE_SCHEMA["required"]) == set(RECIPE_SCHEMA["properties"])
        item = RECIPE_SCHEMA["properties"]["ingredients"]["items"]
        assert item["additionalProperties"] is False and set(item["required"]) == set(item["properties"])


# ---- choosing a provider -------------------------------------------------------------------


class TestRequestText:
    def test_offers_the_household_tags_once_each_in_order(self):
        text = request_text(LINK, ["soup", "meat", "soup", "", "chicken"], "pl")
        assert text == f"Recipe page: {LINK}\nWrite the recipe in: Polish\nThe household's existing tags: chicken, meat, soup"

    @pytest.mark.parametrize("lang, name", [("en", "English"), ("pl", "Polish"), ("lt", "Lithuanian"), ("xx", "English"), (None, "English")])
    def test_a_new_household_gets_starter_tags_in_its_language(self, lang, name):
        text = request_text(LINK, [], lang)
        code = lang if lang in SUGGESTED_TAGS else "en"
        assert f"Write the recipe in: {name}" in text
        assert text.endswith("existing tags: " + ", ".join(SUGGESTED_TAGS[code]))

    def test_starter_tags_match_the_apps_translations(self):
        """Same words as "tags.suggested" in the app, so the editor and the AI suggest the same tags."""
        from pathlib import Path

        locales = Path(__file__).resolve().parents[2] / "web" / "src" / "i18n" / "locales"
        for lang, tags in SUGGESTED_TAGS.items():
            text = (locales / f"{lang}.ts").read_text()
            assert f"'tags.suggested': '{', '.join(tags)}'" in text, lang

    def test_caps_a_long_tag_list(self):
        text = request_text(LINK, [f"t{n:03}" for n in range(80)])
        assert text.count(",") == 49


class TestProviders:
    def test_disabled_without_a_provider(self, monkeypatch):
        monkeypatch.delenv("AI_PROVIDER", raising=False)
        assert ai.enabled() is False
        with pytest.raises(ExtractionError, match="isn't set up"):
            ai.get_extractor()

    def test_unknown_provider(self, monkeypatch):
        monkeypatch.setenv("AI_PROVIDER", "nope")
        assert ai.enabled() is True
        with pytest.raises(ExtractionError, match="isn't set up"):
            ai.get_extractor()

    def test_claude_platform_on_aws_needs_no_key(self, monkeypatch):
        monkeypatch.setenv("AI_PROVIDER", "anthropic-aws")
        monkeypatch.setenv("AWS_REGION", "eu-west-2")
        monkeypatch.setenv("ANTHROPIC_AWS_WORKSPACE_ID", "wrkspc_01Test")
        monkeypatch.setenv("AI_MODEL", "claude-opus-5-5")
        monkeypatch.delenv("AI_EFFORT", raising=False)
        monkeypatch.delenv("ANTHROPIC_SECRET_NAME", raising=False)
        extractor = ai.get_extractor()
        assert isinstance(extractor.client, anthropic.AnthropicAWS)
        assert extractor.client.max_retries == 0
        assert "aws-external-anthropic.eu-west-2" in str(extractor.client.base_url)
        assert (extractor.model, extractor.effort) == ("claude-opus-5-5", "low")

    def test_a_missing_key_is_a_clear_message_not_a_crash(self, table, monkeypatch):
        monkeypatch.setenv("AI_PROVIDER", "anthropic")
        monkeypatch.setenv("ANTHROPIC_SECRET_NAME", "grubgrab/not-stored-yet")
        with pytest.raises(ExtractionError, match="server setup"):
            ai.get_extractor()

    def test_anthropic_reads_its_key_from_secrets_manager(self, table, monkeypatch):
        boto3.client("secretsmanager").create_secret(Name="grubgrab/anthropic-api-key", SecretString=" sk-ant-test \n")
        monkeypatch.setenv("AI_PROVIDER", "anthropic")
        monkeypatch.setenv("ANTHROPIC_SECRET_NAME", "grubgrab/anthropic-api-key")
        monkeypatch.setenv("AI_EFFORT", "medium")
        monkeypatch.delenv("AI_MODEL", raising=False)
        extractor = ai.get_extractor()
        assert isinstance(extractor, AnthropicExtractor)
        assert (extractor.model, extractor.effort) == ("claude-opus-5-5", "medium")
        assert extractor.client.api_key == "sk-ant-test"
        assert extractor.client.max_retries == 0


# ---- the Claude adapter --------------------------------------------------------------------


def message(stop_reason="end_turn", content=None):
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5-5",
        "content": content if content is not None else [{"type": "text", "text": json.dumps(SOUP)}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 3000, "output_tokens": 600},
    }


def claude(*replies):
    """An extractor whose HTTP layer returns the given replies in order (dicts are 200 JSON bodies)."""
    sent = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append({"path": request.url.path, "headers": dict(request.headers), "body": json.loads(request.content)})
        reply = replies[len(sent) - 1]
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, httpx2.Response):
            return reply
        return httpx2.Response(200, json=reply)

    client = anthropic.Anthropic(api_key="sk-ant-test", max_retries=0, http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))
    return AnthropicExtractor(client), sent


class TestClaudeAdapter:
    def test_asks_claude_to_fetch_the_page_and_answer_in_the_schema(self):
        extractor, sent = claude(message())
        assert extractor.extract(LINK, [])["title"] == "Green bean soup"
        assert len(sent) == 1
        body, headers = sent[0]["body"], sent[0]["headers"]
        assert sent[0]["path"] == "/v1/messages"
        assert body["model"] == "claude-opus-5-5"
        assert body["output_config"] == {"effort": "low", "format": {"type": "json_schema", "schema": RECIPE_SCHEMA}}
        assert body["tools"] == [{"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 2, "max_content_tokens": 30000}]
        assert body["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in headers["anthropic-beta"]
        assert body["messages"] == [{"role": "user", "content": request_text(LINK, [], "en")}]
        assert "in the language the request asks for" in body["system"]
        assert "g, kg, ml, l, tsp and tbsp as exactly these codes, in every language" in body["system"]
        assert "thinking" not in body and "temperature" not in body

    def test_reads_the_last_text_after_the_fetch(self):
        fetched = [
            {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_fetch", "input": {"url": LINK}},
            {"type": "text", "text": "  "},
            {"type": "text", "text": json.dumps(SOUP)},
        ]
        extractor, _ = claude(message(content=fetched))
        assert len(extractor.extract(LINK, [])["ingredients"]) == 3

    def test_resumes_a_paused_turn(self):
        paused = message("pause_turn", [{"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_fetch", "input": {"url": LINK}}])
        extractor, sent = claude(paused, message())
        assert extractor.extract(LINK, [])["servings"] == 4
        assert [m["role"] for m in sent[1]["body"]["messages"]] == ["user", "assistant"]

    def test_gives_up_after_too_many_pauses(self):
        extractor, sent = claude(*[message("pause_turn", [])] * 3)
        with pytest.raises(ExtractionError, match="Couldn't finish reading that page"):
            extractor.extract(LINK, [])
        assert len(sent) == 3

    @pytest.mark.parametrize(
        "reply, error",
        [
            (message("refusal", []), "Couldn't read a recipe from that page."),
            (message("max_tokens", []), "Couldn't finish reading that page"),
            (message(content=[]), "Couldn't read a recipe from that page."),
            (message(content=[{"type": "text", "text": "not json"}]), "Couldn't read a recipe from that page."),
            (message(content=[{"type": "text", "text": json.dumps({"found": False})}]), "Couldn't find a recipe on that page."),
        ],
    )
    def test_answers_that_are_not_a_recipe(self, reply, error):
        extractor, _ = claude(reply)
        with pytest.raises(ExtractionError, match=error):
            extractor.extract(LINK, [])

    @pytest.mark.parametrize(
        "reply, error",
        [
            (httpx2.ReadTimeout("slow"), "took too long"),
            (httpx2.Response(429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}), "busy right now"),
            (httpx2.Response(401, json={"type": "error", "error": {"type": "authentication_error", "message": "bad key"}}), "server setup"),
            (httpx2.Response(403, json={"type": "error", "error": {"type": "permission_error", "message": "no"}}), "server setup"),
            (httpx2.Response(529, json={"type": "error", "error": {"type": "overloaded_error", "message": "busy"}}), "Couldn't read that page right now"),
            (httpx2.ConnectError("offline"), "Couldn't read that page right now"),
        ],
    )
    def test_api_errors_become_friendly_messages(self, reply, error):
        extractor, _ = claude(reply)
        with pytest.raises(ExtractionError, match=error):
            extractor.extract(LINK, [])

    def test_module_constants(self):
        assert anthropic_provider.DEFAULT_MODEL == "claude-opus-5-5" and anthropic_provider.DEFAULT_EFFORT == "low"


class TestCostLog:
    def test_logs_tokens_and_cost_for_the_whole_import(self, caplog):
        paused = message("pause_turn", [])
        paused["usage"] = {"input_tokens": 2000, "output_tokens": 100, "cache_read_input_tokens": 1000}
        done = message()
        done["usage"] = {"input_tokens": 3000, "output_tokens": 600, "cache_creation_input_tokens": 400}
        extractor, _ = claude(paused, done)
        with caplog.at_level("INFO", logger="grubgrab"):
            extractor.extract(LINK, ["soup"])
        entry = json.loads(caplog.records[-1].getMessage())
        assert {k: entry[k] for k in ("event", "model", "requests", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "stop")} == {
            "event": "recipe_import",
            "model": "claude-opus-5-5",
            "requests": 2,
            "input_tokens": 5000,
            "output_tokens": 700,
            "cache_read_tokens": 1000,
            "cache_write_tokens": 400,
            "stop": "end_turn",
        }
        # (5000 + 400 * 1.25) * $4 + 700 * $20 + 1000 * $0.20, per million tokens
        assert entry["estimated_usd"] == round((5500 * 4 + 700 * 20 + 1000 * 0.2) / 1e6, 4)
        assert LINK not in caplog.text  # no links or personal details in the log

    def test_no_estimate_for_a_model_without_a_known_price(self, caplog):
        extractor, _ = claude(message())
        extractor.model = "claude-future-9"
        with caplog.at_level("INFO", logger="grubgrab"):
            extractor.extract(LINK, [])
        entry = json.loads(caplog.records[-1].getMessage())
        assert entry["model"] == "claude-future-9" and "estimated_usd" not in entry
