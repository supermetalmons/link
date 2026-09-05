# mons cloud operations

Run commands from the repository root. See the repository [architecture and command map](../README.md) for package boundaries and the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md) for API release and maintenance procedures.

Firebase Auth remains active. Realtime Database retains active invites, match synchronization, and `matchTimerClaims`. The API Worker owns manual invite, join, match creation, and rematch mutations; auth; profile and leaderboard reads; profile customization; username mutation; mining; gameplay; D1-backed events and prizes; profile-link catch-up; profile-game projection; event control and progress Workflows; X callback; event Telegram projection; and Worker-backed Telegram delivery.

`mons-link-profiles` D1 permanently contains the canonical profile, ownership, auth, recovery, rating, wager, and transaction-guard tables. `PROFILE_DB.profile_login_owners` is the sole source for Worker login UID to canonical profile ownership, including merge-target resolution. There is no alternate profile store or fallback; an unreadable or corrupt ownership topology fails closed with `503 profile-ownership-unavailable`.

Firebase custom `profileId` claims and RTDB `players/{uid}/profile` links are non-authoritative compatibility shadows. They remain only for browser Realtime Database Security Rules, claim and link recovery, and missing-profile cleanup. Worker authorization and canonical projection ownership never fall back to either shadow.

Ownership-dependent operations use one D1 snapshot for each authorization decision. A merge committed after that snapshot does not abort an RTDB write already in progress; later operations and projections observe the merged owner, while D1 rating and wager effects converge safely. Event synchronization fails closed before creating a new invite or prize assignment when participant owners already converge.

The browser resolves login-linked profile presentation only through the authenticated profile API. Invite role and write ownership come from the authenticated gameplay API using canonical D1 ownership; browser code must not read or subscribe to `players/{uid}/profile`.

Historical rematch snapshots are read through the public Worker endpoint and stored immutably in `mons-link-profile-games` D1. Rated snapshots take precedence over transition snapshots. D1 is the sole public-history source; there is no RTDB read-through or backfill path. Active match synchronization remains in RTDB.

Rating completion evidence is read only from `mons-link-profiles` D1: canonical `rating_updates` rows with `status = 'done'` prove new completions, and `legacy_rating_completions` preserves historical completions without full rating records.

Manual game-session mutation locks and match-timer start markers live in `mons-link-profile-games` D1. Locks are 60-second owner-and-operation-fenced leases; the five-minute schedule removes at most 1,000 expired rows. Timer markers are removed eagerly on terminal and rating paths, and the same schedule durably reconciles a bounded oldest-first batch. `matchTimerClaims` stays in RTDB because Realtime Database Security Rules use it to fence direct browser match writes.

Background automatch, rating, and profile-link game projections share per-invite locks in `PROFILE_GAMES_DB.profile_game_projection_locks`. Profile-link processing also holds a per-login lock in the same table. Leases expire after 15 minutes, releases require the current owner, and the five-minute projection sweep removes at most 1,000 expired rows. Event projection leases remain in `EVENT_DB`. Pending automatch projection records remain in RTDB. Profile-link catch-up jobs live in `PROFILE_DB.profile_link_catchup_jobs`; canonical owner changes persist their job in the same D1 transaction. Queue dispatch and the scheduled sweep use those durable jobs.

Event records, participants, prize selections, visible prize assignments, progress markers, and event-specific projection state live exclusively in `mons-link-events` D1. Browser event subscriptions poll authenticated Worker snapshots; RTDB has no event mirror.

Event-prize withdrawal ownership, leases, persisted Solana submissions, and completion records live exclusively in `mons-link-event-prize-withdrawals` D1. RTDB has no withdrawal shadow.

Withdrawal storage must be frozen before an operator terminates a withdrawal Workflow. Resuming storage to `d1` explicitly authorizes retained terminated instances to be recreated from their durable D1 state.

## Canonical profile maintenance

The canonical writer control has two states: `active` and `frozen`. Freeze is the operator stop for schema maintenance and incidents; resume re-enables writes. In `frozen`, HTTP mutations return `503 profile-writes-disabled` with `Retry-After: 60`, profile Queue messages retry without acknowledgement, and profile sweeps pause. Auth-state expiry, game-receipt cleanup, and unrelated delivery work continue.

```sh
npm run manage:profile-canonical -- --status
npm run manage:profile-canonical -- --freeze
npm run manage:profile-canonical -- --resume
```

Freeze before applying a profile schema migration, validate the schema and foreign keys, then resume only after the production smoke passes. `AUTH_MUTATIONS_DISABLED` remains an independent auth-maintenance switch.

## Setup

```sh
npm ci
npm ci --prefix cloud/functions
npm ci --prefix cloud/admin
```

The Realtime Database emulator requires Java 21 or newer. Its rules cover active gameplay; canonical event-data paths are retired.

## Firebase rule releases

Preview the complete release without starting a Firebase process:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
```

Deploy Realtime Database rules:

```sh
npm run deploy:firebase -- --project mons-link
```

The Firebase configuration contains only active-gameplay Realtime Database rules. Review the dry-run first; the release helper cannot create Firestore, Hosting, Cloud Functions, or event resources.

## Event storage maintenance

`mons-link-events` supports `d1` and `frozen` storage modes:

```sh
npm run manage:events -- --status
npm run manage:events -- --freeze
npm run manage:events -- --resume-d1
npm run manage:events -- --recover-stale-admission <admission-id>
```

Freeze withdrawals and canonical-profile writes before maintenance that touches event state and its dependent effects. Wait for active requests and leases to drain. Status reports D1 leases, admissions and pending transitions. Recover only an expired admission whose request has finished. Pending transitions remain fenced and retry automatically; repair their underlying implementation or dependency failure while frozen. Successful `eventTransitionReceipts` are live coordination evidence and remain immutable.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` remains an independent auth maintenance switch. Change and release it as reviewed Worker configuration; do not create environment-specific copies or Dashboard overrides.

