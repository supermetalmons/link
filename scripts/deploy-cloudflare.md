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

Before every preview upload, export all four non-secret auth kill switches. Start
from the current production values and change a value only as part of the
reviewed release. The tracked defaults are:

```sh
export AUTH_DISABLE_APPLE_VERIFY=false
export AUTH_DISABLE_X_VERIFY=false
export AUTH_DISABLE_UNLINK=false
export AUTH_DISABLE_MERGE=false
```

The helper rejects missing or non-boolean values and prints the four selected
values before validation. It embeds them in a mode-`0600` temporary release
configuration so Wrangler strict validation reviews the exact upload values,
then deletes that file. A `--secrets-file` may be JSON or dotenv, but must not
contain any `AUTH_DISABLE_*` key. The helper reads only its keys for this check
and never prints or forwards secret values as command arguments.

If the production Worker was last changed in the Dashboard and a reviewed
release changes one of these values, first set that same non-secret variable to
the selected value in the Dashboard. The strict preview then verifies the
Dashboard and candidate agree instead of rejecting the intentional change. This
is safe for the initial merge-disable step below. After that candidate is
promoted through Wrangler, later kill-switch changes are CLI-originated and do
not need the Dashboard step unless someone edits the Worker there again.

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

The tracked `wrangler.jsonc` includes the auth recovery consumer so local Queue
development can process its messages. The release helper's temporary release
configuration omits the auth recovery consumer, so routine trigger updates
cannot attach it. They reconcile only reviewed routes, Cron schedules, and the
tracked Telegram Queue consumers. Attach the recovery consumer only with the
explicit command documented below after a compatible Worker version is
promoted.

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

## Match timer API

Starting and claiming a match timer are served by:

- `POST https://api.mons.link/matches/timer/start`
- `POST https://api.mons.link/matches/timer/claim`

The browser sends its Firebase ID token in the `Authorization: Bearer` header
and provides the acting player, opponent, invite, and match IDs. The Worker
verifies direct login ownership or the existing same-profile claim, checks the
invite participants and match series, reads both RTDB match records, validates
the later state and move history with `mons-rules`, and requires the opponent's
turn.

Timer starts and claims use separate keys on the authenticated rate-limit
binding, each allowing 20 attempts per minute per Firebase UID and Cloudflare
location. The Worker writes through the existing gameplay service account, so
no new secret or IAM permission is required. A protected RTDB marker makes the
first valid timer for a turn win; repeated starts restore that exact timer
without extending its deadline, even if the player match record was cleared or
recreated. A valid expired claim marks the acting player's timer terminal and
clears both protected markers. The terminal transition uses an RTDB transaction
to acquire a protected per-match claim fence, then re-reads both player
replicas. Client move validation respects that fence; abandoned pending claims
expire after 30 seconds, and concurrent claims are rejected while it is active.

Event-owned claims write a source-specific event-progress signal while clearing
the markers. The retained Firebase fallback trigger continues event advancement
until the event subsystem is migrated. Side-effect persistence is retried three
times, and a terminal replay repairs a previously incomplete write.

API smoke checks cover preflight and unauthenticated responses without reading
or changing a match. Deploy the reviewed RTDB rules before testing the Worker
candidate so clients cannot modify the protected timer marker:

```sh
firebase deploy --only database --config cloud/firebase.json --project mons-link
```

Call the version-preview start route with an authenticated disposable match and
repeat the request to confirm the deadline remains unchanged. Claim an expired
timer on disposable non-event and event-owned matches. Verify the acting timer
is `gg`, both protected markers are removed, and the event progresses. Promote
the API Worker, deploy and verify the frontend, then run the complete Firebase
release to remove the retired `claimMatchVictoryByTimer` callable.

Before Firebase reconciliation, rollback the frontend and API Worker versions.
After reconciliation, redeploy `claimMatchVictoryByTimer` from the retained
pre-migration commit before restoring those versions. Already-open tabs using
the former frontend must be refreshed after the callable is removed.

