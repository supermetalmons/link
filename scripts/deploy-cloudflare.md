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
- `PROFILE_DB.profile_login_owners` owns login-to-profile identity. Profiles, authentication state, events, wagers, reservations, projections, withdrawals, and Telegram delivery use their configured D1 databases.
- `PROFILE_GAMES_DB.invite_sources` owns invite metadata. Active match records and timer claims live in the existing SQLite `InviteReactions` Durable Object; D1 retains routes and immutable legacy match records.
- The same Durable Object delivers match, metadata, wager, reaction, and appearance snapshots. Preserve its namespace, canonical records, revisions, alarm behavior, socket attachments, and imported evidence.
- Existing IDs, historical snapshots, completion records, transition receipts, and stored payload digests are application data. Compatibility codecs preserve their exact serialized forms.
- `cloud/workers/api/release.env` stays empty. Release commands never load developer environment files. Keep required secret names in Wrangler configuration and encrypted values in Cloudflare.

Authenticate Wrangler locally or supply `CLOUDFLARE_API_TOKEN` through the process environment. Never put credentials in arguments, source files, release files, or logs.

## Canonical operators

Status commands are read-only and use Cloudflare credentials. Completed migration phases and source-proof operations are retired and fail during argument validation.

| Command                            | Supported operations                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `manage:match-state`               | `--status`, `--inspect-admissions --directory <new-private-output-directory>`         |
| `manage:wager-state`               | `--status`                                                                            |
| `manage:login-match-discovery`     | `--status`                                                                            |
| `manage:match-presentations`       | `--status`                                                                            |
| `manage:event-transition-receipts` | `--status`                                                                            |
| `manage:invite-source`             | `--status`, `--inspect-admission`, `--reconcile-admission`                            |
| `manage:automatch-state`           | `--status`, D1 `--freeze`/`--resume`, `--inspect-admissions`, `--reconcile-admission` |

Match admission inspection reads the import identity from D1 and writes a protected report to a new directory. It requires no original migration manifest. Retained records remain immutable; unexplained admissions or locks require investigation. D1 admission recovery uses exact canonical records and never reinterprets a historical whole-record digest as proof from a public snapshot.

## Validation

Use Node.js 24 or newer. For broad dependency, contract, or stateful changes, install the pinned packages and run the complete gate:

```sh
npm ci
npm ci --prefix cloud/runtime
npm ci --prefix cloud/admin
npm run check:all
```

The gate covers the browser, Worker, generated bindings, tooling, portable runtime, and dependency boundaries. It needs no Java or external database emulator. For routine narrow changes, run the relevant checks and reuse successful unchanged validation lanes. A frontend candidate preparation performs its build and client checks; avoid rebuilding it separately.

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
npm run publish:api:workflows -- --version-id <worker-version-id> --workflow mons-link-event-progress --dry-run
npm run publish:api:workflows -- --version-id <worker-version-id> --workflow mons-link-event-progress
```

This publication updates code for new instances and does not modify Queue delivery, Worker Cron, routes, or existing instances. Compatible releases preserve running instances on their original versions. A concrete incompatible state change requires the coordinated handoff described in its migration procedure.

## Wager settlement Queue rollout

The settlement Queue split uses one compatible API release with unchanged wager payloads and no database migration. Keep writes and existing Queue delivery active. During preparation, inspect the two queue names and create only missing resources, then validate and upload the API candidate:

```sh
npx wrangler queues create mons-link-wager-settlement --message-retention-period-secs 345600 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues create mons-link-wager-settlement-dlq --message-retention-period-secs 1209600 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Promote the exact candidate with `promote:api`, then attach the dedicated consumer and verify its settings. Messages produced before attachment remain queued. Use this targeted operation; `deploy:api:triggers` also updates other consumers, routes, Cron, and Workflow definitions:

