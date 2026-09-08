# mons cloud operations

Run commands from the repository root. See the repository [architecture and command map](../README.md) for package boundaries and the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md) for API release and maintenance procedures.

Routine releases keep canonical writes and Queue delivery active and have no overall time limit. Prepare validated candidates first, then promote and verify the affected behavior, allowing necessary work, provider propagation, and retries to take the time they need. Do not add verification-only waits or observation windows longer than 60 seconds; finish once the required checks pass. The freeze, drain, and recovery procedures below apply only when a concrete schema, state-compatibility, resource-lifecycle, or incident requirement calls for maintenance.

Firebase Auth remains active. Realtime Database retains active match synchronization and `matchTimerClaims`. Invite metadata uses the separately gated `PROFILE_GAMES_DB.invite_sources` repository; the migration control selects RTDB only before one-way D1 activation. The API Worker owns manual invite, join, match creation, and rematch mutations; reaction publishing and subscriptions; auth; profile and leaderboard reads; profile customization; username mutation; mining; gameplay; D1-backed events and prizes; profile-link catch-up; profile-game projection; event control and progress Workflows; X callback; event Telegram projection; and Worker-backed Telegram delivery.

`mons-link-profiles` D1 permanently contains the canonical profile, ownership, auth, recovery, rating, wager, and transaction-guard tables. `PROFILE_DB.profile_login_owners` is the sole source for Worker login UID to canonical profile ownership, including merge-target resolution. There is no alternate profile store or fallback; an unreadable or corrupt ownership topology fails closed with `503 profile-ownership-unavailable`.

Firebase custom `profileId` claims and RTDB `players/{uid}/profile` links are non-authoritative compatibility shadows. They remain only for browser Realtime Database Security Rules, claim and link recovery, and missing-profile cleanup. Worker authorization and canonical projection ownership never fall back to either shadow.

Ownership-dependent operations use one D1 snapshot for each authorization decision. A merge committed after that snapshot does not abort an RTDB write already in progress; later operations and projections observe the merged owner, while D1 rating and wager effects converge safely. Event synchronization fails closed before creating a new invite or prize assignment when participant owners already converge.

The browser resolves login-linked profile presentation only through the authenticated profile API. Invite role and write ownership come from the authenticated gameplay API using canonical D1 ownership; browser code must not read or subscribe to `players/{uid}/profile`.

Historical rematch snapshots are read through the public Worker endpoint and stored immutably in `mons-link-profile-games` D1. Rated snapshots take precedence over transition snapshots. D1 is the sole public-history source; there is no RTDB read-through or backfill path. Active match synchronization remains in RTDB.

The public `GET /matches/snapshot?playerId=…&matchId=…` endpoint serves one-time active-match reads for reconnect recovery and post-retry move verification. It reads only the requested `players/{playerId}/matches/{matchId}` path under the existing public Firebase rules, without service-account credentials. Responses are uncached and contain validated gameplay fields only. An absent Firebase record returns `match: null`; malformed records and upstream failures return `503` and never trigger a repair. Reads do not depend on canonical-write maintenance gates. Browser move transactions and live subscriptions still use RTDB.

Rating completion evidence is read only from `mons-link-profiles` D1: canonical `rating_updates` rows with `status = 'done'` prove new completions, and `legacy_rating_completions` preserves historical completions without full rating records.

Manual game-session mutation locks and match-timer start markers live in `mons-link-profile-games` D1. Locks are 60-second owner-and-operation-fenced leases; the five-minute schedule removes at most 1,000 expired rows. Timer markers are removed eagerly on terminal and rating paths, and the same schedule durably reconciles a bounded oldest-first batch. `matchTimerClaims` stays in RTDB because Realtime Database Security Rules use it to fence direct browser match writes.

Background automatch, rating, and profile-link game projections share per-invite locks in `PROFILE_GAMES_DB.profile_game_projection_locks`. Profile-link processing also holds a per-login lock in the same table. Leases expire after 15 minutes, releases require the current owner, and the five-minute projection sweep removes at most 1,000 expired rows. Event projection leases remain in `EVENT_DB`. Automatch queue entries, Telegram lifecycle sources, shared session receipts, and pending automatch/manual-session projection records live in `PROFILE_GAMES_DB`. D1 transition intents durably coordinate create-only RTDB match effects with invite metadata, receipts, and outboxes. After invite-source activation, session finalization commits the invite and the other gameplay D1 effects together; event transitions use an idempotent invite-effect receipt across databases. Profile-link catch-up jobs live in `PROFILE_DB.profile_link_catchup_jobs`; canonical owner changes persist their job in the same D1 transaction. Queue dispatch and the scheduled sweep use those durable jobs.

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

