#!/usr/bin/env python3
import os

import aws_cdk as cdk

from stack import GrubGrabStack

app = cdk.App()
GrubGrabStack(
    app,
    "GrubGrab",
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region=os.environ.get("CDK_DEFAULT_REGION", "eu-west-2"),
    ),
)
app.synth()
