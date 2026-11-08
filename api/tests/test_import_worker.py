import pytest

from grubgrab import ai, import_worker
from grubgrab.import_worker import UNEXPECTED, run
from grubgrab.store import Store

DRAFT = {"title": "Soup", "servings": 2, "link": "https://e.com", "ingredients": [{"name": "leek", "quantity": 1.5, "unit": ""}]}


class Extractor:
    """Stands in for an AI provider (the external boundary)."""

    def __init__(self, result):
        self.result = result

    def extract(self, link):
        if isinstance(self.result, Exception):
            raise self.result
        return {**self.result, "link": link}


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


def test_stores_a_readable_problem(job):
    store, hh, job_id = job
    run(event(hh, job_id), store, lambda: Extractor(ai.ExtractionError("Couldn't find a recipe on that page.")))
    assert store.get_import_job(hh, job_id) == {"status": "failed", "error": "Couldn't find a recipe on that page."}


@pytest.mark.parametrize("failure", [RuntimeError("boom"), KeyError("ANTHROPIC_SECRET_NAME")])
def test_never_raises_so_lambda_never_retries_and_bills_twice(job, failure):
    store, hh, job_id = job

    def broken():
        raise failure

    run(event(hh, job_id), store, broken)
    assert store.get_import_job(hh, job_id) == {"status": "failed", "error": UNEXPECTED}


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
