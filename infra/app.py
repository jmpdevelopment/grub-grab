#!/usr/bin/env python3
import json
import os
from pathlib import Path

import aws_cdk as cdk

from stack import CertificateStack, GrubGrabStack, SiteDomain

# Your deployment's settings (Google client ID, custom domain) live in settings.local.json, which is
# git-ignored; copy settings.local.example.json to start. Anything passed with `-c key=value` wins.
LOCAL_SETTINGS = Path(__file__).with_name("settings.local.json")
local = json.loads(LOCAL_SETTINGS.read_text()) if LOCAL_SETTINGS.exists() else {}

app = cdk.App(context=local)
account = os.environ.get("CDK_DEFAULT_ACCOUNT")
# Pinned here rather than taken from CDK_DEFAULT_REGION: the cdk CLI always sets that variable from your
# AWS config, falling back to us-east-1, which would silently deploy somewhere the secret doesn't exist.
region = app.node.try_get_context("region") or "eu-west-2"

site_domain = SiteDomain.from_context(app)
certificate = None
if site_domain:
    # CloudFront needs its certificate in us-east-1; CDK passes it across regions for us.
    certificate = CertificateStack(
        app,
        "GrubGrabCert",
        site_domain=site_domain,
        env=cdk.Environment(account=account, region="us-east-1"),
        cross_region_references=True,
    ).certificate

GrubGrabStack(
    app,
    "GrubGrab",
    site_domain=site_domain,
    certificate=certificate,
    env=cdk.Environment(account=account, region=region),
    cross_region_references=bool(site_domain),
)
app.synth()