## Gameplay mutation APIs

Authenticated gameplay mutations are served by:

- `POST https://api.mons.link/automatch/start`
- `POST https://api.mons.link/automatch/cancel`
- `POST https://api.mons.link/matches/timer/claim`
- `POST https://api.mons.link/matches/timer/start`
- `POST https://api.mons.link/navigation/games/remove`
- `POST https://api.mons.link/wagers/proposals/send`
- `POST https://api.mons.link/wagers/proposals/accept`
- `POST https://api.mons.link/wagers/proposals/cancel`
- `POST https://api.mons.link/wagers/proposals/decline`
- `POST https://api.mons.link/wagers/outcomes/resolve`

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

Wager outcome resolution derives both participants from the invite, validates
the match belongs to that invite, and claims the live wager state in one RTDB
transaction. A Firestore ledger and atomic material transforms make the transfer
exactly once. RTDB reservation releases and finalization are resumable through
the existing Cloudflare delivery queue. A `wager-settlement-uncertain` response
means a legacy marker exists without proof of completion; inspect the wager,
both Firestore balances, and both frozen balances before reconciling it manually.

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
Do not reconcile the retired `resolveWagerOutcome` callable until one controlled
wager has resolved through the production Worker and a repeated request returns
the same balances. Already-open tabs using the former frontend must be refreshed.
After reconciliation, restore the callable from the retained pre-migration
commit before rolling back the frontend or API Worker.

## Event participation APIs

Authenticated event participation mutations are served by:

- `POST https://api.mons.link/events/participants/join`
- `POST https://api.mons.link/events/participants/remove`

The browser sends its Firebase ID token. The Worker reads the caller's profile
with that token, then uses the gameplay service account for RTDB reads,
transactions, and multipath updates. Firebase event state, realtime listeners,
event progress, navigation projection, and Telegram projection remain
authoritative.

Both routes use the same `eventLocks/{eventId}` lease schema as the Firebase
event writers. A late join or removal persists the scheduled-start transition
before rejecting the mutation. Join replays preserve the original `joinedAtMs`;
removal clears both the participant and the participant's event-prize selection.

Automated API smoke checks cover preflight and unauthenticated responses without
reading or changing an event.

## Authentication APIs

The API Worker owns these Firebase-authenticated routes:

- `POST https://api.mons.link/auth/intents`
- `GET https://api.mons.link/auth/methods`
- `POST https://api.mons.link/auth/methods/apple/verify`
- `POST https://api.mons.link/auth/methods/eth/verify`
- `POST https://api.mons.link/auth/methods/sol/verify`
- `POST https://api.mons.link/auth/methods/unlink`
- `POST https://api.mons.link/auth/profile-claim/sync`
- `POST https://api.mons.link/auth/x/flows`
- `POST https://api.mons.link/auth/x/flows/complete`

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
remain authoritative for that read path. Auth mutation queries use the
separately conditioned service-account permissions documented below.

The Worker service account owns auth intents, X flows, method indexes,
operation replays, cooldowns, profile linking and merging, username indexes,
and merge repair records. Its Firestore-conditioned custom role must contain
exactly the database transaction and entity permissions below. Update the role
before uploading an auth-mutation candidate:

```sh
gcloud iam roles update monsLinkXCallback --project mons-link --permissions=datastore.databases.get,datastore.entities.create,datastore.entities.delete,datastore.entities.get,datastore.entities.list,datastore.entities.update --stage=GA
```

Profile-claim synchronization queries the caller's profile with the caller's
Firebase ID token and rejects duplicate `logins` ownership before changing
anything. It then reconciles only the Firebase Auth `profileId` custom claim and
`players/{uid}/profile` RTDB link. Existing unrelated custom claims are
preserved. The same projected query detects pending merge repairs and enqueues
them on the durable auth recovery Queue. Requests use the existing auth rate
limiter per Firebase UID. When no profile exists, stale claim and RTDB cleanup
remains best-effort and the route returns the empty linked-method response.

