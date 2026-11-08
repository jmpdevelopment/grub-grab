import html
import json
import shutil
import subprocess
import sys
from pathlib import Path

import jsii
from aws_cdk import BundlingOptions, CfnOutput, DockerImage, Duration, ILocalBundling, RemovalPolicy, SecretValue, Stack
from aws_cdk import aws_apigatewayv2 as apigw
from aws_cdk import aws_apigatewayv2_authorizers as authorizers
from aws_cdk import aws_apigatewayv2_integrations as integrations
from aws_cdk import aws_budgets as budgets
from aws_cdk import aws_certificatemanager as acm
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_route53 as route53
from aws_cdk import aws_route53_targets as targets
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3deploy
from aws_cdk import aws_secretsmanager as secretsmanager
from aws_cdk import aws_sns as sns
from aws_cdk import aws_sns_subscriptions as subscriptions
from constructs import Construct

ROOT = Path(__file__).resolve().parents[1]
LOCAL_DEV_URL = "http://localhost:5173/"

# API-wide limits. Two phones polling every 8s use well under 1 request/second, so this leaves
# plenty of headroom while capping the worst-case bill if a signed-up account is abused.
API_RATE_LIMIT = 10  # steady requests per second
API_BURST_LIMIT = 20
LOG_RETENTION = logs.RetentionDays.THREE_MONTHS

# Spend caps. Even an approved account that's been taken over can't run up more than a few dollars a day:
# the database refuses work beyond these rates, and at most this many copies of the API run at once.
DB_MAX_WRITES_PER_SECOND = 100
DB_MAX_READS_PER_SECOND = 300
API_MAX_CONCURRENCY = 5
SIGNUP_MAX_CONCURRENCY = 2
DEFAULT_MONTHLY_BUDGET_USD = 5
# AI recipe import ("Fill from link"). Off unless aiProvider is set; the API key lives in Secrets Manager.
ANTHROPIC_SECRET_NAME = "grubgrab/anthropic-api-key"
DEFAULT_AI_MODEL = "claude-opus-5-5"
DEFAULT_AI_EFFORT = "low"
DEFAULT_AI_MONTHLY_LIMIT = 20
IMPORT_WORKER_TIMEOUT = Duration.seconds(200)  # a slow page can take a while; well past API Gateway's 30 s
IMPORT_WORKER_MAX_CONCURRENCY = 2
ADMIN_GROUP = "admins"  # must match api/src/grubgrab/handler.py

# Google sign-in. The client ID goes in settings.local.json (git-ignored) or `-c googleClientId=...`.
# The client secret lives in Secrets Manager, never in the repo.
GOOGLE_SECRET_NAME = "grubgrab/google-client-secret"


API_SRC = ROOT / "api" / "src"
API_REQUIREMENTS = ROOT / "api" / "requirements.txt"


