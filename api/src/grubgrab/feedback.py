"""Problem reports and import outcomes, kept in their own table for finding out what isn't working.

Four kinds, each sent by the app with POST /feedback:
  import    someone reported a problem with a "Fill from link" result (or a failed import). The server adds
            everything it kept about that import: link, the page's recipe data, the AI's draft, model,
            prompt version, request id, tokens and cost.
  general   "Report a problem" in Settings.
  error     the app caught a crash or an unexpected error by itself (nobody had to report it).
  outcome   what happened after an import: saved unchanged, saved with edits, or abandoned. Counts only,
            so how often imports go wrong can be measured, not just what gets reported.

Reports carry the person's recent steps in the app (screens, actions, requests and errors: ids and codes,
never what they typed), the app version, languages and device. Never an email or sign-in details.
Each record has a `fingerprint` that groups the same problem (e.g. "import:bbcgoodfood.com:amounts"), and
reports have a `status` (new -> investigating -> fixed / wontfix) for triage.

Table layout: kind (partition) + sk "<ISO time>#<id>" (sort), so "import reports since May" is one query.
The byUser index finds a person's records when they delete their account.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import urlparse

from .errors import ApiError

KINDS = ("import", "general", "error", "outcome")
# What people can pick in the report panel (same codes as web/src/components/FeedbackSheet.tsx).
PROBLEMS = {
    "import": {"missing", "extra", "amounts", "names", "aisles", "tags", "title", "unread", "other"},
    "general": {"broke", "data", "slow", "idea", "other"},
}
OUTCOMES = ("unchanged", "edited", "abandoned")
KEEP_SECONDS = 365 * 24 * 3600  # a year, then the table's TTL removes them
MAX_REPORTS_PER_DAY = 20  # import and general reports, per person
MAX_ERRORS_PER_DAY = 30  # automatic error reports, per person
MAX_NOTE = 1000
MAX_MARKED = 200
MAX_JOURNEY = 100
_MAX_JOURNEY_BYTES = 40_000
_MAX_BLOB_BYTES = 40_000  # the report's edits, or an error's details
_MAX_CLIENT_BYTES = 4_000
_MAX_ITEM_BYTES = 350_000  # DynamoDB's limit is 400 KB per record


def _size(value) -> int:
    return len(json.dumps(value, default=str))


def _invalid(message: str) -> ApiError:
    return ApiError(400, "feedback_invalid", message)


def _text(value, field: str, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise _invalid(f"{field} must be text")
    return value.strip()[:limit]


def _object(value, field: str, limit: int) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise _invalid(f"{field} must be an object")
    if _size(value) > limit:
        raise ApiError(413, "feedback_too_large", f"{field} is too large")
    return value


def _choices(value, allowed: set[str]) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise _invalid("Problems must be a list of choices")
    unknown = set(value) - allowed
    if unknown:
        raise _invalid(f"Unknown problem {sorted(unknown)[0][:20]!r}")
    return sorted(set(value))


def _marked(value) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise _invalid("Marked must be a list of ingredient names")
    return [v.strip()[:200] for v in value[:MAX_MARKED]]


def _journey(value) -> list:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(e, dict) for e in value):
        raise _invalid("Journey must be a list of steps")
    steps = value[-MAX_JOURNEY:]  # the most recent
    while steps and _size(steps) > _MAX_JOURNEY_BYTES:
        steps = steps[len(steps) // 4 or 1 :]  # drop the oldest until it fits
    return steps


def domain(link: str) -> str:
    host = urlparse(link or "").hostname or ""
    return host[4:] if host.startswith("www.") else host


def _import_snapshot(job: dict, job_id: str) -> dict:
    return {
        "jobId": job_id,
        "link": job.get("link", ""),
        "domain": domain(job.get("link", "")),
        "language": job.get("language", ""),
        "status": job.get("status", ""),
        "errorCode": job.get("errorCode", ""),
        "draft": job.get("recipe"),
        "pageData": job.get("pageData"),
        "details": job.get("details") or {},
        "createdAt": job.get("createdAt"),
    }


def build(data: dict, *, user: str, household: str | None, job: dict | None, now: float) -> dict:
    """Check a report from the app and turn it into the record to store. `job` is the import it's about
    (from the store), if it names one."""
    kind = data.get("kind")
    if kind not in KINDS:
        raise _invalid(f"Unknown kind {str(kind)[:20]!r}")
    stamp = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    record_id = uuid.uuid4().hex
    record: dict = {
        "kind": kind,
        "sk": f"{stamp}#{record_id}",
        "id": record_id,
        "at": int(now),
        "expiresAt": int(now) + KEEP_SECONDS,
        "userId": user,
        "householdId": household or "",
        "client": _object(data.get("client"), "Client", _MAX_CLIENT_BYTES),
    }
    job_id = data.get("jobId") if isinstance(data.get("jobId"), str) else ""
    snapshot = _import_snapshot(job, job_id) if job else None

    if kind == "outcome":
        outcome = data.get("outcome")
        if outcome not in OUTCOMES:
            raise _invalid(f"Unknown outcome {str(outcome)[:20]!r}")
        changes = _object(data.get("changes"), "Changes", 2_000)
        if not all(isinstance(v, (int, Decimal)) and not isinstance(v, bool) for v in changes.values()):
            raise _invalid("Changes must be counts")
        record.update(outcome=outcome, changes=changes, fingerprint=f"outcome:{snapshot['domain']}:{outcome}")
        record["import"] = {k: snapshot[k] for k in ("jobId", "domain", "language", "status", "errorCode", "details")}
        return record

    record["journey"] = _journey(data.get("journey"))
    if kind == "error":
        error = _object(data.get("error"), "Error", _MAX_BLOB_BYTES)
        code = _text(error.get("code"), "Error code", 80) or "unknown"
        where = _text(error.get("where"), "Where", 80) or "app"
        record.update(
            error={"code": code, "where": where, "message": _text(error.get("message"), "Message", 500), "stack": _text(error.get("stack"), "Stack", 4000)},
            fingerprint=f"error:{code}:{where}",
        )
    else:
        problems = _choices(data.get("problems"), PROBLEMS[kind])
        if not problems:
            raise _invalid("Pick at least one problem")
        record.update(status="new", problems=problems, note=_text(data.get("note"), "Note", MAX_NOTE))
        if kind == "general":
            record["fingerprint"] = f"general:{'+'.join(problems)}"
        else:
            record.update(marked=_marked(data.get("marked")), edits=_object(data.get("edits"), "Edits", _MAX_BLOB_BYTES))
            # A report can come from an import that never started (e.g. the monthly limit), so the job is optional.
            failure = _text(data.get("errorCode"), "Error code", 80)
            if snapshot:
                record["import"] = snapshot
                failure = snapshot["errorCode"] or failure
            where = snapshot["domain"] if snapshot else "no-job"
            record["fingerprint"] = f"import:{where}:{failure or '+'.join(problems)}"
            if _size(record) > _MAX_ITEM_BYTES and snapshot:
                record["import"] = {**snapshot, "pageData": None}  # the biggest part, and the link is still there
    if _size(record) > _MAX_ITEM_BYTES:
        raise ApiError(413, "feedback_too_large", "That report is too large")
    return record


def daily_limit(kind: str) -> int:
    return MAX_ERRORS_PER_DAY if kind == "error" else MAX_REPORTS_PER_DAY