```sh
npx wrangler queues consumer add mons-link-wager-settlement mons-link-api --batch-size 1 --batch-timeout 0 --message-retries 100 --dead-letter-queue mons-link-wager-settlement-dlq --max-concurrency 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues consumer list mons-link-wager-settlement --json --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

If provisioning or attachment returns an uncertain result, inspect remote state before retrying. Preserve existing resources and settings. Run `smoke:api` and the fixture-owned `smoke:wagers` active lifecycle. Verify both queue paths by publishing the same already-completed fixture settlement task through the authenticated Queue API, once to the settlement queue and once to the legacy Telegram queue. Correlate its operation ID with successful processing and forwarding logs, then confirm unchanged balances. Use bounded delivery checks without artificial initial delays or post-success observation; a missing confirmation requires investigation, not a success claim.

Legacy wager messages forward unchanged to `WAGER_SETTLEMENT_QUEUE` without added delay. Acknowledge the legacy message only after enqueue succeeds; retry it if forwarding fails. Existing settlement replay and admission checks remain in the dedicated consumer.

For rollback, retain both settlement queues and the attached consumer. Promote only the recorded compatible pre-split Worker version after verifying that its queue fallback handles unchanged wager payloads; it can consume the new queue using its existing settlement handler. Do not remove or purge queues, or apply old trigger configuration. Legacy Telegram DLQ entries can still contain settlement work and require canonical-state reconciliation before a specific replay.

## Coordinated maintenance release

Use maintenance only for a concrete schema, state-compatibility, resource-lifecycle, or incident requirement. Specify the affected stores, writer gates, Queues, leases, and recovery condition before applying controls. Prepare and validate candidates first. Preserve any maintenance or Queue pause state that predates the operation.

Freeze only the affected canonical writers and pause only the consumers that could violate the maintenance invariant. Confirm relevant admissions and leases have drained from their actual state. Apply the reviewed schema or lifecycle change, validate the schema and `PRAGMA foreign_key_check`, then promote the exact compatible candidate and verify its reads before resuming affected writers. Never reset authority, bulk-delete evidence, or restore one coordinated database independently.

Keep API `workers_dev` and `preview_urls` disabled. Use the custom domain for verification. On failure, retain the required maintenance controls and repair forward. Resume only controls changed for this operation. Routine compatible releases use the API and frontend release sections without freezes, Queue pauses, fixed drain waits, or observation windows.

## Gameplay and delivery verification

For changes to gameplay or shared state adapters, run the isolated lifecycle smoke after API promotion:

```sh
npm run smoke:invite-lifecycle -- --base-url https://api.mons.link --output /secure/unique-gameplay-report.json
```

It creates temporary anonymous participants and a manual invite, checks two-player and spectator snapshots, cumulative moves, takebacks, exact replay, timer deadlines, surrender, rematches, and reconnects. It ends the series, closes sockets, and revokes sessions. All reads and writes use the Cloudflare API. The real browser check also verifies reload persistence and live two-player/spectator delivery.

Use explicit existing paired invite IDs for read-only delivery checks:

```sh
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
npm run smoke:invite-metadata -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

Reaction checks publish no reaction. Add `--match-id <existing-match-id>` for v2 appearance delivery. Metadata and reaction checks verify HTTP or socket snapshots, heartbeat, and reconnect behavior while preserving canonical data.

`smoke:wagers` supports read-only snapshots and a separate isolated mutation lifecycle using dedicated profiles and their own mined dust. Keep its protected fixture across retries and use only the fixture-owned games and balances. Match validation and surrender preparation read `/matches/snapshot`.

## Canonical profile D1 maintenance

The canonical profile control accepts only `active` and `frozen`. Freeze before schema maintenance and leave production frozen on any failure:

```sh
npm run manage:profile-canonical -- --status
npm run manage:profile-canonical -- --freeze
npx wrangler d1 migrations list PROFILE_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 migrations apply PROFILE_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

Pause the permanent profile-related Queues when a migration changes profile schema or invariants:

```sh
npx wrangler queues pause-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues pause-delivery mons-link-wager-settlement --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

After applying the migration, inspect the expected schema, run `PRAGMA foreign_key_check`, smoke production, then resume the control and Queues:

```sh
npm run manage:profile-canonical -- --resume
npx wrangler queues resume-delivery mons-link-auth-recovery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-profile-game-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler queues resume-delivery mons-link-wager-settlement --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

When running a pre-split rollback version, include `mons-link-telegram-delivery` in these pause and resume operations because that version executes settlement retries there. The current version only forwards legacy wager messages to the settlement queue.

Canonical profile incidents freeze D1 and fix forward. `legacy_fields_json` contains retained migrated data and must remain intact.

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
npx wrangler d1 execute EVENT_PRIZE_WITHDRAWALS_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --command "SELECT COUNT(*) AS pending_withdrawals FROM event_prize_withdrawals WHERE json_extract(record_json, '$.status') IN ('processing', 'submitted');" --json
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

Recover only an expired admission whose original request has finished and whose uncertain effects have been reconciled. Resume requires admissions and gameplay leases drained. Include `mons-link-wager-settlement` in coordinated maintenance because it executes settlement retries. A pre-split rollback version also requires `mons-link-telegram-delivery`; the current Telegram handler only forwards legacy wager messages. Validate frozen reads and stale-client rejection while canonical writes remain frozen, then verify normal wagering after resume. Keep writes frozen and repair forward on failures; canonical balances, reservations, and wager settlement records must stay consistent.

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
npx wrangler workflows trigger mons-link-event-prize-withdrawal '{"schemaVersion":1,"kind":"preflight"}' --id "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances describe mons-link-event-prize-withdrawal "$event_prize_preflight_id" --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

The preflight must complete with `{"ok":true,"status":"ready"}`. It validates the encrypted wallet identity, Metaplex runtimes, and a read-only Helius request without building or sending a transaction.

## Queue and Workflow operations

`mons-link-profile-game-projection` owns rating, invite, automatch, event, and profile-link projections. `mons-link-telegram-projection` owns automatch, rating, and event Telegram projections. Profile-link catch-up jobs are written atomically with canonical ownership changes in `PROFILE_DB`; their Queue dispatch is recovered by the scheduled D1 sweep. Automatch and manual-session outboxes live in `PROFILE_GAMES_DB`; a durable transition journal coordinates create-only Durable Object match effects with canonical invite metadata, session receipts, and outboxes. Event transitions retain their own D1 intents and use idempotent invite-effect receipts. Event and rating outboxes remain in their owning D1 databases. Do not purge Queues or delete pending jobs or outboxes during incidents.

`mons-link-event-progress` owns scheduled event starts and retriable synchronization. Inspect every page of Workflow instances before schema maintenance when version-pinned work could still be active:

```sh
npx wrangler workflows instances list mons-link-event-progress --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler workflows instances list mons-link-event-prize-withdrawal --per-page 100 --page 1 --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

## Telegram D1 operations

Delivery and recovery records live in `TELEGRAM_DB`. Apply its schema before promoting a Worker that requires it:

```sh
npx wrangler d1 migrations apply TELEGRAM_DB --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

`telegram_runtime_control` uses `d1` and `frozen`. Missing or unreadable control state fails closed. Ambiguous sends remain `uncertain` and require an operator-reviewed recovery action; never retry them blindly.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the tracked auth maintenance switch. Change it through candidate upload, explicit Version ID promotion, and custom-domain smoke; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record. Auth origins are enforced in code.

## Frontend release

Prepare the frontend with `preview`, which performs an isolated build, client checks, and candidate upload. Verify the unique preview when the affected behavior works on that origin. When frontend changes depend on API changes, promote and verify the API first.

```sh
npm run deploy -- preview
npm run deploy -- production --version-id <version-id>
```

Promote the prepared frontend's exact version without rebuilding. Verify the affected page on `mons.link` and allow necessary propagation or retries without an overall release deadline. Existing open tabs continue running their loaded version, so public HTTP and WebSocket compatibility must remain intact. Finish after the required checks pass.

## Secrets

Session signing keys, X credentials, Telegram credentials, Helius, and the prize wallet remain encrypted Worker secrets. Preserve their existing values during routine releases. The `TELEGRAM_QUEUE_BRIDGE_SECRET` operator credential also has a protected local copy; see [cloud operations](../cloud/README.md#telegram-recovery-and-announcements).

Stage reviewed secret changes through versioned candidate operations, inspect the final candidate's binding names, then promote that exact version. Deleting a secret through a command that immediately deploys is not a substitute for candidate preparation. Never log secret values or remove shared user-level provider authentication.

## Outstanding infrastructure retirement

The completed Firebase migration retains immutable evidence in D1 and its release record in Git history. No source archive or migration executor is needed for current operations.

Google project `mons-link` (`390871694056`), including `mons-attester`, was last verified `ACTIVE` on September 11, 2026 after automatic approval review rejected project-wide deletion. Its decommissioning remains separate work: inspect [Google Cloud project settings](https://console.cloud.google.com/iam-admin/settings?project=mons-link), verify `DELETE_REQUESTED` after an authorized deletion, and repeat affected API checks. Repository cleanup does not establish that the project is shut down.