Create the durable auth recovery Queue, its primary dead-letter Queue, and the
secondary replay dead-letter Queue before the first candidate upload. All three
Queues use the 14-day retention limit:

```sh
npx wrangler queues create mons-link-auth-recovery --message-retention-period-secs 1209600
npx wrangler queues create mons-link-auth-recovery-dlq --message-retention-period-secs 1209600
npx wrangler queues create mons-link-auth-recovery-replay-dlq --message-retention-period-secs 1209600
```

For any Queue that already exists, update its retention instead of recreating
it:

```sh
npx wrangler queues update mons-link-auth-recovery --message-retention-period-secs 1209600
npx wrangler queues update mons-link-auth-recovery-dlq --message-retention-period-secs 1209600
npx wrangler queues update mons-link-auth-recovery-replay-dlq --message-retention-period-secs 1209600
```

Do not attach the consumer to a Worker version that predates auth recovery.
After the compatible API version is promoted at 100% traffic, apply the tracked
triggers and attach the consumer, then verify it:

```sh
npm run deploy:api:triggers -- --token-file /path/to/cloudflare-token
npm run deploy:api -- consumer --token-file /path/to/cloudflare-token
npx wrangler queues consumer worker list mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc
```

The explicit consumer command reads the tracked auth recovery settings, looks up
that Queue through the Cloudflare API, and creates or updates only the matching
Worker consumer. It does not deploy routes, domains, Cron schedules, Preview URL
settings, or Telegram consumers. Routine trigger deployments omit the recovery
consumer and leave its current attachment unchanged.

Before rolling back to a Worker version that predates auth recovery, remove the
consumer. This preserves buffered tasks; do not purge the Queue. Reattach the
consumer by rerunning the consumer command only after a compatible version is
promoted again. Detached main-Queue tasks also expire after 14 days, so complete
the rollback or repair and restore a compatible consumer before the oldest task
reaches that deadline.

```sh
npx wrangler queues consumer remove mons-link-auth-recovery mons-link-api --config cloud/workers/api/wrangler.jsonc
```

If the temporary primary-DLQ replay consumer is attached, remove it before the
rollback as well:

```sh
npx wrangler queues consumer remove mons-link-auth-recovery-dlq mons-link-api --config cloud/workers/api/wrangler.jsonc
```

With the applicable consumers detached, do not roll back the API from this
generic Queue procedure. Continue with one of the mutually exclusive auth
rollback branches in the cutover section below; they enforce frontend-first
ordering and restore compatibility callables when required.

Keep both dead-letter Queues without consumers during normal operation. The
14-day action deadline applies to buffered tasks on a detached main Queue and
to parked messages in either DLQ. After fixing the root cause, attach the
compatible API Worker to the primary DLQ temporarily, verify the consumer, and
monitor the Queue until it drains. Failed replays move to the secondary DLQ
instead of being deleted:

```sh
npx wrangler queues consumer add mons-link-auth-recovery-dlq mons-link-api --batch-size 1 --batch-timeout 1 --message-retries 100 --retry-delay-secs 60 --dead-letter-queue mons-link-auth-recovery-replay-dlq --max-concurrency 1 --config cloud/workers/api/wrangler.jsonc
npx wrangler queues consumer worker list mons-link-auth-recovery-dlq --config cloud/workers/api/wrangler.jsonc
```

Remove the temporary consumer after the DLQ drains and before any rollback to a
Worker version that predates auth recovery:

```sh
npx wrangler queues consumer remove mons-link-auth-recovery-dlq mons-link-api --config cloud/workers/api/wrangler.jsonc
```

Keep `mons-link-auth-recovery-replay-dlq` consumer-free. If it receives a
message, do not purge or delete the Queue. Inspect the failed profile recovery
and its authoritative Firestore pending markers, fix the remaining cause, and
complete a reviewed recovery before that message's 14-day deadline.