The reaction cutover rules reject writes to `invites/{inviteId}/reactions`, including participant, linked-login, and admin-claim writes. Release these rules only after the API Durable Object bootstrap, frontend release, and two-player/spectator reaction verification described in the deployment guide. Retain the old RTDB records; no import or deletion is required. Older clients must refresh or update to send and receive reactions.

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

Account-link game discovery uses the activated D1 index in `PROFILE_GAMES_DB.login_match_discovery`, controlled by `login_match_discovery_control`. `npm run manage:login-match-discovery -- --status` reports its source selection, capture enforcement, and row counts by resolution/provenance. Current API source rejects inactive control or unavailable D1 reads without a Firebase fallback. The index includes unlinked and deleted-auth login UIDs; profile ownership is still resolved separately from canonical D1 ownership. Missing or ambiguous historical invite mappings remain explicit rows. A different resolved mapping is a conflict that must be reconciled, never overwritten.

The historical [discovery migration procedure](../scripts/deploy-cloudflare.md#account-link-game-discovery-cutover) enabled capture only after the candidate reaches 100% deployment, then exports, imports, verifies, and activates the index without freezing gameplay, pausing Queues, or restarting Workflows. Protected artifacts must stay outside the repository in an owned mode-0700 directory. Firebase scanning requires an explicit `--firebase-credentials` path to an existing private service-account file; Cloudflare operations use `CLOUDFLARE_API_TOKEN` without logging it. Completed session transitions cannot bypass the enforced discovery capture guard. A pending transition needs ordinary recovery, not deletion or a manually forged completion. After activation, retain the guard and use capture-aware API versions for repairs.

`mons-link-profile-game-projection` permanently owns rating, manual invite, automatch, event, and profile-link projections. Manual game-session mutations use D1 per-invite leases and UUID receipts, then atomically persist their RTDB source writes and the historically named `profileGameProjectionOutbox/automatch/{inviteId}` marker. Automatch starts require a client operation ID, use a stable operation-scoped D1 lease, and commit a result receipt for every successful response, including an already-owned pending queue. The frontend reuses the exact unresolved request for seven days and serializes tabs with Web Locks; browsers without origin-wide locking fail before the request. After the seven-day boundary, a click is a new user action rather than a replay. Producers persist durable markers before enqueueing, and the five-minute Worker schedule repairs and re-enqueues stale markers while request fencing preserves newer work and recoverable cleanup owners. The same schedule removes game-session mutation receipts after seven days and expired D1 mutation leases in bounded batches.

Investigate stuck work through Queue consumption, pending marker age, and projection logs. Do not purge the Queue, delete a pending outbox, manually delete profile documents, or manually rewrite canonical profile-event prizes.

## Gameplay coordination

`mons-link-profile-games` D1 owns gameplay mutation leases and timer-start markers. The bounded reconciliation sweep checks the opponent metadata before removing stale timer markers. Active match writes still depend on the RTDB `matchTimerClaims` fence. A committed automatch operation returns its receipted result; an unproven coordination failure returns a sanitized `503`.

## Invite metadata delivery

`GET /invites/:inviteId/metadata` returns a revisioned snapshot of participant IDs, host color, both rematch strings, automatch state, and event membership. Its viewer fields resolve the caller's canonical D1 role and expose only that login's automatch operation ID. Passwords, other logins' operation IDs, and wagers never enter the public snapshot. Paired invites allow public spectators; pending open invites require authentication, and pending private invites require host ownership, including linked logins.

`GET /invites/:inviteId/metadata/socket` uses `mons-invite-metadata-v1` in the existing `InviteReactions` Durable Object. Metadata has separate admission limits and broadcasts from reaction v1/v2 and presentation traffic. HTTP reads and new sockets refresh canonical invite state; access checks and admission are tied to the same metadata revision and private-invite policy. The object persists the latest sanitized snapshot and increments its revision only when that snapshot changes.

Successful invite metadata writes request an immediate refresh after the canonical commit. Notification failure cannot fail a committed gameplay operation. While metadata sockets are connected, a persistent alarm reads the invite every five seconds, shared across all viewers, to recover missed notifications. The storage cutover requires all earlier event-progress Workflow instances to be terminal before D1 activation. Source failure retains the last snapshot and the next alarm. Metadata polling stops when its last subscriber leaves, even if reaction sockets remain.

The browser replaces direct invite and rematch reads with this API and subscription. It preserves separately observed wager snapshots and live match data, applies both rematch fields together, and prevents stale snapshots from reversing confirmed proposals or reopening an ended series. A visible, online client uses five-second HTTP recovery while its socket is unavailable, with bounded error backoff and `Retry-After` support. There is no direct Firebase invite-read fallback. Auth or game-context changes release the metadata subscription and pending work.

The initial transport migration preserved the browser protocol. The [invite-source storage cutover](../scripts/deploy-cloudflare.md#invite-source-d1-cutover) now moves the private source aggregate into `PROFILE_GAMES_DB.invite_sources` without another frontend, rules, trigger, or namespace change. `invite_source_control` has an independent writer gate and one-way storage epoch. Missing or invalid control, unreadable D1 state, and malformed source values fail closed. Firebase records remain protected evidence after activation and never provide a fallback.

`npm run manage:invite-source -- --status` reports the invite, automatch, and event gates plus unresolved admissions, intents, resources, and leases. Its protected export includes every Firebase invite key, preserves unknown metadata and empty objects, and omits only the retired root fields `reactions`, `wagers`, and `matchesWagerResolutions`. Freeze, import, verification, and activation bind the exact sole-deployed API candidate and the same gate generations. Existing Queue payloads, outboxes, Workflow names, Durable Object state, Firebase match data, and timer claims remain intact. Manual-game timers continue during the freeze; event-game timeout claims pause while the event gate is frozen because they write event-progress outboxes. The older automatch, login-discovery, and wager migration operators reject Firebase invite scans after activation.

## Wager delivery

`GET /invites/:inviteId/wagers` returns `{ ok: true, snapshot: { inviteId, revision, wagers } }`. `GET /invites/:inviteId/wagers/socket` uses `mons-invite-wagers-v1` in the existing `InviteReactions` Durable Object. Snapshots contain the invite's complete public wager map so current and historical rematches use the same view. Public proposals, proposal history flags, agreements, and resolutions are retained; operation IDs, reservation bookkeeping, settlement claims, and browser optimistic flags are excluded.

Reads and socket admission follow invite metadata access: paired invites allow spectators, pending open invites require authentication, and pending private invites require canonical host ownership. Admission and subsequent broadcasts recheck the canonical invite policy. Wager snapshots have independent persisted revisions and channel limits; metadata and wagers share queued source reads that combine canonical invite metadata with D1 wager state and the object's single five-second reconciliation alarm. Reads arriving after a source fetch starts use the next fetch. The 512-socket room limit reserves 24 participant sockets across the three channels, allowing at most 488 spectator sockets. Reaction and presentation messages remain isolated from both channels.

`PROFILE_DB.invite_wager_states` is authoritative for wager proposals, agreements, internal settlement state, and resolution markers. Completion updates the wager state and its resolution marker atomically in D1. HTTP mutations, queued settlement recovery, rating messages, and Durable Object snapshots use the same canonical state; retained Firebase values never provide a wager fallback. D1 wager writes request refresh after confirmed or ambiguous attempted writes. Notification failures cannot reject a committed mutation. Source changes advance the wager revision even when only internal bookkeeping changed, so clients still refresh frozen balances. Source failures retain the last valid snapshot; malformed data never becomes an empty wager map.

The browser hydrates and subscribes through the Worker with no Firebase wager-read fallback. It uses the metadata channel's shared reconnect, heartbeat, cancellation, visibility, and bounded HTTP recovery behavior. Mutation generations and confirmed revisions protect optimistic state from old snapshots, and a fresh HTTP read reconciles each completed or failed mutation, including unchanged canonical revisions. Account changes and game-context replacement release the subscription and pending requests.

The initial storage cutover retires Firebase writes before export, applies profile migration `0016`, verifies the import, activates D1, and promotes the API during the [single-freeze wager-state procedure](../scripts/deploy-cloudflare.md#wager-state-d1-cutover). It adds no Worker, namespace, Queue, or browser protocol. Retained `invites/{inviteId}/wagers` and `matchesWagerResolutions` records keep the existing invite-read policy; all browser writes, including nested and admin-claim writes, are denied. Do not delete retained data during the cutover. Later compatible releases use the routine API release path and validate HTTP snapshots, WebSocket delivery/reconnect, historical wager display, and unchanged metadata/reaction behavior.

`npm run manage:wager-state -- --preflight` scans the retained source without a schema change, freeze, or export file; `--status` reports activation state and import evidence. Export, import, verify, and activate require an explicit `CLOUDFLARE_API_TOKEN` in the process environment, canonical profiles and wager reservations frozen, and all admissions and gameplay leases drained. Firebase reads use `--firebase-credentials`, then `GOOGLE_APPLICATION_CREDENTIALS`, then the existing Firebase CLI login. The protected export directory is immutable migration evidence and supports restarting an interrupted import. Activation binds the verified source, reservation baseline, imported rows, and candidate Version ID; missing or inactive activation fails closed. There is no bridge release or post-activation Firebase fallback. Keep writes frozen and repair forward on a failed cutover check.

`npm run smoke:wagers` provides separate preparation, frozen-read, and active-lifecycle phases. Preparation creates two dedicated test profiles with locally generated Solana sign-in keys, mines their first rock for one dust each, and creates three manual invites. It leaves one pending proposal for import verification. After resume, the lifecycle verifies cancel, decline, accept, settlement, and replay behavior using only those two profiles' dust. It never requests ratings, automatch, events, or external announcements. Keep its mode-`0600` credential fixture outside the repository; interrupted runs reuse the same fixture and completed steps. The read-only mode accepts a supplied paired invite and optional protected auth-token fixture without sending gameplay mutations. See the deployment procedure for the exact commands.

## Reaction delivery

`INVITE_REACTIONS` binds the API Worker to `InviteReactions`, one SQLite-backed Durable Object per invite. The Worker checks paired invite membership and canonical D1 participant ownership before publishing `POST /invites/:inviteId/reactions`; spectators use the public `GET /invites/:inviteId/reactions/socket` with an allowed browser origin. The WebSocket accepts heartbeat messages only. Firebase still supplies identity tokens and live match data; invite authorization reads canonical D1 metadata after source activation.

Each room reserves four connections for the host and four for the guest, alongside at most 248 spectators and eight spectator connections per IP. Players authenticate the socket handshake using their Firebase token in the WebSocket protocol header; the server echoes only the negotiated `mons-reactions-v1` or `mons-reactions-v2` protocol and forwards no credentials to the Durable Object. Participant admission uses a separate rate-limit bucket keyed by the resolved player UID. Connection tags retain these limits through hibernation.

The object retains the latest reaction per player and uses hibernating WebSockets. Fresh game contexts suppress their initial snapshot; reconnecting contexts recover unseen reactions through the existing playback filters. There is no Firebase delivery fallback, reaction history import, or persistent outgoing queue. Failures affect reactions independently of active match synchronization.

Use the read-only reaction smoke in the deployment guide to verify snapshots and heartbeat delivery without publishing to a game. Monitor socket connection failures, publish failures, rate-limit rejections, and browser reconnect frequency. Preserve Durable Object storage and its `exports` declaration during repairs.

## Match presentation

`GET` and `POST /invites/:inviteId/matches/:matchId/presentation` read and update live emoji/aura state in the existing invite Durable Object. The Worker resolves the authenticated login to the stored match actor using canonical D1 ownership. Public reads require a paired invite; an authenticated host can read and change their own appearance while waiting for a guest. Updates must target the actor's current match, including their pending rematch. Profile customization uses its existing API independently.

The Worker initializes missing presentation rows from server-read Firebase match records, preserving those records as immutable seeds. A write includes a UUID `operationId`, `expectedRevision`, `emojiId`, and `aura`. Accepted writes advance the stored revision before broadcasting; a retry of the current accepted operation returns its result, and stale or changed operations return `409 presentation-conflict` with canonical state. Clients serialize and coalesce selections. An uncertain write keeps its original operation ID and revision until a newer server revision or an exact retry resolves it; newer selections wait without a retry loop. Pending work is discarded when leaving the game or changing identity. There is no Firebase write fallback.

V2 subscriptions use `?matchId=<existing-match-id>` and `mons-reactions-v2`, plus the existing bearer subprotocol for players. Their bounded snapshots contain reactions and presentation for up to two actors. Anonymous spectators send only the v2 subprotocol. V1 sockets continue receiving their unchanged reaction messages. Presentation snapshots apply on every connection, separately from reaction playback and game processing. HTTP hydration also works before pairing and while a socket is unavailable.

Game-list projections keep canonical profile avatars first. Opponents without a profile avatar use their current Durable Object presentation, falling back to the Firebase seed only when no presentation exists. Lookup failures retry projection instead of storing a stale avatar.

The asynchronous profile-game archive captures immutable appearance in the Durable Object before writing a historical D1 pair. A retry reuses that capture; failures retry projection without undoing rating settlement. Existing archived cosmetics remain authoritative, including when a rated game snapshot replaces a transition snapshot. Later changes to the current finished game's live appearance do not rewrite history. Preserve both live and frozen presentation storage during repairs.

After the ordered API, frontend, and Firebase rules cutover, browser writes cannot change or remove match `emojiId`/`aura`, including through whole-match writes or admin claims. Surrender writes only status and move transactions preserve the seed fields. Older clients must refresh or update. No historical backfill or Firebase record deletion is required.

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

Event creation accepts `telegramAnnouncements` with three required booleans: `invite` sends the initial invite, `matches` sends event start and match updates, and `results` sends final results. The creation UI defaults all three to false. These settings take precedence over the legacy `announceOnTelegram` boolean, which still maps to all three options for older requests and records. Release API support before the frontend that sends these settings; no database migration is needed.

When `invite` is false, joins and postponements cannot send an invite. A confirmed delivery receipt for `event:<event-id>:upcoming`, with instance `event:<event-id>:upcoming:v2` and destination `community`, permits edit-only updates; a missing message is never replaced automatically. Manual invite sending remains a separate future operation. That sender must record the canonical delivery receipt and enqueue event projection after confirmation to refresh participants immediately; otherwise the next event mutation picks it up. Start/match updates and final results work independently of invite delivery.

The Queue operator bridge credential is provisioned in the protected local file `/Users/ivan/.config/mons-link/secrets/telegram-queue`. Pass its path explicitly with `--bridge-secret-file`; commands do not load Firebase secrets or use an environment fallback.

Delivery and recovery records live in the `mons-link-telegram` D1 database. Ambiguous sends remain `uncertain` and are never retried automatically. Preview and execute one reviewed recovery action through the signed Worker command endpoint:

```sh
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue --execute
```

Use `confirm-send-applied --message-id <telegram-message-id>` when Telegram created the message, or `abandon` to retain the audit record and stop delivery.

The reminder timing update was released on September 8, 2026 in API version `7a94cfb8-550d-45c1-9ab1-4399ea9b6e11`. Use this or a later compatible version for rollback once four-hour jobs exist; it accepts both stored three-hour and four-hour schedules. Validation and release evidence is retained in `/private/tmp/mons-reminder-release-x51eqD`.

New Sunday Mons reminders send automatically four hours before the scheduled event start. Previously queued three-hour reminders retain their original schedule, and participant updates preserve the heading of already-sent messages. Only scheduled events with `isSundayMons === true` and a valid start time qualify; prizes are not required. The standalone HTML message goes to the community destination with notifications enabled and link previews disabled:

```text
sunday mons in 4 hours!

https://mons.link/event/{eventId} <tg-emoji emoji-id="5355002036817525409">&#11088;</tg-emoji>
```

The reminder includes the same participant list as the event-created message once at least two participants have joined. Both lists update as scheduled-event participants or their appearance change and freeze when the event starts. Reminder edits work independently of invite announcements and never replace a missing or deleted message.

To refresh an already sent reminder, submit exactly `{"kind":"event-reminder-refresh","eventId":"<event-id>"}` to `POST /internal/telegram/command` with the existing Telegram bridge timestamp and signature headers. The command accepts only a scheduled eligible Sunday Mons event with a confirmed reminder receipt; it returns `202` with the projection request ID and message key, or `409` when the event or receipt is ineligible. It adopts the saved reminder message under `event:<event-id>:reminder` without changing its original announcement receipt. Repeated refreshes remain edit-only. A `dispatch-deferred` response means the durable projection outbox is pending recovery by the existing sweep.

Sunday Mons prize announcements send automatically one hour before the scheduled event start and additionally require prizes in the shared catalog. The album keeps catalog prize order and spoiler-covers every photo. Its first caption uses the lowercased, HTML-escaped catalog collection name inside a Telegram spoiler, followed by `starting in 1 hour` and the event link with the same automatch custom emoji. Both notifications operate independently of the invite, matches, and results settings, and an eligible prize event can receive both.

`EVENT_PROGRESS_WORKFLOW` sleeps until each notification's target; the existing event progress sweep discovers eligible events and recovers pending dispatches. Event changes persist eligible scheduling markers atomically before dispatch. Events first discovered after a notification's target skip that notification; previously scheduled jobs have a 60-second delivery grace period. Before sending, the workflow checks the canonical event and any required prize catalog entry under the event lease. A postponement can schedule a new job for each unsent notification; superseded jobs do nothing.

Each event has one permanent delivery identity per notification kind. A confirmed reminder or prize album never resends, including after postponement. Only safely retryable Telegram failures can retry within the grace period; timeouts, interrupted sends, and ambiguous responses block automatic retries to prevent duplicates. Historical manual prize receipts remain valid. These announcements have no manual send trigger and require no separate announcement bridge credential. The initial reminder rollout requires only the API Worker and an additive Telegram D1 migration that records the notification kind and makes delivery uniqueness specific to each event and kind; no frontend or trigger deployment is needed. Live reminder participant lists require an API-only release with no additional database migration.

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
