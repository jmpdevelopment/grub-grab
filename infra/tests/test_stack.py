"""Assertions on the synthesised CloudFormation, covering the security settings."""

import json
import sys
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stack import API_BURST_LIMIT, API_RATE_LIMIT, GrubGrabStack  # noqa: E402

ENV = cdk.Environment(account="123456789012", region="eu-west-2")


def synth(**context) -> Template:
    app = cdk.App(context=context)
    return Template.from_stack(GrubGrabStack(app, "Test", env=ENV))


@pytest.fixture(scope="module")
def template() -> Template:
    return synth()


def only(template: Template, type_: str) -> dict:
    found = template.find_resources(type_)
    assert len(found) == 1, f"expected one {type_}, found {len(found)}"
    return next(iter(found.values()))["Properties"]


def refs(value) -> set[str]:
    """Logical ids referenced via Ref / Fn::GetAtt anywhere inside a value."""
    out = set()
    if isinstance(value, dict):
        if "Ref" in value:
            out.add(value["Ref"])
        if "Fn::GetAtt" in value:
            out.add(value["Fn::GetAtt"][0])
        for v in value.values():
            out |= refs(v)
    elif isinstance(value, list):
        for v in value:
            out |= refs(v)
    return out


def test_no_dependency_cycles(template):
    resources = template.to_json()["Resources"]
    graph = {
        name: (refs(r.get("Properties", {})) | set(r.get("DependsOn", []))) & resources.keys()
        for name, r in resources.items()
    }
    state: dict[str, int] = {}

    def visit(node, path):
        if state.get(node) == 1:
            raise AssertionError("Dependency cycle: " + " -> ".join(path + [node]))
        if state.get(node) == 2:
            return
        state[node] = 1
        for dep in graph[node]:
            visit(dep, path + [node])
        state[node] = 2

    for node in graph:
        visit(node, [])


# ---- 1. join attempt counters expire --------------------------------------------------


def test_table_ttl_for_join_counters(template):
    template.has_resource_properties(
        "AWS::DynamoDB::GlobalTable", {"TimeToLiveSpecification": {"AttributeName": "expiresAt", "Enabled": True}}
    )


def test_rotate_route_exists_and_requires_auth(template):
    template.has_resource_properties(
        "AWS::ApiGatewayV2::Route", {"RouteKey": "POST /household/invite", "AuthorizationType": "JWT"}
    )


def test_every_route_requires_auth(template):
    for route in template.find_resources("AWS::ApiGatewayV2::Route").values():
        assert route["Properties"]["AuthorizationType"] == "JWT", route["Properties"]["RouteKey"]


# ---- 2. throttling ------------------------------------------------------------------------


def test_api_is_throttled(template):
    stage = only(template, "AWS::ApiGatewayV2::Stage")
    assert stage["StageName"] == "$default" and stage["AutoDeploy"] is True
    assert stage["DefaultRouteSettings"] == {
        "ThrottlingRateLimit": API_RATE_LIMIT,
        "ThrottlingBurstLimit": API_BURST_LIMIT,
    }


# ---- 3. security headers ------------------------------------------------------------------


def test_security_headers(template):
    policy = only(template, "AWS::CloudFront::ResponseHeadersPolicy")["ResponseHeadersPolicyConfig"]
    sec = policy["SecurityHeadersConfig"]
    csp = json.dumps(sec["ContentSecurityPolicy"]["ContentSecurityPolicy"])
    for directive in [
        "default-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "https://*.execute-api.eu-west-2.amazonaws.com",
    ]:
        assert directive in csp
    assert "unsafe-inline" not in csp and "unsafe-eval" not in csp
    assert sec["StrictTransportSecurity"]["AccessControlMaxAgeSec"] == 365 * 24 * 3600
    assert sec["FrameOptions"]["FrameOption"] == "DENY"
    assert sec["ContentTypeOptions"]["Override"] is True
    assert sec["ReferrerPolicy"]["ReferrerPolicy"] == "strict-origin-when-cross-origin"


def test_distribution_uses_security_headers(template):
    template.has_resource_properties(
        "AWS::CloudFront::Distribution",
        {"DistributionConfig": {"DefaultCacheBehavior": {"ResponseHeadersPolicyId": {"Ref": Match.any_value()}}}},
    )


# ---- 4. localhost only in dev -------------------------------------------------------------


def _client_and_cors(template):
    client = only(template, "AWS::Cognito::UserPoolClient")
    cors = only(template, "AWS::ApiGatewayV2::Api")["CorsConfiguration"]
    return client, cors


def test_production_does_not_allow_localhost(template):
    client, cors = _client_and_cors(template)
    blob = json.dumps([client["CallbackURLs"], client["LogoutURLs"], cors["AllowOrigins"]])
    assert "localhost" not in blob
    assert len(client["CallbackURLs"]) == 1 and len(cors["AllowOrigins"]) == 1


@pytest.mark.parametrize("flag", ["true", "True", True])
def test_dev_deploy_allows_localhost(flag):
    client, cors = _client_and_cors(synth(dev=flag))
    assert "http://localhost:5173/" in client["CallbackURLs"]
    assert "http://localhost:5173/" in client["LogoutURLs"]
    assert "http://localhost:5173" in cors["AllowOrigins"]


def test_cors_is_narrow(template):
    _, cors = _client_and_cors(template)
    assert cors["AllowMethods"] == ["GET", "POST", "PUT", "PATCH", "DELETE"]
    assert cors["AllowHeaders"] == ["authorization", "content-type"]


# ---- 5. no user enumeration ---------------------------------------------------------------


def test_sign_in_does_not_reveal_accounts(template):
    client = only(template, "AWS::Cognito::UserPoolClient")
    assert client["PreventUserExistenceErrors"] == "ENABLED"
    assert client["EnableTokenRevocation"] is True
    assert client["AllowedOAuthFlows"] == ["code"]


# ---- 6. logging ---------------------------------------------------------------------------


def test_api_access_logs(template):
    stage = only(template, "AWS::ApiGatewayV2::Stage")
    settings = stage["AccessLogSettings"]
    assert refs(settings["DestinationArn"])
    fields = json.loads(settings["Format"])
    assert {"requestId", "ip", "user", "route", "status"} <= fields.keys()
    assert "Authorization" not in settings["Format"]  # never log tokens


def test_log_groups_have_retention(template):
    groups = template.find_resources("AWS::Logs::LogGroup")
    assert len(groups) == 2
    assert all(g["Properties"]["RetentionInDays"] == 90 for g in groups.values())


# ---- unchanged guarantees ----------------------------------------------------------------


def test_bucket_is_private(template):
    template.has_resource_properties(
        "AWS::S3::Bucket",
        {
            "PublicAccessBlockConfiguration": {
                "BlockPublicAcls": True,
                "BlockPublicPolicy": True,
                "IgnorePublicAcls": True,
                "RestrictPublicBuckets": True,
            }
        },
    )
