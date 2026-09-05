# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Queues, Workflows, consumers, and Cron schedule.
- The migration directories under `cloud/workers/api/` own the six D1 schemas.
- `PROFILE_DB.profile_login_owners` is authoritative for Worker login UID to canonical profile ownership. Firebase custom claims and RTDB profile links are non-authoritative browser-rule and recovery shadows.
- `cloud/workers/api/release.env` stays empty so release commands never load developer environment files.
- Encrypted secrets stay in Cloudflare; required names are declared in the API Wrangler configuration.
- `EVENT_DB` owns event records, participants, prize selections, visible assigned prizes, progress markers, and event-specific projection state after activation. Active invites and matches remain in RTDB.
- `cloud/firebase.json` owns active-gameplay Realtime Database rules. Firestore, Firebase Functions, and canonical event-data RTDB paths are retired and are not rollback targets.

Authenticate Wrangler locally or provide `CLOUDFLARE_API_TOKEN` through the process environment. Never put credentials in command arguments, source files, release files, or logs.

## Validation

```sh
npm ci
npm ci --prefix cloud/functions
npm ci --prefix cloud/admin
npm run check:all
```

The complete gate validates the frontend, API Worker, generated bindings, deployment tooling, portable cloud modules, and Realtime Database rules.

Before event cutover, also rehearse final import and interrupted recovery against local D1 and the Firebase RTDB emulator:

```sh
npx firebase emulators:exec --only database --project demo-mons-link-rules --config cloud/firebase.json "EVENT_CUTOVER_RTDB_EMULATOR_HOST=127.0.0.1:9000 npm run test:api:runtime -- runtime/eventCutoverRehearsal.test.ts"
```

## API Worker release

