import json
from pathlib import Path

from aws_cdk import CfnOutput, Duration, RemovalPolicy, SecretValue, Stack
from aws_cdk import aws_apigatewayv2 as apigw
from aws_cdk import aws_apigatewayv2_authorizers as authorizers
from aws_cdk import aws_apigatewayv2_integrations as integrations
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3deploy
from constructs import Construct

ROOT = Path(__file__).resolve().parents[1]
LOCAL_DEV_URL = "http://localhost:5173/"

# API-wide limits. Two phones polling every 8s use well under 1 request/second, so this leaves
# plenty of headroom while capping the worst-case bill if a signed-up account is abused.
API_RATE_LIMIT = 10  # steady requests per second
API_BURST_LIMIT = 20
LOG_RETENTION = logs.RetentionDays.THREE_MONTHS

# Google sign-in. The client ID is public (it appears in the browser); put it in cdk.json or pass
# `-c googleClientId=...`. The client secret lives in Secrets Manager, never in the repo.
GOOGLE_SECRET_NAME = "grubgrab/google-client-secret"


class GrubGrabStack(Stack):
    """Deploy with `cdk deploy`. Add `-c dev=true` to also allow http://localhost:5173 for local development."""

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        dev = str(self.node.try_get_context("dev")).lower() == "true"
        google_client_id = (self.node.try_get_context("googleClientId") or "").strip()
        if not google_client_id:
            raise ValueError(
                "Missing Google OAuth client ID. Add it to infra/cdk.json under context.googleClientId "
                "or pass -c googleClientId=... (see README: 'Google sign-in')."
            )

        # ---- data ---------------------------------------------------------------
        table = dynamodb.TableV2(
            self,
            "Table",
            partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
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
        fn = lambda_.Function(
            self,
            "ApiFn",
            runtime=lambda_.Runtime.PYTHON_3_13,
            architecture=lambda_.Architecture.ARM_64,
            handler="grubgrab.handler.lambda_handler",
            code=lambda_.Code.from_asset(str(ROOT / "api" / "src")),
            memory_size=256,
            timeout=Duration.seconds(10),
            environment={"TABLE_NAME": table.table_name},
            log_group=logs.LogGroup(self, "ApiFnLogs", retention=LOG_RETENTION, removal_policy=RemovalPolicy.DESTROY),
        )
        table.grant_read_write_data(fn)

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
        )
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
            "/me": [apigw.HttpMethod.GET],
            "/household/join": [apigw.HttpMethod.POST],
            "/household/invite": [apigw.HttpMethod.POST],
            "/recipes": [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
            "/recipes/{id}": [apigw.HttpMethod.GET, apigw.HttpMethod.PUT, apigw.HttpMethod.DELETE],
            "/list": [apigw.HttpMethod.GET, apigw.HttpMethod.DELETE],
            "/list/generate": [apigw.HttpMethod.POST],
            "/list/items": [apigw.HttpMethod.POST],
            "/list/items/{id}": [apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE],
        }
        for path, methods in routes.items():
            api.add_routes(path=path, methods=methods, integration=integration, authorizer=authorizer)

        # ---- deploy the built frontend + runtime config ---------------------------
        s3deploy.BucketDeployment(
            self,
            "DeploySite",
            sources=[
                s3deploy.Source.asset(str(ROOT / "web" / "dist")),
                s3deploy.Source.json_data(
                    "config.json",
                    {
                        "apiUrl": api.api_endpoint,
                        "cognitoDomain": domain.base_url(),
                        "clientId": client.user_pool_client_id,
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
        CfnOutput(
            self,
            "GoogleRedirectUri",
            value=f"{domain.base_url()}/oauth2/idpresponse",
            description="Add this as an authorised redirect URI on the Google OAuth client",
        )
