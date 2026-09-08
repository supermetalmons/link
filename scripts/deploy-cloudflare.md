# Cloudflare deployment

Run commands from the repository root with Node.js 24 and Java 21 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Release policy

Routine release is the default for content, styling, prize catalogs, and backward-compatible code fixes. Routine releases have no overall time limit. Prepare and validate the affected candidates first, then promote and verify the affected behavior. Builds, tests, uploads, promotion, provider propagation, and required verification should take the time they need. Finish as soon as the required checks pass.

Do not add verification-only waits or observation windows longer than 60 seconds, or chain short waits into extended monitoring. This restriction applies to added idle waiting or watching, not actual work, provider latency, or necessary retries. Prefer no artificial waits and do not add post-success observation. Routine releases do not require write freezes, Queue pauses, drain checks, or extended log-tail sessions.

Builds, tests, and candidate uploads happen during preparation; reuse their successful results for the same source instead of repeating them during promotion. Do not impose an overall wall-clock cutoff, stop a progressing release, or request renewed approval solely because more than 60 seconds have elapsed. Resolve uncertain promotion results and retry relevant checks when propagation or a transient failure warrants it. Report unresolved failures and never claim an unverified release succeeded.

Use coordinated maintenance only when a specific operation requires exclusive access or cannot safely overlap old and new code: schema/data migrations, ownership or settlement protocol changes, incompatible Queue/Workflow payload changes, Durable Object lifecycle changes, or incident recovery. State the concrete reason, affected stores/Queues, drain condition, and required observation period before applying maintenance controls. The presence of D1, Queues, or Workflows alone does not make a release maintenance work. Historical cutover instructions below apply only to their named cutover.

Deploy only affected Workers. Shared prize-catalog changes need both the API and frontend; frontend-only edits need only the frontend. Keep writes and Queue delivery running during routine releases, preserving any maintenance state that predates the task. Apply trigger changes only when their configuration actually changed.

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Durable Object class exports, Queues, Workflows, consumers, and Cron schedule.
- The migration directories under `cloud/workers/api/` own the six D1 schemas.
- `PROFILE_DB.profile_login_owners` is authoritative for Worker login UID to canonical profile ownership. Firebase custom claims and RTDB profile links are non-authoritative browser-rule and recovery shadows.
- `cloud/workers/api/release.env` stays empty so release commands never load developer environment files.
- Encrypted secrets stay in Cloudflare; required names are declared in the API Wrangler configuration.
- `EVENT_DB` owns event records, participants, prize selections, visible assigned prizes, progress markers, and event-specific projection state. Active match synchronization remains in RTDB. `PROFILE_GAMES_DB.invite_sources` owns invite metadata after the one-way invite-source activation.
- `INVITE_REACTIONS` owns voice/sticker reaction delivery through one SQLite-backed `InviteReactions` Durable Object per invite. Firebase reaction records are retained but no longer written after the final rules cutover.
- The same Durable Object owns revisioned live match presentation and frozen historical appearance. Firebase matches retain immutable emoji/aura seeds; no extra Worker, namespace, or D1 migration is required.
- The same object serves revisioned invite/lobby/rematch metadata over a separate subscription. Invite source records use `PROFILE_GAMES_DB.invite_sources` after activation; retained RTDB records are evidence only.
- The same object serves invite-wide public wager snapshots over HTTP and `mons-invite-wagers-v1`. `PROFILE_DB.invite_wager_states` owns wager source records and resolution markers; invite metadata uses the gameplay D1 source after activation. Metadata and wagers share composed source reads and one five-second reconciliation alarm while either channel has subscribers; their revisions, admission limits, and broadcasts remain separate. Retained RTDB wagers never provide a read or write fallback.
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

Keep existing request, connection, and smoke-command timeouts that detect stalled checks; do not wrap the release or promotion-and-verification sequence in an additional overall deadline. A check timeout means that check is incomplete, not that the release has run out of time. Resolve uncertain outcomes and retry relevant checks as needed. Once the smoke and affected-feature check pass, record the deployed IDs and finish. Existing sampled logs and recovery jobs continue normally. Investigate concrete failures; apply only the maintenance controls that the failure requires.

`upload:api` sends no production traffic. `promote:api` requires an explicit Version ID and routes 100% of traffic to it. Trigger application is a separate operation for reviewed configuration changes.

## Cumulative move delivery release

Frontend follow-up `ec7e6159-cbe0-41e5-9d17-e36ad270b801` preserves accepted end-series, rating, and wager-result operations across view changes. Confirmed surrender refreshes only the matching authenticated board and remains authoritative over an older in-flight match snapshot. All 539 client tests passed, and production assets matched the tested candidate. Evidence is retained in `/private/tmp/mons-terminal-recovery-VWRLqP`.

Frontend follow-up `fa65fd9c-43b7-4ed0-866a-76ec5a058786` keeps accepted surrender bound to its original authenticated match while pending moves drain, even after navigation or reconnect. Other mutation context guards remain unchanged. All 516 client tests passed, and production assets matched the tested candidate. Evidence is retained in `/private/tmp/mons-surrender-navigation-8S8eac`.

