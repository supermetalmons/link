# mons cloud operations

Run commands from the repository root. See the repository [architecture and command map](../README.md) for package boundaries and the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md) for API release and maintenance procedures.

Routine releases keep canonical writes and Queue delivery active and have no overall time limit. Prepare validated candidates first, then promote and verify the affected behavior, allowing necessary work, provider propagation, and retries to take the time they need. Do not add verification-only waits or observation windows longer than 60 seconds; finish once the required checks pass. The freeze, drain, and recovery procedures below apply only when a concrete schema, state-compatibility, resource-lifecycle, or incident requirement calls for maintenance.

Cloudflare provides persistent browser sessions and five-minute API access tokens. The existing invite Durable Object owns canonical active match records and timer claims and delivers live match snapshots to the browser. Retained Realtime Database data is historical evidence, with no default runtime reads or writes. Invite metadata uses the separately gated `PROFILE_GAMES_DB.invite_sources` repository with required D1 authority. The API Worker owns manual invite, join, match creation, move submission, surrender, and rematch mutations; reaction publishing and subscriptions; auth; profile and leaderboard reads; profile customization; username mutation; mining; gameplay; D1-backed events and prizes; profile-link catch-up; profile-game projection; event control and progress Workflows; X callback; event Telegram projection; and Worker-backed Telegram delivery.

`mons-link-profiles` D1 permanently contains the canonical profile, ownership, auth, recovery, rating, wager, and transaction-guard tables. `PROFILE_DB.profile_login_owners` is the sole source for Worker login UID to canonical profile ownership, including merge-target resolution. There is no alternate profile store or fallback; an unreadable or corrupt ownership topology fails closed with `503 profile-ownership-unavailable`.

Firebase custom `profileId` claims are retired from the browser and Worker runtime: runtime code never reads, writes, or deletes them, and existing stored claims remain untouched. Browser sessions and identity tokens are issued by the API Worker. RTDB `players/{uid}/profile` links are retired: runtime code never reads, writes, or deletes them. The final Realtime Database rules deny all client reads and writes, including match records, timer claims, these links, retained invites, and clients with an admin or former Worker capability claim. Retain existing records as historical evidence. Worker authorization and canonical projection ownership never fall back to claims or retained links.

`POST /auth/profile/sync` uses canonical D1 ownership and returns the current `profileId` and linked methods. The legacy `POST /auth/profile-claim/sync` URL remains a compatibility alias with the same authentication, maintenance gates, rate limit, response, and error behavior. Both routes synchronize profile state through D1 without Firebase Admin account lookups or claim mutations. Browser restoration uses the authenticated profile and sync responses without inspecting token claims or forcing a claim refresh.

