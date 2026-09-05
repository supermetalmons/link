# mons cloud operations

Run commands from the repository root. See the repository [architecture and command map](../README.md) for package boundaries and the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md) for API release and maintenance procedures.

Firebase Auth remains active. Realtime Database retains active invites, match synchronization, and `matchTimerClaims`. The API Worker owns manual invite, join, match creation, and rematch mutations; auth; profile and leaderboard reads; profile customization; username mutation; mining; gameplay; D1-backed events and prizes; profile-link catch-up; profile-game projection; event control and progress Workflows; X callback; event Telegram projection; and Worker-backed Telegram delivery.

`mons-link-profiles` D1 permanently contains the canonical profile, ownership, auth, recovery, rating, wager, and transaction-guard tables. `PROFILE_DB.profile_login_owners` is the sole source for Worker login UID to canonical profile ownership, including merge-target resolution. There is no alternate profile store or fallback; an unreadable or corrupt ownership topology fails closed with `503 profile-ownership-unavailable`.

Firebase custom `profileId` claims and RTDB `players/{uid}/profile` links are non-authoritative compatibility shadows. They remain only for browser Realtime Database Security Rules, claim and link recovery, and missing-profile cleanup. Worker authorization and canonical projection ownership never fall back to either shadow.

Ownership-dependent operations use one D1 snapshot for each authorization decision. A merge committed after that snapshot does not abort an RTDB write already in progress; later operations and projections observe the merged owner, while D1 rating and wager effects converge safely. Event synchronization fails closed before creating a new invite or prize assignment when participant owners already converge.

The browser resolves login-linked profile presentation only through the authenticated profile API. Invite role and write ownership come from the authenticated gameplay API using canonical D1 ownership; browser code must not read or subscribe to `players/{uid}/profile`.

Historical rematch snapshots are read through the public Worker endpoint and stored immutably in `mons-link-profile-games` D1. Rated snapshots take precedence over transition and legacy-backfill snapshots. D1 is the sole public-history source; there is no RTDB read-through or backfill path. Active match synchronization remains in RTDB.