Released on September 8, 2026 with API version `3979ebc2-63e5-47a4-b889-6cc8f6ac50bb` and frontend version `8f9a7d69-ce81-45a6-9983-ac03f13d8015`, each serving 100% of traffic. The complete validation gate passed 2,747 tests. Production lifecycle checks verified cumulative move/move/takeback/move recovery, late older requests acknowledged without rollback, exact replay, legacy requests, and direct Firebase write denials. Browser checks verified rapid consecutive moves, takebacks, a five-action opponent batch, and successful undo after reload. The test series was ended and its temporary guest deleted. Evidence is retained in `/private/tmp/mons-move-reliable-release-MK2KK4`.

Cumulative delivery adds optional `previousStates` checkpoints to the existing move API and preserves strict legacy requests. The browser journals pending moves and takebacks, sends cumulative batches, and reconciles delayed acknowledgements and reconnects. Firebase rules already permit cumulative append-only writes; this release changes only the API and frontend Workers, with no schema, rule, Queue, trigger, or maintenance-control changes.

Validate the API, client delivery/replay behavior, shared contracts, and lifecycle tooling before uploading candidates. Promote the API first and run the standard API smoke and lifecycle smoke. The lifecycle sends a cumulative move/move/takeback/move target before its first request, requires the late first request to return `superseded` without a write, replays the latest target, and verifies a subsequent legacy move request. It also retains direct Firebase write-denial checks and cleans up temporary Auth sessions. Promote the validated frontend's exact version and verify rapid moves and takebacks, live opponent observation, and same-match reload recovery. Preserve the checkpoint-capable API as the rollback baseline once the new frontend is live. Record candidate IDs and checks; keep gameplay and Queue delivery running and finish once the required verification passes.

## Move API and rules release

The cutover completed on September 8, 2026 with API version `e865d985-8fc4-490a-8e08-d98912ac9dda` and frontend version `54a9cfd0-55a3-4d62-b79b-21e1f647af8c`, each serving 100% of traffic. The full validation gate passed 2,704 tests. Production checks verified API moves and replay on initial matches and rematches, direct Firebase move/status denials, unchanged timer protections, and temporary Auth-session cleanup. The promoted browser submitted moves before and after the rules cutover and observed the controlled opponent's moves live. The browser test series was ended and its temporary guest deleted. Deployed Firebase rules exactly matched the tested candidate. Release evidence is retained in `/private/tmp/mons-move-release-7MtqfD`.

Move submissions retain Firebase match storage and subscriptions while moving browser writes to `POST /matches/move`. The API uses the existing gameplay service account with an exact-match `workerMoveMatchId` override. It preserves concurrent non-move fields and checks the existing timer-claim fence atomically. The only new binding is `MOVE_RATE_LIMITER`; no data migration, Queue pause, write freeze, or trigger deployment is required.

Prepare the complete validation gate, frontend build, tested Firebase rules, and both Worker candidates before promotion. Record the current Worker versions and deployed Firebase rules. Promote the API candidate first and run the standard API smoke plus the isolated lifecycle check while direct browser move writes are still permitted:

```sh
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:invite-lifecycle -- --base-url https://api.mons.link --move-rules-pending
```

Promote the validated frontend candidate, verify two-player move submission and live opponent observation, then deploy the reviewed database rules through `npm run deploy:firebase -- --project mons-link`. Rerun the lifecycle smoke without `--move-rules-pending`. It requires API move and surrender replay on initial matches and rematches, unchanged match fields, direct browser move/status denials, and temporary Auth-session cleanup. Compare the deployed Firebase rules with the tested candidate and record the deployed Worker versions.

The cutover requires older open clients to refresh before submitting moves. Keep an API-capable frontend and backend as the rollback baseline after the rules cutover. Follow the routine release timing policy and finish when verification passes.

## Surrender API and rules release

The move release above supersedes this historical procedure for current releases.

The cutover completed on September 8, 2026 with API version `2e4d24c1-3948-4e8f-9725-3b866b27167b` and frontend version `48fe9424-8c55-421e-bc2e-e6c302e33a0f`, each serving 100% of traffic. The complete validation gate passed 2,592 tests. Production checks verified surrender/replay and opponent observation on initial matches and rematches, continued legal moves, direct status-write denials, and temporary Auth-session cleanup. The deployed Firebase rules matched the tested candidate. Release evidence is retained in `/private/tmp/mons-surrender-release-xNjHrQ`; unrelated in-progress Telegram edits were excluded from the release snapshot.

The surrender API uses the existing gameplay service account with a per-match `auth_variable_override`. The override supplies the authorized actor UID and `workerSurrenderMatchId` only to the restricted Firebase REST transaction; it is never issued as a Firebase user claim. The transaction preserves all other match fields, and the existing timer-claim rule is checked atomically with the status write. There are no new resources or schema changes.

Prepare API, frontend, tooling, and database-rule validation before promotion. Promote the API candidate first and run the standard API smoke. The isolated lifecycle smoke can verify moves, surrender/replay, and opponent observation before the rule cutover:

```sh
npm run smoke:invite-lifecycle -- --base-url https://api.mons.link --surrender-rules-pending
```

