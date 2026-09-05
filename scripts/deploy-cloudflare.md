# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Queues, Workflows, consumers, and Cron schedule.
- The migration directories under `cloud/workers/api/` own the six D1 schemas.
- `PROFILE_DB.profile_login_owners` is authoritative for Worker login UID to canonical profile ownership. Firebase custom claims and RTDB profile links are non-authoritative browser-rule and recovery shadows.
- `cloud/workers/api/release.env` stays empty so release commands never load developer environment files.
- Encrypted secrets stay in Cloudflare; required names are declared in the API Wrangler configuration.
- `EVENT_DB` owns event records, participants, prize selections, visible assigned prizes, progress markers, and event-specific projection state. Active invites and matches remain in RTDB.
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

Production API `workers_dev` and `preview_urls` remain disabled. Production-backed candidate preview testing requires canonical writes frozen and all four Queues paused for at least fifteen minutes so earlier consumers finish. Preserve preexisting pauses. Use a separately protected preview environment only when its protection and data isolation are already configured.

Create mode-`0600` smoke fixtures outside the repository: an auth fixture containing `{"idToken":"<existing-linked-login-token>"}` and a profile fixture containing `{"loginId":"<alternate-login-uid>","profileId":"<canonical-profile-id>","invite":{"id":"<existing-invite-id>","actorUid":"<stored-host-or-guest-uid>","role":"host"},"historicalMatch":{"inviteId":"<existing-historical-invite-id>","matchId":"<existing-historical-match-id>"}}`. Use `guest` when appropriate. The token subject must equal `loginId`; `actorUid` must be a different login owned by the same D1 profile. Use a known non-null D1 historical snapshot. The frozen-reservation smoke also needs that linked participant.

```sh
npm run manage:profile-canonical -- --freeze
npm run manage:profile-canonical -- --status
npx wrangler queues pause-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Wait at least 15 minutes after the last pause and verify admissions and active gameplay/projection leases have drained. For a temporary preview window, set local `preview_urls: true`, retain `workers_dev: false`, and use the [Worker subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/):

```http
POST https://api.cloudflare.com/client/v4/accounts/e25f90fc073ea309b54b8b5144bf28e0/workers/scripts/mons-link-api/subdomain
Content-Type: application/json

{"enabled":false,"previews_enabled":true}
```

Read back the same endpoint with `GET` and require `enabled: false` and `previews_enabled: true`. Keep writes frozen on failure. Enabling previews affects every uploaded version, so the freeze lasts until script-wide previews are disabled again. Upload the candidate, run the authenticated read-only smoke on its exact preview URL, promote its explicit Version ID to 100%, apply reviewed triggers, and repeat the smoke on the custom domain:

```sh
npm run upload:api
npm run smoke:api -- --base-url <version-preview-url> --read-only --require-history --require-wager-frozen-read --require-wager-storage-version --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run promote:api -- --version-id <version-id>
npm run deploy:api:triggers
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-wager-frozen-read --require-wager-storage-version --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

The read-only smoke verifies D1 ownership, profile lookups, navigation, alternate-login invite-role authorization, event transport, history, frozen balances and stale-client rejection. The storage-version check requires canonical writes frozen: missing headers return `409 client-update-required`, and valid headers reach `503 profile-writes-disabled` without mutation.

Set local `preview_urls: false` again and disable previews for the entire script before resuming:

```http
POST https://api.cloudflare.com/client/v4/accounts/e25f90fc073ea309b54b8b5144bf28e0/workers/scripts/mons-link-api/subdomain
Content-Type: application/json

{"enabled":false,"previews_enabled":false}
```

Read back `enabled: false` and `previews_enabled: false`, verify the tested preview URL no longer invokes its Worker, and repeat the frozen custom-domain smoke. Local configuration alone does not disable already uploaded entry points. The custom domain remains active. If any check fails, keep writes frozen and repair forward.

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

`mons-link-profile-games` D1 is the sole source for the public historical-match endpoint. A missing snapshot returns `pair: null`; the endpoint never reads RTDB or persists data on a read miss. There is no RTDB recovery or backfill path. Every candidate and production release must pass the authenticated `--require-history` smoke above using a known non-null D1 snapshot.

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

Before promoting a candidate, trigger a unique read-only preflight and inspect the exact instance:

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

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the tracked auth maintenance switch. Change it through candidate upload, smoke, and explicit Version ID promotion; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record. Auth origins are enforced in code.
