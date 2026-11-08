import json

import boto3
import pytest

from grubgrab import signup
from grubgrab.signup import DECLINED, PENDING, AccessDenied, handle
from grubgrab.store import NOTIFY_EVERY_SECONDS, Store


def first_sign_in(username="Google_111", email="New.Person@Gmail.com", name="New Person", source="PreSignUp_ExternalProvider"):
    attrs = {"email": email, "name": name} if email is not None else {}
    return {"triggerSource": source, "userName": username, "request": {"userAttributes": attrs}, "response": {}}


@pytest.fixture
def clock():
    return [1_000_000.0]


@pytest.fixture
def store(table, clock):
    return Store(table, clock=lambda: clock[0])


@pytest.fixture
def sent():
    return []


def attempt(store, sent, **kwargs):
    with pytest.raises(AccessDenied) as exc:
        handle(first_sign_in(**kwargs), store, lambda email, name: sent.append((email, name)))
    return str(exc.value)


class TestSignUpApproval:
    def test_a_new_person_is_held_for_approval_and_you_are_told_once(self, store, sent):
        assert attempt(store, sent) == PENDING
        assert sent == [("new.person@gmail.com", "New Person")]
        assert store.access_requests() == [
            {"username": "Google_111", "email": "new.person@gmail.com", "name": "New Person", "requestedAt": 1_000_000}
        ]
        assert attempt(store, sent) == PENDING  # trying again: still waiting, no second email
        assert len(sent) == 1

    def test_at_most_one_email_an_hour_however_many_ask(self, store, sent, clock):
        for n in range(5):
            attempt(store, sent, username=f"Google_{n}", email=f"bot{n}@example.com")
        assert len(sent) == 1 and len(store.access_requests()) == 5
        clock[0] += NOTIFY_EVERY_SECONDS + 1
        attempt(store, sent, username="Google_late", email="late@example.com")
        assert len(sent) == 2

    def test_approved_people_get_in(self, store, sent):
        attempt(store, sent)
        store.decide_access("Google_111", approve=True)
        event = first_sign_in()
        assert handle(event, store, lambda *_: sent.append("x")) is event  # Cognito goes ahead and creates the account
        assert store.access_requests() == []

    def test_declined_people_stay_out(self, store, sent):
        attempt(store, sent)
        store.decide_access("Google_111", approve=False)
        assert attempt(store, sent) == DECLINED

    def test_only_google_sign_in_is_allowed(self, store, sent):
        assert attempt(store, sent, source="PreSignUp_SignUp") == DECLINED
        assert store.access_requests() == [] and sent == []

    def test_missing_profile_details(self, store, sent):
        assert attempt(store, sent, email=None) == PENDING
        assert store.access_requests()[0]["email"] == "" and sent == [("", "")]
        event = {"triggerSource": "PreSignUp_ExternalProvider", "userName": "Google_222", "request": None}
        with pytest.raises(AccessDenied):
            handle(event, store, lambda *_: None)


class TestLambdaHandler:
    def test_emails_the_admin_through_sns(self, table, monkeypatch):
        sns, sqs = boto3.client("sns"), boto3.client("sqs")
        topic = sns.create_topic(Name="grubgrab")["TopicArn"]
        queue = sqs.create_queue(QueueName="inbox")["QueueUrl"]
        queue_arn = sqs.get_queue_attributes(QueueUrl=queue, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        sns.subscribe(TopicArn=topic, Protocol="sqs", Endpoint=queue_arn)
        monkeypatch.setenv("TOPIC_ARN", topic)
        monkeypatch.setattr(signup, "_store", None)

        with pytest.raises(AccessDenied, match=PENDING):
            signup.lambda_handler(first_sign_in(), None)
        message = json.loads(sqs.receive_message(QueueUrl=queue)["Messages"][0]["Body"])
        assert message["Subject"] == "Grub Grab: someone asked to join"
        assert "New Person <new.person@gmail.com> asked to join" in message["Message"]

        cached = signup._store
        with pytest.raises(AccessDenied):
            signup.lambda_handler(first_sign_in(username="Google_2", email="x@example.com", name=""), None)
        assert signup._store is cached

    def test_notify_without_a_name_or_a_topic(self, monkeypatch):
        monkeypatch.delenv("TOPIC_ARN", raising=False)
        signup._notify("a@example.com", "")  # no topic configured: nothing to send, no error