Promote the frontend candidate, then deploy the reviewed Firebase database rules through `npm run deploy:firebase -- --project mons-link`. Run the lifecycle smoke again without `--surrender-rules-pending`; its default also requires direct Firebase status changes and deletions to be rejected. It creates only controlled manual-game sessions and removes its temporary Auth sessions. Wager smoke tooling also submits surrender through the API, but a live wager test is not a required release check for this change.

The rule cutover disables surrender from older clients, including clients with an admin claim. Move writes continue when status is unchanged. Preserve an API-capable frontend and API version as the rollback baseline after this cutover. Keep ordinary gameplay and Queue delivery active throughout; no write freeze or observation window is required.

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

### Invite-source D1 cutover

The cutover completed on September 8, 2026. All 4,572 existing invite records were imported and verified with source/import digest `e72239f6dd17623eff01ff52d42fab283000ccb507e74e5394c06fb2bc186b0b`, then activated at invite-source epoch 1 on API version `df89c91c-8bf2-4277-99fb-fbee1c7fc837`. Invite, session/automatch, and event gates were restored to their prior active states; Queue delivery continued throughout. Full repository validation and production API, metadata, wager, reaction/presentation, and isolated game lifecycle checks passed. The lifecycle check confirmed new invitations have no RTDB metadata shadow, preserved live match writes and timer rules, and removed its temporary Auth sessions. Protected evidence is retained in `/private/tmp/mons-invite-cutover-T2Wqvt`. Treat the procedure below as the completed initial migration; subsequent compatible releases use the routine release path and must retain D1 invite authority.

For an orphaned invite-source admission, `npm run manage:invite-source -- --status` includes the total count and up to 100 admission tuples, ordered by creation time and UUID. Runtime acquisition/release failure logs also identify the admission. Inspect exactly one with `--inspect-admission <UUID> --directory /private/admission-evidence`. This saves an immutable inspection and a separate `-evidence.json` template in a user-owned 0700 directory outside the repository, with 0600 files. Preserve the inspection and complete the template's `requestFinishedAtMs`, `completionEvidence.reference` and `explanation`, and `sourceReconciliation` fields. The source proof requires `scopeComplete: true`, a reference and explanation covering all original request effects and receipts, and `sources: [{inviteId, digest}]` for every affected invite. Each digest is SHA-256 of the shared `canonicalJson(normalizeInviteSource(value))`, or `canonicalJson(null)` for an absent source, read from the current authority. Set `noSourceEffects: true` with an empty source list only when the investigation proves no source work was dispatched, such as a confirmed acquisition failure before the callback started. A request timeout, elapsed time, or zero pending intents alone proves neither completion nor reconciliation.

Run `npm run manage:invite-source -- --reconcile-admission --evidence /private/admission-evidence/<completed-evidence-file>.json`. Recovery checks the exact inspected admission tuple and unchanged writer controls, current source digests, and absence of session intents/resources/locks, event intents (including uncertain/dead records), and event leases. Other admission rows remain untouched and do not prevent separate reconciliation of multiple crash orphans. Recovery never changes gates or expires work; it works before or after source activation with active or partially frozen gates. After an uncertain delete response, retry the same evidence file and retain its matching protected pre-delete artifact and completion receipt. A missing row without matching pre-delete evidence is rejected. Terminal output contains identifiers and digests, never source payloads.

This migration moves the private `invites/{inviteId}` source aggregate into `PROFILE_GAMES_DB.invite_sources`. Participants, passwords, colors, rematch strings, event ownership, automatch operation IDs, cancellation metadata, transition markers, unknown fields, and empty objects are preserved. The already retired root children `reactions`, `wagers`, and `matchesWagerResolutions` are excluded; their canonical stores and all Firebase live matches, timer claims, and profile-rule shadows remain intact.

Coordinated maintenance is required because an old Firebase invite writer and a D1 writer must not update different authorities. The operator owns an independent invite gate and temporarily freezes only the existing automatch/session and event writer gates. Queue delivery, canonical profiles, auth, mining, live moves, surrender, and manual-game timers remain active. Event-game timeout claims pause while the event gate is frozen because they write event-progress outboxes. Do not add Queue pauses, a global profile freeze, or artificial drain waits. Gate transitions and activation require actual completed work: all affected admissions, session resources, session intents, session leases, event intents including dead/uncertain records, and event leases must be absent. Expiration alone is not completion evidence; never delete an admission, transition, or lease to manufacture a clean count.

Prepare schema `0018_invite_sources.sql`, the control-aware API, full validation, operator rehearsal, and protected evidence before maintenance. `--preflight` performs a bounded read-only source scan without requiring the new schema. It reports only counts and byte sizes. Firebase authentication uses an explicit private `--firebase-credentials` file, then `GOOGLE_APPLICATION_CREDENTIALS`, then the existing Firebase CLI login. Cloudflare requests use `CLOUDFLARE_API_TOKEN` or the current Wrangler OAuth login; credentials are captured privately and never printed or placed in command arguments.

```sh
npm run check:all
npm run manage:invite-source -- --preflight
npm run upload:api
npx wrangler d1 migrations list mons-link-profile-games --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 migrations apply mons-link-profile-games --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run promote:api -- --version-id <candidate-version-id>
npm run smoke:api -- --base-url https://api.mons.link
```

