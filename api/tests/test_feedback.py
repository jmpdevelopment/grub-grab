"""Problem reports, automatic error reports and import outcomes (POST /feedback), stored in their own table."""

import json
from decimal import Decimal

import pytest
from boto3.dynamodb.conditions import Key

from grubgrab import feedback
from grubgrab.feedback import build, domain
from grubgrab.handler import handle

from test_handler import call, error, event

LINK = "https://www.bbcgoodfood.com/recipes/easy-chicken-curry"
DRAFT = {"title": "Curry", "servings": 4, "link": LINK, "tags": ["chicken"], "ingredients": [{"name": "chicken", "quantity": 6, "unit": "", "aisle": "meat"}]}
JOURNEY = [{"t": 1, "type": "screen", "name": "editor"}, {"t": 2, "type": "api", "route": "POST /recipes/import", "status": 202}]
CLIENT = {"appVersion": "abc123", "language": "lt", "userAgent": "Mozilla/5.0 (iPhone)"}


@pytest.fixture
def store(store):
    """Alice and Bob have each started a household; Carol hasn't."""
    store.create_household("alice")
    store.create_household("bob")
    return store


@pytest.fixture
def imported(store):
    """Alice's household imported a recipe: the worker kept its details."""
    hh = store.household_for("alice")
    job = store.create_import_job(hh, LINK, "lt")
    store.finish_import_job(
        hh, job, recipe=DRAFT, details={"model": "claude-opus-5-5", "source": "page_data", "estimated_usd": 0.0123, "promptVersion": "p1"},
        page_data={"name": "Easy chicken curry", "recipeIngredient": ["6 chicken thighs"]},
    )
    return hh, job


def stored(feedback_table, kind):
    return feedback_table.query(KeyConditionExpression=Key("kind").eq(kind))["Items"]


class TestImportReports:
    def test_a_report_carries_everything_about_the_import(self, store, feedback_table, imported):
        hh, job = imported
        body = {
            "kind": "import", "jobId": job, "problems": ["amounts", "names"], "marked": ["chicken"], "note": " Thighs, not 6 ",
            "edits": {"amounts": ["chicken"]}, "journey": JOURNEY, "client": CLIENT,
        }
        status, reply = call(store, "POST /feedback", body=body)
        assert status == 201, reply
        [record] = stored(feedback_table, "import")
        assert record["id"] == reply["id"] and record["sk"].endswith("#" + reply["id"])
        assert record["sk"][:4].isdigit() and record["sk"][10] == "T"  # sorted by time
        assert {k: record[k] for k in ("userId", "householdId", "status", "problems", "marked", "note", "fingerprint")} == {
            "userId": "alice", "householdId": hh, "status": "new", "problems": ["amounts", "names"], "marked": ["chicken"],
            "note": "Thighs, not 6", "fingerprint": "import:bbcgoodfood.com:amounts+names",
        }
        snap = record["import"]
        assert snap["link"] == LINK and snap["domain"] == "bbcgoodfood.com" and snap["language"] == "lt" and snap["status"] == "done"
        assert snap["draft"]["ingredients"][0]["name"] == "chicken" and snap["pageData"]["name"] == "Easy chicken curry"
        assert snap["details"] == {"model": "claude-opus-5-5", "source": "page_data", "estimated_usd": Decimal("0.0123"), "promptVersion": "p1"}
        assert record["journey"] == json.loads(json.dumps(JOURNEY), parse_float=Decimal) and record["client"] == CLIENT
        assert record["edits"] == {"amounts": ["chicken"]}
        assert record["expiresAt"] - record["at"] == 365 * 24 * 3600

    def test_a_failed_import_is_grouped_by_its_error(self, store, feedback_table):
        hh = store.household_for("alice")
        job = store.create_import_job(hh, "https://e.com/x")
        store.finish_import_job(hh, job, error="No recipe", error_code="no_recipe", details={"model": "m"})
        call(store, "POST /feedback", body={"kind": "import", "jobId": job, "problems": ["unread"]})
        assert stored(feedback_table, "import")[0]["fingerprint"] == "import:e.com:no_recipe"

    def test_an_import_that_never_started_can_still_be_reported(self, store, feedback_table):
        assert call(store, "POST /feedback", body={"kind": "import", "problems": ["unread"], "errorCode": "import_limit"})[0] == 201
        assert call(store, "POST /feedback", body={"kind": "import", "problems": ["other"]})[0] == 201
        assert sorted(r["fingerprint"] for r in stored(feedback_table, "import")) == ["import:no-job:import_limit", "import:no-job:other"]

    def test_only_imports_of_your_own_household(self, store, imported):
        _, job = imported
        assert error(store, "POST /feedback", sub="bob", body={"kind": "import", "jobId": job, "problems": ["other"]}) == (404, "Import not found")
        assert error(store, "POST /feedback", sub="carol", body={"kind": "import", "jobId": job, "problems": ["other"]}) == (404, "Import not found")
        assert error(store, "POST /feedback", body={"kind": "import", "jobId": 5, "problems": ["other"]}) == (404, "Import not found")

    def test_a_huge_page_is_left_out_rather_than_losing_the_report(self, store, feedback_table, monkeypatch):
        hh = store.household_for("alice")
        job = store.create_import_job(hh, LINK)
        store.finish_import_job(hh, job, recipe=DRAFT, page_data={"recipeIngredient": ["x" * 300] * 200})
        monkeypatch.setattr(feedback, "_MAX_ITEM_BYTES", 30_000)
        assert call(store, "POST /feedback", body={"kind": "import", "jobId": job, "problems": ["other"]})[0] == 201
        snap = stored(feedback_table, "import")[0]["import"]
        assert snap["pageData"] is None and snap["link"] == LINK


