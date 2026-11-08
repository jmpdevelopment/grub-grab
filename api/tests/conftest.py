import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from grubgrab.store import Store  # noqa: E402

TABLE = "grubgrab-test"
FEEDBACK_TABLE = "grubgrab-feedback-test"


@pytest.fixture(autouse=True)
def aws_env(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-west-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("TABLE_NAME", TABLE)
    monkeypatch.setenv("FEEDBACK_TABLE", FEEDBACK_TABLE)


@pytest.fixture
def table():
    """A real DynamoDB table API, served in-process by moto (the only mocked boundary)."""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="eu-west-2")
        create_feedback_table(ddb)
        yield ddb.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )


def create_feedback_table(ddb):
    """Shaped like the deployed one (infra/stack.py): kind + sk, and a byUser index."""
    return ddb.create_table(
        TableName=FEEDBACK_TABLE,
        KeySchema=[{"AttributeName": "kind", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        AttributeDefinitions=[
            {"AttributeName": "kind", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
            {"AttributeName": "userId", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "byUser",
                "KeySchema": [{"AttributeName": "userId", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
                "Projection": {"ProjectionType": "KEYS_ONLY"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@pytest.fixture
def feedback_table(table):
    return boto3.resource("dynamodb", region_name="eu-west-2").Table(FEEDBACK_TABLE)


@pytest.fixture
def store(table):
    return Store(table)