Confirm only the reviewed additive migration is pending before applying it. The candidate initially reads and writes the retained RTDB source under the new control; no dual-write mode is introduced. Confirm it is the sole 100% deployed API version. Keep `workers_dev` and preview URLs disabled. Reuse completed validation for unchanged source.

Before freezing, the operator inventories every cursor page of `mons-link-event-progress` instances. It rejects any nonterminal instance, including waiting, paused, queued, running, or rollback work, and fails closed on incomplete pagination. A Workflow version ID is not treated as a Worker candidate ID. Do not terminate or recreate Workflows merely to make this check pass: inspect their durable state and reconcile the concrete instance first. Existing completed instances, pending outboxes, Queue backlog, class names, and payloads remain unchanged. No withdrawal Workflow operation is required.

Use one owned mode-0700 directory outside the repository throughout the attempt. Its maintenance file records the exact candidate, gate generations, and each prior state before any gate changes. Freeze first gates events, then sessions, and finally invite writes. Each gate transition atomically rejects unfinished work. If a request arrives between the status read and the SQL update, the freeze fails safely and can be retried after that request finishes.

```sh
npm run manage:invite-source -- --freeze --directory /secure/invite-source --candidate-version-id <candidate-version-id>
npm run manage:invite-source -- --status
npm run manage:invite-source -- --export --directory /secure/invite-source
npm run manage:invite-source -- --import --directory /secure/invite-source
npm run manage:invite-source -- --activate --directory /secure/invite-source --candidate-version-id <candidate-version-id>
```

Export streams the complete unfiltered shallow invite-key inventory into a protected SQLite spool, then reads bounded groups of source records. Four concurrent reads preserve deterministic page order; completed mode-0600 pages and manifests are immutable and resumable. Import uses bounded parameterized batches, never overwrites a conflicting row, and requires the same frozen writer epoch. Do not enumerate only active, visible, profiled, or historically indexed games. Deleted-auth players, abandoned invites, private invites, historical rematches, and event games remain covered.

Activation performs a fresh full verification: it compares the entire normalized source with every destination record, checks exact key coverage and row count, rechecks all frozen generations and candidate deployment, and repeats the complete Workflow audit. It persists this proof immediately before atomically advancing the invite authority from RTDB epoch 0 to D1 epoch 1 while gates remain frozen. A separate `--verify --directory /secure/invite-source --candidate-version-id <candidate-version-id>` remains available for isolated rehearsal or diagnosis; the routine cutover does not reread the source through both commands. Retained Firebase records are never a fallback. After activation, do not promote a pre-cutover source writer or revert the epoch; repair forward with a D1-aware build.

While frozen, run the standard API smoke and read-only metadata, wager, reaction, and presentation checks against dedicated or existing paired invites. Confirm private-invite access and linked-login ownership with current authenticated fixtures when available; do not depend on expired fixtures. Verify D1 source failure cannot become a missing invite or an empty snapshot. Preserve the DO namespace, subscriptions, revision counters, and shared alarm. No frontend, Firebase rules, trigger configuration, or namespace release is needed.

```sh
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:invite-metadata -- --base-url https://api.mons.link --invite-id <paired-invite-id>
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <paired-invite-id>
npm run manage:invite-source -- --resume --directory /secure/invite-source --candidate-version-id <candidate-version-id>
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:invite-lifecycle -- --base-url https://api.mons.link
```

Resume restores only gate states changed by this attempt, preserving prior freezes. Verify create/join, linked-login access, private invites, rematches and replay with isolated fixtures, plus unchanged live moves, surrender, timer fences, and metadata/wager/reaction/presentation reconnect. Exercise automatch and event transition recovery in isolation so checks cannot match real waiting players or announce unsolicited events. Record the import count/digest, active epoch, exact API version, and restored control states. Finish once required checks pass; no post-success observation window is added.

For a repair after activation, validate and deploy a D1-aware repair as the sole 100% API version, then run `--resume --directory /secure/invite-source --candidate-version-id <repair-version>` with the same evidence directory. Adopting the repair version requires all three gates frozen and affected work drained; it preserves the original candidate, activation, and import evidence. Completion receipts use `resumed-<candidate-version-id>.json`, preserving earlier receipts. Interrupted resumes check only gates still awaiting restoration, so traffic in reopened scopes does not block the remaining gates.

`smoke:invite-lifecycle` creates fresh temporary anonymous sessions and its own manual invite, so it needs no preexisting token or fixture. It verifies create/join/rematch/end receipt replay, metadata HTTP and authenticated WebSocket delivery, legal Firebase move writes, API surrender/replay and opponent observation, direct status-write and timer-rule denials, and absence of the new invite in Firebase after D1 activation. Before the surrender rules cutover, pass `--surrender-rules-pending` to omit only the direct status-write denial probes. It then closes the series and deletes its temporary Auth accounts. It never calls automatch, rating, prize, event, or Telegram endpoints. An optional `--output /secure/unique-report.json` writes a new mode-0600 report exclusively; use a new path for each run.