@jsii.implements(ILocalBundling)
class PipBundling:
    """Package the API code with its Python dependencies (the Anthropic SDK) for Lambda, without Docker:
    pip downloads the wheels built for Lambda's Linux on ARM and Python 3.13."""

    def __init__(self, run=subprocess.run):
        self._run = run

    def try_bundle(self, output_dir: str, *args, **kwargs) -> bool:
        command = [
            sys.executable, "-m", "pip", "install", "--quiet", "--no-compile",
            "--requirement", str(API_REQUIREMENTS), "--target", output_dir,
            "--platform", "manylinux2014_aarch64", "--implementation", "cp", "--python-version", "3.13",
            "--only-binary=:all:", "--upgrade",
        ]  # fmt: skip
        if self._run(command, check=False).returncode != 0:
            return False  # fall back to building in the Lambda Docker image
        shutil.copytree(API_SRC, output_dir, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
        return True


def api_code() -> lambda_.Code:
    return lambda_.Code.from_asset(
        str(API_SRC.parent),  # api/: the asset hash changes when the code or requirements.txt change
        exclude=["*", "!src", "!src/**", "!requirements.txt", "**/__pycache__"],
        bundling=BundlingOptions(
            image=DockerImage.from_registry("public.ecr.aws/sam/build-python3.13:latest-arm64"),
            platform="linux/arm64",
            local=PipBundling(),
            command=["bash", "-c", "pip install -r requirements.txt -t /asset-output && cp -r src/. /asset-output"],
        ),
    )


def privacy_page(contact_email: str) -> str:
    """The privacy policy, with the contact address filled in at deploy time so it stays out of the repo."""
    template = (ROOT / "web" / "legal" / "privacy.html").read_text()
    return template.replace("{{CONTACT_EMAIL}}", html.escape(contact_email or "the app's administrator", quote=True))


class SiteDomain:
    """Optional custom domain for the site, e.g. grubgrab.example, in a Route 53 hosted zone in this account.

    Set `domainName` and `hostedZoneId` in settings.local.json (or pass both with -c). The zone ID is given rather
    than looked up, so synth needs no AWS credentials. Leave both empty to use the CloudFront URL.
    """

    def __init__(self, name: str, zone_id: str) -> None:
        self.name = name
        self.zone_id = zone_id

    @classmethod
    def from_context(cls, scope: Construct) -> "SiteDomain | None":
        name = (scope.node.try_get_context("domainName") or "").strip().lower().rstrip(".")
        zone_id = (scope.node.try_get_context("hostedZoneId") or "").strip()
        if bool(name) != bool(zone_id):
            raise ValueError("Set both domainName and hostedZoneId for a custom domain, or neither.")
        return cls(name, zone_id) if name else None

    def zone(self, scope: Construct) -> route53.IHostedZone:
        return route53.HostedZone.from_hosted_zone_attributes(
            scope, "Zone", hosted_zone_id=self.zone_id, zone_name=self.name
        )


class CertificateStack(Stack):
    """TLS certificate for the custom domain. CloudFront only accepts certificates from us-east-1."""

    def __init__(self, scope: Construct, construct_id: str, *, site_domain: SiteDomain, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        self.certificate = acm.Certificate(
            self,
            "Certificate",
            domain_name=site_domain.name,
            validation=acm.CertificateValidation.from_dns(site_domain.zone(self)),
        )


class GrubGrabStack(Stack):
    """Deploy with `cdk deploy --all`. Add `-c dev=true` to also allow http://localhost:5173 for local development."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        site_domain: SiteDomain | None = None,
        certificate: acm.ICertificate | None = None,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)
        if bool(site_domain) != bool(certificate):
            raise ValueError("A custom domain needs its certificate (and vice versa).")
        dev = str(self.node.try_get_context("dev")).lower() == "true"
        google_client_id = (self.node.try_get_context("googleClientId") or "").strip()
        if not google_client_id:
            raise ValueError(
                "Missing Google OAuth client ID. Add it to infra/settings.local.json (copy "
                "settings.local.example.json) or pass -c googleClientId=... (see README: 'Google sign-in')."
            )

        # ---- data ---------------------------------------------------------------
        table = dynamodb.TableV2(
            self,
            "Table",
            partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(
                max_read_request_units=DB_MAX_READS_PER_SECOND, max_write_request_units=DB_MAX_WRITES_PER_SECOND
            ),
            time_to_live_attribute="expiresAt",  # clears old join-attempt counters
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            removal_policy=RemovalPolicy.RETAIN,  # don't lose recipes on `cdk destroy`
        )

        # ---- auth -----------------------------------------------------------------
        # Google is the only way in: no passwords, no self-service email sign-up.
        # (Federated users are still created automatically on their first Google sign-in.)
        user_pool = cognito.UserPool(
            self,
            "Users",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            account_recovery=cognito.AccountRecovery.NONE,  # nothing to recover; Google handles that
            removal_policy=RemovalPolicy.RETAIN,
        )
        google = cognito.UserPoolIdentityProviderGoogle(
            self,
            "Google",
            user_pool=user_pool,
            client_id=google_client_id,
            client_secret_value=SecretValue.secrets_manager(GOOGLE_SECRET_NAME),
            scopes=["openid", "email", "profile"],
            attribute_mapping=cognito.AttributeMapping(
                email=cognito.ProviderAttribute.GOOGLE_EMAIL,
                email_verified=cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
                fullname=cognito.ProviderAttribute.GOOGLE_NAME,
            ),
        )
        domain = user_pool.add_domain(
            "Domain",
            cognito_domain=cognito.CognitoDomainOptions(domain_prefix=f"grubgrab-{self.account}"),
        )

        # ---- API ------------------------------------------------------------------
        # ---- sign-up approval ---------------------------------------------------------
        # New people's first Google sign-in is held until an admin approves it (see api/src/grubgrab/signup.py).
        notify_email = (self.node.try_get_context("notifyEmail") or "").strip()
        contact_email = (self.node.try_get_context("contactEmail") or "").strip() or notify_email  # privacy page
        code = api_code()
        signup_fn = lambda_.Function(
            self,
            "SignupFn",
            runtime=lambda_.Runtime.PYTHON_3_13,
            architecture=lambda_.Architecture.ARM_64,
            handler="grubgrab.signup.lambda_handler",
            code=code,
            memory_size=128,
            timeout=Duration.seconds(5),  # Cognito gives triggers 5 seconds
            reserved_concurrent_executions=SIGNUP_MAX_CONCURRENCY,
            environment={"TABLE_NAME": table.table_name},
            log_group=logs.LogGroup(self, "SignupFnLogs", retention=LOG_RETENTION, removal_policy=RemovalPolicy.DESTROY),
        )
        table.grant_read_write_data(signup_fn)
        user_pool.add_trigger(cognito.UserPoolOperation.PRE_SIGN_UP, signup_fn)
        cognito.CfnUserPoolGroup(
            self,
            "Admins",
            user_pool_id=user_pool.user_pool_id,
            group_name=ADMIN_GROUP,
            description="Can approve or decline sign-up requests",
        )

        # ---- alerts: new sign-up requests and the monthly bill -------------------------
        if notify_email:
            topic = sns.Topic(self, "Notifications", display_name="Grub Grab", enforce_ssl=True)
            topic.add_subscription(subscriptions.EmailSubscription(notify_email))
            topic.grant_publish(signup_fn)
            signup_fn.add_environment("TOPIC_ARN", topic.topic_arn)
            budget_usd = float(self.node.try_get_context("monthlyBudgetUsd") or DEFAULT_MONTHLY_BUDGET_USD)

            def alert(kind: str, percent: int):
                return budgets.CfnBudget.NotificationWithSubscribersProperty(
                    notification=budgets.CfnBudget.NotificationProperty(
                        comparison_operator="GREATER_THAN", notification_type=kind, threshold=percent, threshold_type="PERCENTAGE"
                    ),
                    subscribers=[budgets.CfnBudget.SubscriberProperty(address=notify_email, subscription_type="EMAIL")],
                )

            budgets.CfnBudget(
                self,
                "MonthlyBudget",
                budget=budgets.CfnBudget.BudgetDataProperty(
                    budget_name="grubgrab-monthly",
                    budget_type="COST",
                    time_unit="MONTHLY",
                    budget_limit=budgets.CfnBudget.SpendProperty(amount=budget_usd, unit="USD"),
                ),
                # Email when actual spend passes 80%, or AWS forecasts the month will go over.
                notifications_with_subscribers=[alert("ACTUAL", 80), alert("FORECASTED", 100)],
            )

        fn = lambda_.Function(
            self,
            "ApiFn",
            runtime=lambda_.Runtime.PYTHON_3_13,
            architecture=lambda_.Architecture.ARM_64,
            handler="grubgrab.handler.lambda_handler",
            code=code,
            memory_size=256,
            timeout=Duration.seconds(25),  # building a long list can be slowed by the database cap
            reserved_concurrent_executions=API_MAX_CONCURRENCY,
            environment={"TABLE_NAME": table.table_name},
            log_group=logs.LogGroup(self, "ApiFnLogs", retention=LOG_RETENTION, removal_policy=RemovalPolicy.DESTROY),
        )
        table.grant_read_write_data(fn)
        # "Fill from link": AI recipe import, provider and model chosen in settings.local.json.
        # The API only starts an import job (and checks the allowance); a separate worker does the slow AI
        # call in the background, and only the worker can reach the AI provider.
        ai_provider = (self.node.try_get_context("aiProvider") or "").strip()
        if ai_provider:
            worker = lambda_.Function(
                self,
                "ImportWorkerFn",
                runtime=lambda_.Runtime.PYTHON_3_13,
                architecture=lambda_.Architecture.ARM_64,
                handler="grubgrab.import_worker.lambda_handler",
                code=code,
                memory_size=256,
                timeout=IMPORT_WORKER_TIMEOUT,
                reserved_concurrent_executions=IMPORT_WORKER_MAX_CONCURRENCY,
                retry_attempts=0,  # a failed import is recorded, never re-run (it would call the AI and bill again)
                environment={
                    "TABLE_NAME": table.table_name,
                    "AI_PROVIDER": ai_provider,
                    "AI_MODEL": (self.node.try_get_context("aiModel") or DEFAULT_AI_MODEL).strip(),
                    "AI_EFFORT": (self.node.try_get_context("aiEffort") or DEFAULT_AI_EFFORT).strip(),
                },
                log_group=logs.LogGroup(self, "ImportWorkerFnLogs", retention=LOG_RETENTION, removal_policy=RemovalPolicy.DESTROY),
            )
            table.grant_read_write_data(worker)
            self._grant_ai_access(worker, ai_provider)
            worker.grant_invoke(fn)
            for key, value in {
                "AI_PROVIDER": ai_provider,
                "AI_MONTHLY_LIMIT": str(int(self.node.try_get_context("aiMonthlyLimit") or DEFAULT_AI_MONTHLY_LIMIT)),
                "IMPORT_WORKER_NAME": worker.function_name,
            }.items():
                fn.add_environment(key, value)
        # "Delete my account" removes the caller's own sign-in. Only this one action, only on this pool;
        # the username always comes from the verified token, never from the request.
        fn.add_environment("USER_POOL_ID", user_pool.user_pool_id)
        fn.add_to_role_policy(
            iam.PolicyStatement(actions=["cognito-idp:AdminDeleteUser"], resources=[user_pool.user_pool_arn])
        )

        api = apigw.HttpApi(self, "Api", create_default_stage=False)
        access_logs = logs.LogGroup(self, "ApiAccessLogs", retention=LOG_RETENTION, removal_policy=RemovalPolicy.DESTROY)
        stage = apigw.HttpStage(
            self,
            "DefaultStage",
            http_api=api,
            stage_name="$default",
            auto_deploy=True,
            throttle=apigw.ThrottleSettings(rate_limit=API_RATE_LIMIT, burst_limit=API_BURST_LIMIT),
        )
        # Access logs: who called what, when, and with which result (no request bodies or tokens).
        stage.node.default_child.access_log_settings = apigw.CfnStage.AccessLogSettingsProperty(
            destination_arn=access_logs.log_group_arn,
            format=json.dumps(
                {
                    "requestId": "$context.requestId",
                    "time": "$context.requestTime",
                    "ip": "$context.identity.sourceIp",
                    "userAgent": "$context.identity.userAgent",
                    "user": "$context.authorizer.claims.sub",
                    "route": "$context.routeKey",
                    "status": "$context.status",
                    "latencyMs": "$context.responseLatency",
                    "authError": "$context.authorizer.error",
                }
            ),
        )

        # ---- website hosting ----------------------------------------------------
        site_bucket = s3.Bucket(
            self,
            "SiteBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )
        csp = "; ".join(
            [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self'",
                "img-src 'self' data:",
                "font-src 'self'",
                # The exact API URL can't be used here: the API's CORS rule references this distribution,
                # so referencing the API back would create a deployment cycle. Allow this region's API hosts.
                f"connect-src 'self' https://*.execute-api.{self.region}.amazonaws.com {domain.base_url()}",
                "manifest-src 'self'",
                "worker-src 'self'",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'self'",
                "frame-ancestors 'none'",
            ]
        )
        headers = cloudfront.ResponseHeadersPolicy(
            self,
            "SecurityHeaders",
            security_headers_behavior=cloudfront.ResponseSecurityHeadersBehavior(
                content_security_policy=cloudfront.ResponseHeadersContentSecurityPolicy(
                    content_security_policy=csp, override=True
                ),
                strict_transport_security=cloudfront.ResponseHeadersStrictTransportSecurity(
                    access_control_max_age=Duration.days(365), include_subdomains=True, override=True
                ),
                frame_options=cloudfront.ResponseHeadersFrameOptions(
                    frame_option=cloudfront.HeadersFrameOption.DENY, override=True
                ),
                content_type_options=cloudfront.ResponseHeadersContentTypeOptions(override=True),
                referrer_policy=cloudfront.ResponseHeadersReferrerPolicy(
                    referrer_policy=cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override=True
                ),
            ),
        )
        distribution = cloudfront.Distribution(
            self,
            "Site",
            # Europe and North America edges only: the users are in Europe, and only the app's static files
            # are cached at the edge (never the API or anyone's data). Visitors elsewhere are served from these.
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(site_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                response_headers_policy=headers,
            ),
            default_root_object="index.html",
            error_responses=[
                cloudfront.ErrorResponse(http_status=code, response_http_status=200, response_page_path="/index.html")
                for code in (403, 404)
            ],
            domain_names=[site_domain.name] if site_domain else None,
            certificate=certificate,
        )
        if site_domain:
            zone = site_domain.zone(self)
            target = route53.RecordTarget.from_alias(targets.CloudFrontTarget(distribution))
            route53.ARecord(self, "SiteRecord", zone=zone, target=target)
            route53.AaaaRecord(self, "SiteRecordIpv6", zone=zone, target=target)
            site_url = f"https://{site_domain.name}/"
        else:
            site_url = f"https://{distribution.distribution_domain_name}/"
        app_urls = [site_url] + ([LOCAL_DEV_URL] if dev else [])

        client = user_pool.add_client(
            "WebClient",
            generate_secret=False,
            supported_identity_providers=[cognito.UserPoolClientIdentityProvider.GOOGLE],
            prevent_user_existence_errors=True,
            enable_token_revocation=True,
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(authorization_code_grant=True),
                scopes=[cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
                callback_urls=app_urls,
                logout_urls=app_urls,
            ),
            access_token_validity=Duration.hours(1),
            id_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(365),  # stay signed in on your phone
        )
        client.node.add_dependency(google)  # the client can only list Google once the provider exists

        authorizer = authorizers.HttpJwtAuthorizer(
            "JwtAuth",
            jwt_issuer=f"https://cognito-idp.{self.region}.amazonaws.com/{user_pool.user_pool_id}",
            jwt_audience=[client.user_pool_client_id],
        )
        # CORS is configured on the API itself; set it here now that the site URL is known.
        api.node.default_child.cors_configuration = apigw.CfnApi.CorsProperty(
            allow_origins=[u.rstrip("/") for u in app_urls],
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["authorization", "content-type"],
            max_age=int(Duration.days(1).to_seconds()),
        )
        integration = integrations.HttpLambdaIntegration("ApiIntegration", fn)
        routes = {
            "/me": [apigw.HttpMethod.GET, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE],
            "/household": [apigw.HttpMethod.POST],
            "/household/join": [apigw.HttpMethod.POST],
            "/household/invite": [apigw.HttpMethod.POST],
            "/household/recipe-language": [apigw.HttpMethod.PUT],
            "/recipes": [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
            "/recipes/import": [apigw.HttpMethod.POST],
            "/recipes/import/{id}": [apigw.HttpMethod.GET],
            "/recipes/{id}": [apigw.HttpMethod.GET, apigw.HttpMethod.PUT, apigw.HttpMethod.DELETE],
            "/list": [apigw.HttpMethod.GET, apigw.HttpMethod.DELETE],
            "/list/generate": [apigw.HttpMethod.POST],
            "/list/items": [apigw.HttpMethod.POST],
            "/list/items/{id}": [apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE],
            "/admin/requests": [apigw.HttpMethod.GET],
            "/admin/requests/decline-pending": [apigw.HttpMethod.POST],
            "/admin/requests/{username}/approve": [apigw.HttpMethod.POST],
            "/admin/requests/{username}/decline": [apigw.HttpMethod.POST],
        }
        for path, methods in routes.items():
            api.add_routes(path=path, methods=methods, integration=integration, authorizer=authorizer)

        # ---- deploy the built frontend + runtime config ---------------------------
        s3deploy.BucketDeployment(
            self,
            "DeploySite",
            sources=[
                s3deploy.Source.asset(str(ROOT / "web" / "dist")),
                s3deploy.Source.data("privacy.html", privacy_page(contact_email)),
                s3deploy.Source.json_data(
                    "config.json",
                    {
                        "apiUrl": api.api_endpoint,
                        "cognitoDomain": domain.base_url(),
                        "clientId": client.user_pool_client_id,
                        "aiImport": bool(ai_provider),  # the app shows "Fill from link" only when it's on
                    },
                ),
            ],
            destination_bucket=site_bucket,
            distribution=distribution,
            distribution_paths=["/*"],
        )

        CfnOutput(self, "SiteUrl", value=site_url)
        CfnOutput(self, "ApiUrl", value=api.api_endpoint)
        CfnOutput(self, "CognitoDomain", value=domain.base_url())
        CfnOutput(self, "ClientId", value=client.user_pool_client_id)
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id, description="For adding yourself to the admins group")
        CfnOutput(
            self,
            "GoogleRedirectUri",
            value=f"{domain.base_url()}/oauth2/idpresponse",
            description="Add this as an authorised redirect URI on the Google OAuth client",
        )

    def _grant_ai_access(self, fn: lambda_.Function, provider: str) -> None:
        """Let the API reach the chosen AI provider, and nothing more."""
        if provider == "anthropic-aws":
            # Claude Platform on AWS: requests are signed with the function's role, so there's no key at all.
            workspace = (self.node.try_get_context("anthropicAwsWorkspaceId") or "").strip()
            if not workspace:
                raise ValueError(
                    "aiProvider 'anthropic-aws' needs anthropicAwsWorkspaceId in infra/settings.local.json "
                    "(the wrkspc_... ID from Claude Platform on AWS in the AWS Console)."
                )
            fn.add_environment("ANTHROPIC_AWS_WORKSPACE_ID", workspace)
            fn.add_to_role_policy(
                iam.PolicyStatement(
                    actions=["aws-external-anthropic:CreateInference"],
                    resources=[f"arn:aws:aws-external-anthropic:{self.region}:{self.account}:workspace/{workspace}"],
                )
            )
            # The client proves the role's identity with a short-lived AWS-signed token (no stored secret).
            fn.add_to_role_policy(
                iam.PolicyStatement(actions=["sts:GetWebIdentityToken", "sts:TagGetWebIdentityToken"], resources=["*"])
            )
        elif provider == "anthropic":
            # Claude API with a key: read access to that one secret only (stored by hand, never in the repo).
            fn.add_environment("ANTHROPIC_SECRET_NAME", ANTHROPIC_SECRET_NAME)
            secretsmanager.Secret.from_secret_name_v2(self, "AnthropicApiKey", ANTHROPIC_SECRET_NAME).grant_read(fn)
        else:
            raise ValueError(f"Unknown aiProvider {provider!r}: use 'anthropic-aws' or 'anthropic' (see api/src/grubgrab/ai).")


# ---- extra domains that redirect to the site (e.g. a Lithuanian example.lt -> the main domain) ---------

REDIRECT_FUNCTION = """
function handler(event) {
  var request = event.request;
  var query = [];
  for (var key in request.querystring) {
    var entry = request.querystring[key];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      query.push(values[i].value === '' ? key : key + '=' + values[i].value);
    }
  }
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: TARGET + request.uri + (query.length ? '?' + query.join('&') : '') },
      'cache-control': { value: 'max-age=3600' },
    },
  };
}
"""


def redirect_domains_from_context(scope: Construct, site_domain: "SiteDomain | None") -> list[SiteDomain]:
    """`redirectDomains` in settings.local.json: [{"domainName": "example.lt", "hostedZoneId": "Z..."}].
    Each one (and its www.) permanently redirects to the site's own domain, keeping the path."""
    entries = scope.node.try_get_context("redirectDomains") or []
    domains = []
    for entry in entries:
        name = str(entry.get("domainName") or "").strip().lower().rstrip(".")
        zone_id = str(entry.get("hostedZoneId") or "").strip()
        if not name or not zone_id:
            raise ValueError("Each redirectDomains entry needs a domainName and a hostedZoneId.")
        domains.append(SiteDomain(name, zone_id))
    if domains and not site_domain:
        raise ValueError("redirectDomains need the site's own domainName to redirect to.")
    return domains


