# Cloudflare deployment

See the repository [architecture and command map](../README.md) for local validation lanes. Firebase releases, Telegram recovery, and admin operations are documented in [cloud operations](../cloud/README.md).

## Frontend

- Use Node.js 24 or newer.
- Install dependencies: `npm install`
- Copy `.env.example` to `.env.local` for optional local overrides.
- Run the local development server: `npm start`
- Build the production frontend: `npm run build`

## Deployment

The frontend is an asset-only Cloudflare Worker named `mons-link`. Firebase
Authentication, Realtime Database, Firestore, and Cloud Functions remain
independently deployed to Firebase.

- Validate the frontend build and Wrangler configuration without authenticating:
  `npm run deploy -- dry-run`
- Upload a non-production Worker version:
  `npm run deploy -- preview --token-file /path/to/cloudflare-token`
- Build, upload, and immediately deploy a new production Worker version:
  `npm run deploy -- production`
- Smoke-test the unique Version Preview URL printed by Wrangler, then promote the
  Version ID printed by the same command to `mons.link`:
  `npm run deploy -- production --version-id <candidate-version-id> --token-file /path/to/cloudflare-token`

The token file must contain only a scoped Cloudflare API token. Alternatively,
set `CLOUDFLARE_API_TOKEN` in the invoking shell. The deploy helper removes
Cloudflare credentials, Wrangler settings, and local `VITE_*` overrides from the
frontend build environment. Vite writes to `build`, the helper sets
`VITE_BUILD_DATETIME`, and only passes the token to the Wrangler subprocess.
Candidate builds therefore use the committed Firebase and Apple client
fallbacks; no Worker runtime variables are required.

Production with `--version-id` does not rebuild or upload assets. It promotes the
already tested Version ID, so the preview and production artifacts are
identical. Without `--version-id`, the helper builds and uploads a fresh version,
reads its generated ID from Wrangler's structured output, and deploys it at 100%
traffic. Use the unique version URL for smoke testing rather than a reusable
preview alias. If the preview upload fails, stop before production. Always use
the unmodified pinned Wrangler; do not work around an asset upload error by
borrowing another Worker's asset namespace.

Routine releases do not change routes or domains. If `wrangler.jsonc` routing is
changed, review that change separately and apply it with
`node_modules/.bin/wrangler triggers deploy --config wrangler.jsonc`.

To roll back, provide `CLOUDFLARE_API_TOKEN`, inspect
`node_modules/.bin/wrangler deployments list --config wrangler.jsonc`, and run
`node_modules/.bin/wrangler rollback <known-good-production-version-id> --config wrangler.jsonc`.
Always supply a version ID so the selected rollback target is explicit and can
be checked before it receives production traffic.

The former Amplify app and CloudFront DNS target were retired after the
migration, so application rollbacks must use an explicit Worker version.

There is currently no `.well-known` asset in this frontend. SPA fallback can
serve `index.html` with HTTP 200 for a missing path, so status alone does not
prove that a future `.well-known` file exists. If one is added under
`public/.well-known/`, verify its response body and content type during smoke
testing.

## NFT API

The NFT lookup API is a separate Worker named `mons-link-api`, configured in
`cloud/workers/api/wrangler.jsonc` and served from `api.mons.link`. Its release
does not change the frontend Worker or its `mons.link` route.

- Generate its binding types: `npm run types:api`
- Run its complete local validation: `npm run check:api`
- Upload, validate, and smoke-test an undeployed candidate:
  `npm run deploy:api -- preview --smoke-sol <known-wallet> --token-file /path/to/cloudflare-token`
- Promote that exact candidate and smoke-test the custom domain:
  `npm run deploy:api -- production --version-id <candidate-version-id> --smoke-sol <known-wallet> --token-file /path/to/cloudflare-token`

`HELIUS_RPC_API_KEY` is a required encrypted Worker secret. Keep its value out
of source, Wrangler configuration, shell arguments, and logs. Routine version
uploads inherit the existing encrypted secret, and Wrangler rejects an upload
when a name declared in `secrets.required` is missing. Do not create or pass a
Helius secrets file during routine releases.

