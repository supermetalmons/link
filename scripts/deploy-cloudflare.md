# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Release policy

Routine release is the default for content, styling, prize catalogs, and backward-compatible code fixes. Prepare and validate the affected candidates first, then use a maximum 60-second budget from the first production promotion through one bounded live verification pass. Finish as soon as verification passes. There are no fixed waits, write freezes, Queue pauses, drain checks, or extended log-tail sessions on this path.

Builds, tests, and candidate uploads happen during preparation; reuse their successful results for the same source instead of repeating them during promotion. Cloudflare or network delays can exceed the budget: report the actual delay or failed check, resolve any uncertain promotion result, and never claim an unverified release succeeded. Do not add another observation window after a successful check.

Use coordinated maintenance only when a specific operation requires exclusive access or cannot safely overlap old and new code: schema/data migrations, ownership or settlement protocol changes, incompatible Queue/Workflow payload changes, Durable Object lifecycle changes, or incident recovery. State the concrete reason, affected stores/Queues, drain condition, and required observation period before applying maintenance controls. The presence of D1, Queues, or Workflows alone does not make a release maintenance work. Historical cutover instructions below apply only to their named cutover.

Deploy only affected Workers. Shared prize-catalog changes need both the API and frontend; frontend-only edits need only the frontend. Keep writes and Queue delivery running during routine releases, preserving any maintenance state that predates the task. Apply trigger changes only when their configuration actually changed.

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Durable Object class exports, Queues, Workflows, consumers, and Cron schedule.
- The migration directories under `cloud/workers/api/` own the six D1 schemas.
- `PROFILE_DB.profile_login_owners` is authoritative for Worker login UID to canonical profile ownership. Firebase custom claims and RTDB profile links are non-authoritative browser-rule and recovery shadows.
- `cloud/workers/api/release.env` stays empty so release commands never load developer environment files.
- Encrypted secrets stay in Cloudflare; required names are declared in the API Wrangler configuration.
- `EVENT_DB` owns event records, participants, prize selections, visible assigned prizes, progress markers, and event-specific projection state. Active invites and matches remain in RTDB.
- `INVITE_REACTIONS` owns voice/sticker reaction delivery through one SQLite-backed `InviteReactions` Durable Object per invite. Firebase reaction records are retained but no longer written after the final rules cutover.
- The same Durable Object owns revisioned live match presentation and frozen historical appearance. Firebase matches retain immutable emoji/aura seeds; no extra Worker, namespace, or D1 migration is required.
- The same object serves revisioned invite/lobby/rematch metadata over a separate subscription. Invite source records remain in RTDB.
- The same object serves invite-wide public wager snapshots over HTTP and `mons-invite-wagers-v1`. Wager source records and mutations remain in RTDB. Metadata and wagers share canonical source reads and one five-second reconciliation alarm while either channel has subscribers; their revisions, admission limits, and broadcasts remain separate.
- `cloud/firebase.json` owns active-gameplay Realtime Database rules. Firestore, Firebase Functions, and canonical event-data RTDB paths are retired.

Authenticate Wrangler locally or provide `CLOUDFLARE_API_TOKEN` through the process environment. Never put credentials in command arguments, source files, release files, or logs.

## Validation

For routine releases, run the checks relevant to the change before promotion. Use focused prize tests and frontend/API typechecks for a catalog change; use the frontend build's checks for frontend edits. Reuse completed checks for unchanged source. Install dependencies only when missing or changed. Reserve the complete gate below for broad changes, dependencies/contracts, stateful behavior, and coordinated maintenance:

```sh
npm ci
npm ci --prefix cloud/functions
npm ci --prefix cloud/admin
npm run check:all
```

The complete gate validates the frontend, API Worker, generated bindings, deployment tooling, portable cloud modules, and Realtime Database rules.

## API Worker release

This is the routine path after the existing namespace is provisioned, with no lifecycle or incompatible state change. Record the current version, upload the validated candidate during preparation, then promote its explicit Version ID and run the standard smoke once:

```sh
npm run upload:api
npm run promote:api -- --version-id <version-id>
npm run smoke:api -- --base-url https://api.mons.link
```