The route reuses the existing `mons-link-x-callback` auth API identity and its
`FIRESTORE_SERVICE_ACCOUNT_*` Worker secrets. Its separate
`monsLinkProfileClaimSync` project-level role contains exactly
`firebaseauth.users.get`, `firebaseauth.users.update`,
`firebasedatabase.instances.get`, and `firebasedatabase.instances.update`
without changing the Firestore-conditioned role. No additional service-account
key or Worker secret is required.

Provider verification preserves the existing single-use intent, signature,
profile merge, replay, method-index, username, cooldown, custom-claim, RTDB,
game projection, and event-prize reconciliation contracts. Apple accepts only
the tracked `link.mons` audience. Ethereum accepts the tracked production and
port-3000 local SIWE domains. The existing rate-limit binding rejects excessive
mutation attempts before cryptographic work, keyed by operation and Firebase
UID. Auth proofs, tokens, flow IDs, provider identifiers, and service-account
credentials must never be logged.

Automated API smoke checks cover every auth preflight and unauthenticated
response without creating Firestore records. Before removing the Firebase
callables, exercise all four providers, unlinking, replay, cooldown rejection,
last-method rejection, and a disposable two-profile merge through the promoted
Worker and frontend.

## X OAuth callback

The API Worker also serves `GET https://api.mons.link/auth/x/callback`. It
exchanges the X authorization code, reads and updates the existing
`xAuthRedirectFlows` Firestore document through the Firestore REST API, and
redirects to the flow's validated `mons.link` return URL. The Worker creates
and completes the flow. No Cloudflare storage resource is used.

Register `https://api.mons.link/auth/x/callback` as an exact callback URI in the
X application before deploying the Firebase flow-creator change. X client IDs,
client secrets, authorization codes, access tokens, PKCE verifiers, service
account keys, and raw flow IDs must not appear in source, arguments, or logs.

Create a dedicated Google service account and project custom role for auth and
the callback. Its project binding must be conditioned on the default
`mons-link` Firestore database:

```sh
gcloud iam roles create monsLinkXCallback --project mons-link --title="mons.link auth API" --permissions=datastore.databases.get,datastore.entities.create,datastore.entities.delete,datastore.entities.get,datastore.entities.list,datastore.entities.update --stage=GA
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

Before any mutation-capable Worker receives production traffic, quiesce the
legacy public merge path by deploying the compatibility callables with
`AUTH_DISABLE_MERGE=true` from the retained complete checkout. The other values
below match the tracked Worker configuration; if another kill switch is active
in production, use that same value here:

```sh
AUTH_DISABLE_ROOT="$(mktemp -d)"
git worktree add --detach "$AUTH_DISABLE_ROOT/repo" f6ae7878a
cat > "$AUTH_DISABLE_ROOT/repo/cloud/functions/.env.mons-link" <<'EOF'
APPLE_AUDIENCES=link.mons
SIWE_ALLOWED_DOMAINS=mons.link,www.mons.link,localhost,127.0.0.1
AUTH_DISABLE_APPLE_VERIFY=false
AUTH_DISABLE_X_VERIFY=false
AUTH_DISABLE_UNLINK=false
AUTH_DISABLE_MERGE=true
EOF
npm --prefix "$AUTH_DISABLE_ROOT/repo/cloud/functions" ci
npm --prefix "$AUTH_DISABLE_ROOT/repo/cloud/functions" run deploy:safe -- \
  verifySolanaAddress \
  verifyEthAddress \
  verifyAppleToken \
  completeXRedirectAuth \
  unlinkAuthMethod \
  --project mons-link