The release helper passes the tracked, comment-only
`cloud/workers/api/release.env` to Wrangler with `--env-file`. This file must
remain free of values and credentials; it exists only to prevent release
commands from automatically loading developer `.env` or `.env.local` files.
Cloudflare authentication still comes from `--token-file` or the invoking
shell as described below.

The helper uses the pinned local Wrangler, requires an explicit production
version, and does not upload from production mode. Its smoke checks cover CORS,
the exact empty-wallet response, and a non-empty wallet that exercises Helius.
The wallet is sent only in the POST body and is not printed. Pass
`CLOUDFLARE_API_TOKEN` in the invoking shell instead of `--token-file` when
preferred.

The NFT route accepts only `POST /nfts` plus CORS preflight requests. Request bodies
larger than 4096 bytes return `400`, as do malformed JSON, invalid field types,
and invalid non-empty Solana addresses. The Helius secret must remain in
Firebase because event prize withdrawals also use it. Helius response bodies
over 8 MiB are rejected as generic provider failures.

Routine releases do not change routes or domains. If the API `routes`
configuration is intentionally changed, review it separately and apply it with
`npm run deploy:api:triggers -- --token-file /path/to/cloudflare-token`, or set
`CLOUDFLARE_API_TOKEN` in the invoking shell and omit `--token-file`.

The same trigger command applies the reviewed `mons-link-telegram-delivery`
Queue consumer configuration. Provisioning, secret setup, hard cutover,
recovery, and rollback are documented in the
[Telegram delivery migration guide](migrate-telegram-delivery.md).

## Event prize announcement API

The admin-only prize album operation is served synchronously by
`POST https://api.mons.link/internal/telegram/event-prize-announcement`. The
request body contains `requestId`, `eventId`, and `announcement`. The request is
authenticated with the dedicated `TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET` using
the timestamp and HMAC headers shared with the delivery bridge. The Worker uses
its encrypted Telegram bot token and community chat ID.

For rotation, generate the credential with restrictive file permissions and
store the same value in Firebase Secret Manager for operator access and in the
Worker:

```sh
umask 077
openssl rand -hex 32 > /secure/telegram-announcement-secret
firebase functions:secrets:set TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET --data-file /secure/telegram-announcement-secret --config cloud/firebase.json --project mons-link
node_modules/.bin/wrangler secret put TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET --config cloud/workers/api/wrangler.jsonc < /secure/telegram-announcement-secret
```

Do not reuse the queue bridge secret.

The send stays on the HTTP request path because a timeout or malformed Telegram
acknowledgement is uncertain. Queue retries could publish the album twice. The
Worker and CLI therefore return an explicit uncertain result and require the
operator to inspect the group before retrying.

Each CLI invocation signs a UUID request ID. The Worker reserves that ID in
RTDB before calling Telegram and stores successful message IDs, so replaying an
identical signed request returns the existing receipt without publishing the
album twice.

Validate the production route and credential without reaching Telegram:

```sh
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret --smoke
```

The operational command retains local preview and confirmation:

```sh
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret FRkdorMWaYW "Win compressed NFTs"
```

## Mining API

Authenticated mining is served by `POST https://api.mons.link/mining/rock`.
The browser sends its Firebase ID token in the `Authorization: Bearer` header.
The Worker verifies that token, applies the existing authenticated-origin CORS
policy, and rate limits attempts by Firebase UID.

The Worker queries the caller's profile with the Firebase token, then updates
only `mining.lastRockDate` and `mining.materials` with the existing Firestore
service account. Each update is conditioned on the document version returned
by the query. A conflicting write causes the Worker to re-read, revalidate, and
retry up to three total attempts. The service account therefore needs its
existing `datastore.entities.get` and `datastore.entities.update` permissions;
mining does not require broader IAM access or another Worker secret.

