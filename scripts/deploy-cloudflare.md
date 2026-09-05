# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Durable Object class exports, Queues, Workflows, consumers, and Cron schedule.
- The migration directories under `cloud/workers/api/` own the six D1 schemas.
- `PROFILE_DB.profile_login_owners` is authoritative for Worker login UID to canonical profile ownership. Firebase custom claims and RTDB profile links are non-authoritative browser-rule and recovery shadows.
- `cloud/workers/api/release.env` stays empty so release commands never load developer environment files.
- Encrypted secrets stay in Cloudflare; required names are declared in the API Wrangler configuration.
- `EVENT_DB` owns event records, participants, prize selections, visible assigned prizes, progress markers, and event-specific projection state. Active invites and matches remain in RTDB.
- `INVITE_REACTIONS` owns voice/sticker reaction delivery through one SQLite-backed `InviteReactions` Durable Object per invite. Firebase reaction records are retained but no longer written after the final rules cutover.
- `cloud/firebase.json` owns active-gameplay Realtime Database rules. Firestore, Firebase Functions, and canonical event-data RTDB paths are retired.

Authenticate Wrangler locally or provide `CLOUDFLARE_API_TOKEN` through the process environment. Never put credentials in command arguments, source files, release files, or logs.

## Validation

```sh
npm ci
npm ci --prefix cloud/functions
npm ci --prefix cloud/admin
npm run check:all
```

The complete gate validates the frontend, API Worker, generated bindings, deployment tooling, portable cloud modules, and Realtime Database rules.

## API Worker release

For the initial reaction release, complete the namespace bootstrap and ordered cutover below. The standard version-upload sequence applies after that namespace exists and when the Durable Object lifecycle declaration is unchanged.

Production API `workers_dev` and `preview_urls` remain disabled. [Workers implementing a Durable Object do not receive version-preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations). Validate locally before uploading, then promote the explicit Version ID and smoke the custom domain while canonical writes are frozen and all four Queues remain paused. Record the deployed version and Queue pause states before starting; preserve preexisting pauses.

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

Require `enabled: false` and `previews_enabled: false` before proceeding. Upload the candidate, promote its explicit Version ID to 100%, apply reviewed triggers, and run both smokes on the custom domain before resuming writes or Queues:

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

Record the returned Version ID and confirm the `InviteReactions` namespace and `INVITE_REACTIONS` binding were provisioned. Run the frozen custom-domain API smoke above and the read-only reaction smoke below. Keep writes frozen on failure and repair forward. A namespace lifecycle change prevents returning to a version from before that change; retain the live class export, binding, and stored reactions in any repair. Once the bootstrap is verified, resume canonical writes and only the Queues paused for this release, then repeat the standard and authenticated API smokes. Later releases use the guarded upload and explicit 100% promotion sequence above with the already-provisioned, unchanged class declaration, followed by custom-domain verification before resuming writes; stop if Cloudflare rejects a lifecycle change.

Release the frontend next using the normal frontend release procedure. In a dedicated test invite, verify voice and sticker reactions between two players and an anonymous spectator; linked-login publishing; rematches and event games; no initial snapshot playback; latest unseen reaction recovery after reconnect; sender echo suppression; and teardown after leaving the game or signing out. Ensure reaction failures leave gameplay usable. Only after those checks pass, preview and release the Firebase rules as the final cutover:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
npm run deploy:firebase -- --project mons-link
```

The new rules deny browser writes to `invites/{inviteId}/reactions`; retained records need no import or deletion. Older clients must refresh or update. API and frontend releases must precede this rules release, and mixed old/new clients do not share a reaction transport during the cutover. Observe connection/publish failures, rate-limit rejections and browser reconnect frequency for at least fifteen minutes after cutover. Retain the API namespace if the frontend must be repaired.

### Read-only reaction smoke

Choose an existing paired invite explicitly. This smoke uses no auth fixture, publishes no reaction, and never selects a game automatically:

```sh
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

The smoke connects as a spectator with `Origin: https://mons.link`, validates the versioned snapshot and invite membership of any reaction entries, sends only the application heartbeat, disconnects, and repeats to verify reconnect delivery. Each connection has a ten-second deadline and a 4 KiB message limit; redirects are disabled and output excludes reaction contents. An empty snapshot passes. A pending or missing invite, origin/upgrade rejection, malformed message, missing heartbeat, or premature disconnect fails the command. Run it on the API custom domain after promotion and before resuming writes. The default `smoke:api` command remains unchanged and never broadcasts reactions to a live game.

Unit coverage for this command uses simulated sockets and timers in `npm run test:tooling`. It does not replace the two-player/spectator browser verification before the final rules cutover.

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

`mons-link-profile-games` D1 is the sole source for the public historical-match endpoint. A missing snapshot returns `pair: null`; the endpoint never reads RTDB or persists data on a read miss. There is no RTDB recovery or backfill path. Every promoted API version must pass the authenticated `--require-history` smoke above using a known non-null D1 snapshot before canonical writes resume.

Tail historical reads and their rating- and transition-driven archival projections during production smokes and the observation window:

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

When the frontend depends on new API behavior, promote and smoke the API first. Upload and smoke a unique frontend preview, then promote that exact tested version without rebuilding:

```sh
npm run deploy -- preview
npm run deploy -- production --version-id <version-id>
```

Exercise current event polling and two-tab automatch behavior. Deploying a frontend does not refresh already open tabs; browser clients rejected by the operation-ID or wager-version gate must reload.

## Firebase rule release

Firebase releases update only Realtime Database rules:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
npm run deploy:firebase -- --project mons-link
```

## IAM and secrets

The Firebase identity has only Firebase Auth and RTDB permissions. The gameplay identity has only RTDB read/write permissions. Do not broaden either identity to Editor or Owner.

Keep X, Telegram bot credentials, Helius, Google private keys, and the event-prize wallet as encrypted Worker secrets. Operator bridge credentials are also provisioned in protected local files; see [cloud operations](../cloud/README.md#telegram-recovery-and-announcements). `TELEGRAM_QUEUE_BRIDGE_SECRET` and `TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET` are distinct credentials. Routine releases reuse existing encrypted values.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the tracked auth maintenance switch. Change it through candidate upload, explicit Version ID promotion, and custom-domain smoke; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record. Auth origins are enforced in code.
