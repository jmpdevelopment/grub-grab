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

For two people, the first person signs up and opens **Settings**, which shows a 6-letter invite code. The second person signs up and enters that code under *Join a household*.

**Cost:** at household scale this is effectively free. Everything is pay-per-request, and the Cognito, Lambda and DynamoDB free tiers cover it.

**Region:** the default is `eu-west-2` (London). Set `CDK_DEFAULT_REGION` to change it.

## API

Every route needs a Cognito access token (`Authorization: Bearer …`) and is scoped to the caller's household.

| Method | Path | |
|---|---|---|
| GET | `/me` | household id + invite code (creates a household on first call) |
| POST | `/household/join` | `{code}` |
| GET / POST | `/recipes` | list / create |
| GET / PUT / DELETE | `/recipes/{id}` | |
| GET | `/list` | shopping list items |
| POST | `/list/generate` | `{recipeIds, mode: "replace" \| "append"}` |
| POST | `/list/items` | add a manual item `{name, quantity, unit}` |
| PATCH | `/list/items/{id}` | `{checked}` |
| DELETE | `/list/items/{id}` | |
| DELETE | `/list` | clear (`?checked=true` clears only ticked items) |

## Development

```bash
cd api && pip install -r requirements-dev.txt && pytest
cd web && npm run build && npm run lint
cd infra && cdk synth
```

Quantity merging lives in `api/src/grubgrab/aggregate.py`, mirrored in `web/src/lib/aggregate.ts` for local mode. It converts g↔kg, ml↔l and tsp↔tbsp, and only adds quantities together when the ingredient name and unit family match.
