"""Cognito pre sign-up trigger: new people need an admin's approval before an account is created.

Runs on someone's first Google sign-in only (existing users are never checked again). Until approved,
the sign-in is refused, so they never get a token and can't reach the API. The app turns these error
codes into friendly messages.
"""

from __future__ import annotations

import os
from typing import Callable

import boto3

from .store import Store

PENDING = "ACCESS_PENDING"
DECLINED = "ACCESS_DECLINED"


class AccessDenied(Exception):
    """Cognito shows the message to the app as "PreSignUp failed with error <message>."."""


def handle(event: dict, store: Store, notify: Callable[[str, str], None]) -> dict:
    if event.get("triggerSource") != "PreSignUp_ExternalProvider":
        raise AccessDenied(DECLINED)  # Google is the only way in; email/password sign-up is off anyway
    attrs = (event.get("request") or {}).get("userAttributes") or {}
    email = (attrs.get("email") or "").strip().lower()
    name = (attrs.get("name") or "").strip()
    status, is_new = store.request_access(event["userName"], email, name)
    if status == "approved":
        return event
    if is_new and store.claim_notification():
        notify(email, name)
    raise AccessDenied(PENDING if status == "pending" else DECLINED)


def _notify(email: str, name: str) -> None:
    topic = os.environ.get("TOPIC_ARN")
    if not topic:
        return
    who = f"{name} <{email}>" if name else email
    boto3.client("sns").publish(
        TopicArn=topic,
        Subject="Grub Grab: someone asked to join",
        Message=(
            f"{who} asked to join Grub Grab.\n\n"
            "Open Grub Grab > Settings > Sign-up requests to approve or decline.\n"
            "(You get at most one of these emails an hour, however many requests arrive.)"
        ),
    )


_store: Store | None = None


def lambda_handler(event, context):
    global _store
    if _store is None:
        _store = Store()
    return handle(event, _store, _notify)