Before activation only, `--abort --directory /secure/invite-source --candidate-version-id <candidate-version-id>` discards this attempt's unused D1 import and restores its own gate changes. A partial freeze before import can be aborted while source work remains unfinished, allowing that work to recover on the unchanged RTDB authority. Staged-data cleanup requires the same frozen generations and completed-work proof. The protected evidence remains; begin a later attempt in a new directory. Aborting activated D1 storage is rejected. The older automatch, login-discovery, and wager migration source operations also reject retained Firebase invite scans after activation; their status commands remain available.

### Account-link game discovery cutover

The cutover completed on September 8, 2026: 9,664 resolved game mappings across 2,681 Firebase player records were verified and activated in D1. API version `51cc6aa9-7bab-4ab7-b788-33705f4049cc` includes the follow-up fix that lets ordinary session writes reach their existing journal. Use this version or a later capture-aware build for rollback; earlier cutover builds incorrectly rejected ordinary game creation. Current source requires active D1 discovery and has no Firebase discovery fallback. Later compatible changes use the routine API release path. The steps below document the initial staged cutover.

This additive migration moves only account-link match-key discovery and historical invite resolution into `PROFILE_GAMES_DB.login_match_discovery`. Live matches, timer claims, Firebase Auth, and invite source metadata remain in Firebase. Canonical ownership and existing profile-link jobs remain in `PROFILE_DB`. Catch-up retains its exact request/cursor guards and reads bounded D1 pages after activation; invite recomputation still reads the retained gameplay source.

Prepare and validate migrations `0014_login_match_discovery.sql`, `0015_login_match_discovery_control.sql`, and `0016_login_match_discovery_completion_guard.sql`, the capture-aware API, runtime tests, operator rehearsal, and a private artifact directory first. Upload the validated capture candidate, apply the additive migrations, and promote its explicit Version ID to 100%. No frontend, Firebase rules, trigger configuration, Queue pause, Workflow restart, or global write freeze is needed. The existing automatch persistence backend must already be D1.

Use the existing `CLOUDFLARE_API_TOKEN` process environment and an explicitly selected private Firebase service-account credential file. Keep credentials and artifacts outside the repository, with owned mode-0700 artifact directories and mode-0600 files. The operator does not print player IDs, match IDs, or credential contents. Run the same exact deployed capture Version ID throughout the cutover:

```sh
npm run manage:login-match-discovery -- --status
npm run manage:login-match-discovery -- --preflight --directory /secure/login-match-discovery --candidate-version-id <capture-version-id>
npm run manage:login-match-discovery -- --export --directory /secure/login-match-discovery --firebase-credentials /secure/firebase-service-account.json
npm run manage:login-match-discovery -- --import --directory /secure/login-match-discovery
npm run manage:login-match-discovery -- --verify --directory /secure/login-match-discovery --firebase-credentials /secure/firebase-service-account.json --candidate-version-id <capture-version-id>
npm run manage:login-match-discovery -- --activate --directory /secure/login-match-discovery --firebase-credentials /secure/firebase-service-account.json --candidate-version-id <capture-version-id>
npm run manage:login-match-discovery -- --status
```

`--preflight` is the explicit capture-enforcement step. It verifies the exact sole 100% API deployment, disabled Worker subdomain/previews, the D1 automatch backend, and the installed completion guard before recording immutable capture version/time evidence and enabling that guard. An old session writer cannot complete an uncaptured transition: its completion batch rolls back, retaining the pending intent for capture-aware scheduled recovery. Capture remains enforced through export, import, and activation. Do not replace the capture version or disable the guard during the cutover.

Export streams the unfiltered shallow `/players` and `/invites` inventories, then each player's shallow match-key inventory. It never combines `shallow` with Firebase query filters. A protected local SQLite spool bounds memory and sorts all keys by UTF-16 code units before publishing immutable pages of at most 200 keys. Every source stream must reach a valid end; malformed, oversized, truncated, or duplicate input leaves the export incomplete. Interrupted source streams restart from the beginning; completed immutable inventories and player exports are reused. All RTDB players are inventoried, including anonymous users and records whose Auth account has been deleted. Existing canonical profile owners or visible navigation rows are not a substitute for that inventory.

The manifest accounts for every exported player and match key with counts, page digests, completion proofs, and capture generation. Historical resolution preserves exact invite-ID priority, then accepts only one existing rematch-prefix candidate. Missing and ambiguous resolutions remain explicit evidence and index rows. Import uses bounded parameterized batches, does not overwrite conflicting resolved mappings, and may coexist with idempotent capture. A resolved capture may supersede an unresolved historical backfill; source verification ignores timestamps/provenance except when proving concurrent additions came from capture.

Before publishing an inferred rematch-prefix mapping, export checks pending session creations, captured mappings, and fresh exact-invite evidence so a concurrent new invite cannot be mistaken for an older prefix. Interrupted exports reuse already-published pages unchanged after checking their row identities against the source inventory.

Verification streams the current source again and requires every current key to have compatible D1 coverage, every baseline key to remain accounted for, and every additional backfill row to belong to the immutable export. Concurrent source additions must have capture provenance. It also checks completed session-transition creations since capture began, requires pending transitions to reconcile, and records verification evidence. Activation repeats these checks, then atomically selects D1 only if enforcement, candidate, import proof, and journal conditions still match. Retry interrupted import/verification/activation with the same directory; conflicting mappings, disappearing baseline keys, incomplete inventories, or pending transitions are failures to reconcile rather than reasons to discard evidence.