rm "$AUTH_DISABLE_ROOT/repo/cloud/functions/.env.mons-link"
git worktree remove "$AUTH_DISABLE_ROOT/repo"
rmdir "$AUTH_DISABLE_ROOT"
```

With legacy merges disabled, deploy every merge-aware game projector with this
non-pruning positional maintenance deployment:

```sh
npm --prefix cloud/functions run deploy:safe -- \
  projectProfileGamesOnInviteCreated \
  projectProfileGamesOnInviteGuestIdChanged \
  projectProfileGamesOnInviteHostRematchesChanged \
  projectProfileGamesOnInviteGuestRematchesChanged \
  projectProfileGamesOnMatchCreated \
  projectProfileGamesOnInviteMatchRatingUpdated \
  projectProfileGamesOnAutomatchQueueWritten \
  projectProfileGamesOnProfileLinkCreated \
  projectProfileGamesOnProfileLinkWritten \
  projectProfileGamesOnProfileDeleted \
  projectProfileGamesOnEventWritten \
  --project mons-link
```

With those projectors live, reconcile every existing `profileMergeTargets`
page while merges remain disabled. Preview a bounded page first, execute the
same page, then repeat both commands with the returned `nextCursor` as
`--after <source-profile-id>` until `hasMore` is false:

```sh
npm run reconcile:merge-projections -- --project mons-link --limit 20 --dry-run
npm run reconcile:merge-projections -- --project mons-link --limit 20 --execute
```

The command re-reads authoritative invites and events through the same reviewed
projection logic, repairs canonical target games, and removes retained source
games. Each merge target is streamed in fixed 200-document pages, so histories
larger than one page remain bounded without requiring another cursor.

While merges remain disabled, reconcile the historical wager settlement
ledgers too. Preview a bounded page, execute that page, then repeat both commands
with the returned `nextCursor` as `--after <operation-id>` until `hasMore` is
false:

```sh
npm run reconcile:wager-settlement-merges -- --project mons-link --limit 20 --dry-run
npm run reconcile:wager-settlement-merges -- --project mons-link --limit 20 --execute
```

In both this scan and the final scan below, every dry-run and execute page must
return top-level `"manualReviewRequired": false`. Do not execute or advance a
page while that value is true.

For a settlement committed strictly after a merge marker, the command repairs
the affected canonical side and records that side so retries cannot apply it
twice. A settlement committed before or at the same instant as its merge marker
cannot be classified safely: it returns `manual-review` and remains unmarked.
`would-partially-repair` and `partially-repaired` mean one side was repaired but
another still requires that review. For any of these three results, stop the
cutover and inspect the affected balances plus settlement and merge history.
Resolve every side marked `"reviewRequired": true`, and only those sides, by
deciding whether its wager delta was already `included` in the canonical
balance or was `lost` during the merge:

```sh
npm run reconcile:wager-settlement-merges -- --project mons-link --resolve <operation-id> --winner included --loser lost --dry-run
npm run reconcile:wager-settlement-merges -- --project mons-link --resolve <operation-id> --winner included --loser lost --execute
```

Omit `--winner` or `--loser` when that side does not require review. `included`
makes no balance change; `lost` applies that side's canonical delta. Confirm
`would-resolve`, then `resolved` or the retry-safe `already-reconciled`. Rerun
the blocked scan page after every listed operation is resolved, and advance only
when `"manualReviewRequired": false`. Document-ID pagination is not a snapshot,
so a legacy settlement created during this first pass could also sort behind its
cursor.

Keep merging disabled and promote the fixed Worker before the final pass. Use
the prepared secrets on this first candidate, smoke it, and promote its exact
version ID:

```sh
export AUTH_DISABLE_MERGE=true
npm run deploy:api -- preview --smoke-sol <known-wallet> --secrets-file /secure/mons-link-x-callback.env --token-file /path/to/cloudflare-token
npm run deploy:api -- production --version-id <merge-disabled-candidate-version-id> --smoke-sol <known-wallet> --token-file /path/to/cloudflare-token
```

The secrets file is accepted only in preview mode. The helper reads its JSON or
dotenv keys to reject `AUTH_DISABLE_*`, then passes the file directly to
`wrangler versions upload` without printing its values. Existing secrets omitted
from the file, including `HELIUS_RPC_API_KEY`, remain attached.

Once the fixed Worker serves production traffic, restart the wager settlement
scan from the beginning by omitting `--after`. Preview and execute every page
again until `hasMore` is false. Recorded repairs are safe and cheap to revisit;
an unresolved manual-review case would appear again. This pass catches any late
legacy settlement that sorted behind the first pass. Do not re-enable either
merge path until every page in this second full scan has returned
`"manualReviewRequired": false` and `hasMore` is false.

```sh
npm run reconcile:wager-settlement-merges -- --project mons-link --limit 20 --dry-run
npm run reconcile:wager-settlement-merges -- --project mons-link --limit 20 --execute
```

After every historical page succeeds and every review-required result is
resolved, prepare and smoke the merge-enabled candidate while both production
merge paths are still disabled. The compatibility callables still have
`AUTH_DISABLE_MERGE=true`, and the promoted Worker still has the same value:

```sh
export AUTH_DISABLE_MERGE=false
npm run deploy:api -- preview --smoke-sol <known-wallet> --token-file /path/to/cloudflare-token
```

Only after that exact candidate passes preview smoke, promote it and smoke the
production domain:

```sh
npm run deploy:api -- production --version-id <merge-enabled-candidate-version-id> --smoke-sol <known-wallet> --token-file /path/to/cloudflare-token
```

If promotion or production smoke fails, leave the compatibility callables
disabled and roll back the Worker. After production smoke passes, re-enable the
compatibility callables from a fresh retained checkout. Carry forward any
reviewed non-merge kill-switch overrides from the disable step:

```sh
AUTH_ENABLE_ROOT="$(mktemp -d)"
git worktree add --detach "$AUTH_ENABLE_ROOT/repo" f6ae7878a
cat > "$AUTH_ENABLE_ROOT/repo/cloud/functions/.env.mons-link" <<'EOF'
APPLE_AUDIENCES=link.mons
SIWE_ALLOWED_DOMAINS=mons.link,www.mons.link,localhost,127.0.0.1
AUTH_DISABLE_APPLE_VERIFY=false
AUTH_DISABLE_X_VERIFY=false
AUTH_DISABLE_UNLINK=false
AUTH_DISABLE_MERGE=false
EOF
npm --prefix "$AUTH_ENABLE_ROOT/repo/cloud/functions" ci
npm --prefix "$AUTH_ENABLE_ROOT/repo/cloud/functions" run deploy:safe -- \
  verifySolanaAddress \
  verifyEthAddress \
  verifyAppleToken \
  completeXRedirectAuth \
  unlinkAuthMethod \
  --project mons-link
