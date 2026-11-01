# Cloudflare deployment

Run commands from the repository root. Portable runtime and admin operations are documented in [cloud operations](../cloud/README.md).

## Release policy

Routine release is the default for content, styling, prize catalogs, and backward-compatible code fixes. Routine releases have no overall time limit. Prepare and validate the affected candidates first, then promote and verify the affected behavior. Builds, tests, uploads, promotion, provider propagation, and required verification should take the time they need. Finish as soon as the required checks pass.

Do not add verification-only waits or observation windows longer than 60 seconds, or chain short waits into extended monitoring. This restriction applies to added idle waiting or watching, not actual work, provider latency, or necessary retries. Prefer no artificial waits and do not add post-success observation. Routine releases do not require write freezes, Queue pauses, drain checks, or extended log-tail sessions.

Builds, tests, and candidate uploads happen during preparation; reuse their successful results for the same source instead of repeating them during promotion. Do not impose an overall wall-clock cutoff, stop a progressing release, or request renewed approval solely because more than 60 seconds have elapsed. Resolve uncertain promotion results and retry relevant checks when propagation or a transient failure warrants it. Report unresolved failures and never claim an unverified release succeeded.

Use coordinated maintenance only when a specific operation requires exclusive access or cannot safely overlap old and new code: schema/data migrations, ownership or settlement protocol changes, incompatible Queue/Workflow payload changes, Durable Object lifecycle changes, or incident recovery. State the concrete reason, affected stores/Queues, drain condition, and required observation period before applying maintenance controls. The presence of D1, Queues, or Workflows alone does not make a release maintenance work.

Deploy only affected Workers. Shared prize-catalog changes need both the API and frontend; frontend-only edits need only the frontend. Keep writes and Queue delivery running during routine releases, preserving any maintenance state that predates the task. Apply trigger changes only when their configuration actually changed.

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration; `cloud/workers/api/wrangler.jsonc` owns API routes, bindings, variables, Queues, Workflows, consumers, and the Cron schedule.
- The six canonical D1 databases run in ENAM. Operators resolve stable bindings from the API configuration; direct Wrangler commands use bindings such as `PROFILE_DB` and `EVENT_DB`.
- The six migration directories under `cloud/workers/api/` retain the applied D1 schema history. Never rename or rewrite an applied migration.
- `PROFILE_DB.profile_login_owners_canonical` owns login-to-profile identity. Profiles, authentication state, events, wagers, reservations, projections, withdrawals, and Telegram delivery use their configured D1 databases.
- `PROFILE_GAMES_DB.invite_sources_canonical` owns invite metadata. Active match records and timer claims live in the existing SQLite `InviteReactions` Durable Object; D1 retains routes and immutable legacy match records.
- The same Durable Object delivers match, metadata, wager, reaction, and appearance snapshots. Preserve its namespace, canonical records, revisions, alarm behavior, socket attachments, and imported evidence.
- Existing IDs, historical snapshots, completion records, transition receipts, and stored payload digests are application data. Compatibility codecs preserve their exact serialized forms.
- `cloud/workers/api/release.env` stays empty. Release commands never load developer environment files. Keep required secret names in Wrangler configuration and encrypted values in Cloudflare.

Authenticate Wrangler locally or supply `CLOUDFLARE_API_TOKEN` through the process environment. Never put credentials in arguments, source files, release files, or logs.

## Automatch queue selection

The live-ticket and pending-enqueue projections in `PROFILE_GAMES_DB` are maintained by triggers from canonical automatch records and session journals. Queue selection always uses FIFO; retained `automatch_runtime_control.metadata_json.queueSelection` values do not control the runtime. Bootstrap response enrichment and committed-session notifications are always enabled.

Inspect projection integrity and control state read-only:

```sh
npm run manage:automatch-queue -- --inspect
```

