# mons cloud operations

Run all commands from the repository root.

See the repository [architecture and command map](../README.md) for package boundaries. Cloudflare Worker release and rollback procedures are documented in the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md).

The auth, profile, leaderboard, mining, gameplay, and event participation APIs,
profile-claim synchronization, provider verification, X OAuth completion and
callback, dedicated Google service accounts, and encrypted Worker secret setup
are documented in that deployment guide. Firebase retains the remaining event
functions, event-progress rating projection, and the existing Firestore auth
records.
Automatch and non-event rating Telegram
projection run in the API Worker with durable Firebase-backed pending state;
the Worker and retained event projectors enqueue delivery directly. Manual
recovery is initiated through the authenticated operator command.
Username editing is owned by the API Worker; its dedicated service account and
cutover procedure are documented in the Cloudflare deployment guide.

## Setup

`npm ci --prefix cloud/functions`

`npm ci --prefix cloud/admin`

`npm install -g firebase-tools`

`TELEGRAM_QUEUE_BRIDGE_SECRET` remains attached to the retained event Telegram
projectors and the API Worker queue bridge. Restore its protected operator file
when running announcement or recovery tools:

`umask 077; firebase functions:secrets:access TELEGRAM_QUEUE_BRIDGE_SECRET --project mons-link > /secure/telegram-queue-bridge-secret`

The Telegram bot token, community chat ID, and dedicated announcement bridge
secret are encrypted Worker secrets. Event prize operations use a separate
`TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET`; never use the queue bridge secret. Restore
the protected operator file from Secret Manager when needed:

`umask 077; firebase functions:secrets:access TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET --project mons-link > /secure/telegram-announcement-secret`

## Live Firebase operations

These commands deploy Firebase services or export live authentication data.

Deploy Realtime Database rules, every exported function, then Firestore rules and indexes through the production release driver:

`npm run deploy:firebase -- --project mons-link --confirm-auth-prune`

Live full releases require `--confirm-auth-prune` before starting any Firebase
process. The Functions phase ends with forced manifest reconciliation, which
removes all deployed Firebase-managed Functions that are no longer exported
locally. Until the auth production matrix passes, use only dry runs or
positional maintenance deployments; maintenance deployments do not prune other
Functions.

Preview the same release without starting any Firebase process:

`npm run deploy:firebase -- --project mons-link --dry-run`

Change only the quota-oriented function batch size:

`npm run deploy:firebase -- --project mons-link --batch-size 5 --confirm-auth-prune`

Deploy a single retained function for maintenance:

`npm --prefix cloud/functions run deploy:safe -- createEvent --project mons-link`

## Telegram delivery recovery

Ambiguous sends stay at `telegramMessages/{messageKey}/delivery/status = uncertain` and are never retried automatically. Preview and execute exactly one reviewed recovery action with the protected queue-bridge secret:

`npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link`

`npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link --execute`

Use `--action confirm-send-applied --message-id <telegram-message-id>` when Telegram created the uncertain message. Use `--action abandon` to retain the audit record and stop delivery. The command validates the uncertain send marker, writes a unique request, queues it through Cloudflare, and waits for the matching result.

If the bridge is unavailable after the request is written, retry the same command. It resumes the matching request without replacing it. Recovery remains idempotent by `requestId`. Retry-window exhaustion remains visible through `delivery/deadLetterAtMs`, and failed stale-message cleanup remains visible under `delivery/orphanedDeletes`.

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

## Profile merge projection reconciliation

Keep profile merging disabled while running the one-time reconciliation. Read
the exact compatibility-callable disable/re-enable steps, cutover order, and
bounded dry-run/execute pagination procedure in the
[Cloudflare deployment guide](../scripts/deploy-cloudflare.md).

## Telegram leaderboard announcements

The GP and MP tools publish to the configured community destination. They default to 15 entries and accept one integer limit from 1 through 90:

`node cloud/admin/topGpWithEmojis.js --bridge-secret-file /secure/telegram-queue-bridge-secret`

`node cloud/admin/topGpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret`

`node cloud/admin/topMpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret`

The shooting-star tool uses the same queue bridge:

`npm --prefix cloud/admin run shooting:alert -- --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link`

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

`AUTH_DISABLE_UNLINK=true`

`AUTH_DISABLE_MERGE=true`

The cutover guide temporarily disables the legacy merge path while the
mutation-capable Worker remains unpromoted. Once that Worker receives production
traffic and until the five compatibility callables are pruned, keep all four
values identical in the API Worker and deployed Firebase Functions. A
Worker-only change does not disable the public callable path. After pruning,
these values are Worker-owned. Every API preview upload requires all four values
as explicit shell inputs; the release helper embeds them in Wrangler's temporary
strict-validation configuration so an active switch cannot be reset by a
routine release. See the
[Cloudflare deployment guide](../scripts/deploy-cloudflare.md). Secrets files
must not contain `AUTH_DISABLE_*`; those reviewed values come only from the
explicit shell inputs.