API release smoke checks cover mining preflight and unauthenticated responses
without changing a profile. For the production cutover, promote the tested API
Worker version first, then promote the frontend and break one available rock
with an authenticated profile. Confirm that Firestore advances the date and
materials exactly once before running the complete Firebase release. The final
Firebase function reconciliation removes the retired `mineRock` callable.

Before reconciliation, rollback by restoring the previous frontend and API
Worker versions. After reconciliation, redeploy `mineRock` from the retained
pre-migration commit before restoring those versions.

## Gameplay mutation APIs

Authenticated gameplay mutations are served by:

- `POST https://api.mons.link/automatch/start`
- `POST https://api.mons.link/automatch/cancel`
- `POST https://api.mons.link/navigation/games/remove`
- `POST https://api.mons.link/wagers/proposals/send`
- `POST https://api.mons.link/wagers/proposals/accept`
- `POST https://api.mons.link/wagers/proposals/cancel`
- `POST https://api.mons.link/wagers/proposals/decline`

The browser sends its Firebase ID token in the `Authorization: Bearer` header.
The Worker preserves the existing first-entry matchmaking policy, bounded match
retry behavior, cancellation race check, automatch Telegram source updates,
navigation-state gates, and conditional Firestore deletion. Firebase
Authentication, RTDB, Firestore, and the existing projection triggers remain
authoritative.

Wager proposal send reserves the authenticated participant's available
materials and atomically creates a proposal or matching automatic agreement.
Accept reserves the available agreed amount, claims the agreement, clears both
proposals, and normalizes both participants' frozen materials. Cancellation
removes the authenticated participant's proposal; decline removes the
opponent's proposal. The Worker resolves both login IDs to their Firestore
profiles and accepts direct login ownership or the caller's `profileId` claim.
It reads the caller's authoritative material total with the same Firebase ID
token and performs all frozen-material and wager mutations through RTDB
transactions. Responses expose only the documented result fields and never
include internal debug state. The existing gameplay service account already has
the required RTDB read and update permissions, so these routes require no new
secret or IAM role.

Initial environments require one dedicated Google identity with separate
least-privilege role bindings. Routine releases reuse this identity and its
encrypted Worker secrets. The RTDB role is project-scoped because Realtime
Database IAM does not provide path-level permissions. The Firestore delete role
is conditioned on the default database:

```sh
gcloud iam roles create monsLinkGameplayRtdb --project mons-link --title="mons.link gameplay RTDB" --permissions=firebasedatabase.instances.get,firebasedatabase.instances.update --stage=GA
gcloud iam roles create monsLinkNavigationGameDelete --project mons-link --title="mons.link navigation game deletion" --permissions=datastore.entities.delete --stage=GA
gcloud iam service-accounts create mons-link-gameplay-api --project mons-link --display-name="mons.link gameplay API"
gcloud projects add-iam-policy-binding mons-link --member="serviceAccount:mons-link-gameplay-api@mons-link.iam.gserviceaccount.com" --role="projects/mons-link/roles/monsLinkGameplayRtdb"
gcloud projects add-iam-policy-binding mons-link --member="serviceAccount:mons-link-gameplay-api@mons-link.iam.gserviceaccount.com" --role="projects/mons-link/roles/monsLinkNavigationGameDelete" --condition='expression=resource.name=="projects/mons-link/databases/(default)",title=default-firestore-only'
gcloud iam service-accounts keys create /secure/mons-link-gameplay-api.json --project mons-link --iam-account=mons-link-gameplay-api@mons-link.iam.gserviceaccount.com
```

For initial provisioning or intentional key rotation, prepare an untracked
secrets file outside the repository using the generated service-account key:

```dotenv
GAMEPLAY_SERVICE_ACCOUNT_EMAIL=mons-link-gameplay-api@mons-link.iam.gserviceaccount.com
GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Attach those credentials to the first undeployed API candidate:

```sh
npm run deploy:api -- preview --smoke-sol <known-wallet> --secrets-file /secure/mons-link-gameplay-api.env --token-file /secure/cloudflare-token
```

After that candidate is promoted and the encrypted secrets are retained by the
Worker, delete the temporary secrets file and downloaded service-account key.

Deploy the reviewed RTDB rules before uploading the API candidate so gameplay
state remains readable while the internal wager-operation ledger stays private:

```sh
firebase deploy --only database --config cloud/firebase.json --project mons-link
```

For a routine release, upload and smoke-test the API candidate, promote that
exact version, then promote the frontend candidate:

```sh
npm run deploy:api -- preview --smoke-sol <known-wallet> --token-file /secure/cloudflare-token
npm run deploy:api -- production --version-id <candidate-version-id> --smoke-sol <known-wallet> --token-file /secure/cloudflare-token
npm run deploy -- preview --token-file /secure/cloudflare-token
npm run deploy -- production --version-id <frontend-candidate-version-id> --token-file /secure/cloudflare-token
```

API smoke checks cover every gameplay route's preflight and unauthenticated
response without mutating RTDB. For changes to gameplay behavior, use two
authenticated production sessions backed by distinct profiles and verify only
the affected automatch, navigation, or wager flow before completing the release.

For the wager cutover, verify a normal proposal, explicit acceptance, cancel,
decline, a matching automatic agreement, exact frozen-material counts, and a
failed proposal rollback before running the complete Firebase release. The
final Firebase reconciliation removes the retired `sendWagerProposal`,
`acceptWagerProposal`, `cancelWagerProposal`, and `declineWagerProposal`
callables.

Before reconciliation, rollback only the frontend to restore the callable path.
After reconciliation, first redeploy all four callables from the retained
pre-migration commit, then roll back both the frontend and API Worker versions
so only one wager mutation protocol remains active.

## Auth initiation and reads

The API Worker owns these Firebase-authenticated routes:

- `POST https://api.mons.link/auth/intents`
- `GET https://api.mons.link/auth/methods`
- `POST https://api.mons.link/auth/x/flows`

The browser sends its Firebase ID token in the `Authorization: Bearer` header.
The Worker verifies the token against Google's Secure Token keys. Auth route
CORS permits `mons.link`, `www.mons.link`, and the documented port-3000 local
origins, plus exact account-owned version-preview hostnames. The public NFT
route retains wildcard CORS. Automatic invocation logs are disabled so bearer
headers are not persisted; sanitized custom errors remain enabled.

Intent creation is limited to 20 requests per minute for each authenticated
UID and method through the `AUTH_RATE_LIMITER` binding. These counters are
local to the Cloudflare location processing the request. Linked-method reads
forward the user's Firebase token to Firestore, so Firestore Security Rules
remain authoritative and the Worker service account does not require
`datastore.entities.list`.

The Worker service account creates `authIntents` and `xAuthRedirectFlows`
documents and reads callback/intent records. Its custom role must contain
exactly `datastore.entities.create`, `datastore.entities.get`, and
`datastore.entities.update`. Existing installations created before the auth
migration must update the role before promoting the new Worker:

```sh
gcloud iam roles update monsLinkXCallback --project mons-link --permissions=datastore.entities.create,datastore.entities.get,datastore.entities.update --stage=GA
```

Automated API smoke checks cover every auth preflight and unauthenticated
response without creating Firestore records. After promotion, manually verify
linked-method loading, all four intent types, and the X redirect start before
removing the retired Firebase callables.

## X OAuth callback

The API Worker also serves `GET https://api.mons.link/auth/x/callback`. It
exchanges the X authorization code, reads and updates the existing
`xAuthRedirectFlows` Firestore document through the Firestore REST API, and
redirects to the flow's validated `mons.link` return URL. The Worker creates
the flow, while the completion callable remains in Firebase. No Cloudflare
storage resource is used.

Register `https://api.mons.link/auth/x/callback` as an exact callback URI in the
X application before deploying the Firebase flow-creator change. X client IDs,
client secrets, authorization codes, access tokens, PKCE verifiers, service
account keys, and raw flow IDs must not appear in source, arguments, or logs.