class TestGeneralAndErrorReports:
    def test_report_a_problem_from_settings(self, store, feedback_table):
        assert call(store, "POST /feedback", body={"kind": "general", "problems": ["slow", "broke"], "note": "List took ages", "journey": JOURNEY})[0] == 201
        [record] = stored(feedback_table, "general")
        assert record["fingerprint"] == "general:broke+slow" and record["note"] == "List took ages" and "import" not in record

    def test_an_error_the_app_caught_by_itself(self, store, feedback_table):
        err = {"code": "TypeError", "where": "list", "message": "x is undefined", "stack": "at a (index.js:1)\n" * 500}
        assert call(store, "POST /feedback", body={"kind": "error", "error": err, "journey": JOURNEY, "client": CLIENT})[0] == 201
        [record] = stored(feedback_table, "error")
        assert record["fingerprint"] == "error:TypeError:list" and "status" not in record
        assert record["error"]["message"] == "x is undefined" and len(record["error"]["stack"]) == 4000

    def test_errors_without_details_still_count(self, store, feedback_table):
        call(store, "POST /feedback", body={"kind": "error"})
        assert stored(feedback_table, "error")[0]["fingerprint"] == "error:unknown:app"

    def test_works_before_joining_a_household(self, store, feedback_table):
        assert call(store, "POST /feedback", sub="carol", body={"kind": "error", "error": {"code": "boom", "where": "setup"}})[0] == 201
        assert stored(feedback_table, "error")[0]["householdId"] == ""

    def test_keeps_the_latest_steps_and_trims_to_fit(self, store, feedback_table):
        steps = [{"t": n, "type": "api", "route": "GET /list", "pad": "x" * 600} for n in range(150)]
        call(store, "POST /feedback", body={"kind": "general", "problems": ["other"], "journey": steps})
        kept = stored(feedback_table, "general")[0]["journey"]
        assert kept[-1]["t"] == 149 and len(json.dumps(kept, default=str)) <= 40_000 and len(kept) < 100


class TestOutcomes:
    def test_counts_what_happened_after_an_import_once(self, store, feedback_table, imported):
        _, job = imported
        body = {"kind": "outcome", "jobId": job, "outcome": "edited", "changes": {"renamed": 2, "amounts": 1}}
        assert call(store, "POST /feedback", body=body)[0] == 201
        assert call(store, "POST /feedback", body={**body, "outcome": "unchanged"}) == (200, {"recorded": False})  # sent again
        [record] = stored(feedback_table, "outcome")
        assert record["outcome"] == "edited" and record["changes"] == {"renamed": 2, "amounts": 1}
        assert record["fingerprint"] == "outcome:bbcgoodfood.com:edited"
        assert record["import"]["details"]["model"] == "claude-opus-5-5" and "draft" not in record["import"]  # counts only
        assert "journey" not in record and "note" not in record

    @pytest.mark.parametrize(
        "body, message",
        [
            ({"outcome": "great"}, "Unknown outcome 'great'"),
            ({"outcome": "edited", "changes": {"renamed": "two"}}, "Changes must be counts"),
            ({"outcome": "edited", "changes": {"renamed": True}}, "Changes must be counts"),
        ],
    )
    def test_outcomes_are_checked(self, store, imported, body, message):
        assert error(store, "POST /feedback", body={"kind": "outcome", "jobId": imported[1], **body}) == (400, message)

    def test_needs_its_import(self, store):
        assert error(store, "POST /feedback", body={"kind": "outcome", "outcome": "edited"}) == (400, "An outcome needs its import")


