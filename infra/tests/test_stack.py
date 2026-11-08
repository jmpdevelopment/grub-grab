"""Assertions on the synthesised CloudFormation, covering the security settings."""

import json
import sys
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stack import API_BURST_LIMIT, API_RATE_LIMIT, CertificateStack, GrubGrabStack, SiteDomain  # noqa: E402

ENV = cdk.Environment(account="123456789012", region="eu-west-2")


GOOGLE_ID = "1234-abc.apps.googleusercontent.com"


def synth(**context) -> Template:
    app = cdk.App(context={"googleClientId": GOOGLE_ID, **context})
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


# ---- Google-only sign-in ---------------------------------------------------------------


def test_google_is_the_only_sign_in_method(template):
    client = only(template, "AWS::Cognito::UserPoolClient")
    assert client["SupportedIdentityProviders"] == ["Google"]
    pool = only(template, "AWS::Cognito::UserPool")
    assert pool["AdminCreateUserConfig"]["AllowAdminCreateUserOnly"] is True  # no email/password sign-up
    assert pool["AccountRecoverySetting"]["RecoveryMechanisms"] == [{"Name": "admin_only", "Priority": 1}]


def test_google_provider(template):
    idp = only(template, "AWS::Cognito::UserPoolIdentityProvider")
    assert idp["ProviderName"] == "Google" and idp["ProviderType"] == "Google"
    details = idp["ProviderDetails"]
    assert details["client_id"] == GOOGLE_ID
    assert details["authorize_scopes"] == "openid email profile"
    assert idp["AttributeMapping"] == {"email": "email", "email_verified": "email_verified", "name": "name"}


def test_google_secret_comes_from_secrets_manager_not_the_template(template):
    secret = json.dumps(only(template, "AWS::Cognito::UserPoolIdentityProvider")["ProviderDetails"]["client_secret"])
    assert "{{resolve:secretsmanager:grubgrab/google-client-secret" in secret


def test_client_waits_for_google_provider(template):
    clients = template.find_resources("AWS::Cognito::UserPoolClient")
    idp_id = next(iter(template.find_resources("AWS::Cognito::UserPoolIdentityProvider")))
    assert idp_id in next(iter(clients.values()))["DependsOn"]


def test_redirect_uri_output(template):
    out = template.to_json()["Outputs"]["GoogleRedirectUri"]
    assert "/oauth2/idpresponse" in json.dumps(out["Value"])


@pytest.mark.parametrize("value", [None, "", "   "])
def test_requires_google_client_id(value):
    with pytest.raises(Exception, match="Missing Google OAuth client ID"):
        synth(googleClientId=value)


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


# ---- custom domain ------------------------------------------------------------------------

DOMAIN = SiteDomain("grubgrab.example", "Z0123456789ABCDEFGHIJ")


def synth_with_domain() -> tuple[Template, Template]:
    app = cdk.App(context={"googleClientId": GOOGLE_ID})
    cert = CertificateStack(
        app,
        "TestCert",
        site_domain=DOMAIN,
        env=cdk.Environment(account=ENV.account, region="us-east-1"),
        cross_region_references=True,
    )
    main = GrubGrabStack(
        app, "TestDomain", site_domain=DOMAIN, certificate=cert.certificate, env=ENV, cross_region_references=True
    )
    return Template.from_stack(cert), Template.from_stack(main)


@pytest.fixture(scope="module")
def domain_templates() -> tuple[Template, Template]:
    return synth_with_domain()


def test_certificate_is_dns_validated_in_us_east_1(domain_templates):
    cert, _ = domain_templates
    props = only(cert, "AWS::CertificateManager::Certificate")
    assert props["DomainName"] == "grubgrab.example"
    assert props["ValidationMethod"] == "DNS"
    assert props["DomainValidationOptions"] == [{"DomainName": "grubgrab.example", "HostedZoneId": DOMAIN.zone_id}]


def test_distribution_serves_the_custom_domain(domain_templates):
    _, main = domain_templates
    config = only(main, "AWS::CloudFront::Distribution")["DistributionConfig"]
    assert config["Aliases"] == ["grubgrab.example"]
    assert config["ViewerCertificate"]["SslSupportMethod"] == "sni-only"


def test_dns_points_at_cloudfront(domain_templates):
    _, main = domain_templates
    records = [r["Properties"] for r in main.find_resources("AWS::Route53::RecordSet").values()]
    assert sorted(r["Type"] for r in records) == ["A", "AAAA"]
    for r in records:
        assert r["Name"] == "grubgrab.example."
        assert r["HostedZoneId"] == DOMAIN.zone_id
        assert "AliasTarget" in r


def test_sign_in_and_cors_use_the_custom_domain(domain_templates):
    _, main = domain_templates
    client, cors = _client_and_cors(main)
    assert client["CallbackURLs"] == ["https://grubgrab.example/"]
    assert client["LogoutURLs"] == ["https://grubgrab.example/"]
    assert cors["AllowOrigins"] == ["https://grubgrab.example"]
    assert main.to_json()["Outputs"]["SiteUrl"]["Value"] == "https://grubgrab.example/"


def test_custom_domain_stack_has_no_cycles(domain_templates):
    test_no_dependency_cycles(domain_templates[1])


def test_no_dns_records_without_a_domain(template):
    assert template.find_resources("AWS::Route53::RecordSet") == {}
    assert "Aliases" not in only(template, "AWS::CloudFront::Distribution")["DistributionConfig"]


@pytest.mark.parametrize(
    "context, expected",
    [
        ({}, None),
        ({"domainName": "", "hostedZoneId": ""}, None),
        ({"domainName": " GrubGrab.Example. ", "hostedZoneId": " Z1 "}, ("grubgrab.example", "Z1")),
    ],
)
def test_site_domain_from_context(context, expected):
    domain = SiteDomain.from_context(cdk.App(context=context))
    assert (domain and (domain.name, domain.zone_id)) == expected


@pytest.mark.parametrize("context", [{"domainName": "grubgrab.example"}, {"hostedZoneId": "Z1"}])
def test_site_domain_needs_both_settings(context):
    with pytest.raises(ValueError, match="both domainName and hostedZoneId"):
        SiteDomain.from_context(cdk.App(context=context))


def test_domain_and_certificate_go_together(domain_templates):
    app = cdk.App(context={"googleClientId": GOOGLE_ID})
    with pytest.raises(ValueError, match="needs its certificate"):
        GrubGrabStack(app, "NoCert", site_domain=DOMAIN, env=ENV)