FIFO orders eligible tickets by `(enqueued_at_ms, invite_id)`. Prepared matches and cancellations remove tickets from consideration; receipt-only reservations and pending enqueues require targeted recovery. Resolve malformed or unrecoverable retained data without deleting evidence or rewriting payload digests. Preserve canonical records, journal payloads, receipts, tombstone revisions, tables, and triggers on rollback. Validate concurrency, replay, cancellation, and query plans locally; do not put smoke participants into the public matching queue.

## Canonical operators

Status and inspection commands are read-only and use Cloudflare credentials. Completed migration executors have been removed; the inspection command accepts only one explicit domain.

| Command                  | Supported operations                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `inspect:state`          | `--domain match-discovery`, `--domain match-presentations`, `--domain wagers`, or `--domain event-receipts` |
| `manage:match-state`     | `--status`, `--inspect-admissions --directory <new-private-output-directory>`                               |
| `manage:invite-source`   | `--status`, `--inspect-admission`, `--reconcile-admission`                                                  |
| `manage:automatch-state` | `--status`, D1 `--freeze`/`--resume`, `--inspect-admissions`, `--reconcile-admission`                       |

Inspection preserves authority, provenance, activation, maintenance, and retained-evidence reports. Event-receipt inspection also inventories every Workflow page, the serving deployment, and any retained operator lock. It never takes a lock or changes controls.

Match admission inspection reads the import identity from D1 and writes a protected report to a new directory. It requires no original migration manifest. Retained records remain immutable; unexplained admissions or locks require investigation. D1 admission recovery uses exact canonical records and never reinterprets a historical whole-record digest as proof from a public snapshot.

Supported maintenance writes preserve their original SQL predicates and use a native D1 binding batch for the application guard, owned write context, business statement, and context removal. The runner registers its own central application admission and completes only that exact identity. Uncertain outcomes retain the admission for inspection; use the reported operation ID and never retry the SQL merely because a response or session cleanup failed. A reported confirmed SQL outcome remains completed even if subsequent cleanup is unconfirmed.