Production API `workers_dev` and `preview_urls` remain disabled. [Workers implementing a Durable Object do not receive version-preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations). Verify the affected behavior on the custom domain after promotion. Use an existing protected auth fixture only when that behavior needs authentication; prepare or refresh it before promotion. For a prize-catalog release, confirm the scheduled event and supplied prize images on the updated frontend. Unrelated history, reservation, reaction, and migration checks are not routine release gates.

Keep live verification within the remaining 60-second release budget. The smoke command has per-request timeouts rather than an overall deadline, so enforce the remaining budget at the command runner and report a timeout as incomplete verification. Once the smoke and affected-feature check pass, record the deployed IDs and finish. Existing sampled logs and recovery jobs continue normally. Investigate concrete failures; apply only the maintenance controls that the failure requires.

`upload:api` sends no production traffic. `promote:api` requires an explicit Version ID and routes 100% of traffic to it. Trigger application is a separate operation for reviewed configuration changes.

## Coordinated maintenance release

This section is an exception for the concrete maintenance requirements in the release policy, not a prerequisite for routine API releases. The full profile/gameplay procedure below includes a 15-minute drain and a 15-minute observation period. Use those measures only when the maintenance plan requires them; narrower operations use the relevant storage-specific procedure. The initial reaction namespace bootstrap and historical ordered cutovers also use this path.

Validate locally before uploading, then promote the explicit Version ID and smoke the custom domain while the maintenance plan's canonical writes are frozen and affected Queues remain paused. Record the deployed version and Queue pause states before starting; preserve preexisting pauses. The following full coordinated procedure pauses all four Queues.

Create mode-`0600` smoke fixtures outside the repository: an auth fixture containing `{"idToken":"<existing-linked-login-token>"}` and a profile fixture containing `{"loginId":"<alternate-login-uid>","profileId":"<canonical-profile-id>","invite":{"id":"<existing-invite-id>","actorUid":"<stored-host-or-guest-uid>","role":"host"},"historicalMatch":{"inviteId":"<existing-historical-invite-id>","matchId":"<existing-historical-match-id>"}}`. Use `guest` when appropriate. The token subject must equal `loginId`; `actorUid` must be a different login owned by the same D1 profile. Use a known non-null D1 historical snapshot. The frozen-reservation smoke also needs that linked participant.

```sh
npm run manage:profile-canonical -- --freeze
npm run manage:profile-canonical -- --status
npx wrangler queues pause-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Wait at least 15 minutes after the last pause and verify admissions and active gameplay/projection leases have drained. Verify script-wide entry points through the [Worker subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/):

```http
GET https://api.cloudflare.com/client/v4/accounts/e25f90fc073ea309b54b8b5144bf28e0/workers/scripts/mons-link-api/subdomain
```

Require `enabled: false` and `previews_enabled: false` before proceeding. Upload the candidate, promote its explicit Version ID to 100%, apply reviewed triggers only when their configuration changed, and run both smokes on the custom domain before resuming writes or Queues. Omit `deploy:api:triggers` when triggers are unchanged:

```sh
npm run upload:api
npm run promote:api -- --version-id <version-id>
npm run deploy:api:triggers
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-wager-frozen-read --require-wager-storage-version --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

The read-only smoke verifies D1 ownership, profile lookups, navigation, alternate-login invite-role authorization, event transport, history, frozen balances and stale-client rejection. The storage-version check requires canonical writes frozen: missing headers return `409 client-update-required`, and valid headers reach `503 profile-writes-disabled` without mutation.

The promoted version serves production reads during these checks. If any check fails, keep writes frozen and Queues paused and repair forward; retain the Durable Object class export, binding, and stored reactions.

Resume canonical writes and only the Queues paused for this release, then run the standard smoke and authenticated read-only smoke without the freeze-only storage-version check:

```sh
npm run manage:profile-canonical -- --resume
npx wrangler queues resume-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-wager-frozen-read --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

The standard smoke covers public and temporary anonymous-auth behavior. Observe ownership errors, gameplay 5xx, reservations, settlement retries and queue recovery for at least fifteen minutes. Re-freeze affected writes on failure and repair forward. Tail the exact promoted version:

```sh
npx wrangler tail mons-link-api --version-id <version-id> --search profile-ownership-unavailable --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

`upload:api` sends no production traffic. `promote:api` requires an explicit Version ID. `deploy:api:triggers` applies routes, Cron, Workflows and configured Queue consumers; removing an omitted consumer requires an explicit operator action. Existing D1 schema migrations remain the current schema history.

### Initial reaction namespace and cutover

`InviteReactions` is declared through Wrangler's `exports` configuration with SQLite storage. [Cloudflare provisions a new Durable Object namespace during deployment](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/). The pinned Wrangler 4.127.1 can upload existing class declarations, but uploading a version with a binding to a new, unprovisioned namespace cannot complete that lifecycle change. Do not remove the binding, strip `exports`, substitute legacy migrations, or use a version preview as a provisioning workaround. Future class lifecycle changes need the same separately reviewed deployment procedure.

This first API release is a one-time exception to candidate upload followed by explicit promotion: `wrangler deploy` immediately releases the Worker and applies configured triggers. Review the complete API code, route, Queue, Workflow, Cron, and export changes; run the full validation gate; record the currently deployed version and Queue pause states; freeze canonical writes and pause all four Queues using the commands above. Wait at least 15 minutes and verify active admissions and leases have drained. Keep script-wide `workers_dev` and `preview_urls` disabled and verify those states through the subdomain API. Then review this local dry run before the separately authorized production bootstrap:

```sh
npx wrangler deploy --dry-run --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Record the returned Version ID and confirm the `InviteReactions` namespace and `INVITE_REACTIONS` binding were provisioned. Run the frozen custom-domain API smoke above and the read-only reaction smoke below. Keep writes frozen on failure and repair forward. A namespace lifecycle change prevents returning to a version from before that change; retain the live class export, binding, and stored reactions in any repair. Once the bootstrap is verified, resume canonical writes and only the Queues paused for this release, then repeat the standard and authenticated API smokes. Later compatible releases with the already-provisioned, unchanged class declaration use the routine API Worker release path without repeating bootstrap maintenance; stop if Cloudflare rejects a lifecycle change.

Release the frontend next using the normal frontend release procedure. In a dedicated test invite, verify voice and sticker reactions between two players and an anonymous spectator; linked-login publishing; rematches and event games; no initial snapshot playback; latest unseen reaction recovery after reconnect; sender echo suppression; and teardown after leaving the game or signing out. Ensure reaction failures leave gameplay usable. Only after those checks pass, preview and release the Firebase rules as the final cutover:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
npm run deploy:firebase -- --project mons-link
```

The new rules deny browser writes to `invites/{inviteId}/reactions`; retained records need no import or deletion. Older clients must refresh or update. API and frontend releases must precede this rules release, and mixed old/new clients do not share a reaction transport during the cutover. Observe connection/publish failures, rate-limit rejections and browser reconnect frequency for at least fifteen minutes after cutover. Retain the API namespace if the frontend must be repaired.

### Match presentation cutover

This historical presentation cutover adds tables and RPC methods to the existing `InviteReactions` namespace and coordinates a Firebase rules change; retain its class export, binding, and stored data. Use the coordinated maintenance procedure for this cutover. V1 reaction frames remain compatible while v2 adds a match-specific presentation snapshot and revisioned events. Do not enable a preview URL or repeat the initial namespace bootstrap. Later compatible presentation fixes use the routine release path.

After API promotion, run the existing v1 smoke and the v2 smoke with an explicitly selected paired invite and existing match:

```sh
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id> --match-id <existing-match-id>
```

Release the frontend after the API. In a dedicated test invite, verify emoji and aura changes between two players and an anonymous spectator; clearing an aura; rapid changes; linked-login updates; HTTP hydration while the host waits for a guest; and reconnect after a change. Verify rematches and event games, stale match/profile snapshots, and changing live appearance while viewing historical games. Confirm moves, timers, reactions, and surrender still work, and that archived appearance stays unchanged after a later live update.

