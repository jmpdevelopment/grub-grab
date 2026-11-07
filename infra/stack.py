from pathlib import Path

from aws_cdk import CfnOutput, Duration, RemovalPolicy, Stack
from aws_cdk import aws_apigatewayv2 as apigw
from aws_cdk import aws_apigatewayv2_authorizers as authorizers
from aws_cdk import aws_apigatewayv2_integrations as integrations
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3deploy
from constructs import Construct

ROOT = Path(__file__).resolve().parents[1]
LOCAL_DEV_URL = "http://localhost:5173/"


class GrubGrabStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # ---- data ---------------------------------------------------------------
        table = dynamodb.TableV2(
            self,
            "Table",
            partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            removal_policy=RemovalPolicy.RETAIN,  # don't lose recipes on `cdk destroy`
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
        distribution = cloudfront.Distribution(
            self,
            "Site",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(site_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            ),
            default_root_object="index.html",
            error_responses=[
                cloudfront.ErrorResponse(http_status=code, response_http_status=200, response_page_path="/index.html")
                for code in (403, 404)
            ],
        )
        site_url = f"https://{distribution.distribution_domain_name}/"

        # ---- auth -----------------------------------------------------------------
        user_pool = cognito.UserPool(
            self,
            "Users",
            self_sign_up_enabled=True,
            sign_in_aliases=cognito.SignInAliases(email=True),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            password_policy=cognito.PasswordPolicy(min_length=10, require_symbols=False),
            removal_policy=RemovalPolicy.RETAIN,
        )
        domain = user_pool.add_domain(
            "Domain",
            cognito_domain=cognito.CognitoDomainOptions(domain_prefix=f"grubgrab-{self.account}"),
        )
        client = user_pool.add_client(
            "WebClient",
            generate_secret=False,
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(authorization_code_grant=True),
                scopes=[cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
                callback_urls=[site_url, LOCAL_DEV_URL],
                logout_urls=[site_url, LOCAL_DEV_URL],
            ),
            access_token_validity=Duration.hours(1),
            id_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(365),  # stay signed in on your phone
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
        )
        table.grant_read_write_data(fn)

        authorizer = authorizers.HttpJwtAuthorizer(
            "JwtAuth",
            jwt_issuer=f"https://cognito-idp.{self.region}.amazonaws.com/{user_pool.user_pool_id}",
            jwt_audience=[client.user_pool_client_id],
        )
        api = apigw.HttpApi(
            self,
            "Api",
            cors_preflight=apigw.CorsPreflightOptions(
                allow_origins=[site_url.rstrip("/"), LOCAL_DEV_URL.rstrip("/")],
                allow_methods=[apigw.CorsHttpMethod.ANY],
                allow_headers=["authorization", "content-type"],
                max_age=Duration.days(1),
            ),
        )
        integration = integrations.HttpLambdaIntegration("ApiIntegration", fn)
        routes = {
            "/me": [apigw.HttpMethod.GET],
            "/household/join": [apigw.HttpMethod.POST],
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