After wager reservation cutover, production API version previews remain disabled. Temporary preview testing must follow the canonical-freeze and preview-retirement sequence in [wager reservation cutover](#wager-reservation-cutover), or use a separately protected preview environment. Do not re-enable production API previews while canonical writes are active.

Before the first event D1 release, install withdrawal migration `0006` during withdrawal maintenance. Freeze withdrawals, wait at least five minutes, and confirm `activeLeases` is zero before applying the migration. Resume afterward so pending withdrawals can settle before the final event cutover.

```sh
npm run manage:event-prize-withdrawals -- --freeze
npm run manage:event-prize-withdrawals -- --status
npx wrangler d1 migrations apply mons-link-event-prize-withdrawals --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:event-prize-withdrawals -- --resume
```

Before the first Worker release that uses profile-game migration `0005`, pause profile-game projection delivery. Wait at least 15 minutes for old consumers and outstanding calls to drain, then confirm `/profileGameProjectionLocks/event` has no unexpired lock before applying the migration. Keep the Queue paused through promotion.

```sh
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx firebase database:get "/profileGameProjectionLocks/event" --project mons-link --instance mons-link-default-rtdb
npx wrangler d1 migrations apply mons-link-profile-games --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Apply the additive event migration, then confirm canonical profile writes are active and the ownership database has no foreign-key violations:

```sh
npx wrangler d1 migrations apply mons-link-events --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:profile-canonical -- --status
npx wrangler d1 execute mons-link-profiles --remote --command "PRAGMA foreign_key_check" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Before wager reservation activation, the status must be `active`, and the foreign-key validation must return no rows. After activation, keep canonical writes frozen for production-backed API preview testing and use the read-only candidate and promotion smoke sequence in [wager reservation cutover](#wager-reservation-cutover).

Create mode-`0600` smoke fixtures outside the repository: an auth fixture containing only `{"idToken":"<existing-linked-login-token>"}` and a profile fixture containing `{"loginId":"<alternate-login-uid>","profileId":"<canonical-profile-id>","invite":{"id":"<existing-invite-id>","actorUid":"<stored-host-or-guest-uid>","role":"host"},"historicalMatch":{"inviteId":"<existing-historical-invite-id>","matchId":"<existing-historical-match-id>"}}`. Use `"guest"` when appropriate. The token subject must equal `loginId`; `actorUid` must be a different login owned by the same D1 profile. The historical match must be a known non-null D1 snapshot. Upload the candidate, then run both the standard smoke and the authenticated read-only ownership smoke before it receives traffic:

```sh
npm run upload:api
npm run smoke:api -- --base-url <version-preview-url>
npm run smoke:api -- --base-url <version-preview-url> --read-only --require-history --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

Record the Version ID printed by Wrangler. Promote that exact version, apply reviewed triggers, and repeat both smokes against production:

```sh
npm run promote:api -- --version-id <version-id>
npm run deploy:api:triggers
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

After the production smokes pass, resume profile-game projection delivery if it was paused for migration `0005`:

```sh
npx wrangler queues resume-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

The standard smoke covers public and temporary anonymous-auth behavior. The authenticated read-only smoke verifies the existing login's D1 ownership, profile lookups, navigation, alternate-login invite-role authorization, event read transport, and a known non-null D1 historical snapshot without creating auth state. Both are release gates for preview and production. The stronger mutable event-data fixture is reserved for event cutover verification below.

Tail the promoted version during the production smokes and for at least 15 minutes afterward. Treat the tail as focused real-time evidence, not a complete event ledger; filtering reduces but does not eliminate sampling under load:

```sh
npx wrangler tail mons-link-api --version-id <version-id> --search profile-ownership-unavailable --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Rollback immediately to the previous tested D1-compatible Worker if the authenticated production smoke fails. Otherwise rollback if ownership failures recur across multiple real requests during that window or the Worker 5xx rate rises above its pre-deploy baseline. After automatch activation, use only the exact compatible API recorded by the gameplay coordination cutover below. Additive migrations remain in place and require no D1 restore.

`upload:api` does not send traffic to the candidate. `promote:api` deploys an explicit Version ID to 100%. `deploy:api:triggers` applies routes, Cron, Workflows, and configured Queue consumers. Removing an omitted Queue consumer remains an explicit operator action.

Rollback targets only a reviewed D1-compatible Version ID. After automatch activation, use the recorded version that retains required IDs, the operation-scoped D1 lease, and receipts for every successful path:

```sh
npx wrangler rollback <known-good-version-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

## Projection lock D1 cutover

Migration `0006_profile_game_projection_locks.sql` moves the remaining invite and profile-link projection locks into `mons-link-profile-games`. Event projection leases already live in `mons-link-events`. No bindings, public APIs, Queue payloads, or triggers change. Pending-job records and active matches remain in their existing stores.

Finish `npm run check:all`, record the current production Version ID, and verify both protected smoke fixtures against production before pausing delivery. Keep the validated source unchanged throughout the release. Use the standard and authenticated `--read-only --require-history` smoke commands from the API release section.

```sh
npx wrangler deployments list --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Record when the pause succeeds. Wait at least 15 minutes for in-flight consumers and outstanding calls to drain, then read both retired lock namespaces:

```sh
npx firebase database:get "/profileGameProjectionLocks/automatch" --project mons-link --instance mons-link-default-rtdb
npx firebase database:get "/profileGameProjectionLocks/profile" --project mons-link --instance mons-link-default-rtdb
```

Do not continue until every retained lease has expired. Extend the wait if any `expiresAtMs` is still in the future, and investigate unreadable or malformed leases rather than assuming the namespace is drained. Gameplay and producers continue; game-list projections and historical archival accumulate for later processing. Scheduled sweeps enqueue work but do not acquire these locks. Do not purge the queue or pending-job records.

With delivery still paused, apply the additive migration and upload the validated candidate:

```sh
npx wrangler d1 migrations apply mons-link-profile-games --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run upload:api
```

Run both preview smokes, promote the exact uploaded Version ID to 100% using `npm run promote:api -- --version-id <version-id>`, and run both production smokes. Keep delivery paused on any failure. No trigger deployment is needed for this release. Once both production smokes pass:

```sh
npx wrangler queues resume-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search profile_game_projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Observe at least 15 minutes. Confirm successful `profile_game_projection_queue_processed` records and backlog recovery. Investigate recurring `profile_game_projection_queue_failed` records with a lock failure code and `lockScope`, `profile_game_projection_lock_cleanup_failed`, and historical archive failures. Existing sampled logs are diagnostic evidence, not a complete ledger. Locks need no data import; expired Firebase lock records remain inert.

Rollback across this storage boundary also requires a queue pause. Stop delivery, wait at least 15 minutes for D1 consumers to drain, and verify there are no unexpired D1 leases before restoring the recorded Firebase-lock version:

```sh
npx wrangler d1 execute mons-link-profile-games --remote --command "SELECT COUNT(*) AS active_locks FROM profile_game_projection_locks WHERE expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

After rollback and both production smokes, resume delivery. Retain the additive D1 table. Never run Firebase-lock and D1-lock consumers concurrently. Before promotion, an aborted cutover can resume the recorded current version after confirming no candidate was promoted; the new table may remain installed.

## Gameplay coordination D1 cutover

Migration `0007_gameplay_coordination.sql` made `mons-link-profile-games` D1 the permanent owner of gameplay leases and timer-start markers. Migration `0008_match_timer_reconciliation.sql` adds nullable opponent metadata and the reconciliation index. `matchTimerClaims`, active invites and matches, mutation receipts, and projection outboxes remain in RTDB. Keep the retired coordination roots and explicit `matchTimerStarts` deny rule unchanged, but never repopulate or reactivate those roots.

Record the current frontend and API version IDs as abort-only targets, then freeze profile/gameplay writes. Wait at least 65 seconds, verify that D1 gameplay leases are drained, and run the read-only preview. Record both timer digests, apply migration `0008`, then preview again and require the logical and physical timer-row digests to be unchanged while `hasOpponentIdColumn` changes from `false` to `true`. Upload the API candidate only after that comparison passes. Record each compatible candidate ID when its upload returns, before promoting it. While writes remain frozen, promote the exact frontend version that persists and sends automatch operation IDs, then promote the exact API version that requires those IDs. The old API safely ignores the frontend's new query parameter while the freeze prevents receiptless commits. The production API intentionally rejects browser tabs loaded before the frontend release; those users must reload.

After `npm run deploy -- preview`, stop before production promotion. Open the exact frontend preview in every supported browser, wait for authentication, and duplicate it into a second tab. Trigger Automatch in both tabs and require both requests to use the same UUID query and return `503 profile-writes-disabled`; reload and retry once, requiring the same UUID and one surviving `pendingAutomatchOperation:<uid>` record. Confirm `navigator.locks` exists. Record the preview URL and results, and do not promote on any mismatch.

```sh
npm run check:all
npm run dry-run:api
npm run deploy -- dry-run
npx wrangler deployments list --config wrangler.jsonc
npx wrangler deployments list --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:profile-canonical -- --freeze
npm run manage:profile-canonical -- --status
npx wrangler d1 execute mons-link-profile-games --remote --command "SELECT COUNT(*) AS active_leases FROM game_session_mutation_locks WHERE expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run migrate:gameplay-coordination -- --preview --project mons-link
npx wrangler d1 migrations apply mons-link-profile-games --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run migrate:gameplay-coordination -- --preview --project mons-link
npm run upload:api
npm run smoke:api -- --base-url <version-preview-url> --read-only --require-history --require-automatch-operation-id --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run deploy -- preview
npm run deploy -- production --version-id <tested-automatch-compatible-frontend-version-id>
npm run promote:api -- --version-id <tested-automatch-compatible-api-version-id>
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-automatch-operation-id --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run manage:profile-canonical -- --resume
npm run smoke:api -- --base-url https://api.mons.link
```

Keep writes frozen through the preview-browser check and both authenticated production smokes if migration, any preview smoke, either promotion, or either production smoke fails. After resuming, immediately re-freeze if the standard smoke fails. The frontend reuses one exact unresolved automatch request for seven days, matching the RTDB receipt-retention window. A missing or duplicate operation ID is rejected before rate limiting or mutation; an old open tab therefore fails safely until it reloads. Every successful start, including an already-owned pending queue, has a replayable receipt. Run `--require-automatch-operation-id` only after the compatible API is live and while writes remain frozen: it verifies the freeze, requires missing ID `400 invalid-request`, and requires a fixed valid UUID to reach `503 profile-writes-disabled` without mutation.

The recorded pre-release pair remains an abort target only while writes are frozen and before `--resume`. After resuming writes or accepting the first receipt-aware mutation, roll back only to the separately recorded compatible candidate pair: the API must retain required IDs, the operation-scoped D1 lease, and receipts for every successful path; the frontend must retain per-UID persistence, Web Locks, and exact invite correlation. If that pair is unavailable, keep profile/gameplay writes frozen and fix forward. Additive D1 migrations and RTDB receipt roots remain installed; never restore coordination data to RTDB. After resuming, run mutable and authenticated smokes and observe gameplay 5xx, stale-client `400` responses, receipt cleanup, and coordination failures for at least 15 minutes.

## Wager reservation cutover

Profile migrations `0010_wager_frozen_reservations.sql` and `0011_wager_reservation_control.sql` add participant-UID reservation balances, operation records, the storage control, and tracked write admissions to `mons-link-profiles`. This migration preserves active proposals, agreements, pending settlements, and consumed operation tombstones. Do not cancel wagers, zero frozen balances, merge participant UIDs, or delete queue messages to simplify the import.

Use one `WHEN` predicate and one `SELECT RAISE(...)` statement for each guard trigger in these remote D1 migrations. The verified remote migration executor split `CASE`-based trigger bodies; successful local SQLite execution alone does not verify that remote path. Check the installed tables and triggers after applying the migrations.

Install the additive migrations using [canonical profile maintenance](#canonical-profile-d1-maintenance). Record the current API/frontend versions as preactivation abort targets. Upload and promote the bridge API, which supports explicit Firebase and D1 reservation modes, and the frontend, which polls Worker frozen snapshots and sends `X-Mons-Wager-Storage-Version: 1` on all five wager mutation routes. Use the standard API-first frontend release order. Keep storage in `firebase` during these releases and verify the exact API version serves 100 percent of traffic:

```sh
npm run manage:wager-reservations -- --status
npx wrangler deployments list --json --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-wager-frozen-read --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run migrate:wager-reservations -- --preview --project mons-link
```

The frozen-read smoke fixture needs the caller's existing `loginId` and a linked alternate participant in `invite.actorUid`. Verify the frontend preview in two authenticated tabs, including a linked UID, an account switch, and a failed snapshot request. Failed or outdated snapshots must not appear as zero available materials, and late responses must not update a new identity's balance. Resume ordinary canonical maintenance after the bridge release passes its smokes. Allow the bridge to serve all production traffic for at least fifteen minutes before the final window; stop any access to old mutation-capable version previews and investigate evidence of legacy writes.

For the final window, record each Queue's existing `settings.delivery_paused` value, then freeze canonical writes and pause all four profile-related Queues. Record the time each pause succeeds. Resume only Queues that this maintenance window paused; preserve any preexisting pause. Reservation freeze blocks new admissions while retained admissions show requests that have not finished:

```sh
npm run manage:profile-canonical -- --freeze
npx wrangler queues pause-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:wager-reservations -- --freeze
npm run manage:wager-reservations -- --status
```

Do not export the first observation until `writeAdmissions` and `activeGameplayLeases` are zero. Expired or uncertain admissions still count. Queue pause does not terminate an invocation already running; final import requires at least fifteen minutes since the last of the four pauses. That wait covers the documented Queue-consumer duration limit. The six-minute source comparison below separately covers the existing RTDB transaction retry interval. Neither interval nor an empty bridge admission table proves that untracked legacy HTTP code could never resume: legacy-drain verification remains an explicit operational requirement. Keep writes frozen if the source changes or any older writer remains unexplained.

Create a mode-`0600` JSON evidence file. Copy the exact latest deployment's version ID and `created_on` converted to Unix milliseconds. The queue timestamps are operator attestations of successful pauses; record all four, and set `legacyWritersDrained` only after checking the retired version entry points and legacy activity. Replace every zero below with the captured Unix-millisecond timestamp:

```json
{
  "bridgeVersionId": "<exact-bridge-version-id>",
  "bridgeDeployedAtMs": 0,
  "queuesPausedAtMs": {
    "mons-link-auth-recovery": 0,
    "mons-link-profile-game-projection": 0,
    "mons-link-telegram-projection": 0,
    "mons-link-telegram-delivery": 0
  },
  "legacyWritersDrained": true,
  "recordedAtMs": 0
}
```

With explicit `GOOGLE_APPLICATION_CREDENTIALS`, the exporter authenticates once and reads at most four complete mining children concurrently. Credentials and OAuth tokens never appear in arguments, logs, or artifacts. Without explicit credentials, the exporter uses the pinned Firebase CLI. Both paths read a shallow `/players` inventory before and after the export; neither reads match histories. Preview and observation are read-only. Raw snapshots and SQL stay in protected artifact files; stdout prints only counts, digests, and the artifact directory.

```sh
npm run migrate:wager-reservations -- --observe --evidence-file /secure/wager-cutover.json
```

Keep that run's `observation.json`. At least six minutes after its export finishes, and at least fifteen minutes after all queues were paused, run final import with the unchanged evidence file:

```sh
npm run migrate:wager-reservations -- --final --evidence-file /secure/wager-cutover.json --observation <observation-run-directory>/observation.json
npm run manage:wager-reservations -- --status
```

Final import checks the current 100-percent bridge deployment, canonical and reservation freezes, all admissions, gameplay leases, and the freeze generation. It claims one unique import attempt and invalidates earlier proof before reading source data. The second source digest must match the first. It replaces only the two new reservation tables in bounded SQL batches; every batch checks its attempt ID and freeze generation. D1 readback and a final Firebase source read must match before the tool atomically records proof and releases the attempt. Malformed records fail closed; valid sparse balances, orphan UIDs, legacy zero-delta records, and every consumed tombstone are retained. A failed import leaves storage frozen and its attempt retained.

After stopping and investigating an interrupted import process, recover only its named attempt; this invalidates proof without changing reservation data. Expired write admissions require checking the original request has finished and reconciling any uncertain source effect before recovering the named row. Neither operation is an expiry-based automatic takeover:

```sh
npm run manage:wager-reservations -- --recover-import <attempt-id> --confirm-import-stopped
npm run manage:wager-reservations -- --recover-admission <admission-id> --confirm-request-finished --confirm-source-reconciled
```

Activate only after the final import reports `verified: true`. Activation requires matching proof for the current freeze generation, no active import, no admissions, drained gameplay leases, canonical freeze, and the same complete bridge deployment. Keep canonical writes frozen while testing the activated reads and stale-client gate:

```sh
npm run manage:wager-reservations -- --activate-d1
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-wager-storage-version --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

Keep canonical writes frozen and Queues paused after activation. Prepare the final D1-only API candidate with `preview_urls: true` only for its temporary validation window. Changing that local flag alone does not enable previews for an existing script. Before uploading, enable them through the Worker subdomain API:

```http
POST https://api.cloudflare.com/client/v4/accounts/e25f90fc073ea309b54b8b5144bf28e0/workers/scripts/mons-link-api/subdomain
Content-Type: application/json

{"enabled":false,"previews_enabled":true}
```

Read back the same endpoint with `GET` and require `result.enabled === false` and `result.previews_enabled === true`. Keep writes frozen if either step fails. Then upload, test the exact candidate preview, promote its recorded Version ID, and repeat the authenticated smoke on the custom domain:

```sh
npm run upload:api
npm run smoke:api -- --base-url <d1-only-version-preview-url> --read-only --require-history --require-wager-frozen-read --require-wager-storage-version --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run promote:api -- --version-id <d1-only-version-id>
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-wager-frozen-read --require-wager-storage-version --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

After both final-candidate smokes pass, set the tracked `cloud/workers/api/wrangler.jsonc` to `preview_urls: false` and retain `workers_dev: false`. Before resuming any writes, disable API previews for the entire script using the [Worker subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/):

```http
POST https://api.cloudflare.com/client/v4/accounts/e25f90fc073ea309b54b8b5144bf28e0/workers/scripts/mons-link-api/subdomain
Content-Type: application/json

{"enabled":false,"previews_enabled":false}
```

Read back the same endpoint with `GET` and require `result.enabled === false` and `result.previews_enabled === false`. Verify the recorded bridge and older API version-preview URLs no longer invoke their Workers, then repeat the authenticated frozen-read smoke through `https://api.mons.link`. This script-wide change disables the `workers.dev` and version-preview entry points; it keeps the `api.mons.link` custom-domain route. Editing `preview_urls` locally alone does not retire already uploaded preview entry points. Keep writes frozen if the API toggle, readback, retired-preview check, or custom-domain smoke fails.

For future API releases, leave production previews disabled while writes are active. Any temporary re-enablement can expose older uploaded versions as well as the candidate, so freeze canonical writes and follow the enabling API call and readback above before uploading. Complete candidate validation and promotion, disable previews again through the same API, and verify retirement before resuming. A separate protected preview environment is an alternative only when its protection and data isolation have been explicitly configured; this runbook does not automatically create or broaden preview access.

After preview retirement and all frozen production checks pass, resume D1 reservation writes before canonical writes. This is safe after initial activation and also reopens reservations after incident recovery. Run the Queue resume commands below only for Queues recorded as running before this window:

```sh
npm run manage:wager-reservations -- --resume-d1
npm run manage:profile-canonical -- --resume
npx wrangler queues resume-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-wager-frozen-read --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

The version-gate smoke requires canonical writes frozen: all five routes return `409 client-update-required` without the header and `503 profile-writes-disabled` with it. Queued settlement messages do not require the browser header. Observe snapshots, reservation failures, settlement retries, and queue recovery for at least fifteen minutes after resuming; test reserve, accept, remove, and replay with the designated smoke accounts when applicable. Re-freeze canonical and reservation writes on a failure.

Before activation, recover any stopped import, use `--return-to-firebase`, verify the bridge reads, then resume canonical writes and queues to abort. After activation, `--return-to-firebase` is permanently rejected. Roll back only to a tested D1-compatible API/frontend pair; retain additive tables and fix data forward while frozen. Do not restore `PROFILE_DB` alone because canonical balances/settlement receipts and RTDB wager effects must remain consistent.

The final deployed runtime must read and write reservations only through D1 and reject Firebase storage mode; it never falls back to Firebase. Retain the preparatory bridge only as its immutable uploaded version and protected source artifact, with its API preview entry point disabled. Firebase reservation adapters retained in the repository are test fixtures only and must not be imported by the production runtime. After actual production activation and verification, remove the retired Firebase frozen-balance read rule. Keep the source mining data inert as migration evidence; this tool never deletes it.

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

`historical_match_read_failed` is the handled public-history 503 signal; `--status error` covers uncaught Worker failures and limits, not handled 5xx responses. Any required-history smoke failure, archive conflict, recurring Queue failure, or new history 5xx requires rollback or a separate fix-forward task. Historical RTDB match data remains untouched while active match synchronization continues to use RTDB.

## Event D1 migration and operations

The provisioned `mons-link-events` database is bound as `EVENT_DB` in `cloud/workers/api/wrangler.jsonc`. Create it only when bootstrapping a new Cloudflare account, then place the returned UUID in that account's configuration.

```sh
npx wrangler d1 create mons-link-events
```

Apply the schema and stage the import while Firebase remains canonical:

```sh
npx wrangler d1 migrations apply mons-link-events --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run migrate:events-d1 -- --preview --project mons-link
npm run migrate:events-d1 -- --stage --project mons-link
```

The preview validates and writes protected recovery artifacts without mutating D1. Stage exactly replaces the imported D1 tables, verifies the canonical digest and counts, and leaves event storage in `firebase` mode without creating activation proof. Event reads remain available through the Worker in `firebase`, `frozen`, and `d1` modes.

Before final freeze, complete the [API Worker release](#api-worker-release), including `npm run upload:api`, both routine preview smokes, exact-Version promotion with `npm run promote:api -- --version-id <version-id>`, trigger deployment, and both routine production smokes. Then complete the [Frontend release](#frontend-release) with `npm run deploy -- preview` followed by `npm run deploy -- production --version-id <version-id>`. Keep event storage in `firebase` mode throughout these releases, and do not continue to final freeze until both production versions are live.

For final cutover, extend the protected profile smoke fixture with `"events":{"currentId":"<scheduled-or-active-event-id>","endedId":"<ended-prize-event-id>","selectionPrizeId":"<selected-prize-id>","assignedPrizeId":"<assigned-prize-id>"}`. It must identify a real selection owned by that profile and a visible, unwithdrawn assignment from the ended event. The selection defaults to `currentId`; when the real selection belongs to the ended event, add `"selectionEventId":"<ended-prize-event-id>"`. The smoke still requires both current and ended snapshots and checks the exact selection and assignment.

Confirm withdrawal migration `0006` is applied, then freeze event-prize withdrawals first and wait until the query returns zero. Existing executions holding their lease can finish while frozen; waiting or retrying work cannot acquire a new lease. If pending withdrawals cannot drain, abort the cutover, resume withdrawals, and reconcile them before freezing again. Never delete pending records to make the count zero. Then inspect every page of withdrawal Workflow instances and terminate every nonterminal instance. Do not continue while any withdrawal record is `processing` or `submitted`.

```sh
npm run manage:event-prize-withdrawals -- --freeze
npx wrangler d1 execute mons-link-event-prize-withdrawals --remote --command "SELECT COUNT(*) AS pending_withdrawals FROM event_prize_withdrawals WHERE json_extract(record_json, '$.status') IN ('processing', 'submitted')" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances list mons-link-event-prize-withdrawal --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances terminate mons-link-event-prize-withdrawal <nonterminal-instance-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Then freeze canonical profile and event writes, pause the event projection Queues, and wait for event and projection leases to expire. Before exporting, inspect every page of Event Progress Workflow instances. For each nonterminal instance created by a Worker version that predates D1 event storage, describe it, verify its deterministic Firebase outbox exists, terminate it, and re-list every page until none remain. Only then run the final import.

```sh
npm run manage:profile-canonical -- --freeze
npm run manage:events -- --freeze
npx wrangler workflows instances list mons-link-event-progress --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances describe mons-link-event-progress <old-nonterminal-instance-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx firebase database:get "/eventProgressOutbox/<outbox-id>" --project mons-link --instance mons-link-default-rtdb
npx wrangler workflows instances terminate mons-link-event-progress <old-nonterminal-instance-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances list mons-link-event-progress --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run migrate:events-d1 -- --final --project mons-link
```

Only then activate D1 and run the cutover smoke:

```sh
npm run manage:events -- --activate-d1
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-events --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
```

Entering the event freeze advances its generation and invalidates every earlier import proof. Freeze, final import, and activation reject every outstanding write admission regardless of expiry. If an admission remains after its logged request has finished, inspect it and recover only that expired row:

```sh
npm run manage:events -- --status
npm run manage:events -- --recover-stale-admission <admission-id>
```

Never bulk-delete admissions. Final import requires all three stores to be frozen, no `processing` or `submitted` withdrawals, and no active event, Telegram-projection, or profile-game-projection leases. It rejects visible prize assignments that match completed withdrawals, performs exact replacement, rereads the imported snapshot, and marks only that freeze generation verified. Reconcile any rejected completed assignment before exporting again. Run the cutover smoke while the dependent stores remain frozen. Only after it passes should you recreate Event Progress instances from the preserved D1 outboxes, resume profile and withdrawal stores, resume Queue delivery, and repeat the normal production smokes.

Status also reports metadata for pending cross-store transitions. The Worker retries them automatically. A pending transition keeps its event fenced until the same durable intent succeeds. Diagnose its recorded error and fix the implementation or unavailable dependency forward; do not detach, delete, or dead-letter the intent.

Successful transition receipts are immutable coordination evidence and are retained in `eventTransitionReceipts`; there is no scheduled receipt deletion. The root remains active and is not a retired Firebase root.

After production smoke checks pass, retain the mode-`0600` final export outside the repository and keep the retired Firebase roots through an observation period covering normal event completion and prize withdrawal. Treat deletion as a separate maintenance task. After that observation succeeds, and only after confirming the API Worker and frontend release prerequisites above remain deployed, explicitly delete the retired Firebase roots: `events`, `eventPrizeSelections`, `profileEventPrizes`, `eventLocks`, `eventSyncThrottles`, `eventProgressOutbox`, `eventProgressOutboxDead`, `telegramProjectionOutbox/event`, `eventTelegramProjectionGenerations`, `eventTelegramProjectionLocks`, `eventTelegramProjections`, `profileGameProjectionLocks/event`, and `profileGameProjectionOutbox/event`. Only then deploy the reduced Realtime Database rules.

Before D1 activation, abort a failed cutover by returning events to Firebase, recreating terminated Event Progress instances from their preserved outboxes, and resuming profile and withdrawal storage plus paused Queues after verification. After activation there is no independent event-store rollback: freeze withdrawals, profiles, and events, pause their dependent Queues, and fix forward while they remain frozen. Do not restore `EVENT_DB` alone with D1 Time Travel because it cannot restore matching RTDB gameplay effects or transition receipts. Resume the stores only after the repair is verified.

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

When a frontend release depends on API behavior, promote and smoke the API first. The first required automatch-operation-ID release is the documented exception: keep writes frozen and promote its compatible frontend before the requiring API. Upload and smoke a unique frontend preview:

```sh
npm run deploy -- preview
```

Promote the exact tested version without rebuilding:

```sh
npm run deploy -- production --version-id <version-id>
```

Before event D1 activation, record a tested frontend Version ID that uses Worker polling. Browser sessions loaded before that polling release must refresh before using events after cutover; deploying the frontend does not update already open tabs. After activation, roll back only to that D1-compatible version or a newer tested version; a frontend that reads the retired Firebase event paths is not a rollback target.

Rollback with that explicit known-good version:

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