Only after those checks pass, dry-run and release Firebase rules:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
npm run deploy:firebase -- --project mons-link
```

These rules preserve both the values and existence of match `emojiId` and `aura` for all browser claims. They reject child updates, deletion, and whole-record changes, while service-side match creation retains its existing behavior. Older clients must refresh or update; old/new clients do not share live cosmetic updates during the cutover. Retain the Firebase seed fields and historical records without bulk backfill. Observe presentation GET/POST failures, revision conflicts, v2 reconnect frequency, Firebase permission errors, and historical projection retries for at least fifteen minutes. Repair forward while preserving the namespace, live presentations, and frozen snapshots.

### Read-only reaction smoke

Choose an existing paired invite explicitly. This smoke uses no auth fixture, publishes no reaction, and never selects a game automatically:

```sh
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

The smoke connects as a spectator with `Origin: https://mons.link`, validates the versioned snapshot and invite membership of any reaction entries, sends only the application heartbeat, disconnects, and repeats to verify reconnect delivery. Each connection has a ten-second deadline and a 4 KiB message limit; redirects are disabled and output excludes reaction contents. An empty snapshot passes. A pending or missing invite, origin/upgrade rejection, malformed message, missing heartbeat, or premature disconnect fails the command. Run it on the API custom domain after a release affecting reactions; when maintenance paused writes, run it before resuming them. The default `smoke:api` command remains unchanged and never broadcasts reactions to a live game.

Adding `--match-id <existing-match-id>` explicitly selects v2. The smoke requires successful v2 protocol negotiation, validates the selected match's presentation snapshot and any arriving presentation events within a 16 KiB envelope, and repeats after reconnect. The larger response bound accommodates maximum-length legacy match IDs; presentation mutation bodies retain a 4 KiB limit. The smoke never sends a presentation mutation, logs cosmetic values, or imports historical records. The server may lazily initialize missing presentation seeds while serving the snapshot. Omitting `--match-id` retains the v1 reaction-only smoke.

Unit coverage for this command uses simulated sockets and timers in `npm run test:tooling`. It does not replace the two-player/spectator browser verification before the final rules cutover.

### Read-only invite metadata smoke

Prepare an explicitly selected existing paired invite before production promotion. After promoting the API candidate, run:

```sh
npm run smoke:invite-metadata -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

The command validates the public HTTP snapshot and anonymous viewer, connects with `mons-invite-metadata-v1`, checks the snapshot revision and heartbeat, then repeats the connection to verify reconnect delivery. One thirty-second deadline covers the entire command; also enforce the remaining routine release budget at the command runner. The smoke never selects a game automatically, sends a gameplay mutation, or logs invite contents. Serving reads initializes or refreshes the derived Durable Object snapshot without changing the canonical invite.

Validate pending-host, linked-login, joining, cancellation, rematch, spectator, and recovery behavior in the API runtime and client tests during preparation. Existing reaction v1/v2 runtime coverage remains required because the namespace is shared. Upload both validated candidates before promoting the API, then the frontend, with no trigger deployment or Firebase rules change. The added snapshot table is compatible with existing reactions and requires no namespace lifecycle migration or maintenance controls.

## Canonical profile D1 maintenance

The canonical profile control accepts only `active` and `frozen`. Freeze before schema maintenance and leave production frozen on any failure:

```sh
npm run manage:profile-canonical -- --status
npm run manage:profile-canonical -- --freeze
npx wrangler d1 migrations list mons-link-profiles --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 migrations apply mons-link-profiles --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Pause the permanent profile-related Queues when a migration changes profile schema or invariants:

```sh
npx wrangler queues pause-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

After applying the migration, inspect the expected schema, run `PRAGMA foreign_key_check`, smoke production, then resume the control and Queues:

```sh
npm run manage:profile-canonical -- --resume
npx wrangler queues resume-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Canonical profile incidents freeze D1 and fix forward. `legacy_fields_json` contains retained migrated data and must remain intact.

## Historical match D1 operations

