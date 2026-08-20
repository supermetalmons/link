# mons cloud operations

Run all commands from the repository root.

See the repository [architecture and command map](../README.md) for package boundaries. Cloudflare Worker release and rollback procedures are documented in the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md).

The auth, profile, leaderboard, mining, and gameplay APIs, X OAuth callback,
dedicated Google service accounts, and encrypted Worker secret setup are
documented in that deployment guide.
Firebase retains auth verification/linking, the X completion callable, the
remaining game and event functions, and the existing Firestore auth records.

## Setup

`npm ci --prefix cloud/functions`

`npm ci --prefix cloud/admin`

`npm install -g firebase-tools`

Set `TELEGRAM_QUEUE_BRIDGE_SECRET` for both retained Telegram dispatch triggers. The Cloudflare Queue migration, hard cutover, recovery, and rollback procedure is documented in the [Telegram delivery migration guide](../scripts/migrate-telegram-delivery.md).

The Telegram bot token, community chat ID, and dedicated announcement bridge
secret are encrypted Worker secrets. Event prize operations use a separate
`TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET`; never use the queue bridge secret. Restore
the protected operator file from Secret Manager when needed:

`umask 077; firebase functions:secrets:access TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET --project mons-link > /secure/telegram-announcement-secret`

## Live Firebase operations

These commands deploy Firebase services or export live authentication data.

Deploy Realtime Database rules, every exported function, then Firestore rules and indexes through the production release driver:

`npm run deploy:firebase -- --project mons-link`

Full releases finish the Functions phase with a forced manifest reconciliation. This removes deployed Firebase-managed Functions that are no longer exported locally. Positional maintenance deployments do not prune other Functions.

Preview the same release without starting any Firebase process:

`npm run deploy:firebase -- --project mons-link --dry-run`

Change only the quota-oriented function batch size:

`npm run deploy:firebase -- --project mons-link --batch-size 5`

Deploy a single function for maintenance:

`npm --prefix cloud/functions run deploy:safe -- verifyEthAddress --project mons-link`

## Telegram delivery recovery

Ambiguous sends stay at `telegramMessages/{messageKey}/delivery/status = uncertain` and are never retried automatically. Resolve one by writing a new unique `requestId` under `telegramMessages/{messageKey}/manualRecovery` with one of these payloads:

- `{ "requestId": "...", "action": "confirm-send-absent" }` when Telegram did not create the message.
- `{ "requestId": "...", "action": "confirm-send-applied", "messageId": 123 }` when Telegram created it.
- `{ "requestId": "...", "action": "abandon" }` to retain the audit record and stop delivery.

The recovery dispatcher is idempotent by `requestId`. Retry-window exhaustion remains visible through `delivery/deadLetterAtMs`, and failed stale-message cleanup remains visible under `delivery/orphanedDeletes`.

`AUTH_EXPORT_PATH="$(mktemp)" && firebase auth:export "$AUTH_EXPORT_PATH" --config cloud/firebase.json --project mons-link --format=json && echo "Exported to $AUTH_EXPORT_PATH"`

## Admin address listing

Authenticate with Application Default Credentials before running the address commands:

`gcloud auth application-default login`

`npm --prefix cloud/admin start`

`npm --prefix cloud/admin start -- --project mons-link --out-eth /tmp/eth_addresses.txt --out-sol /tmp/sol_addresses.txt`

## Auth cooldown cleanup

The recurring cleanup uses the `retryAtMs` index in both cooldown collections, so it reads only expired candidates. Preview the candidates first:

`node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --dry-run`

Delete them using the explicit execution flag:

`node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --execute`

After deploying this cleanup, run one legacy-compatible preview to find older records that do not have a numeric `retryAtMs`:

`node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --scan-legacy --dry-run`

Then delete expired legacy records and normalize active legacy records for future indexed cleanup:

`node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --scan-legacy --execute`

Records without a resolvable expiry are retained. Repeat the legacy scan after importing old data, manually writing legacy-shaped records, or rolling back to a writer that does not store `retryAtMs`.

## Telegram leaderboard announcements

The GP and MP tools publish to the configured community destination. They default to 15 entries and accept one integer limit from 1 through 90:

`node cloud/admin/topGpWithEmojis.js`

`node cloud/admin/topGpWithEmojis.js 25`

`node cloud/admin/topMpWithEmojis.js 25`

## Event prize announcements

Event prize albums are sent synchronously through the HMAC-protected API Worker
route. Use the dedicated announcement-secret file. Validate the live route and
credential without sending to Telegram:

`npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret --smoke`

Preview, confirm, and send an announcement interactively:

`npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret`

Or provide the event and single-line announcement explicitly; confirmation is
still required:

`npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret FRkdorMWaYW "Win compressed NFTs"`

An uncertain Telegram response is never retried automatically. Check the group
before invoking the command again.

## Auth rollout configuration

These are configuration values, not standalone shell commands.

`AUTH_DISABLE_APPLE_VERIFY=true`

`AUTH_DISABLE_X_VERIFY=true`

X verification is initiated by the API Worker and completed by Firebase. Keep
`AUTH_DISABLE_X_VERIFY` synchronized across both deployments; changing the
Worker value requires a reviewed API Worker version release.

`AUTH_DISABLE_UNLINK=true`

`AUTH_DISABLE_MERGE=true`