Canonical ownership transactions create profile-link catch-up jobs atomically in D1, including previous-owner cleanup. Profile synchronization validates active canonical ownership and only dispatches an existing job without resetting its request ID or cursor. Completed jobs remain absent; the scheduled sweep recovers Queue dispatch failures. Missing-profile cleanup settles only the guarded D1 job. The [profile-link retirement release](../scripts/deploy-cloudflare.md#firebase-profile-link-retirement) records the earlier migration; its claim-repair behavior is historical.

Ownership-dependent operations use one D1 snapshot for each authorization decision. A merge committed after that snapshot does not abort a match mutation already in progress; later operations and projections observe the merged owner, while D1 rating and wager effects converge safely. Event synchronization fails closed before creating a new invite or prize assignment when participant owners already converge.

The browser resolves login-linked profile presentation only through the authenticated profile API. Invite role and write ownership come from the authenticated gameplay API using canonical D1 ownership; browser code must not read or subscribe to `players/{uid}/profile`.

Historical rematch snapshots are read through the public Worker endpoint and stored immutably in `mons-link-profile-games` D1. Rated snapshots take precedence over transition snapshots. D1 is the sole public-history source; there is no RTDB read-through or backfill path. Active match records and timer claims live in the invite Durable Object; exact legacy records remain read-only in gameplay D1.

Move submission uses `POST /matches/move` with the invite, match, actor, confirmed base history, cumulative target history/FEN, and optional game variant. New clients include `previousStates` containing each pending prefix's move count and FEN, bounded to 64 checkpoints and a 1 MiB encoded request. The Worker accepts a stored prefix only when its checkpoint FEN agrees, acknowledges exact replay as `already-applied`, and returns `superseded` with the newer stored history/FEN without writing backward. Requests without checkpoints retain the original strict compare-and-set behavior. Divergent histories and conflicting checkpoint FENs fail with `409 move-chain-conflict`.

The browser keeps a per-login, invite, match, and actor delivery journal in `sessionStorage`, coalesces unsent snapshots while preserving every action, and allows at most two overlapping requests. Takebacks are appended `z` actions, never removed history. Acknowledgements advance confirmed history monotonically; late replies cannot clear a newer pending suffix. Same-match hydration reconciles saved pending actions before restoring the board. Account changes pause delivery, and navigation cannot redirect a later completion into another board. Exhausted retries retain the journal for recovery instead of clearing it through a reload. Surrender, rating/wager settlement, timer, and rematch operations wait for pending move delivery. Receivers drain cached histories from both colors in turn order and preserve pending terminal updates until their preceding actions are replayed.

The Worker sends authenticated match operations to the invite Durable Object, which preserves non-move fields and checks its local timer-claim fence atomically with each mutation. A temporary fence returns `409 match-move-blocked` and remains retryable within the browser's 60-second retry window. `MOVE_RATE_LIMITER` permits 120 attempts per minute per authenticated login independently of auth and invite quotas. The default runtime does not construct a Firebase match client or use gameplay service-account credentials. Cumulative delivery, replay, timer deadlines, and the existing browser protocol remain unchanged.

The public `GET /matches/snapshot?playerId=…&matchId=…` endpoint serves one-time active-match reads for reconnect recovery and post-retry move verification. It resolves the requested actor/match through gameplay D1 routing and reads the canonical Durable Object record or its exact retained D1 legacy record. Responses are uncached and contain validated gameplay fields only. An absent canonical record returns `match: null`; malformed records and upstream failures return `503` and never trigger a repair. Reads do not depend on canonical-write maintenance gates. Browser move submissions use `POST /matches/move`; live subscriptions and revisioned HTTP recovery use the Cloudflare match channel.

Rating completion evidence is read only from `mons-link-profiles` D1: canonical `rating_updates` rows with `status = 'done'` prove new completions, and `legacy_rating_completions` preserves historical completions without full rating records.

Manual game-session mutation locks and match-timer start markers live in `mons-link-profile-games` D1. Locks are 60-second owner-and-operation-fenced leases; the five-minute schedule removes at most 1,000 expired rows. Timer markers are removed eagerly on terminal and rating paths, and the same schedule durably reconciles a bounded oldest-first batch. Canonical timer claims live beside the match records in the invite Durable Object and fence moves and surrender in the same storage transaction. The retained Firebase claims remain unchanged historical evidence.

Background automatch, rating, and profile-link game projections share per-invite locks in `PROFILE_GAMES_DB.profile_game_projection_locks`. Profile-link processing also holds a per-login lock in the same table. Leases expire after 15 minutes, releases require the current owner, and the five-minute projection sweep removes at most 1,000 expired rows. Event projection leases remain in `EVENT_DB`. Automatch queue entries, Telegram lifecycle sources, shared session receipts, and pending automatch/manual-session projection records live in `PROFILE_GAMES_DB`. D1 transition intents durably coordinate create-only Durable Object match effects with invite metadata, receipts, and outboxes. After invite-source activation, session finalization commits the invite and the other gameplay D1 effects together; event transitions use an idempotent invite-effect receipt across databases. Profile-link catch-up jobs live in `PROFILE_DB.profile_link_catchup_jobs`; canonical owner changes persist their job in the same D1 transaction. Queue dispatch and the scheduled sweep use those durable jobs.

Event records, participants, prize selections, visible prize assignments, progress markers, and event-specific projection state live exclusively in `mons-link-events` D1. Browser event subscriptions poll authenticated Worker snapshots; RTDB has no event mirror.

Event-prize withdrawal ownership, leases, persisted Solana submissions, and completion records live exclusively in `mons-link-event-prize-withdrawals` D1. RTDB has no withdrawal shadow.

Withdrawal storage must be frozen before an operator terminates a withdrawal Workflow. Resuming storage to `d1` explicitly authorizes retained terminated instances to be recreated from their durable D1 state.

## Browser sessions

`AUTH_STATE_DB.anonymous_sessions` stores session IDs, server-generated login UIDs, SHA-256 credential hashes, and permanent revocation records. Session creation is idempotent and logout can revoke a pending creation before it arrives. Neither inactivity nor age expires a session. Never delete a revoked row: replayed creation credentials must remain revoked.

The browser stores its refresh and revoke-only capabilities in IndexedDB and caches five-minute access JWTs in memory. `POST /auth/session/anonymous`, `/refresh`, and `/logout` create, refresh, and revoke sessions. Ordinary HTTP and WebSocket routes accept only access JWTs. Refresh and logout consult primary D1; HTTP authorization does not add a per-request database lookup. Authenticated sockets close at token expiry and reconnect with refreshed credentials. Server revocation blocks refresh immediately and existing access lasts at most five minutes. Offline logout clears local login authority and retries the retained revoke-only capability when online.

`SESSION_JWT_KEYS` is an encrypted Worker secret containing `{ "activeKid": "<key-id>", "keys": { "<key-id>": "<base64url-32-byte-key>" } }`. Generate keys cryptographically and never store them in source, release environment files, commands, or logs. To rotate, provision both old and new keys with the new active ID, retain the prior verification key for at least five minutes, then remove it in a later release.

Firebase ID tokens have no compatibility bridge. Existing linked users must sign in again; existing unlinked guest identity is inaccessible. Retain Firebase users, canonical D1 ownership, historical records, and RTDB service-account credentials. Reverting to Firebase-only API or frontend code after issuing Cloudflare sessions would strand the new sessions.

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

The Realtime Database emulator requires Java 21 or newer. Its retirement suite verifies deny-all client access, rejected former Worker overrides, canceled subscriptions, and preserved privileged evidence reads. Run it with `npm run test:database-rules`.

## Firebase rule releases

Preview the complete release without starting a Firebase process:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
```

Deploy Realtime Database rules:

```sh
npm run deploy:firebase -- --project mons-link
```

The Firebase configuration contains only the final deny-all Realtime Database rules. Review the dry-run first; the release helper cannot create Firestore, Hosting, Cloud Functions, or event resources.

The deny-all rules were deployed after the completed [active-match storage cutover](../scripts/deploy-cloudflare.md#active-match-storage-cutover) verified durable authority and strict Cloudflare reads. Rules do not revoke privileged IAM access: retain explicitly authorized read-only admin/operator evidence access and the separate runtime source-write fence. Preserve every Firebase record and retained account or key; rules publication does not authorize deletion.

## Event storage maintenance

`mons-link-events` supports `d1` and `frozen` storage modes:

```sh
npm run manage:events -- --status
npm run manage:events -- --freeze
npm run manage:events -- --resume-d1
npm run manage:events -- --recover-stale-admission <admission-id>
```

Freeze withdrawals and canonical-profile writes before maintenance that touches event state and its dependent effects. Wait for active requests and leases to drain. Status reports D1 leases, admissions and pending transitions. Recover only an expired admission whose request has finished. Pending transitions remain fenced and retry automatically; repair their underlying implementation or dependency failure while frozen.

`mons-link-profile-games.event_transition_receipts` owns immutable acknowledgments of event match effects, including retained acknowledgments from the former Firebase authority. These are distinct from `invite_event_effect_receipts`, which commits atomically with invite metadata and login-match discovery. Receipt recovery preserves transition payloads, match creation markers, and terminal timer effects. Historical V1 receipts are retained as evidence; the Worker executes only V2 transitions and never reads or writes the retained Firebase `eventTransitionReceipts` root.

The completed [receipt cutover](../scripts/deploy-cloudflare.md#event-transition-receipt-d1-cutover) preserved historical receipts, scheduled Workflow identities, and protected verification evidence. `npm run manage:event-transition-receipts -- --status` reports active authority, unresolved-work counts, and any operator lock. Its initial migration and Workflow-replacement commands are retired. Current event incidents use the maintenance and recovery operations above.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` remains an independent auth maintenance switch. Change and release it as reviewed Worker configuration; do not create environment-specific copies or Dashboard overrides.

Auth intents and X redirect flows are stored in the `mons-link-auth-state` D1 database through `AUTH_STATE_DB`. Cloudflare provides persistent browser sessions and five-minute API access tokens. Auth-state D1 is consume-once and revision-fenced. After a one-hour grace, the Worker schedule removes expired created/processing rows and compacts obsolete proof material; verified/completed/failed replays are retained for 30 days. Do not manually edit or delete active rows.

`mons-link-auth-recovery` is the permanent recovery Queue. Its consumer applies `authRecoveryJobs` idempotently, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record.

Identity reconciliation removes recovered login UIDs directly from the canonical D1 recovery record. Prize recovery uses a D1-only store for profile-prize reads, event-lock transactions, and lease-guarded stored-prize writes. Auth and recovery do not construct Firebase clients or require Firebase credentials. Recovery preserves retired prize assignments, withdrawal completion checks, bounded pagination, and durable retry progress. Active match adapters and downstream game projections use Cloudflare state. `FIREBASE_RTDB_URL`, `GAMEPLAY_SERVICE_ACCOUNT_EMAIL`, and `GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY` are absent from the final Worker configuration. Firebase identity, Telegram, and gameplay credentials are no longer runtime requirements; retained Google accounts, keys, and historical evidence remain preserved.

## Profile-game projection recovery

Account-link game discovery uses the activated D1 index in `PROFILE_GAMES_DB.login_match_discovery`, controlled by `login_match_discovery_control`. `npm run manage:login-match-discovery -- --status` reports its source selection, capture enforcement, and row counts by resolution/provenance. Current API source rejects inactive control or unavailable D1 reads without a Firebase fallback. The index includes unlinked and deleted-auth login UIDs; profile ownership is still resolved separately from canonical D1 ownership. Missing or ambiguous historical invite mappings remain explicit rows. A different resolved mapping is a conflict that must be reconciled, never overwritten.

The completed [discovery cutover](../scripts/deploy-cloudflare.md#account-link-game-discovery-cutover) preserved full source inventory and activation evidence while gameplay remained active. Its initial inventory, import, verification, and activation commands are retired. Keep the capture guard and existing catch-up jobs; ongoing event-discovery repair verifies canonical Cloudflare matches.

`mons-link-profile-game-projection` permanently owns rating, manual invite, automatch, event, and profile-link projections. Manual game-session mutations use D1 per-invite leases, UUID receipts, and durable transition intents. Recovery preserves create-only Durable Object match effects before committing canonical D1 invite/discovery state, receipts, and projection outboxes. Automatch starts require a client operation ID, use a stable operation-scoped D1 lease, and commit a result receipt for every successful response, including an already-owned pending queue. The frontend reuses the exact unresolved request for seven days and serializes tabs with Web Locks; browsers without origin-wide locking fail before the request. After the seven-day boundary, a click is a new user action rather than a replay. Producers persist durable markers before enqueueing, and the five-minute Worker schedule repairs and re-enqueues stale markers while request fencing preserves newer work and recoverable cleanup owners. The same schedule removes game-session mutation receipts after seven days and expired D1 mutation leases in bounded batches.

Investigate stuck work through Queue consumption, pending marker age, and projection logs. Do not purge the Queue, delete a pending outbox, manually delete profile documents, or manually rewrite canonical profile-event prizes.

## Gameplay coordination

`mons-link-profile-games` D1 owns gameplay mutation leases and timer-start markers. The bounded reconciliation sweep checks the opponent metadata before removing stale timer markers. Active match writes use the invite Durable Object timer-claim fence. A committed automatch operation returns its receipted result; an unproven coordination failure returns a sanitized `503`.

`npm run manage:match-state -- --status` reports the retained one-way authority, source/verification digests, current counts, and operator lock without Firebase credentials. After `backend = 'durable'` and `state = 'active'`, migration write phases are retired and fail before accessing credentials, deployments, or local evidence. `--inspect-admissions --directory <original-private-directory>` exports retained admissions using read-only SQL and the original import identity. Preserve `0024_match_state.sql`, routing, legacy records, import and reconciliation receipts, and protected exports. Normal gameplay no longer creates cutover admissions; retained rows are evidence, never an instruction to restart migration.

## Invite metadata delivery

`GET /invites/:inviteId/metadata` returns a revisioned snapshot of participant IDs, host color, both rematch strings, automatch state, and event membership. Its viewer fields resolve the caller's canonical D1 role and expose only that login's automatch operation ID. Passwords, other logins' operation IDs, and wagers never enter the public snapshot. Paired invites allow public spectators; pending open invites require authentication, and pending private invites require host ownership, including linked logins.

`GET /invites/:inviteId/metadata/socket` uses `mons-invite-metadata-v1` in the existing `InviteReactions` Durable Object. Metadata has separate admission limits and broadcasts from reaction v1/v2 and presentation traffic. HTTP reads and new sockets refresh canonical invite state; access checks and admission are tied to the same metadata revision and private-invite policy. The object persists the latest sanitized snapshot and increments its revision only when that snapshot changes.

Successful invite metadata writes request an immediate refresh after the canonical commit. Notification failure cannot fail a committed gameplay operation. While metadata sockets are connected, a persistent alarm reads the invite every five seconds, shared across all viewers, to recover missed notifications. Routine compatible releases preserve existing Workflow instances. Source failure retains the last snapshot and the next alarm. Metadata polling stops when its last subscriber leaves, even if reaction sockets remain.

The browser replaces direct invite and rematch reads with this API and subscription. It preserves separately observed wager snapshots and live match data, applies both rematch fields together, and prevents stale snapshots from reversing confirmed proposals or reopening an ended series. A visible, online client uses five-second HTTP recovery while its socket is unavailable, with bounded error backoff and `Retry-After` support. There is no direct Firebase invite-read fallback. Auth or game-context changes release the metadata subscription and pending work.

The initial transport migration preserved the browser protocol. The completed [invite-source storage cutover](../scripts/deploy-cloudflare.md#invite-source-d1-cutover) made `PROFILE_GAMES_DB.invite_sources` authoritative. The default invite reader composes invite metadata and wager state directly from D1 without constructing a Firebase client. Runtime persistence rejects retired source modes and preserves v2 session recovery and create-only Durable Object match writes.

`npm run manage:invite-source -- --status` reports the invite, automatch, and event gates plus unresolved admissions, intents, resources, and leases. `--inspect-admission` and `--reconcile-admission` retain exact-row, scoped-source, and protected-evidence checks for current D1 recovery. Initial freeze/export/import/verification/activation/restoration commands are retired. Retained Firebase invites and historical evidence remain intact.

## Wager delivery

`GET /invites/:inviteId/wagers` returns `{ ok: true, snapshot: { inviteId, revision, wagers } }`. `GET /invites/:inviteId/wagers/socket` uses `mons-invite-wagers-v1` in the existing `InviteReactions` Durable Object. Snapshots contain the invite's complete public wager map so current and historical rematches use the same view. Public proposals, proposal history flags, agreements, and resolutions are retained; operation IDs, reservation bookkeeping, settlement claims, and browser optimistic flags are excluded.

Reads and socket admission follow invite metadata access: paired invites allow spectators, pending open invites require authentication, and pending private invites require canonical host ownership. Admission and subsequent broadcasts recheck the canonical invite policy. Wager snapshots have independent persisted revisions and channel limits; metadata and wagers share queued source reads that combine canonical invite metadata with D1 wager state and the object's single five-second reconciliation alarm. Reads arriving after a source fetch starts use the next fetch. The 512-socket room limit reserves 24 participant sockets across the three channels, allowing at most 488 spectator sockets. Reaction and presentation messages remain isolated from both channels.

`PROFILE_DB.invite_wager_states` is authoritative for wager proposals, agreements, internal settlement state, and resolution markers. Completion updates the wager state and its resolution marker atomically in D1. HTTP mutations, queued settlement recovery, rating messages, and Durable Object snapshots use the same canonical state; retained Firebase values never provide a wager fallback. D1 wager writes request refresh after confirmed or ambiguous attempted writes. Notification failures cannot reject a committed mutation. Source changes advance the wager revision even when only internal bookkeeping changed, so clients still refresh frozen balances. Source failures retain the last valid snapshot; malformed data never becomes an empty wager map.

The browser hydrates and subscribes through the Worker with no Firebase wager-read fallback. It uses the metadata channel's shared reconnect, heartbeat, cancellation, visibility, and bounded HTTP recovery behavior. Mutation generations and confirmed revisions protect optimistic state from old snapshots, and a fresh HTTP read reconciles each completed or failed mutation, including unchanged canonical revisions. Account changes and game-context replacement release the subscription and pending requests.

The completed [wager-state cutover](../scripts/deploy-cloudflare.md#wager-state-d1-cutover) established D1 source authority. Retained `invites/{inviteId}/wagers` and `matchesWagerResolutions` records remain unread and unchanged. The Worker, namespace, Queue, and browser protocol contracts are preserved.

`npm run manage:wager-state -- --status` reports activation state, immutable import evidence, and destination counts without Firebase credentials. Initial source scans, exports, imports, verification, and activation are retired. Current wager incidents use the canonical-profile and wager-reservation maintenance operators.

`npm run smoke:wagers` provides separate preparation, frozen-read, and active-lifecycle phases. Preparation creates two dedicated test profiles with locally generated Solana sign-in keys, mines their first rock for one dust each, and creates three manual invites. It leaves one pending proposal for import verification. After resume, the lifecycle verifies cancel, decline, accept, settlement, and replay behavior using only those two profiles' dust. It never requests ratings, automatch, events, or external announcements. Keep its mode-`0600` credential fixture outside the repository; interrupted runs reuse the same fixture and completed steps. The read-only mode accepts a supplied paired invite and optional protected auth-token fixture without sending gameplay mutations. See the deployment procedure for the exact commands.

## Live match delivery

`GET /invites/:inviteId/matches/:matchId/snapshot` returns a revisioned pair of validated match records. The matching `/socket` route uses `mons-match-sync-v1` for receive-only snapshots and the existing heartbeat. Both routes use the existing `InviteReactions` namespace and canonical invite membership. Authenticated participants can read a pending match; paired invites support anonymous spectators. Cloudflare session JWTs supply participant tokens; `MATCH_SYNC_RATE_LIMITER` allows 600 HTTP reads per minute in its independent bucket; socket upgrades retain the existing connection rate limiter.

Each snapshot identifies the invite, match, host and optional guest, includes nullable host/guest match records, and advances its persisted revision only when the normalized source changes. Only a genuinely absent record becomes `null`; malformed records and upstream failures preserve the last valid state and return an error instead of fabricating a missing game. The source is canonical Durable Object match storage. Imported timer claims retain their exact deadlines and atomically fence Worker mutations in that object. Legacy records without a canonical room remain exact read-only D1 evidence.

Committed gameplay changes request immediate refresh. The object's single alarm reconciles subscribed matches every second while preserving metadata and wager reconciliation every five seconds. Match channels remain separate from reaction v1/v2, presentation, metadata, and wagers, including hibernated attachments and connection reservations. The browser shares each invite/match subscription between its two player observers, ignores stale revisions and retired contexts, and recovers through Worker HTTP snapshots and reconnects without a Firebase delivery fallback.

The [active-match storage cutover](../scripts/deploy-cloudflare.md#active-match-storage-cutover) records the completed authority transition; subsequent compatible releases use the routine API-first path. The lifecycle smoke defaults to durable storage, creates temporary anonymous participants and a manual invite, checks pending/join/rematch snapshots, cumulative moves and takebacks, timer deadline replay, surrender, spectator delivery, and reconnect heartbeats, then ends the series and revokes both sessions. Verification includes denied direct Firebase reads and writes, preserved source evidence, and Cloudflare-only gameplay and reconnect behavior.

## Reaction delivery

`INVITE_REACTIONS` binds the API Worker to `InviteReactions`, one SQLite-backed Durable Object per invite. The Worker checks paired invite membership and canonical D1 participant ownership before publishing `POST /invites/:inviteId/reactions`; spectators use the public `GET /invites/:inviteId/reactions/socket` with an allowed browser origin. The WebSocket accepts heartbeat messages only. Cloudflare sessions supply identity, the invite Durable Object owns active match data, and invite authorization reads canonical D1 metadata.

Each room reserves four connections for the host and four for the guest, alongside at most 248 spectators and eight spectator connections per IP. Players authenticate the socket handshake using their Cloudflare access token in the WebSocket protocol header; the server echoes only the negotiated `mons-reactions-v1` or `mons-reactions-v2` protocol and forwards no credentials to the Durable Object. Participant admission uses a separate rate-limit bucket keyed by the resolved player UID. Connection tags retain these limits through hibernation.

The object retains the latest reaction per player and uses hibernating WebSockets. Fresh game contexts suppress their initial snapshot; reconnecting contexts recover unseen reactions through the existing playback filters. There is no Firebase delivery fallback, reaction history import, or persistent outgoing queue. Failures affect reactions independently of active match synchronization.

Use the read-only reaction smoke in the deployment guide to verify snapshots and heartbeat delivery without publishing to a game. Monitor socket connection failures, publish failures, rate-limit rejections, and browser reconnect frequency. Preserve Durable Object storage and its `exports` declaration during repairs.

## Match presentation

`GET` and `POST /invites/:inviteId/matches/:matchId/presentation` read and update live emoji/aura state in the existing invite Durable Object. The Worker resolves the authenticated login to the stored match actor using canonical D1 ownership. Public reads require a paired invite; an authenticated host can read and change their own appearance while waiting for a guest. Updates must target the actor's current match, including their pending rematch. Profile customization uses its existing API independently.

Match creation initializes missing Durable Object presentation and immutable seed evidence before committing actor registration in `PROFILE_GAMES_DB.match_presentation_registrations`. Registrations establish actual actor existence; archive-only rows do not authorize an actor. Metadata references without an actual match record and discovery evidence remain absent actors, preserving partial player snapshots. The `match_presentation_control` authority is `durable`. Presentation HTTP reads, v2 admission, and appearance projection require registration plus Durable Object state; retired authority modes fail without a Firebase appearance fallback. A registered actor with missing or invalid Durable Object state fails retryably. Canonical gameplay records retain immutable seed copies for compatible snapshots; historical Firebase seed copies remain unchanged. A write includes a UUID `operationId`, `expectedRevision`, `emojiId`, and `aura`. Accepted writes advance the stored revision before broadcasting; a retry of the current accepted operation returns its result, and stale or changed operations return `409 presentation-conflict` with canonical state. Clients serialize and coalesce selections. An uncertain write keeps its original operation ID and revision until a newer server revision or an exact retry resolves it; newer selections wait without a retry loop. Pending work is discarded when leaving the game or changing identity. There is no Firebase write fallback.

V2 subscriptions use `?matchId=<existing-match-id>` and `mons-reactions-v2`, plus the existing bearer subprotocol for players. Their bounded snapshots contain reactions and presentation for up to two actors. Anonymous spectators send only the v2 subprotocol. V1 sockets continue receiving their unchanged reaction messages. Presentation snapshots apply on every connection, separately from reaction playback and game processing. HTTP hydration also works before pairing and while a socket is unavailable.

Game-list projections keep canonical profile avatars first. Opponents without a profile avatar use their registered Durable Object presentation. Lookup failures retry projection instead of storing a stale avatar.

The asynchronous profile-game archive freezes registered Durable Object appearance before writing a historical D1 pair. A retry reuses that capture; failures retry projection without undoing rating settlement. Existing archived cosmetics remain authoritative, including when a rated game snapshot replaces a transition snapshot. Later changes to the current finished game's live appearance do not rewrite history. Preserve both live and frozen presentation storage during repairs.

After the ordered API, frontend, and Firebase rules cutover, browser writes cannot change or remove match `emojiId`/`aura`, including through whole-match writes or admin claims. Surrender writes only status and move transactions preserve the seed fields. The completed [appearance authority migration](../scripts/deploy-cloudflare.md#match-appearance-authority-migration) initialized and verified existing actors before switching reads. Its capture, inventory, import, verification, and activation commands are retired. The explicitly reviewed nonparticipant source copies are retained separately in `match_presentation_source_exceptions`, including complete raw records and immutable evidence: verified aliases reference a canonical actor, while incompatible records remain archived. Neither kind grants live actor registration; source keys and Firebase originals remain preserved. It preserves edited live rows, operation replay, frozen history, and all Firebase records. `npm run manage:match-presentations -- --status` reports the phase and registration counts; after activation, repair forward without restoring Firebase appearance fallback.

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