`mons-link-profile-games` D1 is the sole source for the public historical-match endpoint. A missing snapshot returns `pair: null`; the endpoint never reads RTDB or persists data on a read miss. There is no RTDB recovery or backfill path. Releases affecting history or its projections must pass the authenticated `--require-history` smoke using a known non-null D1 snapshot. Prepare its fixture before promotion and include this check in the routine verification budget; for coordinated maintenance, run it before canonical writes resume. Unrelated catalog or frontend changes do not require this fixture.

During a relevant maintenance observation window or an investigation, tail historical reads and their rating- and transition-driven archival projections. Routine releases require no fixed observation window:

```sh
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical_match_read_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical_match_archive_descriptor_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical-match-conflict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search profile_game_projection_queue_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --status error --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

`historical_match_read_failed` is the handled public-history 503 signal; `--status error` covers uncaught Worker failures and limits, not handled 5xx responses. Any required-history smoke failure, archive conflict, recurring Queue failure, or new history 5xx requires freezing affected writes and repairing forward. Active match synchronization continues to use RTDB.

## Event D1 operations

`mons-link-events` owns event data and coordination. Its control supports `d1` and `frozen`:

```sh
npm run manage:event-prize-withdrawals -- --freeze
npm run manage:profile-canonical -- --freeze
npm run manage:events -- --status
npm run manage:events -- --freeze
```

Wait until no withdrawal is `processing` or `submitted`, and event/projection leases and write admissions have drained before changing coordinated state. Inspect all pages of version-pinned Workflow instances during schema maintenance. Freeze storage before terminating an instance, and preserve pending D1 work for recovery.

```sh
npx wrangler d1 execute mons-link-event-prize-withdrawals --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --command "SELECT COUNT(*) AS pending_withdrawals FROM event_prize_withdrawals WHERE json_extract(record_json, '$.status') IN ('processing', 'submitted');" --json
npx wrangler d1 migrations apply mons-link-events --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:events -- --recover-stale-admission <admission-id>
```

Recover only a named expired admission after confirming its request finished. Never bulk-delete admissions. Pending transitions retry while preserving their fences; fix the implementation or unavailable dependency forward, and do not detach, delete, or dead-letter the intent. Successful transition receipts are immutable coordination evidence in `eventTransitionReceipts`; there is no scheduled receipt deletion. Do not restore `EVENT_DB` alone because event state and RTDB gameplay effects must remain consistent.

Validate current and ended events through the authenticated `--require-events` smoke. Its profile fixture includes `"events":{"currentId":"<scheduled-or-active-event-id>","endedId":"<ended-prize-event-id>","selectionPrizeId":"<selected-prize-id>","assignedPrizeId":"<assigned-prize-id>"}`. Use a visible, unwithdrawn assignment owned by that profile; add `selectionEventId` if the selection belongs to a different event. After verification, resume events and dependent stores, resume only Queues paused for maintenance, and repeat production smokes:

```sh
npm run manage:events -- --resume-d1
npm run manage:event-prize-withdrawals -- --resume
npm run manage:profile-canonical -- --resume
```

## Wager reservation D1 operations

Frozen balances and operation records are current D1 application state. Preserve consumed operation tombstones and pending settlements. Freeze canonical profiles before reservation maintenance:

```sh
npm run manage:profile-canonical -- --freeze
npm run manage:wager-reservations -- --status
npm run manage:wager-reservations -- --freeze
npm run manage:wager-reservations -- --recover-admission <admission-id> --confirm-request-finished --confirm-source-reconciled
npm run manage:wager-reservations -- --resume-d1
npm run manage:profile-canonical -- --resume
```

Recover only an expired admission whose original request has finished and whose uncertain effects have been reconciled. Resume requires admissions and gameplay leases drained. Include `mons-link-telegram-delivery` in coordinated maintenance because it delivers settlement retries. Validate frozen reads and stale-client rejection while canonical writes remain frozen, then verify normal wagering after resume. Keep writes frozen and repair forward on failures; canonical balances and RTDB wager effects must stay consistent.

## Event-prize withdrawal D1 operations

`mons-link-event-prize-withdrawals` owns admission, leases, persisted Solana submissions, and completion records. Its runtime control accepts `d1` and `frozen`:

```sh
npm run manage:event-prize-withdrawals -- --status
npm run manage:event-prize-withdrawals -- --freeze
npm run manage:event-prize-withdrawals -- --resume
```

Freeze storage before terminating a withdrawal Workflow or changing its schema. After freezing, wait at least five minutes and confirm `activeLeases` is zero.

After promoting a candidate, trigger a unique read-only preflight and inspect the exact instance before resuming withdrawal storage:

```sh
event_prize_preflight_id="preflight-$(date -u +%Y%m%d%H%M%S)-$$"
npx wrangler workflows trigger mons-link-event-prize-withdrawal '{"schemaVersion":1,"kind":"preflight"}' --id "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances describe mons-link-event-prize-withdrawal "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

