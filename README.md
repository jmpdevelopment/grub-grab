# Grub Grab 🛒

Recipes in, shopping list out.

Keep your recipes and their ingredients in one place. Tick the ones you're cooking this week and Grub Grab builds a combined shopping list, adding up the quantities (garlic from two recipes → 7 cloves). You can tick items off in the shop or share the list as text. Two people can share one household, so you both see the same recipes and the same list.

It's a React web app that installs to the home screen on both iPhone and Android, backed by a small serverless API on AWS.

## Layout

```
web/     React + TypeScript + Vite PWA (the app)
api/     Python Lambda handler + DynamoDB access, with pytest tests
infra/   AWS CDK (Python): S3 + CloudFront, Cognito, HTTP API + Lambda, DynamoDB
```

## Try it locally (no AWS needed)

```bash
cd web
npm install
npm run dev
```

With no `config.json` present, the app runs in **local mode** and keeps everything in the browser's storage. To try it on your phone, run `npm run dev -- --host` and open the printed network URL while on the same Wi-Fi.

## Deploy to AWS

Prerequisites: AWS credentials configured (`aws configure` or SSO), Node 20+, Python 3.12+.

`./deploy.sh` deploys production, which only accepts sign-ins from the CloudFront URL. To also sign in from `npm run dev` on `http://localhost:5173`, deploy with `./deploy.sh -c dev=true`. Use that for a dev deployment only.

```bash
# one-off
npm install -g aws-cdk
pip install -r infra/requirements.txt
cdk bootstrap --app "python3 infra/app.py"     # once per account/region

# each deploy
./deploy.sh
```

`deploy.sh` builds the web app, then runs `cdk deploy`. The stack:

- serves the built app from S3 behind CloudFront
- writes a `config.json` beside it pointing at the API and Cognito, which switches the app to cloud mode
- creates a Cognito user pool with a hosted sign-in page (email + password; self sign-up is on)
- runs one Python Lambda behind an HTTP API with a JWT authoriser
- stores everything in a single on-demand DynamoDB table (kept if you destroy the stack)

When it finishes, open the printed `SiteUrl` on your phone:

- **iPhone (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** ⋮ → *Install app*

For two people, the first person signs up and opens **Settings**, which shows a 10-character invite code (e.g. `ABCDE-FGH23`). The second person signs up and enters that code under *Join a household*. Each account gets 5 join attempts per hour. **New code** in Settings replaces the code if it has leaked; people who already joined stay in.

**Cost:** at household scale this is effectively free. Everything is pay-per-request, and the Cognito, Lambda and DynamoDB free tiers cover it.

**Region:** the default is `eu-west-2` (London). Set `CDK_DEFAULT_REGION` to change it.

## API

Every route needs a Cognito access token (`Authorization: Bearer …`) and is scoped to the caller's household.

| Method | Path | |
|---|---|---|
| GET | `/me` | household id + invite code (creates a household on first call) |
| POST | `/household/join` | `{code}`, max 5 attempts per user per hour (429 after that) |
| POST | `/household/invite` | replace the invite code; the old one stops working |
| GET / POST | `/recipes` | list / create |
| GET / PUT / DELETE | `/recipes/{id}` | |
| GET | `/list` | shopping list items |
| POST | `/list/generate` | `{recipeIds, mode: "replace" \| "append"}` |
| POST | `/list/items` | add a manual item `{name, quantity, unit}` |
| PATCH | `/list/items/{id}` | `{checked}` |
| DELETE | `/list/items/{id}` | |
| DELETE | `/list` | clear (`?checked=true` clears only ticked items) |

## Security

- Every API route requires a Cognito access token. All data is scoped to the caller's household, taken from the verified token, never from the request.
- Invite codes are 10 characters (about 50 bits), with a per-user limit on join attempts and a way to rotate the code.
- The API is throttled to 10 requests/second (bursts of 20) to cap cost if an account is abused.
- CloudFront sends a strict Content-Security-Policy (no inline scripts, `frame-ancestors 'none'`), HSTS, `X-Frame-Options: DENY`, `nosniff` and a referrer policy.
- Sign-in doesn't reveal whether an email has an account. Tokens can be revoked.
- API access logs (no request bodies or tokens) and Lambda logs are kept for 90 days.
- `infra/tests` asserts all of the above against the synthesised template.

## Development

```bash
cd api && pip install -r requirements-dev.txt && pytest
cd web && npm run build && npm run lint
cd infra && pytest -q tests && cdk synth
```

Quantity merging lives in `api/src/grubgrab/aggregate.py`, mirrored in `web/src/lib/aggregate.ts` for local mode. It converts g↔kg, ml↔l and tsp↔tbsp, and only adds quantities together when the ingredient name and unit family match.
