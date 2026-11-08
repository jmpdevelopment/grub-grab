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

**Cost:** at household scale this is effectively free. Everything is pay-per-request, and the Cognito, Lambda and DynamoDB free tiers cover it. Hard caps keep the worst case to a few dollars a day even if an approved account is abused: the database is capped at 100 writes and 300 reads per second, at most 5 copies of the API run at once, and each household can hold up to 500 recipes and 500 list items.

### Sign-up approval and alerts

New people can't just sign in: their first Google sign-in becomes a **request**, and nothing is created for them until an admin approves it. They see *"Your request to join has been sent"*; the admin sees it under **Settings → Sign-up requests** (with a count on the Settings tab) and approves or declines it. Once approved, they sign in again and join a household with an invite code. Unapproved people never get an account or a token, so they can't reach the API at all.

After the first deploy, make yourself an admin (find your username with `aws cognito-idp list-users`; the pool id is the `UserPoolId` output), then sign out and back in so your session picks it up:

```bash
aws cognito-idp admin-add-user-to-group --region eu-west-2 \
  --user-pool-id <UserPoolId> --username <your username, e.g. google_1234…> --group-name admins
```

The privacy policy is served at `/privacy.html` (linked from the sign-in screen and Settings). Its template is `web/legal/privacy.html`; the contact address is filled in at deploy time from `contactEmail` in `infra/settings.local.json` (falling back to `notifyEmail`), so it never sits in the repo. Use that URL as the privacy policy link in Google's branding settings.

Set `notifyEmail` in `infra/settings.local.json` to be emailed when someone asks to join (at most one email an hour, however many ask) and when AWS spend passes 80% of `monthlyBudgetUsd` (default $5) or is forecast to exceed it. AWS emails you once to confirm the subscription; click the link. The budget covers your whole AWS account.

**Region:** the app deploys to `eu-west-2` (London) whatever your AWS CLI's default region is. To use another region, set `"region"` in `infra/settings.local.json` (or pass `-c region=...`), and create the Google client secret and the OAuth URLs in that region too.

## API

Every route needs a Cognito access token (`Authorization: Bearer …`) and is scoped to the caller's household. Until the caller has started or joined a household, every route except the three household ones returns `409`.

| Method | Path | |
|---|---|---|
| DELETE | `/me` | delete your account: your sign-in, profile and sign-up request, plus your household's recipes, list and invite code if nobody else is in it |
| GET | `/me` | household id + invite code, or both `null` for a new user who hasn't started or joined one |
| POST | `/household` | start a household (returns the existing one if the user already has one) |
| GET | `/admin/requests` | admins only: pending sign-up requests |
| POST | `/admin/requests/{username}/approve` · `/decline` | admins only |
| POST | `/admin/requests/decline-pending` | admins only: decline everyone waiting |
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
- New accounts need an admin's approval (see *Sign-up approval*); until then a sign-in is refused before any account or token exists. Signing out revokes the session on the server, so a copied refresh token stops working.
- Anyone can delete their account in Settings. For that one action the API may call Cognito's `AdminDeleteUser` on its own user pool, and the username always comes from the caller's verified token. Nothing in the app can add anyone to the `admins` group.
- Spend caps (database throughput, function concurrency, per-household limits) bound what even an approved account can cost, and the monthly budget alert flags anything unusual. A list request that would exceed the limit is refused before anything is written.
- API access logs (no request bodies or tokens) and Lambda logs are kept for 90 days.
- `infra/tests` asserts all of the above against the synthesised template.

## Development

```bash
cd api && pip install -r requirements-dev.txt && pytest
cd web && npm run build && npm run lint
cd infra && pytest -q tests && cdk synth -c googleClientId=dummy
```

Quantity merging lives in `api/src/grubgrab/aggregate.py`, mirrored in `web/src/lib/aggregate.ts` for local mode. It converts g↔kg, ml↔l and tsp↔tbsp, and only adds quantities together when the ingredient name and unit family match.
