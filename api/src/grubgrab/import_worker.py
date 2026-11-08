"""Background worker for "Fill from link". The API starts it asynchronously and returns straight away;
the app polls GET /recipes/import/{id} until the job is done or failed.

It never raises: every outcome is written to the job, so the app always gets an answer, and Lambda's
automatic retry (which would call the AI and bill again) never has a reason to run. It's also turned off.
"""

from __future__ import annotations

import logging
from typing import Callable

from . import ai
from .store import Store

log = logging.getLogger()

UNEXPECTED = "Couldn't read that page right now. Try again, or add the recipe by hand."


def run(event: dict, store: Store, get_extractor: Callable[[], ai.RecipeExtractor]) -> None:
    household, job, link = event["householdId"], event["jobId"], event["link"]
    try:
        draft = get_extractor().extract(link)
    except ai.ExtractionError as err:
        store.finish_import_job(household, job, error=str(err))
    except Exception:  # a bug or an outage: record it for the app, keep the details in the log
        log.exception("recipe import job %s failed", job)
        store.finish_import_job(household, job, error=UNEXPECTED)
    else:
        store.finish_import_job(household, job, recipe=draft)


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