rm "$AUTH_ENABLE_ROOT/repo/cloud/functions/.env.mons-link"
git worktree remove "$AUTH_ENABLE_ROOT/repo"
rmdir "$AUTH_ENABLE_ROOT"
```

Delete the local secrets file and downloaded service-account JSON after the
merge-disabled candidate has been promoted and their values are stored as
encrypted Worker secrets.

Preview and production smoke checks cover the NFT API, auth CORS and
unauthenticated responses, callback routing without a state value, and a random
absent state that proves Google OAuth and Firestore read access. A real X code
is intentionally not used by automated smoke checks.

Only after every listed projector is live, historical reconciliation is
complete, the merge-enabled Worker passes production smoke, and the
compatibility callables are re-enabled may the frontend version that calls the
mutation routes be promoted. After both production promotions, exercise X
sign-in and settings linking manually, including provider denial. Keep
`verifySolanaAddress`,
`verifyEthAddress`, `verifyAppleToken`, `completeXRedirectAuth`, and
`unlinkAuthMethod` deployed until the production matrix passes. During that
overlap, keep `AUTH_DISABLE_APPLE_VERIFY`, `AUTH_DISABLE_X_VERIFY`,
`AUTH_DISABLE_UNLINK`, and `AUTH_DISABLE_MERGE` identical in the Worker and
Firebase Functions; changing only the Worker leaves the public callable path
enabled. Then run
`npm run deploy:firebase -- --project mons-link --confirm-auth-prune` to prune
the callables together.
Already-open tabs using the former frontend must refresh.

If rollback is needed before pruning, roll back the frontend version first,
then the API version. The compatibility callables are still deployed, so do not
run the post-prune restoration.

If rollback is needed after pruning, first detach the main recovery consumer:

```sh
npx wrangler queues consumer remove mons-link-auth-recovery mons-link-api --config cloud/workers/api/wrangler.jsonc
```

If the temporary primary-DLQ replay consumer is attached, detach it too:

```sh
npx wrangler queues consumer remove mons-link-auth-recovery-dlq mons-link-api --config cloud/workers/api/wrangler.jsonc
```

Next restore the five callables from the complete detached checkout below with
merging disabled. The other dotenv values match the tracked Worker
configuration; if a kill switch is active in production, use that same value
here before deploying:

```sh
AUTH_ROLLBACK_ROOT="$(mktemp -d)"
git worktree add --detach "$AUTH_ROLLBACK_ROOT/repo" f6ae7878a
cat > "$AUTH_ROLLBACK_ROOT/repo/cloud/functions/.env.mons-link" <<'EOF'
APPLE_AUDIENCES=link.mons
SIWE_ALLOWED_DOMAINS=mons.link,www.mons.link,localhost,127.0.0.1
AUTH_DISABLE_APPLE_VERIFY=false
AUTH_DISABLE_X_VERIFY=false
AUTH_DISABLE_UNLINK=false
AUTH_DISABLE_MERGE=true
EOF
npm --prefix "$AUTH_ROLLBACK_ROOT/repo/cloud/functions" ci
npm --prefix "$AUTH_ROLLBACK_ROOT/repo/cloud/functions" run deploy:safe -- \
  verifySolanaAddress \
  verifyEthAddress \
  verifyAppleToken \
  completeXRedirectAuth \
  unlinkAuthMethod \
  --project mons-link