class RedirectStack(Stack):
    """Extra domains (plus their www.) that permanently redirect to the site: a certificate, a tiny
    CloudFront distribution whose only job is a CloudFront Function answering 301, and DNS records.
    Deployed in us-east-1 next to its certificate; separate from the site, so it can't affect it."""

    def __init__(self, scope: Construct, construct_id: str, *, target: str, domains: list[SiteDomain], **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        zones = {d.name: route53.HostedZone.from_hosted_zone_attributes(self, f"Zone{i}", hosted_zone_id=d.zone_id, zone_name=d.name)
                 for i, d in enumerate(domains)}
        names = [n for d in domains for n in (d.name, f"www.{d.name}")]
        certificate = acm.Certificate(
            self,
            "Certificate",
            domain_name=names[0],
            subject_alternative_names=names[1:],
            validation=acm.CertificateValidation.from_dns_multi_zone(
                {n: zones[n.removeprefix("www.")] for n in names}
            ),
        )
        redirect = cloudfront.Function(
            self,
            "Redirect",
            runtime=cloudfront.FunctionRuntime.JS_2_0,
            comment=f"301 to {target}",
            code=cloudfront.FunctionCode.from_inline(f"var TARGET = {json.dumps(target)};" + REDIRECT_FUNCTION),
        )
        distribution = cloudfront.Distribution(
            self,
            "Redirects",
            comment=f"Redirects {', '.join(names)} to {target}",
            domain_names=names,
            certificate=certificate,
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.HttpOrigin(target.removeprefix("https://")),  # never reached: the function answers
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.ALLOW_ALL,  # http:// goes there in one hop
                cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
                function_associations=[
                    cloudfront.FunctionAssociation(function=redirect, event_type=cloudfront.FunctionEventType.VIEWER_REQUEST)
                ],
            ),
        )
        alias = route53.RecordTarget.from_alias(targets.CloudFrontTarget(distribution))
        for i, name in enumerate(names):
            zone = zones[name.removeprefix("www.")]
            route53.ARecord(self, f"A{i}", zone=zone, record_name=name, target=alias)
            route53.AaaaRecord(self, f"Aaaa{i}", zone=zone, record_name=name, target=alias)
