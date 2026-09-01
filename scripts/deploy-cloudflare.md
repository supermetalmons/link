# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Queues, Workflows, consumers, and Cron schedule.
- The migration directories under `cloud/workers/api/` own the five D1 schemas.
- `PROFILE_DB.profile_login_owners` is authoritative for Worker login UID to canonical profile ownership. Firebase custom claims and RTDB profile links are non-authoritative browser-rule and recovery shadows.
- `cloud/workers/api/release.env` stays empty so release commands never load developer environment files.
- Encrypted secrets stay in Cloudflare; required names are declared in the API Wrangler configuration.
- `cloud/firebase.json` owns only Realtime Database rules. Firestore and Firebase Functions are retired and are not rollback targets.

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

Before uploading, confirm canonical profile writes are active and the ownership database has no foreign-key violations:

```sh
npm run manage:profile-canonical -- --status
npx wrangler d1 execute mons-link-profiles --remote --command "PRAGMA foreign_key_check" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

The status must be `active`, and the foreign-key validation must return no rows.

Create mode-`0600` smoke fixtures outside the repository: an auth fixture containing only `{"idToken":"<existing-linked-login-token>"}` and a profile fixture containing `{"loginId":"<alternate-login-uid>","profileId":"<canonical-profile-id>","invite":{"id":"<existing-invite-id>","actorUid":"<stored-host-or-guest-uid>","role":"host"},"historicalMatch":{"inviteId":"<existing-historical-invite-id>","matchId":"<existing-historical-match-id>"}}`. Use `"guest"` when appropriate. The token subject must equal `loginId`; `actorUid` must be a different login owned by the same D1 profile. The historical match must be a known non-null D1 snapshot. Upload the candidate, then run both the standard smoke and the authenticated read-only ownership smoke before it receives traffic:

```sh
npm run upload:api
npm run smoke:api -- --base-url <version-preview-url>
npm run smoke:api -- --base-url <version-preview-url> --read-only --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

Record the Version ID printed by Wrangler. Promote that exact version, apply reviewed triggers, and repeat both smokes against production:

```sh
npm run promote:api -- --version-id <version-id>
npm run deploy:api:triggers
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:api -- --base-url https://api.mons.link --read-only --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

The standard smoke covers public and temporary anonymous-auth behavior. The authenticated read-only smoke verifies the existing login's D1 ownership, profile lookups, navigation, and alternate-login invite-role authorization without creating auth state. Both are release gates for preview and production.

Tail the promoted version during the production smokes and for at least 15 minutes afterward. Treat the tail as focused real-time evidence, not a complete event ledger; filtering reduces but does not eliminate sampling under load:

```sh
npx wrangler tail mons-link-api --version-id <version-id> --search profile-ownership-unavailable --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Rollback immediately to the previous tested D1-compatible Worker if the authenticated production smoke fails. Otherwise rollback if ownership failures recur across multiple real requests during that window or the Worker 5xx rate rises above its pre-deploy baseline. Additive migrations remain in place and require no D1 restore.

`upload:api` does not send traffic to the candidate. `promote:api` deploys an explicit Version ID to 100%. `deploy:api:triggers` applies routes, Cron, Workflows, and configured Queue consumers. Removing an omitted Queue consumer remains an explicit operator action.

Rollback targets only a reviewed D1-compatible Version ID:

```sh
npx wrangler rollback <known-good-version-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

## Canonical profile D1 maintenance

The canonical profile control accepts only `active` and `frozen`. Freeze before schema maintenance and leave production frozen on any failure:

```sh
npm run manage:profile-canonical -- --status
npm run manage:profile-canonical -- --freeze
npx wrangler d1 time-travel info mons-link-profiles --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --json
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

## Historical match D1 migration

Apply the additive profile-games migration before uploading an API version that serves historical matches:

```sh
npx wrangler d1 migrations apply mons-link-profile-games --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

The completed counts-only production metadata audit paged `/invites` 10 records at a time and checked each `hostRematches` and `guestRematches` field against limits of 64 KiB UTF-8 and 10,000 canonical tokens per field. It inspected 4,503 invites. The host/guest maxima were 54/53 bytes and 21/21 tokens, with zero outliers. Zero outliers is a rollout gate. Any new outlier blocks this rollout and requires a separate remediation task; do not expand the migration to repair it.

Release and smoke the API with `HISTORICAL_MATCH_RTDB_FALLBACK_ENABLED` set to `true`. Preview the complete invite scan, then execute it with a new protected failure report:

```sh
npm run backfill:historical-matches -- --project mons-link --base-url https://api.mons.link
umask 077
npm run backfill:historical-matches -- --project mons-link --base-url https://api.mons.link --execute --failure-file /secure/historical-match-backfill-failures.json
```

The final summary prints counts and the last safe cursor only. On failure, resolve the protected report, then rerun from the last safe cursor with a new failure-file path. The failed page is intentionally replayed, and D1 writes are idempotent:

```sh
umask 077
npm run backfill:historical-matches -- --project mons-link --base-url https://api.mons.link --execute --start-at "<last-safe-cursor>" --failure-file /secure/historical-match-backfill-failures-02.json
```

If the reported cursor is `null`, omit `--start-at` and rerun from the beginning with a new failure-file path. Never reuse an existing failure file or paste its contents into commands or logs. Repeat until the final summary reports zero failures.

Inspect aggregate state only; never select match identifiers or `snapshot_json`:

```sh
npx wrangler d1 execute mons-link-profile-games --remote --json --command "SELECT COUNT(*) AS total_snapshots, COUNT(CASE WHEN source_kind = 'rating' THEN 1 END) AS rating_snapshots, COUNT(CASE WHEN source_kind = 'transition' THEN 1 END) AS transition_snapshots, COUNT(CASE WHEN source_kind = 'backfill' THEN 1 END) AS backfill_snapshots, COUNT(CASE WHEN revision > 1 THEN 1 END) AS revised_snapshots FROM historical_match_pairs" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 execute mons-link-profile-games --remote --json --command "SELECT COUNT(*) AS invalid_metadata_count FROM historical_match_pairs WHERE schema_version <> 1 OR revision < 1 OR finalized_at_ms < 0 OR archived_at_ms < finalized_at_ms OR json_type(snapshot_json) <> 'object' OR COALESCE(json_extract(snapshot_json, '$.matchId'), '') <> match_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 execute mons-link-profiles --remote --json --command "SELECT COUNT(CASE WHEN profile_game_projection_state = 'pending' THEN 1 END) AS pending_profile_game_projections, COUNT(CASE WHEN json_extract(payload_json, '$.historicalMatchArchiveVersion') = 1 AND COALESCE(profile_game_projection_state, '') <> 'done' THEN 1 END) AS unresolved_historical_archives, COUNT(CASE WHEN json_extract(payload_json, '$.historicalMatchArchiveVersion') = 1 AND profile_game_projection_state = 'dead' THEN 1 END) AS dead_historical_archives FROM rating_updates" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
./node_modules/.bin/firebase database:get /profileGameProjectionOutbox/automatch --project mons-link | jq -c '. as $raw | (if $raw == null then {} else $raw end) as $root | (if ($root | type) == "object" then [$root[]] else [] end) as $rows | [$rows[] | if type == "object" then (if has("historicalMatches") then .historicalMatches else {} end) else null end] as $maps | {malformedRoot: (if ($root | type) == "object" then 0 else 1 end), malformedOutboxes: ([$maps[] | select(type != "object")] | length), unresolvedOutboxes: ([$maps[] | select(type == "object") | select(length > 0)] | length), unresolvedDescriptors: ([$maps[] | select(type == "object") | length] | add // 0)}'
```

`invalid_metadata_count` and every count reported by the final two commands must be zero before disabling fallback. Record the source counts for comparison after cutover.

After the execute pass finishes with zero failures, release the frontend using the Worker history endpoint. After its observation window, change the tracked fallback variable to `false`, upload and promote an exact API version, repeat the standard production smoke, then require the protected historical fixture to return a non-null pair:

```sh
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

Run each focused tail in a separate terminal during the execute pass, production smokes, cutover, and at least 15 minutes of live traffic:

```sh
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical_match_read_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical_match_archive_descriptor_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical-match-conflict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search profile_game_projection_queue_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search profile_game_projection_queue_processed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --status error --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

`historical_match_read_failed` is the handled public-history 503 signal; `--status error` covers uncaught Worker failures and limits, not handled 5xx responses. Continue running the standard smoke to verify successful public reads. Any archive conflict, recurring Queue failure, unresolved count, unexpected null, or new history 5xx blocks cutover and requires a separate fix-forward task. The migration does not delete RTDB matches, and any previous Worker version must remain D1-compatible.

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

`mons-link-profile-game-projection` owns rating, invite, automatch, event, and profile-link projections. `mons-link-telegram-projection` owns automatch, rating, and event Telegram projections. Durable RTDB outboxes are written atomically with their source mutations; do not purge Queues or delete pending outboxes during incidents.

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

When a frontend release depends on API behavior, promote and smoke the API first. Upload and smoke a unique frontend preview:

```sh
npm run deploy -- preview
```

Promote the exact tested version without rebuilding:

```sh
npm run deploy -- production --version-id <version-id>
```

Rollback with an explicit known-good version:

```sh
npx wrangler rollback <known-good-version-id> --config wrangler.jsonc
```

## Firebase rule release

Firebase releases update only Realtime Database rules:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
npm run deploy:firebase -- --project mons-link
```

## IAM and secrets

The Firebase identity has only Firebase Auth and RTDB permissions. The gameplay identity has only RTDB read/write permissions. Do not broaden either identity to Editor or Owner.

Keep X, Telegram, Helius, Google private keys, and the event-prize wallet only as encrypted Worker secrets. `TELEGRAM_QUEUE_BRIDGE_SECRET` and `TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET` are distinct credentials. Routine releases reuse existing encrypted values.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the tracked auth maintenance switch. Change it through candidate upload, smoke, and explicit Version ID promotion; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record. Auth origins are enforced in code.