After activation, run the standard API smoke and the affected authenticated read-only profile/navigation checks. Verify account-link catch-up with anonymous-before-link, alternate-login, rematch, and merge-cleanup fixtures in isolation. Release the final API with the temporary Firebase discovery adapter removed and verify its catch-up path. Keep gameplay and Queues running and finish once the required checks pass; no observation window is added. Retain the capture guard and immutable source evidence. A rollback must preserve capture and pending jobs; never restore a pre-capture version or disable enforcement.

### Automatch persistence cutover

The initial cutover completed on September 7, 2026 with API version `ba859dbe-c595-4b4d-8ec0-766b094e4065`. Production uses the active D1 backend. Later compatible automatch fixes use the routine API release path; the controls below belong to the initial migration or a concrete recovery requirement.

Automatch queue entries, Telegram lifecycle sources, both shared session projection outboxes, operation receipts, and receipt expiration markers move together into `PROFILE_GAMES_DB`. Manual joins and rematches share these outboxes and receipts. Live matches, timer claims, invite source metadata, and Firebase Auth stay in Firebase. The existing API Worker, Queues, and Cron own the new stores; no extra resource is provisioned.

This is coordinated maintenance because old and new writers must not split these records between Firebase and D1. Prepare the additive migrations, control-aware API candidate, migration tooling, Firebase rules, full validation, and protected evidence directory first. The source manifests and pages contain private waiting-player records; keep them outside the repository in a mode-0700 directory and mode-0600 files. Use `npm run manage:automatch-state -- --help` for exact operator arguments.

Release the control-aware candidate at 100% while its tracked D1 control still selects RTDB. Its versioned lease writes stamp the acquiring owner; apply migration `0013_game_session_writer_owner_fence.sql` before releasing that API and enabling a new RTDB staging fence. Unstamped or inherited-owner RTDB leases remain legacy evidence; do not backfill them. Already activated D1 deployments retain compatibility with existing generation-two leases. Stage its exact version through the migration tool, which fences new legacy acquisitions and records the staging time. Preserve old lease and release evidence until its effects are reconciled. Compatible control-aware candidate refinements preserve that original fenced staging time and version evidence while updating the exact candidate required for export and activation. Continue necessary implementation verification and migration rehearsal during normal service. Before freezing, require old Cron/Queue invocations to have retired and legacy HTTP effects to be reconciled. Do not infer retirement from sampled logs, equal successive reads, or a version promotion alone; do not add an artificial observation window while service is frozen.

Deploy the reviewed database rules that deny browser-admin automatch writes and preserve the immutable `sessionCreation` field on existing match records, including legacy records without that field. Pause only `mons-link-profile-game-projection` and `mons-link-telegram-projection`, preserving their prior pause states. Freeze the automatch persistence admission gate; this blocks new affected persistence writes and receipt cleanup without freezing live moves, timers, authentication, or unrelated stores. Require admitted work to complete and uncertain effects to be reconciled. Queue backlog may remain.

Export all six roots through the migration tool; import the immutable pages; verify complete record equality, source stability, pending-entry references, the exact candidate version, and the unchanged freeze generation. Activate D1 only while frozen and after verification. Resume only controls changed for this migration. The backend activation is one-way; retained Firebase records are evidence, never a fallback. After activation, repair forward with a D1-aware version.

Staging RTDB writes record their exact patch scope or each conditional transaction attempt before dispatch. An uncertain response retains its admission and proof; only a proven pre-dispatch abort or durably recorded completion can release automatically. Inspect retained work with `npm run manage:automatch-state -- --inspect-admissions --directory /secure/automatch-admission-audit`, then use `--reconcile-admission --evidence /secure/audited-admission.json` after establishing request completion and comparing every recorded source target. Legacy untracked writes also require audited scope evidence. Never delete admissions merely because they are old.

These commands remain available for D1-backed admissions after invite-source activation. D1 `prepared` rows still require completed-request and scoped source evidence; that phase does not prove no work was dispatched. If the investigation proves no source work was dispatched, set `noSourceEffects: true` with `sources: []`, completed-request evidence, and a `scopeEvidence` reference and explanation establishing the empty scope. Recorded source targets cannot be bypassed this way. Canonical D1 receipts and outboxes remain readable, while retired Firebase invite evidence stays blocked.

Before D1 activation, `--resume` discards unactivated import data and verification metadata while keeping the gate frozen until cleanup finishes. It preserves the staging evidence and export files. Retry the same command after an interruption, then use a fresh export for the next cutover. Activated D1 data is never reset.

The runtime journal reserves the invite and affected owners beyond execution-lease expiry. Match creation uses conditional writes that never overwrite an existing match. Invite metadata updates preserve unrelated fields and retain a monotonic `sessionTransition` marker. D1 finalization commits queue/source/outbox/receipt changes once. Retries and the existing five-minute Cron recover the same persisted operation; never remove a pending intent or its reservations as routine cleanup.

