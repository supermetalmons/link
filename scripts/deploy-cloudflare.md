# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Queues, Workflows, consumers, and Cron schedule.
- `cloud/workers/api/auth-state-migrations/` owns the `mons-link-auth-state` D1 schema for auth intents and X redirect flows.
- `cloud/workers/api/telegram-migrations/` owns the `mons-link-telegram` D1 schema for Telegram delivery, recovery, and announcement receipts.
- `cloud/workers/api/event-prize-withdrawal-migrations/` owns the `mons-link-event-prize-withdrawals` D1 schema and storage-mode fence for Solana prize withdrawals.
- `cloud/workers/api/profile-migrations/` owns the canonical profile schema in `mons-link-profiles` D1.
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

`upload:api` uses `wrangler versions upload --strict`; it does not send traffic to the candidate. `promote:api` deploys the explicit Version ID to 100% of traffic without prompting. `deploy:api:triggers` applies the tracked route, Cron, Workflow, and configured Queue consumer updates. Removing an omitted Queue consumer requires an explicit `wrangler queues consumer remove`. Routine code-only releases may omit trigger deployment when that configuration is unchanged.

## Canonical profile D1 cutover

This is a forward-only cutover implemented by two reviewed commits. Commit 1 is the
Firestore maintenance bridge and one-shot importer. Commit 2 is the permanent
D1-only Worker. No profile runtime returns to Firestore after `begin-import`.

The shared control states are:

| State       | Commit 1 bridge                     | Commit 2 D1 Worker                  |
| ----------- | ----------------------------------- | ----------------------------------- |
| `firestore` | Reads and writes the current source | Not deployable in this state        |
| `importing` | Reads continue; all writers freeze  | Not deployable in this state        |
| `frozen`    | Reads continue; all writers freeze  | Canonical reads; all writers freeze |
| `active`    | Old bridge writers remain blocked   | Canonical reads and writes          |

Only `firestore → importing → frozen → active` and `active → frozen` are
allowed. HTTP writes return `503 profile-writes-disabled` with `Retry-After:
60` while blocked. Profile Queue messages retry without acknowledgement,
profile Cron work pauses, and every mutating Workflow step rechecks control.
Auth-state expiry, game-receipt cleanup, and unrelated Telegram delivery remain
independent. `AUTH_MUTATIONS_DISABLED` remains a separate auth-maintenance
switch.

Run local validation and privacy-safe source preflight before the maintenance
window:

```sh
npm run check:all
npm run migrate:profile-canonical -- --dry-run --project mons-link
```

Dry-run builds the complete deterministic plan and validates ownership,
topology, D1 row size, SQL, parameters, and serialized request batches without
creating a D1 client or writing either store. Oversized legacy archives and all
other blockers must be fixed before continuing.

Apply the additive schema and deploy Commit 1 with control still in
`firestore`. Upload Commit 2 but do not promote it yet. Prepare the protected
read-only smoke fixture and an explicit controlled mutation plus identical
replay.

```sh
npx wrangler d1 migrations apply mons-link-profiles --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
# from the reviewed Commit 1 checkout
npm run check:all
npm run upload:api
npm run promote:api -- --version-id <commit-1-version-id>
npm run deploy:api:triggers
npm run smoke:api -- --base-url https://api.mons.link
# from the reviewed Commit 2 checkout
npm run check:all
npm run upload:api
```

Record the Commit 2 Version ID and preview URL without promoting it.

The read-only smoke fixture is an untracked mode-`0600` JSON file containing
exactly `{"idToken":"<existing Firebase ID token>"}` for the configured smoke
profile. The smoke command refuses broader file permissions, malformed JSON, and
extra fields, and never prints the token or profile contents.

Begin the one-way maintenance window:

```sh
npx wrangler queues pause-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:event-prize-withdrawals -- --freeze
npm run manage:profile-canonical -- --begin-import
```

Wait more than 15 minutes and inspect every page for both profile Workflow
types. `rollingBack` and `unknown` are blockers: wait and re-inspect them. Do
not terminate either state. Terminate remaining `queued`, `running`, `paused`,
`waiting`, and `waitingForPause` instances by exact ID after their durable state
is safe. Do not continue until every instance is `complete`, `errored`, or
`terminated`.