rm "$AUTH_ROLLBACK_ROOT/repo/cloud/functions/.env.mons-link"
git worktree remove "$AUTH_ROLLBACK_ROOT/repo"
rmdir "$AUTH_ROLLBACK_ROOT"
```

Then supply `CLOUDFLARE_API_TOKEN` in the shell and roll back the frontend
version before the API version:

```sh
node_modules/.bin/wrangler deployments list --config wrangler.jsonc
node_modules/.bin/wrangler rollback <known-good-frontend-version-id> --config wrangler.jsonc
node_modules/.bin/wrangler deployments list --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
node_modules/.bin/wrangler rollback <known-good-api-version-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Keep legacy merging disabled until a compatible recovery consumer is restored
and every buffered recovery task and pending profile marker is drained or
verified absent.

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

## Username editing

Authenticated username changes are served by:

- `POST https://api.mons.link/profiles/username`

The browser sends its Firebase ID token in the `Authorization: Bearer` header
and a strict `{ "username": "..." }` body. The Worker preserves the existing
trimmed, case-insensitive uniqueness contract, reserved-name rules, legacy
username-index cleanup, and the restriction that Apple- or X-only profiles
cannot clear their username. Firestore remains authoritative, and the Worker
uses a read-write Firestore REST transaction with bounded conflict retries.

Create one dedicated Google identity and a custom role with only the database
transaction and entity permissions used by username mutation:

```sh
gcloud iam roles create monsLinkUsernameMutation --project mons-link --title="mons.link username mutation" --permissions=datastore.databases.get,datastore.entities.create,datastore.entities.delete,datastore.entities.get,datastore.entities.list,datastore.entities.update --stage=GA
gcloud iam service-accounts create mons-link-username-api --project mons-link --display-name="mons.link username API"
gcloud projects add-iam-policy-binding mons-link --member="serviceAccount:mons-link-username-api@mons-link.iam.gserviceaccount.com" --role="projects/mons-link/roles/monsLinkUsernameMutation" --condition='expression=resource.name=="projects/mons-link/databases/(default)",title=default-firestore-only'
gcloud iam service-accounts keys create /secure/mons-link-username-api.json --project mons-link --iam-account=mons-link-username-api@mons-link.iam.gserviceaccount.com
```

