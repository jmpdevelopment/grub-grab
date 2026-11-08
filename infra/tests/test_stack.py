"""Assertions on the synthesised CloudFormation, covering the security settings."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stack import (  # noqa: E402
    API_BURST_LIMIT,
    API_MAX_CONCURRENCY,
    API_RATE_LIMIT,
    DB_MAX_READS_PER_SECOND,
    DB_MAX_WRITES_PER_SECOND,
    CertificateStack,
    GrubGrabStack,
    SiteDomain,
)

ENV = cdk.Environment(account="123456789012", region="eu-west-2")


GOOGLE_ID = "1234-abc.apps.googleusercontent.com"
# Skip packaging the Lambda code (pip) in unit tests; test_pip_bundling covers it.
BASE = {"googleClientId": GOOGLE_ID, "aws:cdk:bundling-stacks": []}


def synth(**context) -> Template:
    app = cdk.App(context={**BASE, **context})
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
    assert len(groups) == 3  # API access logs, API function, sign-up function
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
    app = cdk.App(context=BASE)
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
    app = cdk.App(context=BASE)
    with pytest.raises(ValueError, match="needs its certificate"):
        GrubGrabStack(app, "NoCert", site_domain=DOMAIN, env=ENV)


# ---- sign-up approval --------------------------------------------------------------------


def functions(template: Template) -> dict[str, dict]:
    """Our Lambda functions by handler (CDK adds helper functions of its own)."""
    out = {}
    for f in template.find_resources("AWS::Lambda::Function").values():
        handler = f["Properties"].get("Handler", "")
        if handler.startswith("grubgrab."):
            out[handler] = f["Properties"]
    return out


def logical_id(template: Template, type_: str, handler: str | None = None) -> str:
    for name, r in template.find_resources(type_).items():
        if handler is None or r["Properties"].get("Handler") == handler:
            return name
    raise AssertionError(f"no {type_} {handler or ''}")


def test_new_sign_ups_go_through_the_approval_trigger(template):
    pool = only(template, "AWS::Cognito::UserPool")
    signup = logical_id(template, "AWS::Lambda::Function", "grubgrab.signup.lambda_handler")
    assert refs(pool["LambdaConfig"]["PreSignUp"]) == {signup}
    group = only(template, "AWS::Cognito::UserPoolGroup")
    assert group["GroupName"] == "admins"


def test_admin_routes_exist_and_require_sign_in(template):
    keys = {r["Properties"]["RouteKey"]: r["Properties"] for r in template.find_resources("AWS::ApiGatewayV2::Route").values()}
    for key in [
        "GET /admin/requests",
        "POST /admin/requests/decline-pending",
        "POST /admin/requests/{username}/approve",
        "POST /admin/requests/{username}/decline",
    ]:
        assert keys[key]["AuthorizationType"] == "JWT"


def test_spend_caps(template):
    fns = functions(template)
    assert fns["grubgrab.handler.lambda_handler"]["ReservedConcurrentExecutions"] == API_MAX_CONCURRENCY
    assert fns["grubgrab.signup.lambda_handler"]["ReservedConcurrentExecutions"] == 2
    assert fns["grubgrab.signup.lambda_handler"]["Timeout"] <= 5  # Cognito's limit for triggers
    table = only(template, "AWS::DynamoDB::GlobalTable")
    assert table["WriteOnDemandThroughputSettings"] == {"MaxWriteRequestUnits": DB_MAX_WRITES_PER_SECOND}
    assert table["Replicas"][0]["ReadOnDemandThroughputSettings"] == {"MaxReadRequestUnits": DB_MAX_READS_PER_SECOND}


def test_no_email_alerts_without_an_address(template):
    assert template.find_resources("AWS::SNS::Topic") == {}
    assert template.find_resources("AWS::Budgets::Budget") == {}
    assert "TOPIC_ARN" not in json.dumps(functions(template)["grubgrab.signup.lambda_handler"])


@pytest.mark.parametrize("budget, expected", [(None, 5), ("12.5", 12.5)])
def test_email_alerts_for_sign_ups_and_the_monthly_bill(budget, expected):
    context = {"notifyEmail": " me@example.com "}
    if budget:
        context["monthlyBudgetUsd"] = budget
    t = synth(**context)
    topic = logical_id(t, "AWS::SNS::Topic")
    t.has_resource_properties("AWS::SNS::Subscription", {"Protocol": "email", "Endpoint": "me@example.com"})
    signup = functions(t)["grubgrab.signup.lambda_handler"]
    assert refs(signup["Environment"]["Variables"]["TOPIC_ARN"]) == {topic}
    policy = json.dumps(t.find_resources("AWS::SNS::TopicPolicy"))
    assert "aws:SecureTransport" in policy  # publishing only over TLS

    budget_props = only(t, "AWS::Budgets::Budget")
    assert budget_props["Budget"]["BudgetLimit"] == {"Amount": expected, "Unit": "USD"}
    assert budget_props["Budget"]["TimeUnit"] == "MONTHLY"
    alerts = {(n["Notification"]["NotificationType"], n["Notification"]["Threshold"]) for n in budget_props["NotificationsWithSubscribers"]}
    assert alerts == {("ACTUAL", 80), ("FORECASTED", 100)}
    assert all(n["Subscribers"] == [{"Address": "me@example.com", "SubscriptionType": "EMAIL"}] for n in budget_props["NotificationsWithSubscribers"])
    test_no_dependency_cycles(t)


# ---- account deletion and the privacy page ---------------------------------------------------


def policy_actions(template: Template, role_prefix: str) -> list[dict]:
    for name, r in template.find_resources("AWS::IAM::Policy").items():
        if name.startswith(role_prefix):
            return r["Properties"]["PolicyDocument"]["Statement"]
    raise AssertionError(role_prefix)


def test_api_may_only_delete_users_from_its_own_pool(template):
    cognito = [s for s in policy_actions(template, "ApiFnServiceRole") if "cognito" in json.dumps(s["Action"])]
    assert len(cognito) == 1
    assert cognito[0]["Action"] == "cognito-idp:AdminDeleteUser"
    assert refs(cognito[0]["Resource"]) == {logical_id(template, "AWS::Cognito::UserPool")}
    signup_actions = json.dumps([s["Action"] for s in policy_actions(template, "SignupFnServiceRole")])
    assert "cognito" not in signup_actions
    env = functions(template)["grubgrab.handler.lambda_handler"]["Environment"]["Variables"]
    assert refs(env["USER_POOL_ID"]) == {logical_id(template, "AWS::Cognito::UserPool")}


def test_delete_account_route_requires_sign_in(template):
    template.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": "DELETE /me", "AuthorizationType": "JWT"})


def test_privacy_page_gets_the_contact_address_at_deploy_time():
    from stack import ROOT, privacy_page

    template = (ROOT / "web" / "legal" / "privacy.html").read_text()
    assert "{{CONTACT_EMAIL}}" in template and "@" not in template.split("<body>")[1].replace("mailto:", "")  # no address in the repo
    page = privacy_page("me@example.com")
    assert "{{" not in page and page.count("me@example.com") == 4  # two mailto links, two visible
    assert 'href="mailto:a&amp;b@x.com"' in privacy_page("a&b@x.com")  # escaped
    assert "the app&#x27;s administrator" in privacy_page("")
    for required in ["Google API Services User Data Policy", "Limited Use", "Delete my account", "London", "Anthropic", "never sent to an AI model"]:
        assert required in page


def test_contact_address_can_differ_from_the_notification_address():
    synth(notifyEmail="alerts@example.com", contactEmail="privacy@example.com")  # synthesises cleanly



# ---- AI recipe import ----------------------------------------------------------------------


def test_ai_import_is_off_unless_configured(template):
    env = functions(template)["grubgrab.handler.lambda_handler"]["Environment"]["Variables"]
    assert not any(k.startswith("AI_") or k.startswith("ANTHROPIC") for k in env)
    assert "secretsmanager" not in json.dumps(policy_actions(template, "ApiFnServiceRole"))
    template.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": "POST /recipes/import", "AuthorizationType": "JWT"})


@pytest.mark.parametrize(
    "context, expected",
    [
        ({"aiProvider": "anthropic"}, {"AI_MODEL": "claude-opus-5-5", "AI_EFFORT": "low", "limit": "20"}),
        (
            {"aiProvider": "anthropic", "aiModel": "claude-sonnet-5-5", "aiEffort": "medium", "aiMonthlyLimit": 100},
            {"AI_MODEL": "claude-sonnet-5-5", "AI_EFFORT": "medium", "limit": "100"},
        ),
    ],
)
def test_ai_import_runs_in_a_background_worker_that_alone_holds_the_key(context, expected):
    t = synth(**context)
    fns = functions(t)
    api_env = fns["grubgrab.handler.lambda_handler"]["Environment"]["Variables"]
    worker = fns["grubgrab.import_worker.lambda_handler"]
    worker_env = worker["Environment"]["Variables"]
    worker_id = logical_id(t, "AWS::Lambda::Function", "grubgrab.import_worker.lambda_handler")

    # The API checks the allowance and starts the worker; it can't reach the AI or its key.
    assert api_env["AI_PROVIDER"] == "anthropic" and api_env["AI_MONTHLY_LIMIT"] == expected["limit"]
    assert refs(api_env["IMPORT_WORKER_NAME"]) == {worker_id}
    assert "ANTHROPIC_SECRET_NAME" not in api_env and "AI_MODEL" not in api_env
    api_policy = policy_actions(t, "ApiFnServiceRole")
    assert "secretsmanager" not in json.dumps(api_policy)
    invoke = [s for s in api_policy if s["Action"] == "lambda:InvokeFunction"]
    assert len(invoke) == 1 and refs(invoke[0]["Resource"]) == {worker_id}

    # The worker: the model settings and read access to that one secret.
    assert {k: worker_env[k] for k in ("AI_MODEL", "AI_EFFORT")} == {k: expected[k] for k in ("AI_MODEL", "AI_EFFORT")}
    assert worker_env["ANTHROPIC_SECRET_NAME"] == "grubgrab/anthropic-api-key"
    secret = [s for s in policy_actions(t, "ImportWorkerFnServiceRole") if "secretsmanager" in json.dumps(s["Action"])]
    assert sorted(secret[0]["Action"]) == ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    assert "secret:grubgrab/anthropic-api-key-??????" in json.dumps(secret[0]["Resource"])  # that one secret only
    assert "secretsmanager" not in json.dumps(policy_actions(t, "SignupFnServiceRole"))

    # Room for a slow page, but bounded: two at a time, and a failure is never retried (it would bill twice).
    assert worker["Timeout"] == 200 and worker["ReservedConcurrentExecutions"] == 2
    invoke_config = only(t, "AWS::Lambda::EventInvokeConfig")
    assert invoke_config["MaximumRetryAttempts"] == 0 and refs(invoke_config["FunctionName"]) == {worker_id}
    t.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": "GET /recipes/import/{id}", "AuthorizationType": "JWT"})
    assert len(t.find_resources("AWS::Logs::LogGroup")) == 4
    test_no_dependency_cycles(t)


def test_claude_platform_on_aws_needs_no_key_only_its_workspace():
    t = synth(aiProvider="anthropic-aws", anthropicAwsWorkspaceId="wrkspc_01Test")
    env = functions(t)["grubgrab.import_worker.lambda_handler"]["Environment"]["Variables"]
    assert env["AI_PROVIDER"] == "anthropic-aws" and env["ANTHROPIC_AWS_WORKSPACE_ID"] == "wrkspc_01Test"
    assert "ANTHROPIC_SECRET_NAME" not in env
    statements = policy_actions(t, "ImportWorkerFnServiceRole")
    assert "secretsmanager" not in json.dumps(statements)
    inference = [s for s in statements if s["Action"] == "aws-external-anthropic:CreateInference"]
    assert len(inference) == 1
    assert inference[0]["Resource"] == "arn:aws:aws-external-anthropic:eu-west-2:123456789012:workspace/wrkspc_01Test"
    tokens = [s for s in statements if "sts:GetWebIdentityToken" in json.dumps(s["Action"])]
    assert tokens[0]["Action"] == ["sts:GetWebIdentityToken", "sts:TagGetWebIdentityToken"]
    for role in ("ApiFnServiceRole", "SignupFnServiceRole"):
        assert "aws-external-anthropic" not in json.dumps(policy_actions(t, role))


@pytest.mark.parametrize(
    "context, message",
    [
        ({"aiProvider": "anthropic-aws"}, "needs anthropicAwsWorkspaceId"),
        ({"aiProvider": "gemini"}, "Unknown aiProvider 'gemini'"),
    ],
)
def test_ai_provider_settings_are_checked(context, message):
    with pytest.raises(ValueError, match=message):
        synth(**context)


def test_pip_bundling(tmp_path):
    from stack import API_REQUIREMENTS, PipBundling

    commands = []

    def ok(command, check):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    assert PipBundling(run=ok).try_bundle(str(tmp_path)) is True
    command = commands[0]
    assert command[1:4] == ["-m", "pip", "install"] and str(API_REQUIREMENTS) in command
    for flag in ["--platform", "manylinux2014_aarch64", "--python-version", "3.13", "--only-binary=:all:", str(tmp_path)]:
        assert flag in command
    assert (tmp_path / "grubgrab" / "handler.py").exists() and (tmp_path / "grubgrab" / "ai" / "recipe.py").exists()
    assert not list(tmp_path.rglob("__pycache__"))

    failed = PipBundling(run=lambda command, check: subprocess.CompletedProcess(command, 1))
    assert failed.try_bundle(str(tmp_path / "other")) is False  # CDK then builds it in Docker


def test_requirements_pin_the_sdk_major():
    from stack import API_REQUIREMENTS

    assert "anthropic>=2.6,<3" in API_REQUIREMENTS.read_text()


# ---- extra domains that redirect to the site ------------------------------------------------------


def redirect_template() -> Template:
    from stack import RedirectStack

    app = cdk.App(context=BASE)
    stack = RedirectStack(
        app,
        "TestRedirects",
        target="https://grubgrab.example",
        domains=[SiteDomain("redirect.example", "ZREDIRECT")],
        env=cdk.Environment(account=ENV.account, region="us-east-1"),
    )
    return Template.from_stack(stack)


def test_redirect_domains_get_a_certificate_and_dns_for_the_name_and_its_www():
    t = redirect_template()
    cert = only(t, "AWS::CertificateManager::Certificate")
    assert cert["DomainName"] == "redirect.example" and cert["SubjectAlternativeNames"] == ["www.redirect.example"]
    assert cert["ValidationMethod"] == "DNS"
    assert {o["HostedZoneId"] for o in cert["DomainValidationOptions"]} == {"ZREDIRECT"}
    records = [r["Properties"] for r in t.find_resources("AWS::Route53::RecordSet").values()]
    assert sorted((r["Name"], r["Type"]) for r in records) == [
        ("redirect.example.", "A"),
        ("redirect.example.", "AAAA"),
        ("www.redirect.example.", "A"),
        ("www.redirect.example.", "AAAA"),
    ]
    assert all(r["HostedZoneId"] == "ZREDIRECT" and "AliasTarget" in r for r in records)


def test_the_redirect_distribution_only_answers_with_the_redirect():
    t = redirect_template()
    config = only(t, "AWS::CloudFront::Distribution")["DistributionConfig"]
    assert config["Aliases"] == ["redirect.example", "www.redirect.example"]
    behaviour = config["DefaultCacheBehavior"]
    assert behaviour["ViewerProtocolPolicy"] == "allow-all"  # http:// reaches the redirect in one hop
    assert behaviour["CachePolicyId"] == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"  # caching disabled
    assert [a["EventType"] for a in behaviour["FunctionAssociations"]] == ["viewer-request"]
    function = only(t, "AWS::CloudFront::Function")
    assert function["FunctionConfig"]["Runtime"] == "cloudfront-js-2.0"
    assert function["FunctionCode"].startswith('var TARGET = "https://grubgrab.example";')


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node to run the CloudFront Function")
@pytest.mark.parametrize(
    "uri, querystring, location",
    [
        ("/", {}, "https://grubgrab.example/"),
        ("/privacy.html", {}, "https://grubgrab.example/privacy.html"),
        ("/", {"code": {"value": "abc"}, "state": {"value": "x"}}, "https://grubgrab.example/?code=abc&state=x"),
        ("/a", {"t": {"value": "1", "multiValue": [{"value": "1"}, {"value": "2"}]}, "flag": {"value": ""}}, "https://grubgrab.example/a?t=1&t=2&flag"),
    ],
)
def test_the_redirect_keeps_the_path_and_query(uri, querystring, location):
    from stack import REDIRECT_FUNCTION

    script = (
        'var TARGET = "https://grubgrab.example";'
        + REDIRECT_FUNCTION
        + f"console.log(JSON.stringify(handler({{request: {{uri: {json.dumps(uri)}, querystring: {json.dumps(querystring)}}}}})));"
    )
    response = json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)
    assert response["statusCode"] == 301
    assert response["headers"]["location"]["value"] == location


def test_redirect_domain_settings_are_checked():
    from stack import redirect_domains_from_context

    site = SiteDomain("grubgrab.example", "ZSITE")
    app = lambda **c: cdk.App(context=c)  # noqa: E731
    assert redirect_domains_from_context(app(), site) == []
    [d] = redirect_domains_from_context(app(redirectDomains=[{"domainName": " Redirect.Example. ", "hostedZoneId": "Z1"}]), site)
    assert (d.name, d.zone_id) == ("redirect.example", "Z1")
    with pytest.raises(ValueError, match="needs a domainName and a hostedZoneId"):
        redirect_domains_from_context(app(redirectDomains=[{"domainName": "redirect.example"}]), site)
    with pytest.raises(ValueError, match="need the site's own domainName"):
        redirect_domains_from_context(app(redirectDomains=[{"domainName": "redirect.example", "hostedZoneId": "Z1"}]), None)


def test_site_is_served_from_europe_and_north_america_edges_only(template):
    assert only(template, "AWS::CloudFront::Distribution")["DistributionConfig"]["PriceClass"] == "PriceClass_100"
