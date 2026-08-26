# mons cloud operations

Run commands from the repository root. See the repository [architecture and command map](../README.md) for package boundaries and the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md) for API release, maintenance, and rollback procedures.

Firebase retains the five manual invite and match projection triggers, event-prize withdrawal, and the existing Firebase data stores. The API Worker owns auth, profile and leaderboard reads, profile customization, username mutation, mining, gameplay, event-prize selection and canonical projection, profile-link catch-up, rating-, automatch-, and event-driven profile-game projection, event control and progress Workflows, X callback, event Telegram projection, and Worker-backed Telegram delivery.

## Setup

```sh
npm ci
npm ci --prefix cloud/functions
npm ci --prefix cloud/admin
npm install -g firebase-tools
```

Use Application Default Credentials for admin tools:

```sh
gcloud auth application-default login
```

## Firebase releases

Preview the complete release without starting a Firebase process:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
```

Deploy Realtime Database rules, exported functions, Firestore rules, and indexes, then reconcile the deployed Functions manifest:

```sh
npm run deploy:firebase -- --project mons-link
```

The full release reconciles deployed Functions with the current export manifest. Review the dry-run first. Use a positional maintenance deployment when full reconciliation is not intended:

```sh
npm --prefix cloud/functions run deploy:safe -- <function-name> --project mons-link
```

For the forward profile-projection cutover, do not start with the full release. Follow the ordered cutover in the Cloudflare deployment guide so the additive database and Firestore indexes are ready before the Worker takes ownership and the legacy Functions are reconciled.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the only auth maintenance switch. Change and release it as reviewed Worker configuration; do not create environment-specific copies or Dashboard overrides.

`mons-link-auth-recovery` is the permanent recovery Queue. Its consumer applies `authRecoveryJobs` idempotently, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record.

## Event profile-game projection recovery

Event mutations atomically accumulate prior owners under `profileGameProjectionOutbox/event/{eventId}` before enqueueing the permanent profile-game projection Queue. The five-minute Worker schedule re-enqueues stale markers. Preview a production reconciliation, then execute and wait for Cloudflare to clear the exact marker and verify every canonical Firestore projection:

```sh
node cloud/admin/reconcileEventProfileGames.js --sample --project mons-link
node cloud/admin/reconcileEventProfileGames.js --sample --project mons-link --execute --wait
```

Do not purge the Queue or delete a pending outbox. Malformed markers are repaired in place and re-enqueued while preserving recoverable cleanup owners.

## Profile-link projection recovery

Profile-link changes atomically persist `profileGameProjectionOutbox/profile/{loginUid}` before the API Worker attempts to enqueue the permanent profile-game projection Queue. The five-minute schedule recovers stale markers, and request IDs prevent an older task from clearing a newer link change. Preview a production candidate, then execute and wait for the marker to settle:

```sh
npm run reconcile:profile-link-games -- --sample --project mons-link
npm run reconcile:profile-link-games -- --sample --project mons-link --execute --wait
```

Profile documents must not be deleted manually. Audit bounded pages of profile-game documents and explicitly delete only confirmed orphans:

```sh
npm run audit:orphan-profile-games -- --project mons-link --dry-run
npm run audit:orphan-profile-games -- --project mons-link --execute
```

Repeat bounded pages with the reported `--after <nextCursor>` until a clean pass reports no orphans.

Reconcile profile-event prizes across merge targets with a dry-run immediately before each execute page. Conflicts are retained for review and never overwritten:

```sh
npm run reconcile:profile-event-prizes -- --project mons-link --dry-run
npm run reconcile:profile-event-prizes -- --project mons-link --execute
```

Repeat bounded pages with the reported `--after <nextCursor>`, then restart from the beginning and require a clean dry-run pass.

## Auth cooldown cleanup

Preview indexed expired records, then execute the same cleanup:

```sh
node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --dry-run
node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --execute
```

## Telegram recovery and announcements

Event Telegram projection runs through `mons-link-telegram-projection`. Every supported API or Workflow mutation writes `telegramProjectionOutbox/event/{eventId}` and increments `eventTelegramProjectionGenerations/{eventId}` atomically with the event update. The five-minute Worker schedule recovers pending markers; direct Firebase client event writes are disabled.

Restore protected operator credentials only when needed:

```sh
umask 077
firebase functions:secrets:access TELEGRAM_QUEUE_BRIDGE_SECRET --project mons-link > /secure/telegram-queue-bridge-secret
firebase functions:secrets:access TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET --project mons-link > /secure/telegram-announcement-secret
```

The Queue bridge and announcement bridge are separate credentials.

Ambiguous sends remain `uncertain` and are never retried automatically. Preview and execute one reviewed recovery action:

```sh
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link --execute
```

Use `confirm-send-applied --message-id <telegram-message-id>` when Telegram created the message, or `abandon` to retain the audit record and stop delivery.

Smoke the event-prize route without publishing, then run the confirmed operation:

```sh
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret --smoke
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret
```

An uncertain Telegram response requires checking the group before retrying.

## Other admin tools

List profile addresses:

```sh
npm --prefix cloud/admin start -- --project mons-link --out-eth /tmp/eth_addresses.txt --out-sol /tmp/sol_addresses.txt
```

Publish GP, MP, or shooting-star leaderboard messages through the Queue bridge:

```sh
node cloud/admin/topGpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
node cloud/admin/topMpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
npm --prefix cloud/admin run shooting:alert -- --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link
```