Create a dedicated Google service account and project custom role for auth and
the callback. The role must contain only `datastore.entities.create`,
`datastore.entities.get`, and `datastore.entities.update`, and its project
binding must be conditioned on the default `mons-link` Firestore database:

```sh
gcloud iam roles create monsLinkXCallback --project mons-link --title="mons.link auth API" --permissions=datastore.entities.create,datastore.entities.get,datastore.entities.update --stage=GA
gcloud iam service-accounts create mons-link-x-callback --project mons-link --display-name="mons.link auth API"
gcloud projects add-iam-policy-binding mons-link --member="serviceAccount:mons-link-x-callback@mons-link.iam.gserviceaccount.com" --role="projects/mons-link/roles/monsLinkXCallback" --condition='expression=resource.name=="projects/mons-link/databases/(default)",title=default-firestore-only'
gcloud iam service-accounts keys create /secure/mons-link-x-callback.json --project mons-link --iam-account=mons-link-x-callback@mons-link.iam.gserviceaccount.com
```

Prepare an untracked dotenv file outside the repository containing the existing
X application credentials and the `client_email` and `private_key` values from
the generated service-account key:

```dotenv
X_CLIENT_ID=...
X_CLIENT_SECRET=...
FIRESTORE_SERVICE_ACCOUNT_EMAIL=mons-link-x-callback@mons-link.iam.gserviceaccount.com
FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Upload the first candidate with those secrets attached to that undeployed
version:

```sh
npm run deploy:api -- preview --smoke-sol <known-wallet> --secrets-file /secure/mons-link-x-callback.env --token-file /path/to/cloudflare-token
```

The secrets file is accepted only in preview mode and is passed directly to
`wrangler versions upload`; the release helper never reads or prints it.
Existing secrets omitted from the file, including `HELIUS_RPC_API_KEY`, remain
attached. Delete the local secrets file and the downloaded service-account JSON
after the candidate has been promoted and the values are stored as encrypted
Worker secrets.

Preview and production smoke checks cover the NFT API, auth CORS and
unauthenticated responses, callback routing without a state value, and a random
absent state that proves Google OAuth and Firestore read access. A real X code
is intentionally not used by automated smoke checks. After production
promotion, exercise X sign-in and settings linking manually, including provider
denial.

The auth compute migration uses an immediate cutover. Deploy and smoke-test the
Worker candidate, promote and verify the frontend, then reconcile away
`beginAuthIntent`, `getLinkedAuthMethods`, and `beginXRedirectAuth` through the
complete Firebase release. Already-open tabs running the former frontend can
fail after reconciliation and must be refreshed.

For rollback after Firebase reconciliation, redeploy the three retired
callables from the retained pre-migration commit, then roll back the frontend
and API Workers to their recorded version IDs. The X callback remains on the
API Worker throughout this rollback. Remove `datastore.entities.create` from
the custom role only after the old auth start path is restored.

## Profile and leaderboard reads

Authenticated one-shot profile lookups and leaderboards are served by:

- `POST https://api.mons.link/profiles/lookup`
- `POST https://api.mons.link/leaderboards/read`

The browser sends its Firebase ID token in the `Authorization: Bearer` header.
The Worker verifies the token and forwards that same token to Firestore REST, so
the existing Firestore read rules remain authoritative. Profile lookup supports
login UID and profile ID requests; profile-ID reads retain the bounded canonical
merge redirect behavior. Leaderboards support rating, mana points, and each
mining material with the existing 99-profile limit. Total-material ranking and
the 60-second material cache remain browser-side. Leaderboard payloads include
the card customization fields needed to open profile cards immediately without
another lookup.

These routes add no Worker binding, secret, service-account permission, or
shared edge cache. Automated smoke checks cover preflight and unauthenticated
responses without reading production profile data. Promote the API Worker before
the frontend that calls these routes. No Firebase deployment or function
reconciliation is required for this migration.

## Firebase deployment

- Deploy the complete Firebase release: `npm run deploy:firebase -- --project mons-link`
- See `cloud/README.md` for dry-run, batch-size, and maintenance commands.