class TestChecks:
    @pytest.mark.parametrize(
        "body, message",
        [
            ({"kind": "rant"}, "Unknown kind 'rant'"),
            ({}, "Unknown kind 'None'"),
            ({"kind": "general"}, "Problems must be a list of choices"),
            ({"kind": "general", "problems": []}, "Pick at least one problem"),
            ({"kind": "general", "problems": ["amounts"]}, "Unknown problem 'amounts'"),  # an import choice
            ({"kind": "import", "problems": [5]}, "Problems must be a list of choices"),
            ({"kind": "general", "problems": ["other"], "note": 5}, "Note must be text"),
            ({"kind": "general", "problems": ["other"], "client": "x"}, "Client must be an object"),
            ({"kind": "general", "problems": ["other"], "journey": "x"}, "Journey must be a list of steps"),
            ({"kind": "general", "problems": ["other"], "journey": ["x"]}, "Journey must be a list of steps"),
            ({"kind": "import", "problems": ["other"], "marked": "chicken"}, "Marked must be a list of ingredient names"),
        ],
    )
    def test_reports_are_checked(self, store, body, message):
        assert error(store, "POST /feedback", body=body) == (400, message)

    def test_size_limits(self, store):
        assert error(store, "POST /feedback", body={"kind": "general", "problems": ["other"], "client": {"x": "y" * 5000}}) == (413, "Client is too large")
        assert call(store, "POST /feedback", body={"kind": "general", "problems": ["other"], "note": "n" * 5000})[0] == 201  # cut, not refused

    def test_whole_record_size_limit(self, store, monkeypatch):
        monkeypatch.setattr(feedback, "_MAX_ITEM_BYTES", 500)
        assert error(store, "POST /feedback", body={"kind": "general", "problems": ["other"], "note": "n" * 900}) == (413, "That report is too large")

    def test_a_daily_limit_per_person(self, store, monkeypatch):
        monkeypatch.setattr(feedback, "MAX_REPORTS_PER_DAY", 2)
        monkeypatch.setattr(feedback, "MAX_ERRORS_PER_DAY", 1)
        report = {"kind": "general", "problems": ["other"]}
        assert [call(store, "POST /feedback", body=report)[0] for _ in range(3)] == [201, 201, 429]
        assert call(store, "POST /feedback", body={"kind": "error"})[0] == 201  # errors are counted separately
        assert error(store, "POST /feedback", body={"kind": "error"}) == (429, "Too many reports today. Try again tomorrow.")
        assert call(store, "POST /feedback", sub="bob", body=report)[0] == 201  # per person


class TestPrivacy:
    def test_reports_go_when_the_account_does(self, store, feedback_table, imported, monkeypatch):
        monkeypatch.setattr("grubgrab.handler._delete_sign_in", lambda username: None)
        _, job = imported
        call(store, "POST /feedback", body={"kind": "import", "jobId": job, "problems": ["other"]})
        call(store, "POST /feedback", body={"kind": "outcome", "jobId": job, "outcome": "unchanged"})
        call(store, "POST /feedback", sub="bob", body={"kind": "error"})
        resp = handle({**event("DELETE /me"), "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "alice", "username": "Google_a"}}}}}, store)
        assert resp["statusCode"] == 200
        left = [r["userId"] for k in feedback.KINDS for r in stored(feedback_table, k)]
        assert left == ["bob"]

    def test_deleting_many_reports_pages_through_them(self, store, feedback_table):
        for n in range(30):
            store.add_feedback({"kind": "error", "sk": f"2026-01-01T00:00:{n:02}Z#{n}", "userId": "alice", "pad": "x" * 40_000})
        store.delete_user_feedback("alice")
        assert stored(feedback_table, "error") == []

    def test_no_email_is_ever_stored(self, store, feedback_table, imported):
        call(store, "POST /feedback", body={"kind": "import", "jobId": imported[1], "problems": ["other"]})
        assert "@" not in json.dumps(stored(feedback_table, "import"), default=str)


def test_domain():
    assert domain("https://www.kwestiasmaku.com/przepis/x") == "kwestiasmaku.com"
    assert domain("") == "" and domain("nonsense") == ""


def test_build_rejects_unknown_kinds_directly():
    with pytest.raises(Exception, match="Unknown kind"):
        build({"kind": "x"}, user="u", household=None, job=None, now=0)
