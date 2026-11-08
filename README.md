# Grub Grab 🛒

Recipes in, shopping list out.

Keep your recipes and their ingredients in one place, tagged however suits you (soup, fish, quick…) so you can filter by tag, with a one-tap link back to the page each recipe came from. Tick the ones you're cooking this week and Grub Grab builds a combined shopping list, adding up the quantities (garlic from two recipes → 7 cloves). You can tick items off in the shop or share the list as text. Two people can share one household, so you both see the same recipes and the same list.

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

Prerequisites: AWS credentials configured (`aws configure` or SSO), Node 20+, Python 3.12+, and a Google OAuth client (below).

### Google sign-in (one-off)

Sign-in is **Google only**: there are no passwords and no email sign-up. You need a Google OAuth client. Your Cognito sign-in domain is fixed in advance as `https://grubgrab-<AWS_ACCOUNT_ID>.auth.<REGION>.amazoncognito.com` (e.g. region `eu-west-2`), so you can do this before the first deploy.

1. In [Google Cloud Console](https://console.cloud.google.com/) create or pick a project, open **Google Auth Platform** and click **Get started**. Set an app name and support email, and choose audience **External**. Then, under **Data Access**, add the scopes `openid`, `email` and `profile`.
2. Under **Audience**, either add your Google accounts as **test users**, or click **Publish app**. Until it's published, only listed test users can sign in. These basic scopes don't need Google's review.
3. Under **Clients → Create client**, choose **Web application** and add:
   - Authorised JavaScript origin: `https://grubgrab-<AWS_ACCOUNT_ID>.auth.<REGION>.amazoncognito.com`
   - Authorised redirect URI: `https://grubgrab-<AWS_ACCOUNT_ID>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse`
4. Store the **client secret** in AWS Secrets Manager. It never goes in the repo. Secrets Manager costs about $0.40/month.
   ```bash
   aws secretsmanager create-secret --region eu-west-2 \
     --name grubgrab/google-client-secret --secret-string 'GOCSPX-...'
   ```
5. Put the **client ID** in `infra/settings.local.json` (copy `infra/settings.local.example.json` to start). That file is git-ignored, so your deployment's settings stay out of the repo. You can also pass `-c googleClientId=...` to `./deploy.sh`.

After deploying, the `GoogleRedirectUri` output shows the exact redirect URI to check against step 3.

`./deploy.sh` deploys production, which only accepts sign-ins from the CloudFront URL. To also sign in from `npm run dev` on `http://localhost:5173`, deploy with `./deploy.sh -c dev=true`. Use that for a dev deployment only.

```bash
# one-off
npm install -g aws-cdk
pip install -r infra/requirements.txt
(cd infra && cdk bootstrap)    # once; covers every region the app uses

# each deploy
./deploy.sh
```

### Custom domain (optional)

Without one, the app is served from its CloudFront URL (`https://dxxxx.cloudfront.net/`). To use your own domain, register it in Route 53 in the same AWS account (Route 53 creates its hosted zone), then set both values in `infra/settings.local.json`:

```json
"domainName": "grubgrab.example",
"hostedZoneId": "Z0123456789ABCDEFGHIJ"
```

Find the zone ID with `aws route53 list-hosted-zones`. The deploy then adds a `GrubGrabCert` stack in `us-east-1` (CloudFront only accepts certificates from there), validated through DNS, plus A/AAAA records pointing the domain at CloudFront. Sign-in and the API's CORS use the custom domain only. Bootstrap `us-east-1` too: `(cd infra && cdk bootstrap)` does both regions. The Google OAuth client doesn't change, because sign-in still goes through the Cognito domain.

Changing the domain later is safe for your data, but home-screen installs are tied to the address, so they need re-adding from the new one.

`deploy.sh` builds the web app, then runs `cdk deploy --all`. The stack:

- serves the built app from S3 behind CloudFront
- writes a `config.json` beside it pointing at the API and Cognito, which switches the app to cloud mode
- creates a Cognito user pool where Google is the only way in (accounts are created on first Google sign-in)
- runs one Python Lambda behind an HTTP API with a JWT authoriser
- stores everything in a single on-demand DynamoDB table (kept if you destroy the stack)

When it finishes, open the printed `SiteUrl` on your phone:

- **iPhone (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** ⋮ → *Install app*

Pull down from the top of any screen to refresh: it loads the other person's changes, and switches to a newly deployed version of the app if there is one.

On first sign-in, the app asks whether to **join a household** with a code or **start a new one**. For two people, the first person starts one and opens **Settings**, which shows a 10-character invite code (e.g. `ABCDE-FGH23`). The second person signs in with their own Google account and enters that code on the welcome screen. Anyone can also switch household later under *Settings → Join a household*. Each account gets 5 join attempts per hour. **New code** in Settings replaces the code if it has leaked; people who already joined stay in.

**Cost:** at household scale this is effectively free. Everything is pay-per-request, and the Cognito, Lambda and DynamoDB free tiers cover it.

**Region:** the app deploys to `eu-west-2` (London) whatever your AWS CLI's default region is. To use another region, set `"region"` in `infra/settings.local.json` (or pass `-c region=...`), and create the Google client secret and the OAuth URLs in that region too.

## API

Every route needs a Cognito access token (`Authorization: Bearer …`) and is scoped to the caller's household. Until the caller has started or joined a household, every route except the three household ones returns `409`.

| Method | Path | |
|---|---|---|
| GET | `/me` | household id + invite code, or both `null` for a new user who hasn't started or joined one |
| POST | `/household` | start a household (returns the existing one if the user already has one) |
| POST | `/household/join` | `{code}`, max 5 attempts per user per hour (429 after that) |
| POST | `/household/invite` | replace the invite code; the old one stops working |
| GET / POST | `/recipes` | list / create. A recipe is `{title, servings, notes, link, tags, ingredients}`; `link` must be an http(s) address; tags are lower-cased and de-duplicated, max 20 of 30 characters |
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
- Sign-in is Google only: no passwords are stored, and self-service email sign-up is switched off. The Google client secret is read from Secrets Manager at deploy time.
- Tokens can be revoked. Note that **any** Google account can sign in and get its own empty household; only someone with your invite code can see your data.
- API access logs (no request bodies or tokens) and Lambda logs are kept for 90 days.
- `infra/tests` asserts all of the above against the synthesised template.

## Development

```bash
cd api && pip install -r requirements-dev.txt && pytest
cd web && npm run build && npm run lint
cd infra && pytest -q tests && cdk synth -c googleClientId=dummy
```

Quantity merging lives in `api/src/grubgrab/aggregate.py`, mirrored in `web/src/lib/aggregate.ts` for local mode. It converts g↔kg, ml↔l and tsp↔tbsp, and only adds quantities together when the ingredient name and unit family match.