Rating completion evidence is read only from `mons-link-profiles` D1: canonical `rating_updates` rows with `status = 'done'` prove new completions, and `legacy_rating_completions` preserves imported Firebase flags even when no full rating record exists. The Worker requires verified activation in `rating_completion_control`; it never consults or repairs the retained `invites/*/matchesRatingUpdates` subtree. Follow the [rating completion cutover](../scripts/deploy-cloudflare.md#rating-completion-d1-cutover) before promoting this runtime. The read-only `npm run migrate:rating-completions -- --preview` exports only invite IDs and marker children. Final import requires canonical writes frozen, all four Queues drained, unchanged source observations, and exact D1 verification. Keep the Firebase evidence inert after activation and roll back only to a D1-compatible Worker.

Manual game-session mutation locks and match-timer start markers live in `mons-link-profile-games` D1. Locks are 60-second owner-and-operation-fenced leases; the five-minute schedule removes at most 1,000 expired rows. Timer markers are removed eagerly on terminal and rating paths, and the same schedule durably reconciles a bounded oldest-first batch. `matchTimerClaims` stays in RTDB because Realtime Database Security Rules use it to fence direct browser match writes. The retired `gameplayMutationLocks` and `matchTimerStarts` roots and the explicit timer-start deny rule remain untouched during the retention period.

Background automatch, rating, and profile-link game projections share per-invite locks in `PROFILE_GAMES_DB.profile_game_projection_locks`. Profile-link processing also holds a per-login lock in the same table. Leases expire after 15 minutes, releases require the current owner, and the five-minute projection sweep removes at most 1,000 expired rows. Event projection leases remain in `EVENT_DB`. Pending automatch projection records remain in RTDB. Profile-link catch-up jobs live in `PROFILE_DB.profile_link_catchup_jobs`; canonical owner changes persist their job in the same D1 transaction. Queue dispatch and the scheduled sweep use those durable jobs, and the retired `profileGameProjectionOutbox/profile` root stays inert.

Follow the [profile-link catch-up cutover](../scripts/deploy-cloudflare.md#profile-link-catch-up-d1-cutover) for the protected preview, four-Queue pause, source observations, exact import, and activation record. Pending auth recovery from an older release can create a D1 catch-up job before repairing a missing profile-link shadow. It does not resume the retired outbox. After activation, keep the old RTDB root through the observation period and roll back only to a D1-compatible Worker. The importer permanently rejects overwriting jobs once activation is recorded.

Event records, participants, prize selections, visible prize assignments, progress markers, and event-specific projection state live exclusively in `mons-link-events` D1 after activation. Browser event subscriptions poll authenticated Worker snapshots; RTDB has no event mirror.

Event-prize withdrawal ownership, leases, persisted Solana submissions, and completion records live exclusively in `mons-link-event-prize-withdrawals` D1. RTDB has no withdrawal shadow.

Withdrawal storage must be frozen before an operator terminates a withdrawal Workflow. Resuming storage to `d1` explicitly authorizes retained terminated instances to be recreated from their durable D1 state.

## Canonical profile maintenance

The canonical writer control has two states: `active` and `frozen`. Freeze is the operator stop for schema maintenance and incidents; resume re-enables writes. In `frozen`, HTTP mutations return `503 profile-writes-disabled` with `Retry-After: 60`, profile Queue messages retry without acknowledgement, and profile sweeps pause. Auth-state expiry, game-receipt cleanup, and unrelated delivery work continue.

```sh
npm run manage:profile-canonical -- --status
npm run manage:profile-canonical -- --freeze
npm run manage:profile-canonical -- --resume
```

Freeze before applying a profile schema migration, record a D1 Time Travel bookmark, validate the schema and foreign keys, then resume only after the production smoke passes. `AUTH_MUTATIONS_DISABLED` remains an independent auth-maintenance switch.

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

`mons-link-events` uses explicit `firebase`, `frozen`, and `d1` storage modes for migration, followed by `d1` and `frozen` only after activation:

```sh
npm run manage:events -- --status
npm run manage:events -- --freeze
npm run manage:events -- --return-to-firebase
npm run manage:events -- --activate-d1
npm run manage:events -- --resume-d1
```

The import tool supports `--preview`, `--stage`, and `--final`. Final import requires event, canonical-profile, and withdrawal storage to be frozen with no active event or projection leases. It preserves all event statuses, prize selections, visible assigned prizes, scheduled progress, and event projection recovery markers. Event status reports D1 lease rows as `d1ActiveLeases`; before cutover, the final migration separately checks RTDB event and projection leases. If status reports an expired write admission after its request has finished, recover only that named row with `npm run manage:events -- --recover-stale-admission <admission-id>`. Pending cross-store transitions remain fenced and retry automatically; fix their underlying code or dependency failure forward instead of detaching or dead-lettering them. Successful transition receipts are immutable coordination evidence retained in `eventTransitionReceipts`. See the deployment guide for the ordered cutover and explicit post-smoke Firebase deletion.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` remains an independent auth maintenance switch. Change and release it as reviewed Worker configuration; do not create environment-specific copies or Dashboard overrides.

Auth intents and X redirect flows are stored in the `mons-link-auth-state` D1 database through `AUTH_STATE_DB`. Firebase Auth remains active. Auth-state D1 is consume-once and revision-fenced. After a one-hour grace, the Worker schedule removes expired created/processing rows and compacts obsolete proof material; verified/completed/failed replays are retained for 30 days. Do not manually edit or delete active rows.

`mons-link-auth-recovery` is the permanent recovery Queue. Its consumer applies `authRecoveryJobs` idempotently, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record.

## Profile-game projection recovery

`mons-link-profile-game-projection` permanently owns rating, manual invite, automatch, event, and profile-link projections. Manual game-session mutations use D1 per-invite leases and UUID receipts, then atomically persist their RTDB source writes and the historically named `profileGameProjectionOutbox/automatch/{inviteId}` marker. Automatch starts require a client operation ID, use a stable operation-scoped D1 lease, and commit a result receipt for every successful response, including an already-owned pending queue. The frontend reuses the exact unresolved request for seven days and serializes tabs with Web Locks; browsers without origin-wide locking fail before the request. After the seven-day boundary, a click is a new user action rather than a replay. Producers persist durable markers before enqueueing, and the five-minute Worker schedule repairs and re-enqueues stale markers while request fencing preserves newer work and recoverable cleanup owners. The same schedule removes game-session mutation receipts after seven days and expired D1 mutation leases in bounded batches.

The first required-operation-ID rollout is frontend-first while canonical profile/gameplay writes remain frozen. Record the current versions only for a pre-activation abort, and record the compatible candidate pair separately. Promote the frontend only after its two-tab preview-browser check passes. Keep writes frozen through the API promotion and both authenticated production smokes; immediately re-freeze if the post-resume standard smoke fails. Browser tabs loaded before the frontend release must reload after the API promotion; their missing-ID starts fail before rate limiting or mutation. The pre-release pair remains an abort target only before writes resume. After resume or the first receipt-aware mutation, roll back only to the separately recorded compatible candidate pair: the API must retain required IDs, the operation-scoped D1 lease, and receipts for every successful path; the frontend must retain per-UID persistence, Web Locks, and exact invite correlation. Otherwise keep writes frozen and fix forward.

Investigate stuck work through Queue consumption, pending marker age, and projection logs. Do not purge the Queue, delete a pending outbox, manually delete profile documents, or manually rewrite canonical profile-event prizes.

## Gameplay coordination migration

`mons-link-profile-games` D1 permanently owns gameplay mutation leases and match-timer start markers. Migration `0008_match_timer_reconciliation.sql` adds the opponent metadata and index used by the bounded timer reconciliation sweep.

The migration tool stores private snapshots under ignored `.cache/gameplay-coordination-migration/` directories. Files use mode `0600`; stdout contains only counts and SHA-256 digests.

```sh
npm run migrate:gameplay-coordination -- --preview --project mons-link
```

Preview is structurally read-only. It validates the retired RTDB roots and current D1 rows, works before or after migration `0008`, and reports separate logical and physical timer-row digests. Column presence is recorded separately in the private metadata. Canonical production previews reject Firebase source overrides. The RTDB roots and Firebase Rules remain in place as historical evidence, but must never be repopulated or reactivated.

Rollback is limited to a D1-compatible Worker version with additive migrations left installed. After automatch activation, use only the separately recorded compatible API candidate that retains required IDs, the operation-scoped D1 lease, and receipts for every successful path. D1 data incidents require a reviewed fix-forward while writes remain frozen because `PROFILE_GAMES_DB` also owns historical matches and projection state. A committed automatch operation returns its receipted result; an unproven coordination failure returns a sanitized `503`.

## Wager reservation storage

`wager_frozen_balances` and `wager_frozen_operations` in `mons-link-profiles` permanently store reserved materials and their replay records. Rows remain keyed by participant login UID, including retained UIDs without a current canonical profile. Active operations, consumed tombstones, and pending settlements survive the cutover; total mining balances and settlement receipts also use canonical D1 storage.

The production runtime requires activated D1 storage and never reads or writes the retired Firebase reservation subtree. It also permits balance reads while D1 reservation writes are frozen. The migration bridge used `firebase`, `frozen`, and `d1` control states; its source and immutable uploaded version remain migration evidence, and its Firebase adapter exists only in test fixtures. A complete HTTP wager mutation or queued settlement keeps its admission for its lifetime. Canonical profile freeze stops new wager work; reservation freeze closes admission while existing requests drain. Uncertain and expired admissions require explicit investigation. Wager settlement retries travel on `mons-link-telegram-delivery`, so that Queue is part of reservation maintenance.

```sh
npm run manage:wager-reservations -- --status
npm run migrate:wager-reservations -- --preview --project mons-link
```

Preview reads a shallow player UID inventory and each player's complete mining child, validates the reservation fields, and writes private recovery artifacts under `.cache/wager-reservation-migration/`. With explicit `GOOGLE_APPLICATION_CREDENTIALS`, one authenticated export process reads four mining children concurrently by default; `WAGER_RESERVATION_SOURCE_CONCURRENCY` accepts values from 1 to 16. Environments without explicit credentials use the Firebase CLI. The tools never read match history or delete Firebase source data. Artifact files use mode `0600`; logs contain counts and digests.

Follow the [wager reservation cutover](../scripts/deploy-cloudflare.md#wager-reservation-cutover) for the bridge release, queue pause evidence, two identical source observations at least six minutes apart, bounded import, and activation. Final import requires all four queues paused for at least fifteen minutes. Each final import claims a unique attempt ID; interrupted attempts block other imports and activation until the named stopped attempt is explicitly recovered. An import cannot publish proof for another runner's data.

The browser reads authenticated `POST /wagers/frozen/read` snapshots every two seconds while visible and refreshes after wager actions. HTTP wager mutations require `X-Mons-Wager-Storage-Version: 1`; old browser tabs must reload before wagering. Queued settlement tasks remain compatible. D1 activation is irreversible: freeze and fix forward after activation, and roll back only to a tested D1-compatible API/frontend pair. The Firebase source remains inert evidence, with browser reads denied. Production API version previews remain disabled so retired versions cannot receive new requests through their preview URLs.

## Telegram recovery and announcements

Event Telegram projection runs through `mons-link-telegram-projection`. Every supported API or Workflow mutation writes `telegramProjectionOutbox/event/{eventId}` and increments `eventTelegramProjectionGenerations/{eventId}` atomically with the event update. The five-minute Worker schedule recovers pending markers; direct Firebase client event writes are disabled.

Restore the protected Queue bridge credential only when needed:

```sh
umask 077
firebase functions:secrets:access TELEGRAM_QUEUE_BRIDGE_SECRET --project mons-link > /secure/telegram-queue-bridge-secret
```

The Queue bridge and announcement bridge are separate credentials.

Delivery and recovery records live in the `mons-link-telegram` D1 database. Ambiguous sends remain `uncertain` and are never retried automatically. Preview and execute one reviewed recovery action through the signed Worker command endpoint:

```sh
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --execute
```

Use `confirm-send-applied --message-id <telegram-message-id>` when Telegram created the message, or `abandon` to retain the audit record and stop delivery.

Send a confirmed event-prize announcement with an explicit event and collection name:

```sh
npm run announceEventPrizes -- <event-id> "<collection-name>"
```

The command reads only `TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET` through the pinned Firebase CLI after confirmation. It never reads the Telegram bot token or chat ID.

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
node cloud/admin/topGpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
node cloud/admin/topMpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
npm --prefix cloud/admin run shooting:alert -- --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link
```