Auth intents and X redirect flows are stored in the `mons-link-auth-state` D1 database through `AUTH_STATE_DB`. Firebase Auth remains active. Auth-state D1 is consume-once and revision-fenced. After a one-hour grace, the Worker schedule removes expired created/processing rows and compacts obsolete proof material; verified/completed/failed replays are retained for 30 days. Do not manually edit or delete active rows.

`mons-link-auth-recovery` is the permanent recovery Queue. Its consumer applies `authRecoveryJobs` idempotently, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record.

## Profile-game projection recovery

`mons-link-profile-game-projection` permanently owns rating, manual invite, automatch, event, and profile-link projections. Manual game-session mutations use D1 per-invite leases and UUID receipts, then atomically persist their RTDB source writes and the historically named `profileGameProjectionOutbox/automatch/{inviteId}` marker. Automatch starts require a client operation ID, use a stable operation-scoped D1 lease, and commit a result receipt for every successful response, including an already-owned pending queue. The frontend reuses the exact unresolved request for seven days and serializes tabs with Web Locks; browsers without origin-wide locking fail before the request. After the seven-day boundary, a click is a new user action rather than a replay. Producers persist durable markers before enqueueing, and the five-minute Worker schedule repairs and re-enqueues stale markers while request fencing preserves newer work and recoverable cleanup owners. The same schedule removes game-session mutation receipts after seven days and expired D1 mutation leases in bounded batches.

Investigate stuck work through Queue consumption, pending marker age, and projection logs. Do not purge the Queue, delete a pending outbox, manually delete profile documents, or manually rewrite canonical profile-event prizes.

## Gameplay coordination

`mons-link-profile-games` D1 owns gameplay mutation leases and timer-start markers. The bounded reconciliation sweep checks the opponent metadata before removing stale timer markers. Active match writes still depend on the RTDB `matchTimerClaims` fence. A committed automatch operation returns its receipted result; an unproven coordination failure returns a sanitized `503`.

## Wager reservation storage

`wager_frozen_balances` and `wager_frozen_operations` in `mons-link-profiles` store reserved materials and replay records keyed by participant login UID. Active operations, consumed tombstones, pending settlements, total mining balances and settlement receipts are current application data.

The browser polls authenticated `POST /wagers/frozen/read` snapshots every two seconds while visible and refreshes after wager actions. HTTP wager mutations require `X-Mons-Wager-Storage-Version: 1`. Reads remain available while reservation writes are frozen. A complete HTTP wager mutation or queued settlement holds its admission until it finishes.

```sh
npm run manage:profile-canonical -- --freeze
npm run manage:wager-reservations -- --status
npm run manage:wager-reservations -- --freeze
npm run manage:wager-reservations -- --recover-admission <admission-id> --confirm-request-finished --confirm-source-reconciled
npm run manage:wager-reservations -- --resume-d1
npm run manage:profile-canonical -- --resume
```

Recover only the named expired admission after investigating its request and reconciling any uncertain effect. Reservation resume requires admissions and gameplay leases to drain. Wager settlement retries use `mons-link-telegram-delivery`, so include that Queue in maintenance. During incidents keep writes frozen and repair forward. Production API version previews remain disabled.

## Telegram recovery and announcements

Event Telegram projection runs through `mons-link-telegram-projection`. Every supported API or Workflow mutation writes `EVENT_DB.event_telegram_projection_outboxes` and increments the generation in `event_telegram_projection_state` atomically with the event update. The five-minute Worker schedule recovers pending markers; direct Firebase client event writes are disabled.

Operator bridge credentials are provisioned as protected local files. Pass their paths explicitly with `--bridge-secret-file`; commands do not load Firebase secrets or use an environment fallback. The standard files are `/Users/ivan/.config/mons-link/secrets/telegram-queue` and `/Users/ivan/.config/mons-link/secrets/telegram-announcement`. They contain separate credentials.

Delivery and recovery records live in the `mons-link-telegram` D1 database. Ambiguous sends remain `uncertain` and are never retried automatically. Preview and execute one reviewed recovery action through the signed Worker command endpoint:

```sh
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue --execute
```

Use `confirm-send-applied --message-id <telegram-message-id>` when Telegram created the message, or `abandon` to retain the audit record and stop delivery.

Send a confirmed event-prize announcement with an explicit event and collection name:

```sh
npm run announceEventPrizes -- <event-id> "<collection-name>" --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-announcement
```

The announcement command shows the preview and asks for confirmation before reading the supplied credential file and signing the request. It never reads the Telegram bot token or chat ID.

An uncertain Telegram response requires checking the group before retrying.

## Other admin tools

Canonical profile admin readers require an explicit `CLOUDFLARE_API_TOKEN` scoped to Account D1 Read for `mons-link-profiles`. They accept `frozen` and `active` and never use the Wrangler login token. Use a separate read-only operator token supplied through the process environment; do not place it in arguments or logs.

List profile addresses:

```sh
npm --prefix cloud/admin start -- --out-eth /secure/eth-addresses.txt --out-sol /secure/sol-addresses.txt
```

At least one output path is required. Address exports create new mode-`0600` files and refuse to overwrite an existing path; stdout contains counts only.

Publish GP, MP, or shooting-star leaderboard messages through the Queue bridge:

```sh
node cloud/admin/topGpWithEmojis.js 25 --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue
node cloud/admin/topMpWithEmojis.js 25 --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue
npm --prefix cloud/admin run shooting:alert -- --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue --project mons-link
```