Verify imported waiting players and operation replay with read-only protected fixtures. Test full start/match/cancel behavior in isolation so production checks cannot match a test profile with a real waiting player or send unsolicited Telegram messages. Run the standard API smoke and affected read-only metadata checks after activation, then finish once required checks pass; no post-success observation is needed.

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

The command validates the public HTTP snapshot and anonymous viewer, connects with `mons-invite-metadata-v1`, checks the snapshot revision and heartbeat, then repeats the connection to verify reconnect delivery. Its existing thirty-second command timeout detects stalled checks and does not set an overall release deadline. The smoke never selects a game automatically, sends a gameplay mutation, or logs invite contents. Serving reads initializes or refreshes the derived Durable Object snapshot without changing the canonical invite.

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

`mons-link-profile-games` D1 is the sole source for the public historical-match endpoint. A missing snapshot returns `pair: null`; the endpoint never reads RTDB or persists data on a read miss. There is no RTDB recovery or backfill path. Releases affecting history or its projections must pass the authenticated `--require-history` smoke using a known non-null D1 snapshot. Prepare its fixture before promotion and include this check in the required live verification; for coordinated maintenance, run it before canonical writes resume. Unrelated catalog or frontend changes do not require this fixture.

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

## Wager state D1 cutover

This one-time migration moves `invites/{inviteId}/wagers/{matchId}` and `invites/{inviteId}/matchesWagerResolutions/{matchId}` into `PROFILE_DB.invite_wager_states`. Wager reservations, mining balances, and transfer receipts already live in D1. The storage change requires one continuous freeze because an old RTDB writer and a new D1 writer must never settle the same wager against different source state. Freeze canonical profiles and wager reservations and pause only `mons-link-telegram-delivery`, which carries settlement retries. Other Queues, event storage, invite metadata, and live Firebase match synchronization retain their existing controls. This targeted procedure replaces the generic historical drain and observation periods above: inspect actual admissions and leases, perform the required checks, and use no artificial waits or post-success monitoring window.

Prepare the complete validation gate, rules dry run, protected smoke fixtures, and API candidate before freezing. Record the current deployed API version, the candidate Version ID, both writer controls, and the settlement Queue's pause state. Reuse validation for unchanged source. No frontend, trigger, or Durable Object namespace release is needed. Wager-state export/import/verify/activate require `CLOUDFLARE_API_TOKEN` in the process environment for parameterized D1 requests; supply no token through arguments or files in the repository. Preflight can use the existing Wrangler authentication and needs no new schema, freeze, or output directory.

```sh
npm run check:all
node --experimental-strip-types scripts/deploy-firebase.ts --project mons-link --dry-run
npm run manage:wager-state -- --preflight
npm run smoke:wagers -- --base-url https://api.mons.link --prepare-fixtures --fixture /secure/wager-smoke.json
npm run upload:api
```

Create the smoke fixture's parent directory with mode `0700` before preparation. Preparation writes a mode-`0600` fixture containing locally generated Solana signing seeds, Firebase refresh tokens, two new test-profile IDs, and three manual invite IDs. It funds each profile through its supported first-rock mining request for exactly one dust and leaves a pending host proposal in the cancellation invite. The other invites isolate decline and settlement because canceled or declined reservation lineages cannot be reused. No user-funded profile, D1 seed, blockchain transaction, rating update, automatch, event, or external announcement is used. Retain the fixture for every later phase; do not replace it after an uncertain request.

Start the single freeze and pause settlement delivery only if it was active:

```sh
npm run manage:profile-canonical -- --freeze
npm run manage:wager-reservations -- --freeze
npx wrangler queues pause-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:profile-canonical -- --status
npm run manage:wager-reservations -- --status
```

Require zero wager admissions and active gameplay leases before continuing. Investigate any expired or uncertain admission; recover it only after its request has finished and its RTDB and D1 effects have been reconciled. A timeout or expired lease alone does not prove that an old write finished. Preserve consumed reservation tombstones, pending settlements, balances, and transfer receipts throughout the procedure.

Retire Firebase browser writes before export, including the nested admin grants, then apply the reviewed profile migration. Confirm the pending migration list contains only the expected wager-state migration `0016` before applying it. Retained Firebase records and their parent invite-read policy remain unchanged.

```sh
node --experimental-strip-types scripts/deploy-firebase.ts --project mons-link
npx wrangler d1 migrations list mons-link-profiles --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npx wrangler d1 migrations apply mons-link-profiles --remote --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run manage:wager-state -- --status
```

Export into a new protected directory outside the repository. The same directory resumes an interrupted export or import; never edit its manifest, source pages, or baseline evidence. `--firebase-credentials /secure/firebase-service-account.json` optionally selects a protected service-account file for preflight, export, verify, and activate; otherwise the CLI checks `GOOGLE_APPLICATION_CREDENTIALS` and then the existing Firebase CLI login. Pass only the credential file path; never log its contents or authentication tokens. The export preserves complete internal wager state and resolution markers, including historical matches and pending operations. Unknown nested wager fields are retained; a malformed nonobject wager aggregate must be reconciled before export.

