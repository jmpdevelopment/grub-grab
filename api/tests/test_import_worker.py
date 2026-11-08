import json
from decimal import Decimal

import pytest

from grubgrab import ai, import_worker, page
from grubgrab.import_worker import UNEXPECTED, run
from grubgrab.store import Store

DRAFT = {"title": "Soup", "servings": 2, "link": "https://e.com", "ingredients": [{"name": "leek", "quantity": 1.5, "unit": ""}]}


class Extractor:
    """Stands in for an AI provider (the external boundary)."""

    def __init__(self, result):
        self.result = result
        self.known_tags = None

    def extract(self, link, known_tags, language, page_data=None):
        self.known_tags = known_tags
        self.language = language
        self.page_data = page_data
        if isinstance(self.result, Exception):
            raise self.result
        return {**self.result, "link": link}, {"model": "test-model", "source": "page_data" if page_data else "web_fetch"}


@pytest.fixture(autouse=True)
def page_without_recipe_data(monkeypatch):
    """No real downloads in these tests: by default the page has no recipe data of its own."""
    monkeypatch.setattr(page, "recipe_data", lambda link: None)


@pytest.fixture
def job(store):
    hh = store.create_household("alice")["householdId"]
    return store, hh, store.create_import_job(hh, "https://e.com")


def event(hh, job_id):
    return {"householdId": hh, "jobId": job_id, "link": "https://e.com"}


def test_stores_the_draft_for_the_app_to_pick_up(job):
    store, hh, job_id = job
    run(event(hh, job_id), store, lambda: Extractor(DRAFT))
    assert store.get_import_job(hh, job_id) == {"status": "done", "recipe": DRAFT}


def test_tells_the_ai_which_tags_the_household_already_uses(job):
    store, hh, job_id = job
    store.put_recipe(hh, {"title": "Zurek", "tags": ["soup", "meat"], "ingredients": []})
    store.put_recipe(hh, {"title": "Old", "ingredients": []})  # saved before tags existed
    extractor = Extractor(DRAFT)
    run(event(hh, job_id), store, lambda: extractor)
    assert sorted(extractor.known_tags) == ["meat", "soup"]
    assert extractor.language == "en"  # jobs from before languages existed


def test_hands_the_ai_the_pages_own_recipe_data(job, monkeypatch):
    store, hh, job_id = job
    data = {"name": "Soup", "recipeIngredient": ["1 leek"]}
    monkeypatch.setattr(page, "recipe_data", lambda link: data if link == "https://e.com" else None)
    extractor = Extractor(DRAFT)
    run(event(hh, job_id), store, lambda: extractor)
    assert extractor.page_data == data
    assert store.get_import_job(hh, job_id)["status"] == "done"


def test_without_recipe_data_the_ai_reads_the_page(job):
    store, hh, job_id = job
    extractor = Extractor(DRAFT)
    run(event(hh, job_id), store, lambda: extractor)
    assert extractor.page_data is None


def test_writes_the_recipe_in_the_jobs_language(job):
    store, hh, job_id = job
    extractor = Extractor(DRAFT)
    run({**event(hh, job_id), "language": "lt"}, store, lambda: extractor)
    assert extractor.language == "lt"


def test_stores_a_readable_problem(job):
    store, hh, job_id = job
    run(event(hh, job_id), store, lambda: Extractor(ai.ExtractionError("no_recipe", "Couldn't find a recipe on that page.")))
    assert store.get_import_job(hh, job_id) == {
        "status": "failed",
        "error": "Couldn't find a recipe on that page.",
        "errorCode": "no_recipe",
    }


@pytest.mark.parametrize("failure", [RuntimeError("boom"), KeyError("ANTHROPIC_SECRET_NAME")])
def test_never_raises_so_lambda_never_retries_and_bills_twice(job, failure):
    store, hh, job_id = job

    def broken():
        raise failure

    run(event(hh, job_id), store, broken)
    assert store.get_import_job(hh, job_id) == {"status": "failed", "error": UNEXPECTED, "errorCode": "import_unavailable"}


def test_lambda_handler_sets_up_once_per_container(job, monkeypatch):
    store, hh, job_id = job
    made = []
    monkeypatch.setattr(import_worker, "_store", None)
    monkeypatch.setattr(import_worker, "_extractor", None)
    monkeypatch.setattr(ai, "get_extractor", lambda: made.append(1) or Extractor(DRAFT))
    import_worker.lambda_handler(event(hh, job_id), None)
    second = store.create_import_job(hh, "https://e.com")
    import_worker.lambda_handler(event(hh, second), None)
    assert made == [1] and isinstance(import_worker._store, Store)
    assert store.get_import_job(hh, second)["status"] == "done"


def test_keeps_the_ai_requests_details_and_the_pages_data_for_problem_reports(job, monkeypatch):
    store, hh, job_id = job
    data = {"name": "Soup", "recipeIngredient": ["1 leek"]}
    monkeypatch.setattr(page, "recipe_data", lambda link: data)
    run(event(hh, job_id), store, lambda: Extractor(DRAFT))
    record = store.import_job_record(hh, job_id)
    assert {k: v for k, v in record["details"].items() if k != "timing"} == {"model": "test-model", "source": "page_data"}
    assert record["pageData"] == data
    assert store.get_import_job(hh, job_id) == {"status": "done", "recipe": DRAFT}  # the app never gets them


def test_a_failure_keeps_what_was_learned(job):
    store, hh, job_id = job
    err = ai.ExtractionError("unreadable", "Couldn't read a recipe from that page.")
    err.details = {"model": "test-model", "request_id": "req_1"}
    run(event(hh, job_id), store, lambda: Extractor(err))
    record = store.import_job_record(hh, job_id)
    assert {k: v for k, v in record["details"].items() if k != "timing"} == {"model": "test-model", "request_id": "req_1"}
    assert record["pageData"] is None


def test_an_unexpected_failure_has_no_details(job):
    store, hh, job_id = job
    run(event(hh, job_id), store, lambda: Extractor(RuntimeError("bug")))
    assert set(store.import_job_record(hh, job_id)["details"]) == {"timing"}
    assert store.import_job_record(hh, "missing") is None


def test_says_where_the_time_went(job, caplog):
    """Reading the page, getting the AI ready (slow in a fresh container), the AI itself: logged and kept."""
    store, hh, job_id = job
    ticks = iter([0.0, 1.2, 20.6, 30.0, 30.1])
    with caplog.at_level("INFO", logger="grubgrab"):
        run(event(hh, job_id), store, lambda: Extractor(DRAFT), clock=lambda: next(ticks))
    expected = {"pageSeconds": 1.2, "setupSeconds": 19.4, "aiSeconds": 9.4, "totalSeconds": 30.1}
    assert store.import_job_record(hh, job_id)["details"]["timing"] == json.loads(json.dumps(expected), parse_float=Decimal)
    assert json.loads(caplog.records[-1].getMessage()) == {"event": "import_timing", **expected}


def test_a_failure_says_how_far_it_got(job):
    store, hh, job_id = job
    ticks = iter([0.0, 2.0, 2.5, 3.0])
    run(event(hh, job_id), store, lambda: Extractor(ai.ExtractionError("no_recipe", "No recipe")), clock=lambda: next(ticks))
    assert store.import_job_record(hh, job_id)["details"]["timing"] == {"pageSeconds": Decimal("2"), "setupSeconds": Decimal("0.5"), "totalSeconds": Decimal("3")}