The preflight must complete with `{"ok":true,"status":"ready"}`. It validates the encrypted wallet identity, Metaplex runtimes, and a read-only Helius request without building or sending a transaction.

## Queue and Workflow operations

`mons-link-profile-game-projection` owns rating, invite, automatch, event, and profile-link projections. `mons-link-telegram-projection` owns automatch, rating, and event Telegram projections. Profile-link catch-up jobs are written atomically with canonical ownership changes in `PROFILE_DB`; their Queue dispatch is recovered by the scheduled D1 sweep. Active RTDB outboxes are written atomically with their source mutations. Do not purge Queues or delete pending jobs or outboxes during incidents.

`mons-link-event-progress` owns scheduled event starts and retriable synchronization. Inspect every page of Workflow instances before schema maintenance when version-pinned work could still be active:

```sh
npx wrangler workflows instances list mons-link-event-progress --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances list mons-link-event-prize-withdrawal --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

## Telegram D1 operations

Delivery and recovery records live in `mons-link-telegram`. Apply its schema before promoting a Worker that requires it:

```sh
npx wrangler d1 migrations apply mons-link-telegram --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

`telegram_runtime_control` uses `d1` and `frozen`. Missing or unreadable control state fails closed. Ambiguous sends remain `uncertain` and require an operator-reviewed recovery action; never retry them blindly.

## Frontend release

Prepare the frontend before starting the production release budget: `preview` performs an isolated build, its client checks, and a candidate upload. Avoid running the same build/checks separately first. Verify a unique frontend preview when the affected behavior works on that origin; existing Firebase referrer restrictions may block preview sign-in. In that case, use local fixture rendering for visual checks and verify the real affected page on `mons.link` immediately after promotion. Keep the existing auth restrictions.

When the frontend depends on new API behavior, promote and smoke the API first. Promote the prepared frontend's exact tested version without rebuilding, then verify the affected live page once within the remaining 60-second release budget:

```sh
npm run deploy -- preview
npm run deploy -- production --version-id <version-id>
```

Exercise current event polling or two-tab automatch behavior when the change affects those flows. For a prize-catalog update, verify the actual event's images and order without joining or changing prize selections. Finish after the targeted check; no log-tail wait is required. Deploying a frontend does not refresh already open tabs; browser clients rejected by the operation-ID or wager-version gate must reload.

## Firebase rule release

Firebase releases update only Realtime Database rules:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
npm run deploy:firebase -- --project mons-link
```

## IAM and secrets

The Firebase identity has only Firebase Auth and RTDB permissions. The gameplay identity has only RTDB read/write permissions. Do not broaden either identity to Editor or Owner.

Keep X, Telegram bot credentials, Helius, Google private keys, and the event-prize wallet as encrypted Worker secrets. The `TELEGRAM_QUEUE_BRIDGE_SECRET` operator credential is also provisioned in a protected local file; see [cloud operations](../cloud/README.md#telegram-recovery-and-announcements). Automatic Sunday Mons prize announcements use the existing bot credentials and require no announcement bridge secret. Routine releases reuse existing encrypted values.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the tracked auth maintenance switch. Change it through candidate upload, explicit Version ID promotion, and custom-domain smoke; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record. Auth origins are enforced in code.
