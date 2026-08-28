# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Queues, Workflows, consumers, and Cron schedule.
- `cloud/workers/api/auth-state-migrations/` owns the `mons-link-auth-state` D1 schema for auth intents and X redirect flows.
- `cloud/workers/api/telegram-migrations/` owns the `mons-link-telegram` D1 schema for Telegram delivery, recovery, and announcement receipts.
- `cloud/workers/api/event-prize-withdrawal-migrations/` owns the `mons-link-event-prize-withdrawals` D1 schema and storage-mode fence for Solana prize withdrawals.
- `cloud/workers/api/profile-migrations/` owns the `mons-link-profiles` D1 read-model schema for profile lookup and leaderboards.
- `cloud/workers/api/release.env` stays empty. It prevents release commands from loading developer environment files.
- Encrypted secrets stay in Cloudflare. Their required names are declared in the API Wrangler configuration.
- Do not edit production Worker configuration in the Cloudflare Dashboard. Review and deploy the tracked configuration.

Authenticate locally with `npx wrangler login`, or provide `CLOUDFLARE_API_TOKEN` through the release environment. Never put credentials in command arguments, source files, or logs. Set or rotate Worker secrets interactively:

```sh
npx wrangler secret put <NAME> --config cloud/workers/api/wrangler.jsonc
```

## Validation

Install dependencies, then run:

```sh
npm ci
npm ci --prefix cloud/functions
npm run check:all
```

This validates the frontend, API Worker, Wrangler types and configuration, tooling, and Firebase functions.

## Auth state D1 cutover

`mons-link-auth-state` is the sole store for new auth intents and X redirect flows. It uses the `AUTH_STATE_DB` binding and does not use read replication. Apply and verify its schema before uploading a D1-backed candidate:

```sh
npx wrangler d1 migrations apply mons-link-auth-state --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 execute mons-link-auth-state --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --command "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('auth_intents', 'x_redirect_flows') ORDER BY name"
```

The 2026-08-27 cutover backfilled all legacy verified, completed, and failed X flows plus their referenced intents. Runtime reads remain D1-only. Before uploading a D1-backed candidate, upload and retain a version of the current production source with `AUTH_MUTATIONS_DISABLED=true`; do not give it traffic yet. Upload and smoke the D1-backed candidate with the tracked final value `AUTH_MUTATIONS_DISABLED=false`.

Promote the retained maintenance version to 100%, verify auth POST routes return `auth-mutations-disabled`, and wait ten full minutes. Then promote the exact tested D1-backed Version ID and run the authenticated API smoke. Verify only table counts so nonce, state, and OAuth verifier values never enter operator logs:

```sh
npx wrangler d1 execute mons-link-auth-state --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --command "SELECT 'auth_intents' AS table_name, COUNT(*) AS row_count FROM auth_intents UNION ALL SELECT 'x_redirect_flows', COUNT(*) FROM x_redirect_flows"
```

If the D1-backed version is unhealthy, immediately promote the retained maintenance Version ID rather than an auth-enabled Firestore version. Keep the D1 database intact. Fix forward, or wait another ten minutes before restoring an auth-enabled Firestore version. Expired legacy Firestore documents are intentionally not deleted by this migration.

The five-minute Worker schedule removes expired created/processing flows and orphaned intents after a one-hour replay grace. It compacts expired proof material from verified/completed/failed rows after one hour and retains those terminal replays for 30 days.

## API Worker release

Apply the profile read-model schema before releasing a Worker version that includes `PROFILE_DB`:

```sh
npx wrangler d1 migrations apply mons-link-profiles --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Before applying profile migration `0005`, promote the tagged Firestore-mode rollback version. Keep reads on Firestore while the schema-v2 Worker reconciles and verification passes; only then promote D1 mode. After `0005`, do not roll back to a schema-v1 D1 version because it uses the retired login-mapping table.

`PROFILE_READ_MODE` is tracked in `cloud/workers/api/wrangler.jsonc` and accepts only `firestore` or `d1`. Invalid values fail closed. Keep it on `firestore` while validating projection delivery and reconciliation, then promote the exact verified code in `d1` mode. Do not create a Dashboard override.

Backfill and verify without printing profile contents. The helper is locked to the production `mons-link` Firebase project because its Wrangler target is the production D1 database:

```sh
npm run migrate:profile-reads -- --dry-run --project mons-link
npm run migrate:profile-reads -- --execute --project mons-link
npm run migrate:profile-reads -- --verify --project mons-link
```

The `mons-link-profile-projection` Queue carries deduplicated profile IDs after committed Worker mutations. Delivery is best effort: the consumer rereads Firestore and applies the latest version, while the five-minute schedule scans all Firestore profile metadata and re-enqueues missing or version-mismatched projections in batches of at most 100. Apparent deletions are rechecked against Firestore before a version-fenced tombstone is applied. Caught infrastructure failures are acknowledged and recovered by Cron reconciliation. Validation failures remain fenced until the canonical profile is corrected or the projection schema changes. The configured platform retry applies only when the consumer invocation fails unexpectedly.

A relevant `profile_projection_failures` row makes the affected D1 profile or login read return the sanitized profile-service error, while any failure globally fences leaderboards. D1 read errors never fall back to Firestore. Retain the existing outbox documents and index, profile projection DLQ, tombstones, failure table, Queue, migrations, and D1 data for rollback compatibility, but do not use them as active recovery mechanisms.

First upload and promote the simplified Worker with tracked mode `firestore`, deploy its triggers, and record that Version ID for rollback. Require two consecutive successful five-minute reconciliation runs, an empty active Queue backlog, no projection failures, matching profile/login/version counts and digests, and successful profile, login, and all seven leaderboard smoke checks. Then change the tracked mode to `d1`, regenerate Worker types, run `npm run check:api`, `npm run check:tooling`, and `npm run check:all`, and upload and smoke that exact candidate before promoting it. After promotion, smoke production and rerun remote verification.

Use Git tag `profile-d1-firestore-26f7ab59` for the retained Firestore rollback source and `profile-d1-cutover-84135e82` for the initial D1 cutover source. Custom Worker logs use the steady-state `0.1` sampling rate after cutover verification.

Rollback by promoting the retained simplified `firestore`-mode Version ID. Keep all profile projection infrastructure and data intact so reconciliation continues while reads are rolled back.

Upload and smoke a version before it receives traffic:

The smoke command carries reviewed non-secret production defaults for one canonical login/profile mapping and one Solana wallet. Use `--smoke-sol` and `--smoke-profile-fixture` only when explicitly testing alternate values.

```sh
npm run upload:api
npm run smoke:api -- --base-url <version-preview-url>
```

Record the Version ID printed by Wrangler. Promote that exact version, apply reviewed triggers, and smoke production:

```sh
npm run promote:api -- --version-id <version-id>
npm run deploy:api:triggers
npm run smoke:api -- --base-url https://api.mons.link
```

`upload:api` uses `wrangler versions upload --strict`; it does not send traffic to the candidate. `promote:api` deploys the explicit Version ID to 100% of traffic without prompting. `deploy:api:triggers` applies the tracked route, Cron, and Queue consumer configuration. Routine code-only releases may omit the trigger command when that configuration is unchanged.

## Event-prize withdrawal D1 operations

`mons-link-event-prize-withdrawals` permanently owns event-prize withdrawal admission, leases, submitted Solana transactions, and completion records. The runtime accepts only `d1` and `frozen`: `d1` serves requests and Workflow attempts, while `frozen` fails them closed during maintenance. Event reconciliation and auth recovery continue to read canonical D1 state while withdrawals are frozen.

Inspect or change the maintenance gate without logging withdrawal contents:

```sh
npm run manage:event-prize-withdrawals -- --status
npm run manage:event-prize-withdrawals -- --freeze
npm run manage:event-prize-withdrawals -- --resume
```

Freeze and resume are idempotent. After freezing, wait at least five minutes and confirm `activeLeases` is zero before schema or Worker maintenance. Missing or invalid control state fails closed.

Migration `0004_retire_firebase_shadow.sql` removes the retired repair table and triggers and permanently rejects Firebase storage mode. Promote and smoke a D1-only Worker while frozen before applying it:

```sh
npx wrangler d1 time-travel info mons-link-event-prize-withdrawals --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --json
npx wrangler d1 migrations apply mons-link-event-prize-withdrawals --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:event-prize-withdrawals -- --status
```

After this migration, Firebase and hybrid Worker versions are invalid rollback targets. Roll back only to a retained D1-only Version ID or fix forward, and keep the D1 database intact.

Apply the Telegram D1 schema before uploading a Worker version that includes the `TELEGRAM_DB` binding:

```sh
npx wrangler d1 migrations apply mons-link-telegram --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Telegram storage mode is held in `telegram_runtime_control`. `frozen` pauses Telegram bridges, consumers, and sweeps, and `d1` is the permanent mode. Firebase delivery storage is rejected after the finalization migration. Missing or unreadable control state fails closed. Use the migration helper for content-free summaries, protected exports, idempotent imports, and digest verification:

```sh
npm run migrate:telegram-d1 -- --dry-run --project mons-link
npm run migrate:telegram-d1 -- --final --project mons-link
```

For final cutover, set the mode to `frozen`, wait at least 60 seconds, confirm the migration summary has no active leases, in-flight sends, pending recovery, or API gate, and run the final import. Set the mode to `d1`, invoke the signed delete-only command smoke, and verify its D1 record reaches `delivered` with no applied message. Only then remove `/telegramMessages`, `/telegramDeliveryControl`, and `/telegramEventPrizeAnnouncements` from RTDB. Telegram projection sources, outboxes, generations, and locks remain in RTDB.

`mons-link-profile-game-projection` is the permanent rating, manual invite, automatch, event, and profile-link projector Queue. Manual game-session and automatch mutations atomically persist `profileGameProjectionOutbox/automatch/{inviteId}` before enqueueing; the namespace retains its historical name for in-flight compatibility. Manual mutations also persist seven-day UUID receipts while per-invite leases serialize structural writes. Event mutations accumulate every pre-mutation owner under `profileGameProjectionOutbox/event/{eventId}` in the same RTDB commit as the event and use a separate per-event projection lock. Profile-link changes atomically persist `profileGameProjectionOutbox/profile/{loginUid}`, accumulate stale profile owners, and use request-fenced per-login and per-invite locks. The five-minute Worker schedule repairs malformed automatch, event, and profile-link markers, preserving recoverable cleanup owners, repairs rating completion markers, removes expired mutation receipts, claims pending markers by `lastQueuedAtMs`, and re-enqueues all four task kinds. Monitor Queue consumption, pending marker age, `game_session_*`, `event_profile_game_projection_*`, `profile_link_profile_game_projection_*`, and `profile_game_projection_*` logs.

`mons-link-telegram-projection` owns automatch, rating, and event Telegram projections. Event mutations persist `telegramProjectionOutbox/event/{eventId}` and increment a durable per-event generation before enqueueing. The consumer serializes each event with `eventTelegramProjectionLocks`, generation-fences D1 desired records and RTDB projection-state commits, advances state only after dispatch succeeds, and clears only the exact request marker it processed. The five-minute schedule claims pending markers by `updatedAtMs`; monitor `firstQueuedAtMs`, `telegram_projection_queue_*`, `telegram_d1_*`, and `telegram_projection_event_sweep_failed`.

The retired Firebase functions `projectEventTelegramOnCreated` and `projectEventTelegramOnUpdated` must not remain deployed in steady state. A rollback briefly restores the compatible database rules and both functions from the pre-cutover source before rolling the API Worker back, so every event mutation always has a projector owner.

The `mons-link-event-progress` Workflow owns scheduled event starts and retriable event synchronization. The five-minute Worker schedule reconciles `eventProgressOutbox` records and scheduled events with deterministic Workflow instances. Inspect a production instance with:

```sh
npx wrangler workflows instances describe mons-link-event-progress latest --config cloud/workers/api/wrangler.jsonc
```

Before retiring the legacy Firebase event-progress functions, verify that `processEventProgress` has no pending Cloud Tasks and that `eventProgressFallback` is empty. The Cloudflare outbox is private and indexed by `lastQueuedAtMs` for bounded recovery sweeps.

`mons-link-event-prize-withdrawal` owns durable Solana prize transfers. The authenticated API admits a deterministic instance per event prize, while `mons-link-event-prize-withdrawals` D1 permanently owns the withdrawal state. The browser polls the authenticated status route; a browser timeout never terminates the Workflow.

Set the wallet key as an encrypted Worker secret through a protected file:

```sh
(
  set -e
  umask 077
  event_prize_key_file="$(mktemp)"
  trap 'rm -f "$event_prize_key_file"' EXIT
  firebase functions:secrets:access EVENT_PRIZE_ADMIN_PRIVATE_KEY --project mons-link > "$event_prize_key_file"
  test -s "$event_prize_key_file"
  npx wrangler secret put EVENT_PRIZE_ADMIN_PRIVATE_KEY --config cloud/workers/api/wrangler.jsonc < "$event_prize_key_file"
)
```

