# mons cloud operations

Run commands from the repository root. See the repository [architecture and command map](../README.md) for package boundaries and the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md) for API release, maintenance, and rollback procedures.

Firebase Auth and Realtime Database remain active. The API Worker owns manual invite, join, match creation, and rematch mutations; auth; profile and leaderboard reads; profile customization; username mutation; mining; gameplay; event-prize selection, withdrawal, and canonical projection; profile-link catch-up; rating-, invite-, automatch-, and event-driven profile-game projection; event control and progress Workflows; X callback; event Telegram projection; and Worker-backed Telegram delivery.

`mons-link-profiles` D1 contains the canonical profile, ownership, auth, recovery, rating, wager, and transaction-guard tables. The temporary Commit 1 bridge keeps Firestore authoritative until the one-shot frozen import. Commit 2 is permanently D1-only; Firestore then remains read-only for 30 days as an audit snapshot, not as a runtime fallback.

The browser resolves login-linked profile presentation only through the authenticated profile API. Invite role and write ownership come from the authenticated gameplay API using authoritative RTDB links; browser code must not read or subscribe to `players/{uid}/profile`.

Event-prize withdrawal ownership, leases, persisted Solana submissions, and completion records live exclusively in `mons-link-event-prize-withdrawals` D1. RTDB has no withdrawal shadow, and Firebase-backed Worker versions are not valid rollback targets.

## Forward-only profile cutover

The shared control row moves only through `firestore → importing → frozen → active`; `active → frozen` remains the permanent maintenance switch. The Commit 1 bridge writes only in `firestore`. The Commit 2 Worker writes only in `active`. Older bridge versions therefore stay blocked after import begins, including version-pinned Workflows.

In blocked states, HTTP mutations return `503 profile-writes-disabled` with `Retry-After: 60`, profile Queue messages retry without acknowledgement, and profile sweeps pause. Auth-state expiry, game-receipt cleanup, and unrelated Telegram delivery continue. `AUTH_MUTATIONS_DISABLED` remains an independent auth-maintenance switch.

The additive schema and migration tool are present in the repository, but no remote schema application, import, Worker promotion, trigger change, IAM change, or production cutover is implied. The default migration mode is read-only:

```sh
npm run migrate:profile-canonical -- --dry-run --project mons-link
```

This command reads production Firestore and emits only counts and stale-index totals. It also preflights every normalized row and complete D1 request plan without writing either store. After `manage:profile-canonical -- --begin-import` freezes all writers, `--execute` claims one private digest/version and runs idempotent batches from batch one. On interruption, rerun the same command. Exact parity and query plans are required before the importer moves control to `frozen`. Run mutating commands only within the reviewed cutover in the deployment guide, and never copy private comparison material into logs.

## Setup

```sh
npm ci
npm ci --prefix cloud/functions
npm ci --prefix cloud/admin
```

The Realtime Database emulator requires Java 21 or newer.

Use Application Default Credentials for admin tools:

```sh
gcloud auth application-default login
```

## Firebase rule releases

Preview the complete release without starting a Firebase process:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
```

Deploy Realtime Database rules followed by Firestore rules and indexes:

```sh
npm run deploy:firebase -- --project mons-link
```

The Firebase configuration intentionally has no Functions codebase. Review the dry-run first; the release helper cannot create or reconcile Cloud Functions.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` remains an independent auth maintenance switch. Change and release it as reviewed Worker configuration; do not create environment-specific copies or Dashboard overrides.

New auth intents and X redirect flows are stored in the `mons-link-auth-state` D1 database through `AUTH_STATE_DB`; legacy verified, completed, and failed X flows were backfilled during that separate cutover. Firebase Auth remains active. Commit 1 profile documents and auth replays remain Firestore-backed; Commit 2 uses canonical D1 permanently. Auth-state D1 is consume-once and revision-fenced. After a one-hour grace, the Worker schedule removes expired created/processing rows and compacts obsolete proof material; verified/completed/failed replays are retained for 30 days. Do not manually edit or delete active rows.

`mons-link-auth-recovery` is the permanent recovery Queue. Its consumer applies `authRecoveryJobs` idempotently, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record.