```sh
npm run manage:wager-state -- --export --directory /secure/wager-state-cutover
npm run manage:wager-state -- --import --directory /secure/wager-state-cutover
npm run manage:wager-state -- --verify --directory /secure/wager-state-cutover --candidate-version-id <candidate-version-id>
```

Verification must prove complete source-to-D1 equality and unchanged reservation, balance, and transfer-receipt baseline, with all writer controls still frozen and admissions and leases drained. Review only counts, digests, and sanitized failure details in terminal output; retain the protected evidence directory. Resolve a mismatch before activation. Do not introduce a bridge version, dual writes, a Firebase fallback, or a temporary unfreeze to make progress.

Activate D1 and immediately promote the exact verified candidate to 100% while the same freeze remains in effect. Activation repeats full source, destination, and baseline verification before advancing the immutable writer epoch from `0` to `1`. Old code cannot acquire a compatible wager admission after activation. Confirm the explicit candidate is the only deployed API version before resuming any writes.

```sh
npm run manage:wager-state -- --activate --directory /secure/wager-state-cutover --candidate-version-id <candidate-version-id>
npm run promote:api -- --version-id <candidate-version-id>
npm run manage:wager-state -- --status
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-wager-frozen-read --require-wager-storage-version --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run smoke:wagers -- --base-url https://api.mons.link --frozen-read --fixture /secure/wager-smoke.json
npm run smoke:invite-metadata -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

While frozen, verify current and historical wager HTTP snapshots, wager WebSocket delivery and reconnect, and unchanged invite metadata, reaction, and presentation behavior. Confirm stored proposals, agreements, internal settlement state, and markers still match the import evidence. Confirm Firebase rules are deployed and preserve reads while rejecting legacy writes. A failure leaves the same freeze and Queue pause in place for repair; after activation, repair forward with D1-aware code and never promote a pre-cutover writer or revert the epoch.

When those checks pass, resume reservations, then canonical profiles, and restore settlement delivery only if this cutover paused it. Preserve any freeze or Queue pause that predated the work.

```sh
npm run manage:wager-reservations -- --resume-d1
npm run manage:profile-canonical -- --resume
npx wrangler queues resume-delivery mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-wager-frozen-read --auth-token-fixture /secure/api-smoke-auth.json --smoke-profile-fixture /secure/api-smoke-profile.json
npm run smoke:wagers -- --base-url https://api.mons.link --active-lifecycle --fixture /secure/wager-smoke.json
```

The lifecycle opens wager sockets before each mutation, checks broadcasts and reconnect snapshots, replays each action, and verifies released reservations plus a single dust transfer from guest to host. The guest surrenders through the API, with replay and stored-field preservation checks; no rating request is sent. A failed phase preserves its completed-step journal so an explicit rerun continues with the same identities, invites, and operation lineages. Keep historical wagers and live moves usable. Record the active epoch, deployed Version ID, verification digests/counts, and final control states, then finish. Keep the original Firebase records and protected export and smoke fixtures. Later compatible wager changes use the routine API release path.

For an existing paired invite, HTTP/WebSocket snapshot and reconnect verification also has a read-only mode:

```sh
npm run smoke:wagers -- --base-url https://api.mons.link --read-only --invite-id <existing-paired-invite-id> --auth-token-fixture /secure/api-smoke-auth.json
```

Omit the auth fixture to verify public spectator reads. Each HTTP request and socket operation has its own deadline; there is no overall smoke-phase or release deadline and no artificial observation wait.

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

Recover only an expired admission whose original request has finished and whose uncertain effects have been reconciled. Resume requires admissions and gameplay leases drained. Include `mons-link-telegram-delivery` in coordinated maintenance because it delivers settlement retries. Validate frozen reads and stale-client rejection while canonical writes remain frozen, then verify normal wagering after resume. Keep writes frozen and repair forward on failures; canonical balances, reservations, and wager settlement records must stay consistent.

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

`mons-link-profile-game-projection` owns rating, invite, automatch, event, and profile-link projections. `mons-link-telegram-projection` owns automatch, rating, and event Telegram projections. Profile-link catch-up jobs are written atomically with canonical ownership changes in `PROFILE_DB`; their Queue dispatch is recovered by the scheduled D1 sweep. Automatch and manual-session outboxes live in `PROFILE_GAMES_DB`; a durable transition journal coordinates create-only RTDB match effects with canonical invite metadata, session receipts, and outboxes. Event transitions retain their own D1 intents and use idempotent invite-effect receipts after the invite-source cutover. Event and rating outboxes remain in their owning D1 databases. Do not purge Queues or delete pending jobs or outboxes during incidents.

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

Prepare the frontend before production promotion: `preview` performs an isolated build, its client checks, and a candidate upload. Avoid running the same build/checks separately first. Verify a unique frontend preview when the affected behavior works on that origin; existing Firebase referrer restrictions may block preview sign-in. In that case, use local fixture rendering for visual checks and verify the real affected page on `mons.link` after promotion. Keep the existing auth restrictions.

When the frontend depends on new API behavior, promote and smoke the API first. Promote the prepared frontend's exact tested version without rebuilding, then verify the affected live page. Allow provider propagation and necessary rechecks to complete without an overall release deadline:

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