After promoting a candidate API version and before switching the frontend, run the read-only runtime preflight and inspect its result:

```sh
event_prize_preflight_id="preflight-$(date -u +%Y%m%d%H%M%S)-$$"
npx wrangler workflows trigger mons-link-event-prize-withdrawal --id "$event_prize_preflight_id" --params '{"schemaVersion":1,"kind":"preflight"}' --config cloud/workers/api/wrangler.jsonc
npx wrangler workflows instances describe mons-link-event-prize-withdrawal "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc
```

The preflight must complete with `{"ok":true,"status":"ready"}`. It verifies the encrypted wallet identity, both Metaplex runtimes, and a read-only Helius RPC request without building or sending a transaction.

The retired Firebase callable must remain absent:

```sh
firebase functions:list --project mons-link
```

Do not restore the Firebase callable or route withdrawal state back to RTDB during rollback. Restore only a reviewed D1-only API Worker version.

Rollback always targets a reviewed Version ID:

```sh
npx wrangler rollback <known-good-version-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

## Frontend release

When a frontend release depends on a new API route, promote and smoke the API Worker in production before uploading or promoting the frontend.

Build and upload through the isolated frontend helper, then smoke the unique preview URL it prints:

```sh
npm run deploy -- preview
```

Promote the exact tested version without rebuilding it:

```sh
npm run deploy -- production --version-id <version-id>
```

Rollback with an explicit known-good version:

```sh
npx wrangler rollback <known-good-version-id> --config wrangler.jsonc
```

## Profile and event-prize mutation cutover

Profile customization and event-prize selection are Worker-owned mutations. Their Firebase reads and live subscriptions remain active, but direct browser writes are denied by the tracked Firestore and Realtime Database rules. Avatar and aura changes use one atomic `emojiAndAura` mutation.

Release changes to these mutations in this order:

1. Upload, smoke, and promote the API Worker version.
2. Upload, smoke, and promote the frontend Worker version.
3. From `cloud/`, deploy only the rule targets:

```sh
firebase deploy --only database,firestore:rules --project mons-link
```

Do not use the full Firebase release for this rule-only cutover. If rollback is required after the rules close, restore the previous Firebase rules first, roll back the frontend Worker second, and roll back the API Worker last.

When changing the profile mutation contract, first promote an API bridge that accepts both the old and new request shapes. Promote the new frontend next, then remove the old API shape. Retain the bridge Version ID; after the frontend switches, rollback starts by restoring the bridge API before restoring the old frontend.

## IAM and secrets

Use the dedicated Google identities already named by the required Worker secrets. Routine releases reuse their encrypted credentials; key creation and role changes are provisioning work, not deployment steps.

- The auth identity named by `FIRESTORE_SERVICE_ACCOUNT_*` uses default-database-conditioned Datastore permissions plus `firebaseauth.users.get`, `firebaseauth.users.update`, `firebasedatabase.instances.get`, and `firebasedatabase.instances.update` for claim recovery.
- The username identity uses only default-database-conditioned Datastore get, create, delete, list, and update permissions.
- The rating role uses the same database condition without entity delete.
- The gameplay identity has project-level `firebasedatabase.instances.get` and `firebasedatabase.instances.update`; its Firestore delete permission is conditioned on the default database.
- Do not broaden these roles to Editor or Owner. Revoke an old service-account key only after its replacement Worker version is healthy.
- Keep X, Telegram, Helius, and Google private-key values only as encrypted Worker secrets. `TELEGRAM_QUEUE_BRIDGE_SECRET` and `TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET` are distinct credentials.

The API smoke command covers NFT lookup, unauthenticated checks for both browser mutation routes, one auth route, the X callback, and one internal route without performing an authenticated mutation.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the single tracked auth maintenance switch. When `true`, provider verification, unlink, claim sync, X flow, X callback, and related auth mutations fail closed. Change it through the normal candidate upload, smoke, and explicit Version ID promotion workflow; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale `authRecoveryJobs`. The Queue intentionally has no recovery DLQ. Investigate a stuck job without purging the Queue or deleting its job record.

Auth origins are enforced in code. There is no deployment-time SIWE domain list.