## Profile read-model recovery

While Commit 1 remains in control state `firestore`, the profile read-model Queue carries best-effort profile ID notifications after committed Firestore mutations. Its consumer rereads Firestore before applying a version-fenced D1 projection. Every five minutes in that state, the Worker scans Firestore profile metadata, repairs missing or mismatched projections, and rechecks apparent deletions before applying version-fenced tombstones. A relevant `profile_projection_failures` row fences the affected profile or login read, while any failure row globally fences leaderboards. Validation fences persist until the source profile is corrected or the projection schema changes.

Cron reconciliation is the durable recovery path before canonical cutover. Investigate failed scheduled invocations, Queue backlog, projection errors, and failure rows; do not purge the Queue or manually rewrite D1 projection state. The Queue, failure fences, Firestore adapters, and read-model tables remain during the 30-day retention window; their cleanup is deferred and must not be folded into the initial cutover.

## Profile-game projection recovery

`mons-link-profile-game-projection` permanently owns rating, manual invite, automatch, event, and profile-link projections. Manual game-session mutations use per-invite leases and UUID receipts, then atomically persist their source writes and the historically named `profileGameProjectionOutbox/automatch/{inviteId}` marker. Producers persist durable markers before enqueueing, and the five-minute Worker schedule repairs and re-enqueues stale markers while request fencing preserves newer work and recoverable cleanup owners. The same schedule removes game-session mutation receipts after seven days.

Investigate stuck work through Queue consumption, pending marker age, and projection logs. Do not purge the Queue, delete a pending outbox, manually delete profile documents, or manually rewrite canonical profile-event prizes.

## Auth cooldown cleanup

Only before `begin-import`, preview indexed expired records, then execute the same cleanup:

```sh
node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --dry-run
node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --execute
```

After freezing Firestore, never run this cleanup. Canonical D1 owns expiration cleanup after cutover, and Firestore remains an unchanged audit snapshot.

## Telegram recovery and announcements

Event Telegram projection runs through `mons-link-telegram-projection`. Every supported API or Workflow mutation writes `telegramProjectionOutbox/event/{eventId}` and increments `eventTelegramProjectionGenerations/{eventId}` atomically with the event update. The five-minute Worker schedule recovers pending markers; direct Firebase client event writes are disabled.

Restore protected operator credentials only when needed:

```sh
umask 077
firebase functions:secrets:access TELEGRAM_QUEUE_BRIDGE_SECRET --project mons-link > /secure/telegram-queue-bridge-secret
firebase functions:secrets:access TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET --project mons-link > /secure/telegram-announcement-secret
```

The Queue bridge and announcement bridge are separate credentials.

Delivery and recovery records live in the `mons-link-telegram` D1 database. Ambiguous sends remain `uncertain` and are never retried automatically. Preview and execute one reviewed recovery action through the signed Worker command endpoint:

```sh
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --execute
```

Use `confirm-send-applied --message-id <telegram-message-id>` when Telegram created the message, or `abandon` to retain the audit record and stop delivery.

Smoke the event-prize route without publishing, then run the confirmed operation:

```sh
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret --smoke
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret
```

An uncertain Telegram response requires checking the group before retrying.

## Other admin tools

Canonical profile admin readers require an imported canonical store and an explicit `CLOUDFLARE_API_TOKEN` scoped to Account D1 Read for `mons-link-profiles`. They accept `frozen` and `active`, fail closed before import finalization, and never fall back to Firestore or the Wrangler login token. Use a separate read-only operator token supplied through the process environment; do not place it in arguments or logs.

List profile addresses:

```sh
npm --prefix cloud/admin start -- --out-eth /secure/eth-addresses.txt --out-sol /secure/sol-addresses.txt
```

At least one output path is required. Address exports create new mode-`0600` files and refuse to overwrite an existing path; stdout contains counts only.

Publish GP, MP, or shooting-star leaderboard messages through the Queue bridge:

```sh
node cloud/admin/topGpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
node cloud/admin/topMpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
npm --prefix cloud/admin run shooting:alert -- --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link
```