Prepare an untracked secrets file outside the repository for the first
candidate or an intentional key rotation:

```dotenv
USERNAME_SERVICE_ACCOUNT_EMAIL=mons-link-username-api@mons-link.iam.gserviceaccount.com
USERNAME_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Upload and smoke-test the API candidate with that secrets file, promote the
exact API version, then promote the frontend. Automated production checks cover
preflight and unauthenticated responses and do not change a live username.
After the frontend promotion, run the complete Firebase release to reconcile
away the retired `editUsername` callable. Already-open tabs using the former
frontend must refresh.

Before Firebase reconciliation, rollback only the frontend and API versions.
After reconciliation, restore and deploy `editUsername` from commit
`e928329da`, then rollback both Workers. Delete the downloaded Google key and
the external secrets file once Cloudflare retains the encrypted secrets.

## Rating updates

Authenticated automatch rating completion is served by:

- `POST https://api.mons.link/ratings/update`

The browser sends its Firebase ID token and the acting login, opponent login,
invite, and match IDs. The Worker validates the invite participants and the
authoritative match replicas, resolves the result with `mons-rules`, and uses
the `ratingUpdates/{inviteId}__{matchId}` Firestore lease. The shared record
keeps concurrent clients and retries from applying the same match twice.

The Worker commits both profile changes and the completed rating record in one
Firestore transaction. It then repairs the RTDB completion and timer markers.
The Worker stores non-event Telegram projection state in the completed rating
record and wakes the dedicated projection Queue. Its five-minute recovery sweep
re-enqueues pending records after an immediate Queue failure. The retained
`projectRatingTelegramUpdates` Firebase trigger handles only event progress;
automatch and rating projections persist desired state and then enqueue the
Cloudflare delivery Queue directly before completing their pending markers.

The dedicated `mons-link-rating-api` service account uses the
`monsLinkRatingMutation` custom role, conditioned on the default Firestore
database. The role contains exactly `datastore.databases.get`,
`datastore.entities.create`, `datastore.entities.get`,
`datastore.entities.list`, and `datastore.entities.update`.

For key rotation, create a replacement key in a protected temporary directory:

```sh
umask 077
gcloud iam service-accounts keys create /secure/mons-link-rating-api.json --project mons-link --iam-account=mons-link-rating-api@mons-link.iam.gserviceaccount.com
```

Prepare an untracked external secrets file from that key:

```dotenv
RATING_SERVICE_ACCOUNT_EMAIL=mons-link-rating-api@mons-link.iam.gserviceaccount.com
RATING_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Upload and smoke-test an API candidate with the secrets file, then promote that
exact version. Confirm both rating secret names are present on the promoted
Worker before deleting the downloaded key and external secrets file. Revoke the
previous Google key only after the new Worker version is confirmed healthy.

## Telegram delivery

Telegram desired records remain in Firebase RTDB, while every producer now
enqueues delivery explicitly. Worker-owned automatch and rating projections use
the `TELEGRAM_DELIVERY_QUEUE` binding. Retained event projectors persist guarded
desired records, call the HMAC-protected Worker bridge, and advance projection
state only after every enqueue succeeds. Admin sends and manual recovery use the
same bridge with a protected secret file. Manual recovery operations are
documented in [cloud operations](../cloud/README.md).

## Firebase deployment

- Deploy the complete Firebase release after reviewing its dry run:
  `npm run deploy:firebase -- --project mons-link --confirm-auth-prune`
- See `cloud/README.md` for dry-run, batch-size, and maintenance commands.