```sh
for profile_workflow in mons-link-event-progress mons-link-event-prize-withdrawal; do
  npx wrangler workflows instances list "$profile_workflow" --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
done
npx wrangler workflows instances terminate <workflow-name> <instance-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Inspect page 2 and higher whenever a page contains 100 rows, then re-list every
page after termination. Never treat `rollingBack` or `unknown` as drained.

Run the one-shot import:

```sh
npm run migrate:profile-canonical -- --execute --project mons-link
npm run migrate:profile-canonical -- --verify --project mons-link
npm run migrate:profile-canonical -- --verify-d1
```

`--execute` reads Firestore twice, claims a private digest and plan version,
runs guarded idempotent batches, rereads Firestore, verifies exact parity and
query plans, then moves control from `importing` to `frozen`. If interrupted,
rerun the same command from batch one. A different digest or plan version fails
closed. Private digests and identity values are never printed.

While control is `frozen`, run Commit 2's preview read-only smoke, promote that
exact D1-only version, deploy its tracked triggers, explicitly remove the old
profile projection Queue consumer, and repeat the production read-only smoke:

```sh
npm run smoke:api -- --base-url <commit-2-preview-url> --read-only --auth-token-fixture <protected-json-file>
npm run promote:api -- --version-id <commit-2-version-id>
npm run deploy:api:triggers
npx wrangler queues consumer remove mons-link-profile-projection mons-link-api --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues consumer list mons-link-profile-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run smoke:api -- --base-url https://api.mons.link --read-only --auth-token-fixture <protected-json-file>
```

The consumer listing must not contain `mons-link-api`.

Then enable writes while withdrawals and the permanent Queues remain paused.
Run the same reviewed mutation request twice, preserving its idempotency key
when the route has one, verify the expected replay response, and prove its D1
receipt or profile revision changed exactly once. Freeze immediately for the
final invariant check:

```sh
npm run manage:profile-canonical -- --resume
# run the identical reviewed mutation request twice
# verify one D1 receipt or one profile revision increment
npm run manage:profile-canonical -- --freeze
npm run migrate:profile-canonical -- --verify-d1
npm run manage:profile-canonical -- --resume
npm run smoke:api -- --base-url https://api.mons.link
```

Resume withdrawals and only the four permanent Queues after verification and
smoke pass. The retired `mons-link-profile-projection` Queue stays paused and
has no Commit 2 consumer.

```sh
npm run manage:event-prize-withdrawals -- --resume
npx wrangler queues resume-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Revoke runtime Datastore permissions while retaining Firebase Auth and RTDB
access. From `begin-import` onward, incidents freeze D1 and fix forward; a
reviewed D1 Time Travel restore is exceptional and never restores a
Firestore-writing runtime.

Keep Firestore deny-write/read-only for 30 days as an audit snapshot. It is not
a runtime fallback. After the retention gate, remove the archived collections,
Firestore deployment configuration, and remaining audit-only migration code.

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
npx wrangler workflows trigger mons-link-event-prize-withdrawal '{"schemaVersion":1,"kind":"preflight"}' --id "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances describe mons-link-event-prize-withdrawal "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
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

Profile customization and event-prize selection are Worker-owned mutations. Firebase Auth and RTDB reads remain active, while Firestore is audit-only after the profile cutover. Direct browser writes are denied by the tracked Firestore and Realtime Database rules. Avatar and aura changes use one atomic `emojiAndAura` mutation.

Release changes to these mutations in this order:

1. Upload, smoke, and promote the API Worker version.
2. Upload, smoke, and promote the frontend Worker version.
3. From `cloud/`, deploy only the rule targets:

```sh
firebase deploy --only database,firestore:rules --project mons-link
```

Do not use the full Firebase release for this rule-only cutover. After profile import begins, any API fix must remain D1-only.

When changing the profile mutation contract, first promote a D1-only API compatibility version that accepts both request shapes. Promote the new frontend next, then remove the old API shape.

## IAM and secrets

Use the dedicated Google identities already named by the required Worker secrets. Routine releases reuse their encrypted credentials; key creation and role changes are provisioning work, not deployment steps.

Before uploading Commit 2, install the retained Firebase Auth/RTDB identity under
its final names without printing either value:

```sh
npx wrangler secret put FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL --config cloud/workers/api/wrangler.jsonc
npx wrangler secret put FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY --config cloud/workers/api/wrangler.jsonc
```

- The identity named by `FIREBASE_IDENTITY_SERVICE_ACCOUNT_*` has only `firebaseauth.users.get`, `firebaseauth.users.update`, `firebasedatabase.instances.get`, and `firebasedatabase.instances.update` for token claims and RTDB convergence.
- The gameplay identity retains only project-level `firebasedatabase.instances.get` and `firebasedatabase.instances.update`.
- Firestore audit access belongs to an operator identity and is never a Worker secret or runtime permission.
- Do not broaden these roles to Editor or Owner. Revoke an old service-account key only after its replacement Worker version is healthy.
- Keep X, Telegram, Helius, and Google private-key values only as encrypted Worker secrets. `TELEGRAM_QUEUE_BRIDGE_SECRET` and `TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET` are distinct credentials.

After Commit 2 is healthy and Datastore denial is proven, delete the retired
`FIRESTORE_SERVICE_ACCOUNT_*`, `RATING_SERVICE_ACCOUNT_*`, and
`USERNAME_SERVICE_ACCOUNT_*` Worker secrets through `wrangler secret delete`.

The API smoke command covers NFT lookup, unauthenticated checks for both browser mutation routes, one auth route, the X callback, and one internal route without performing an authenticated mutation.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the single tracked auth maintenance switch. When `true`, provider verification, unlink, claim sync, X flow, X callback, and related auth mutations fail closed. Change it through the normal candidate upload, smoke, and explicit Version ID promotion workflow; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale `authRecoveryJobs`. The Queue intentionally has no recovery DLQ. Investigate a stuck job without purging the Queue or deleting its job record.

Auth origins are enforced in code. There is no deployment-time SIWE domain list.