This write transport uses a private child process and an authenticated temporary [remote-binding session](https://developers.cloudflare.com/workers/local-development/#api). It requires an existing account `workers.dev` subdomain and fails closed if none exists. It creates no permanent Worker deployment or API route, but preview-session startup is a provider resource operation. Status reads do not open that session. Credentials pass through private IPC; command arguments, generated configuration, and returned diagnostics contain no credential values. The runner disposes the session and its child process after use. Atomicity relies on the [native D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), not on a REST batch assumption or a successful read-only probe.

## Retained request and invite safeguards

`application_admission_retirements` permanently rejects the exact retired request identities at each D1 write-context boundary. The central database also rejects their new child admissions. Immutable retirement receipts preserve the original records and explicitly leave business outcomes unknown; they do not claim that an invocation terminated or that accepted background work completed. Keep these tables, triggers and receipts on rollback. The older `application_admission_reconciliations` records remain independent and immutable.

The [canonical cleanup report](../cloud/reports/canonical-cleanup-2026-11-01.md) records completed retirement work and archived tooling. Ongoing maintenance commands use the four-database guarded transport described above; immutable retirement markers and receipts remain required.

`retired_invites` permanently excludes the two reviewed legacy rooms in the gameplay, profile and Telegram databases. Current code rejects their mutation locks and rerolls generated automatch collisions; database triggers also reject held or older writers. Preserve the exact identities, scoped guards, closed object controls and cleanup receipts. Removing an entire object or its controls can make it eligible for fresh initialization. Normal traffic and canonical Queue delivery remain active during these scoped operations.

## Validation

Use Node.js 24 or newer. For broad dependency, contract, or stateful changes, install the pinned packages and run the complete gate:

```sh
npm ci
npm ci --prefix cloud/runtime
npm ci --prefix cloud/admin
npm run check:all
```

The gate covers the browser, Worker, generated bindings, tooling, portable runtime, and dependency boundaries. It needs no Java or external database emulator. For routine narrow changes, run the relevant checks and reuse successful unchanged validation lanes. A frontend candidate preparation performs its build and client checks; avoid rebuilding it separately.

## Reusable local admin fixture

Authenticated deployment checks reuse the protected local fixture for ETH `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE`. Use or refresh this fixture before asking the user for credentials. Its files live outside the repository in `/Users/ivan/.codex/secure/mons-link/`:

- `admin-session.json`: persistent session credentials, including refresh and revoke capabilities.
- `admin-auth.json`: smoke authentication with exactly `uid`, `sessionId`, `accessToken`, `accessExpiresAtMs`, and `refreshToken`.
- `admin-profile.json`: the profile fixture consumed by authenticated smoke checks.
- `admin-identity.json`: the expected ETH and canonical admin identity.

Run the local helper from the repository root before authenticated verification:

```sh
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /Users/ivan/.codex/secure/mons-link/refresh-admin-session.mjs
npm run smoke:api -- --base-url https://api.mons.link --read-only --auth-token-fixture /Users/ivan/.codex/secure/mons-link/admin-auth.json --smoke-profile-fixture /Users/ivan/.codex/secure/mons-link/admin-profile.json
```

The helper verifies the ETH identity, canonical profile, and admin access. Access JWTs last five minutes; the refresh capability remains reusable until revoked. Keep these files protected, never print or commit tokens, and never revoke the persistent admin session during temporary smoke-fixture cleanup. If refresh or identity/admin verification fails, stop authenticated checks and investigate; a deliberate revocation must fail closed. Never overwrite or restore session or ownership rows to reactivate the fixture, or change runtime authentication policy to keep it working.

## API Worker release

This is the routine path after the existing namespace is provisioned, with no lifecycle or incompatible state change. Record the current version, upload the validated candidate during preparation, then promote its explicit Version ID and run the standard smoke once:

```sh
npm run upload:api
npm run promote:api -- --version-id <version-id>
npm run smoke:api -- --base-url https://api.mons.link
```

Production API `workers_dev` and `preview_urls` remain disabled. [Workers implementing a Durable Object do not receive version-preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations). Verify the affected behavior on the custom domain after promotion. Use an existing protected auth fixture only when that behavior needs authentication; prepare or refresh it before promotion. For a prize-catalog release, confirm the scheduled event and supplied prize images on the updated frontend. Unrelated history, reservation, reaction, and migration checks are not routine release gates.

Keep existing request, connection, and smoke-command timeouts that detect stalled checks; do not wrap the release or promotion-and-verification sequence in an additional overall deadline. A check timeout means that check is incomplete, not that the release has run out of time. Resolve uncertain outcomes and retry relevant checks as needed. Once the smoke and affected-feature check pass, record the deployed IDs and finish. Existing sampled logs and recovery jobs continue normally. Investigate concrete failures; apply only the maintenance controls that the failure requires.

`upload:api` sends no production traffic. `promote:api` requires an explicit Version ID and routes 100% of traffic to it. Trigger application is a separate operation for reviewed configuration changes.

Event read bookmarks are scoped by `EVENT_DB_BOOKMARK_EPOCH`, which must equal the configured `EVENT_DB` UUID. Legacy or foreign bookmarks restart from the primary and receive a current scoped bookmark, including on `304` responses. Rollback candidates must retain the current ENAM bindings and scoped bookmark support.

When Workflow code or its dependencies change, publish the affected owned definitions after promoting the exact Worker version and before uploading another candidate. The helper preserves current Workflow settings and schedules, checks that the selected Worker is both the latest upload and the version serving 100% of traffic, and records the resulting distinct Workflow version IDs. Cloudflare's Workflow publication API has no atomic Worker-version pin, so do not run concurrent Worker uploads or promotions during this command. The helper rechecks both conditions around publication and fails closed on a mismatch. Its dry-run makes read-only provider requests. Omit `--workflow` to select both configured definitions when their shared dependencies change:

```sh
npm run publish:api:workflows -- --version-id <worker-version-id> --workflow mons-link-event-progress-data1 --dry-run
npm run publish:api:workflows -- --version-id <worker-version-id> --workflow mons-link-event-progress-data1
```

This publication updates code for new instances and does not modify Queue delivery, Worker Cron, routes, or existing instances. Compatible releases preserve running instances on their original versions. A concrete incompatible state change requires the coordinated handoff described in its migration procedure.

## Scheduled-event recovery

The current recovery behavior and budgets are documented in [cloud operations](../cloud/README.md#events-wagers-and-withdrawals). Canonical event migrations include the scheduled-announcement index. Validate busy combined recovery, deadline priority, and admission/provider edge cases locally:

```sh
npm run test:api:runtime -- projectionRecoveryScheduledBudget.test.ts scheduledRecoveryDeadlines.test.ts eventScheduledRecoveryD1.test.ts eventProgressRecoveryD1.test.ts eventProgressDispatch.test.ts
```

Changes to shared event/profile repositories may affect both owned Workflow definitions. Use the routine API release path and publish affected definitions. Verify authenticated current/ended event reads and affected metadata, wager, or gameplay behavior without adding a Cron observation wait.

## Wager settlement delivery

`WAGER_SETTLEMENT_QUEUE` sends initial and deferred retries to `mons-link-wager-settlement-data1`, with exhausted work retained in `mons-link-wager-settlement-data1-dlq`. Its consumer runs independently of Telegram delivery and preserves wager payloads, replay, profile admissions, and reservation checks.

Telegram delivery accepts only Telegram tasks. Inspect the settlement DLQ during recovery and reconcile canonical state before replaying a specific operation through the settlement queue.

Preserve the settlement queue, its DLQ, and their consumer configuration on rollback. A compatible Worker must route settlement work to the dedicated consumer. Verify affected behavior with `smoke:api` and fixture-owned `smoke:wagers`; do not purge queues or alter balances to make checks pass. Provisioning or consumer changes require their own explicit resource operation, not an ordinary code release.

## Event navigation delivery

`EVENT_PROFILE_GAME_PROJECTION_QUEUE` delivers event navigation work through `mons-link-event-profile-game-projection-data1`, independently of rating, invite, automatch, and profile-link work. Preserve canonical event records, task payloads, projection generations, durable outboxes, and the dedicated consumer.

The shared profile-game consumer logs and acknowledges misrouted event tasks. The event recovery sweep can re-enqueue pending outboxes through the dedicated queue; investigate the exact event and request before replaying. Rollback versions and version-pinned Workflows must retain dedicated event routing. Never redirect event work to an unknown handler, purge queues, or delete pending outboxes.

For affected releases, publish changed Workflow definitions and verify the event read plus an isolated event preview. Use an approved admin fixture, an event outside the prize catalog with `isSundayMons: false` and all `telegramAnnouncements` flags false, and a dedicated test participant. Compare `/navigation/games/read` with `/events/snapshot`, remove the participant before start, and keep approved live events read-only. Finish after the required checks pass.

## Coordinated maintenance release

The canonical data cutover is complete at data epoch 1. Current releases preserve the active application generation and its retained admission, retirement, and migration evidence. Completed migration executors and source-export capabilities are retired.

Use maintenance only for a concrete schema, state-compatibility, resource-lifecycle, or incident requirement. Specify the affected stores, writer gates, Queues, leases, and recovery condition before applying controls. Prepare and validate candidates first. Preserve any maintenance or Queue pause state that predates the operation.

Freeze only the affected canonical writers and pause only the consumers that could violate the maintenance invariant. Confirm relevant admissions and leases have drained from their actual state. Apply the reviewed schema or lifecycle change, validate the schema and `PRAGMA foreign_key_check`, then promote the exact compatible candidate and verify its reads before resuming affected writers. Never reset authority, bulk-delete evidence, or restore one coordinated database independently.

Keep API `workers_dev` and `preview_urls` disabled. Use the custom domain for verification. On failure, retain the required maintenance controls and repair forward. Resume only controls changed for this operation. Routine compatible releases use the API and frontend release sections without freezes, Queue pauses, fixed drain waits, or observation windows.

## Canonical timer storage

Current timer starts and claims use the invite Durable Object's verified local layout version 2 and a local cohort for every match. Fresh rooms establish the layout atomically before business writes. The API has no D1 timer backend, timer-storage selector, global timer-start sweep, or temporary cleanup ingress. Permanent writer guards and retained outcomes remain required. Existing rooms with missing or inconsistent layout evidence fail closed; do not recreate empty replacement tables or reset their metadata to force startup.

Preserve absolute deadlines, highest-turn markers, claims, and downstream effect receipts. Validate retry, takeback, eviction, terminal-claim replay, and writer-fence behavior locally, then use the routine release and affected invite-lifecycle checks. A rollback version must understand the verified local layout and writer guards; never restore an older timer backend or reset a stored deadline.

Applied migrations and immutable ownership/receipt records remain preserved. Migration `0039_retire_canonical_timer_starts.sql` retired the former D1 timer table and deletion context; current local timer rows were outside its scope. The [canonical cleanup report](../cloud/reports/canonical-cleanup-2026-11-01.md) indexes the completed storage transition and protected verification evidence.

Before a destructive schema change, qualify every version-pinned Workflow that could still execute older D1 queries. Promoting a newer API does not upgrade existing Workflow instances. Later compatible releases use the ordinary release path and preserve the retired schema state; they do not rerun a completed cleanup executor or introduce another cleanup endpoint.

## Gameplay and delivery verification

For changes to gameplay or shared state adapters, run the isolated lifecycle smoke after API promotion:

```sh
npm run smoke:invite-lifecycle -- --base-url https://api.mons.link --output /secure/unique-gameplay-report.json
```

It creates temporary anonymous participants and a manual invite, checks two-player and spectator snapshots, cumulative moves, takebacks, exact replay, timer deadlines, surrender, rematches, and reconnects. It ends the series, closes sockets, and revokes sessions. All reads and writes use the Cloudflare API. The real browser check also verifies reload persistence and live two-player/spectator delivery.

Use explicit existing paired invite IDs for read-only delivery checks:

```sh
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id> --match-id <existing-match-id>
npm run smoke:invite-metadata -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

Reaction checks require the match ID for v2 appearance delivery and publish no reaction. Metadata and reaction checks verify HTTP or socket snapshots, heartbeat, and reconnect behavior while preserving canonical data.

`smoke:wagers` supports read-only snapshots and a separate isolated mutation lifecycle using dedicated profiles and their own mined dust. Keep its protected fixture across retries and use only the fixture-owned games and balances. Match validation and surrender preparation read `/matches/snapshot`.

## Canonical profile D1 maintenance

The canonical profile control accepts only `active` and `frozen`. Freeze before schema maintenance that requires exclusive access and leave affected writes frozen on a failure of that maintenance. Compatible additive changes use the routine release path after reviewing their actual schema and writer dependencies.

```sh
npm run manage:profile-canonical -- --status
npm run manage:profile-canonical -- --freeze
npx wrangler d1 migrations list PROFILE_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 migrations apply PROFILE_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Pause the permanent profile-related Queues when a migration changes profile schema or invariants:

```sh
npx wrangler queues pause-delivery mons-link-auth-recovery-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-event-profile-game-projection-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-projection-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-wager-settlement-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

After applying the migration, inspect the expected schema, run `PRAGMA foreign_key_check`, smoke production, then resume the control and Queues:

```sh
npm run manage:profile-canonical -- --resume
npx wrangler queues resume-delivery mons-link-auth-recovery-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-profile-game-projection-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-event-profile-game-projection-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-projection-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-wager-settlement-data1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Rollback versions must retain the [current queue routing](#queue-and-workflow-operations). Telegram delivery does not execute or forward settlement tasks.

Canonical profile incidents freeze affected writers and fix forward. Retained profile evidence, ownership, balances, and blocked business outcomes must remain intact.

## Historical match D1 operations

`PROFILE_GAMES_DB` D1 is the sole source for the public historical-match endpoint. A missing snapshot returns `pair: null`; the endpoint never reconstructs or persists data on a read miss. There is no read-through recovery or backfill path. Releases affecting history or its projections must pass the authenticated `--require-history` smoke using a known non-null D1 snapshot. Prepare its fixture before promotion and include this check in the required live verification; for coordinated maintenance, run it before canonical writes resume. Unrelated catalog or frontend changes do not require this fixture.

During a relevant maintenance observation window or an investigation, tail historical reads and their rating- and transition-driven archival projections. Routine releases require no fixed observation window:

```sh
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical_match_read_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical_match_archive_descriptor_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search historical-match-conflict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --search profile_game_projection_queue_failed --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler tail mons-link-api --version-id <version-id> --format pretty --status error --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

`historical_match_read_failed` is the handled public-history 503 signal; `--status error` covers uncaught Worker failures and limits, not handled 5xx responses. Any required-history smoke failure, archive conflict, recurring Queue failure, or new history 5xx requires freezing affected writes and repairing forward. Active match synchronization uses canonical invite Durable Object records and timer claims.

## Event D1 operations

`EVENT_DB` owns event data and coordination. Its control supports `d1` and `frozen`:

```sh
npm run manage:event-prize-withdrawals -- --freeze
npm run manage:profile-canonical -- --freeze
npm run manage:events -- --status
npm run manage:events -- --freeze
```

Wait until no withdrawal is `processing` or `submitted`, and event/projection leases and write admissions have drained before changing coordinated state. Inspect all pages of version-pinned Workflow instances during schema maintenance. Freeze storage before terminating an instance, and preserve pending D1 work for recovery.

```sh
npx wrangler d1 execute EVENT_PRIZE_WITHDRAWALS_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --command "SELECT COUNT(*) AS pending_withdrawals FROM event_prize_withdrawals_canonical WHERE json_extract(record_json, '$.status') IN ('processing', 'submitted');" --json
npx wrangler d1 migrations apply EVENT_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:events -- --recover-stale-admission <admission-id>
```

Recover only a named expired admission after confirming its request finished. Add `--evidence /secure/proof.json` to bind the request-finished and source-reconciled proof to the exact retained admission row; the file must be private and use an absolute path. Never bulk-delete admissions. Pending transitions retry while preserving their fences; fix the implementation or unavailable dependency forward, and do not detach, delete, or dead-letter the intent. Successful transition receipts are immutable coordination evidence in `PROFILE_GAMES_DB.event_transition_receipts`; there is no scheduled receipt deletion. Do not restore `EVENT_DB` alone because event state, gameplay D1 receipts, and Durable Object match effects must remain consistent.

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

Recover only an expired admission whose original request has finished and whose uncertain effects have been reconciled. Resume requires admissions and gameplay leases drained. Include `mons-link-wager-settlement-data1` in coordinated maintenance because it executes settlement retries. Validate frozen reads and stale-client rejection while canonical writes remain frozen, then verify normal wagering after resume. Keep writes frozen and repair forward on failures; canonical balances, reservations, and wager settlement records must stay consistent.

## Event-prize withdrawal D1 operations

`EVENT_PRIZE_WITHDRAWALS_DB` owns admission, leases, persisted Solana submissions, and completion records. Its runtime control accepts `d1` and `frozen`:

```sh
npm run manage:event-prize-withdrawals -- --status
npm run manage:event-prize-withdrawals -- --freeze
npm run manage:event-prize-withdrawals -- --resume
```

Freeze storage before terminating a withdrawal Workflow or changing its schema. After freezing, confirm `activeLeases` is zero before changing its coordinated state.

After promoting a candidate, trigger a unique read-only preflight and inspect the exact instance before resuming withdrawal storage:

```sh
event_prize_preflight_id="preflight-$(date -u +%Y%m%d%H%M%S)-$$"
npx wrangler workflows trigger mons-link-event-prize-withdrawal-data1 '{"schemaVersion":2,"dataEpoch":1,"kind":"preflight"}' --id "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances describe mons-link-event-prize-withdrawal-data1 "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

The preflight must complete with `{"ok":true,"status":"ready"}`. It validates the encrypted wallet identity, Metaplex runtimes, and a read-only Helius request without building or sending a transaction.

## Queue and Workflow operations

| Queue                                           | Work                                                    |
| ----------------------------------------------- | ------------------------------------------------------- |
| `mons-link-auth-recovery-data1`                 | Profile recovery                                        |
| `mons-link-profile-game-projection-data1`       | Rating, invite, automatch, and profile-link projections |
| `mons-link-event-profile-game-projection-data1` | Event navigation previews                               |
| `mons-link-telegram-projection-data1`           | Automatch, rating, and event Telegram projections       |
| `mons-link-telegram-delivery-data1`             | Telegram message delivery                               |
| `mons-link-wager-settlement-data1`              | Wager settlement retries                                |

Each producer targets its owning queue. Scheduled sweeps recover pending jobs and outboxes in their owning D1 databases. Session and event transitions retain their guarded journals and idempotent invite-effect receipts. Do not purge Queues or delete pending jobs or outboxes during incidents.

`mons-link-event-progress-data1` owns scheduled event starts and retriable synchronization. Inspect every page of Workflow instances before schema maintenance when version-pinned work could still be active:

```sh
npx wrangler workflows instances list mons-link-event-progress-data1 --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances list mons-link-event-prize-withdrawal-data1 --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

## Telegram D1 operations

Delivery and recovery records live in `TELEGRAM_DB`. Apply its schema before promoting a Worker that requires it:

```sh
npx wrangler d1 migrations apply TELEGRAM_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

`telegram_runtime_control` uses `d1` and `frozen`. Missing or unreadable control state fails closed. Ambiguous sends remain `uncertain` and require an operator-reviewed recovery action; never retry them blindly.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the tracked auth maintenance switch. Change it through candidate upload, explicit Version ID promotion, and custom-domain smoke; do not create Dashboard overrides.

`mons-link-auth-recovery-data1` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record. Auth origins are enforced in code.

## Frontend release

Prepare the frontend with `preview`, which performs an isolated build, client checks, and candidate upload. Verify the unique preview when the affected behavior works on that origin. When frontend changes depend on API changes, promote and verify the API first.

```sh
npm run deploy -- preview
npm run deploy -- production --version-id <version-id>
```

Promote the prepared frontend's exact version without rebuilding. Verify the affected page on `mons.link` and allow necessary propagation or retries without an overall release deadline. Routine releases preserve supported HTTP and WebSocket contracts. Existing tabs using retired reaction v1 need to reload the current frontend; stored reactions are preserved. Finish after the required checks pass.

## Secrets

Session signing keys, X credentials, Telegram credentials, Helius, and the prize wallet remain encrypted Worker secrets. Preserve their existing values during routine releases. The `TELEGRAM_QUEUE_BRIDGE_SECRET` operator credential also has a protected local copy; see [cloud operations](../cloud/README.md#telegram-recovery-and-announcements).

Stage reviewed secret changes through versioned candidate operations, inspect the final candidate's binding names, then promote that exact version. Deleting a secret through a command that immediately deploys is not a substitute for candidate preparation. Never log secret values or remove shared user-level provider authentication.

## Deferred Firebase cleanup

The [canonical cleanup report](../cloud/reports/canonical-cleanup-2026-11-01.md) records the completed migration, retained evidence, and deferred Firebase cleanup. Current operations do not use the completed migration executor.

The deferred scope is eligible obsolete data in Firebase project `mons-link`, pending account access. Project deletion is outside this cleanup. Preserve financial records, authentication and revocation state, recovery evidence, and protected archives. Repository cleanup does not establish the current state of external infrastructure.
