"""Background worker for "Fill from link". The API starts it asynchronously and returns straight away;
the app polls GET /recipes/import/{id} until the job is done or failed.

It never raises: every outcome is written to the job, so the app always gets an answer, and Lambda's
automatic retry (which would call the AI and bill again) never has a reason to run. It's also turned off.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Callable

from . import ai, page
from .store import Store

log = logging.getLogger(__name__)  # under "grubgrab", which is set to INFO below (Lambda shows only warnings otherwise)
# Lambda shows only warnings by default; keep this app's info lines (e.g. each import's tokens and cost).
logging.getLogger("grubgrab").setLevel(logging.INFO)

UNEXPECTED = "Couldn't read that page right now. Try again, or add the recipe by hand."


def run(event: dict, store: Store, get_extractor: Callable[[], ai.RecipeExtractor], clock: Callable[[], float] = time.monotonic) -> None:
    household, job, link = event["householdId"], event["jobId"], event["link"]
    data = None
    # Where the time goes (reading the page, getting the AI client ready, the AI itself), logged and kept
    # with the import so a "slow" report shows it. A step that didn't happen is left out.
    timing: dict = {}
    started = last = clock()

    def lap(step: str) -> None:
        nonlocal last
        now = clock()
        timing[step] = round(now - last, 1)
        last = now

    def timed(details: dict | None) -> dict:
        timing["totalSeconds"] = round(clock() - started, 1)
        log.info(json.dumps({"event": "import_timing", **timing}))
        return {**(details or {}), "timing": timing}

    try:
        known_tags = [t for r in store.list_recipes(household) for t in r.get("tags") or []]
        # The page's own recipe data, when it has some, saves the AI reading the whole page.
        data = page.recipe_data(link)
        lap("pageSeconds")
        extractor = get_extractor()  # slow the first time in a fresh container: loads the AI library
        lap("setupSeconds")
        draft, details = extractor.extract(link, known_tags, event.get("language", "en"), data)
        lap("aiSeconds")
    except ai.ExtractionError as err:
        store.finish_import_job(household, job, error=str(err), error_code=err.code, details=timed(err.details), page_data=data)
    except Exception:  # a bug or an outage: record it for the app, keep the details in the log
        log.exception("recipe import job %s failed", job)
        store.finish_import_job(household, job, error=UNEXPECTED, error_code="import_unavailable", details=timed(None), page_data=data)
    else:
        store.finish_import_job(household, job, recipe=draft, details=timed(details), page_data=data)


_store: Store | None = None
_extractor: ai.RecipeExtractor | None = None


def _get_extractor() -> ai.RecipeExtractor:
    """One per warm container, so the API key or AWS client is set up once."""
    global _extractor
    if _extractor is None:
        _extractor = ai.get_extractor()
    return _extractor


def lambda_handler(event, context):
    global _store
    if _store is None:
        _store = Store()
    run(event, _store, _get_extractor)
