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
- `PROFILE_DB.profile_login_owners` is authoritative for Worker login UID to canonical profile ownership. Firebase `profileId` claims are no longer read or mirrored by runtime code; existing stored claims remain untouched. RTDB profile links are retained historical records with no runtime reads, writes, or cleanup.
- `cloud/workers/api/release.env` stays empty so release commands never load developer environment files.
- Encrypted secrets stay in Cloudflare; required names are declared in the API Wrangler configuration.
- `EVENT_DB` owns event records, participants, prize selections, visible assigned prizes, progress markers, and event-specific projection state. Canonical active match records and timer claims live in the existing invite Durable Object, which also provides live delivery. `PROFILE_GAMES_DB.invite_sources` owns invite metadata after the one-way invite-source activation.
- `INVITE_REACTIONS` owns voice/sticker reaction delivery through one SQLite-backed `InviteReactions` Durable Object per invite. Firebase reaction records are retained but no longer written after the final rules cutover.
- The same Durable Object owns revisioned live match presentation and frozen historical appearance. Canonical match records retain immutable emoji/aura seeds; Firebase originals remain historical evidence. The [appearance authority migration](#match-appearance-authority-migration) adds D1 registration and reconciliation evidence; it needs no extra Worker or namespace.
- The same object serves revisioned host/guest gameplay snapshots over `mons-match-sync-v1` and matching HTTP snapshots. The same object owns canonical match records and timer claims. One shared alarm reconciles subscribed matches every second and metadata/wagers every five seconds. Preserve its canonical rows, imported records, revisions, and existing namespace.
- The same object serves revisioned invite/lobby/rematch metadata over a separate subscription. Invite source records use `PROFILE_GAMES_DB.invite_sources` after activation; retained RTDB records are evidence only.
- The same object serves invite-wide public wager snapshots over HTTP and `mons-invite-wagers-v1`. `PROFILE_DB.invite_wager_states` owns wager source records and resolution markers; invite metadata uses the gameplay D1 source after activation. Metadata and wagers share composed source reads and reconcile every five seconds through the object's shared alarm while either channel has subscribers; their revisions, admission limits, and broadcasts remain separate. Retained RTDB wagers never provide a read or write fallback.
- `cloud/firebase.json` owns the final deny-all Realtime Database rules. Firestore, Firebase Functions, and canonical event-data RTDB paths are retired.

Authenticate Wrangler locally or provide `CLOUDFLARE_API_TOKEN` through the process environment. Never put credentials in command arguments, source files, release files, or logs.

## Active-match storage cutover

Completed September 11, 2026. API version `bad5a3f4-2301-47a8-9fb5-42968e5b3c4b` serves 100% of traffic. Match authority is `durable`, active at epoch 2, with no remaining migration admissions or operator lock. Events are active in D1 at freeze generation 5. The existing `InviteReactions` namespace is unchanged; no frontend release or new Worker namespace was needed.

The verified import covers all 9,821 Firebase match records, 9 timer claims, and 4,629 invite rooms. Twelve previously documented nonparticipant records remain exact read-only D1 legacy records; there are no legacy claims or unresolved playable mappings. Source and verification digests match `486123eba6e315ccd0d0c911bdcd706a3f823ccfb03a8217d6db15aa70aec6aa`. Current route counts can increase through ordinary gameplay; immutable import counts remain in `match_state_control` and the protected manifest. Absolute timer deadlines, unknown record fields, creation markers, source records, and delivery revisions were preserved.

Migration `0024_match_state.sql` retains the one-way authority control, exact actor/match routes, legacy records, import receipts, and admission/reconciliation evidence. Canonical records and timer claims live inside the existing invite Durable Object. Moves, surrender, timer claims, and pending downstream effects commit locally; external D1 effects retain their idempotency keys and recover through the shared alarm without connected sockets. Public HTTP and WebSocket contracts remain unchanged. Activated reads never fall back to Firebase.

The coordinated source phase used preparation version `fc0f7e02-2f0b-488a-8818-66c3adb1c8af`. New gameplay/event work was drained, six incompatible event-progress instances were paused, and exact recovery evidence reconciled retained admissions before the final freeze. The dedicated gameplay service-account role lost `firebasedatabase.instances.update` and retained `firebasedatabase.instances.get`. Previously issued and fresh runtime tokens both returned read 200 and write 401 against an isolated probe. The temporary impersonation grant was removed. Firebase source records and unrelated permissions were preserved.

Every room was imported, read back, and activated while writes remained frozen. Verification and activation each repeated the complete source readback. A provider response failure during room activation was resumed from matching stored receipts; global authority changed only after complete coverage and digest verification. The strict candidate was then promoted while match and event controls remained frozen, allowing read verification without admitting new writes.

Workflow definitions require publication separately from Worker traffic promotion. The final event-progress Workflow version is `8c8101f7-3ede-4a67-bbbb-9fc49ff826e9`; all six retained instances were recreated under it with their original IDs, payloads, outbox bytes, and scheduled times. The withdrawal Workflow definition is `25c622ca-c8cb-42a3-a99d-55d693cdf040`; its existing terminal instances were untouched. Workflow version IDs are distinct from Worker version IDs. After verifying the strict deployment, frozen read fixtures, Workflow handoff, authority evidence, zero admissions, and owned operator lock, the guarded final resume reopened match control and released the lock. Event control then resumed in D1. Auth, profiles, prize withdrawals, and Queue delivery remained active throughout.

The deployed strict version has no `FIREBASE_RTDB_URL`, `GAMEPLAY_SERVICE_ACCOUNT_EMAIL`, or `GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY` binding. Runtime Firebase transport and credential access are removed. The tested deny-all Realtime Database rules are deployed; privileged operator reads still match retained source evidence. Preserve the IAM write fence, Google accounts and keys, source records, historical receipts, and private exports. After activation, repair forward with Cloudflare-compatible code; never restore Firebase authority or one database independently.

Validation passed the repository gate using the successful unchanged preparation lanes and strict replacement lanes, including 664 client tests, 1,011 API Node tests, 612 Worker runtime tests, 538 portable cloud tests, and 6 rules emulator tests. Final tooling validation passed 335 tests after the operator and smoke updates, for 3,166 passing tests across the validation lanes. Later focused checks covered activation resume, bounded source-read retries, and the updated lifecycle smoke. The Workflow publication helper also passed unit tests and a read-only production preview. Typechecks, lint, formatting, generated bindings, and upload dry-run passed. Production API smoke, all 18 isolated durable-gameplay checks, and four existing event/wager/history checks passed. The game checks include cumulative moves, takebacks, timer deadline replay, surrender, rematches, reconnects, source-access denial, and session cleanup. Immutable history matched before and after the cutover. Protected manifests, source hashes, IAM evidence, deployment metadata, Workflow handoff, and final readback are retained in `/private/tmp/mons-match-cutover-JKZOlI`.

Current operations are read-only:

```sh
npm run manage:match-state -- --status
npm run manage:match-state -- --inspect-admissions --directory <original-private-directory>
```

Completed migration write phases are retired and fail before credentials or source access. Preserve all control and evidence tables. Do not clear unexplained admissions or locks, reset authority, overwrite failed-import evidence, or restart the migration to force progress. Subsequent compatible releases use the routine release path below.

## Retired migration operators

The Firebase-to-D1 and appearance cutovers below are complete. The operator package commands remain available for current status and recovery, with this supported surface:

| Command                            | Supported operations                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `manage:match-state`               | `--status`, `--inspect-admissions` after completed durable activation                 |
| `manage:wager-state`               | `--status`                                                                            |
| `manage:login-match-discovery`     | `--status`                                                                            |
| `manage:match-presentations`       | `--status`                                                                            |
| `manage:event-transition-receipts` | `--status`                                                                            |
| `manage:invite-source`             | `--status`, `--inspect-admission`, `--reconcile-admission`                            |
| `manage:automatch-state`           | `--status`, D1 `--freeze`/`--resume`, `--inspect-admissions`, `--reconcile-admission` |

Retired migration arguments fail before provider clients or credentials are accessed. Status commands are read-only and need no Firebase credentials. Current D1 recovery preserves existing evidence formats; explicit historical source inspection may read exact retained Firebase proofs with separate read-only operator credentials. It never scans retired Firebase invite data. Other D1 maintenance operators and Firebase rules tooling retain their existing behavior.

Retain historical SQL migrations, activation proofs, stored receipts, source exceptions, and protected evidence. A compatible code cleanup needs no schema migration, write freeze, Queue pause, Workflow restart, or trigger update.

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

When Workflow code or its dependencies change, publish the affected owned definitions after promoting the exact Worker version and before uploading another candidate. The helper preserves current Workflow settings and schedules, checks that the selected Worker is both the latest upload and the version serving 100% of traffic, and records the resulting distinct Workflow version IDs. Cloudflare's Workflow publication API has no atomic Worker-version pin, so do not run concurrent Worker uploads or promotions during this command. The helper rechecks both conditions around publication and fails closed on a mismatch. Its dry-run makes read-only provider requests. Omit `--workflow` to select both configured definitions when their shared dependencies change:

```sh
npm run publish:api:workflows -- --version-id <worker-version-id> --workflow mons-link-event-progress --dry-run
npm run publish:api:workflows -- --version-id <worker-version-id> --workflow mons-link-event-progress
```

This publication updates code for new instances and does not modify Queue delivery, Worker Cron, routes, or existing instances. Compatible releases preserve running instances on their original versions. A concrete incompatible state change requires the coordinated handoff described in its migration procedure.

The dated release sections below retain historical behavior and evidence. The active-match storage cutover above supersedes their Firebase match storage, scoped-write, and credential requirements.

## Firebase migration-path retirement

Released on September 10, 2026 with API version `48c5d916-3b6f-468e-b8ab-cfe1d2064708` serving 100% of traffic, replacing `c0d768e9-6394-4902-acea-ea6b93e75bd4`. The cleanup removes retired Firebase automatch/invite backends, their admission audit, v1 pending session transitions, appearance seed fallbacks, and completed migration operations. Current D1 status, maintenance, and admission recovery remain available, including exact active-match Firebase evidence reads. Existing v2 payload serialization is unchanged; completed historical rows and both event-receipt formats remain intact. All 37 deployed bindings, including 16 encrypted secrets, runtime settings, handlers, and disabled Worker subdomain/previews were verified unchanged.

Validation completed all repository gates with 3,048 tests under Node 24 and Java 21, including 559 Worker runtime tests and 272 tooling tests. The first full run identified legacy runtime fixtures; those fixtures were updated, the complete runtime suite and affected static checks passed, and successful unchanged validation lanes were reused. Production API smoke, 18 isolated lifecycle checks, 15 appearance checks, three existing-match appearance/reconnect checks, and three unchanged historical-pair checks passed. Temporary series were ended, sockets closed, and sessions revoked. Final status checks confirmed unchanged authority and retained source-exception evidence. No schema, frontend, Firebase rules, trigger, namespace, write-freeze, or Queue-pause operation was needed. Release evidence, source fingerprints, and verification reports are retained in `/private/tmp/mons-firebase-retirement-N0aLah`.

## Invite-reader and credential cleanup

Released on September 10, 2026 with API version `7b3dcdfe-227f-40c2-a28c-ba347cb39c52` serving 100% of traffic, replacing `a445685e-972b-4407-a902-c38bdfee73cd`. Invite readers now compose canonical invite and wager D1 records directly, preserving activation checks, frozen reads, and session-transition guards. Google token exchange requires explicit credentials; unscoped RTDB clients require credentials or a token provider, while scoped move/surrender clients retain gameplay credentials. The four retired Firebase identity/Telegram credential names are removed from runtime requirements. All 37 deployed bindings, including all 16 encrypted secrets, and runtime configuration were verified unchanged.

The complete validation gate passed all 3,228 tests, including 567 Worker runtime tests. Production API smoke, metadata/wager/reaction/presentation snapshots, heartbeats, reconnects, and presentation HTTP reads passed. The first production lifecycle attempt closed a match socket after join with `1011; Match source unavailable`; its cleanup succeeded, and a fresh isolated attempt passed all 18 lifecycle checks without another code change. Existing diagnostics did not identify the first closure's cause. The baseline and both production attempts ended their series and revoked all six temporary sessions. Invite and automatch controls remained active on D1. No frontend, schema, Firebase rules, trigger, service-account, or encrypted-secret changes were made, and no write freeze or Queue pause was applied. Source hashes, validation output, provider proofs, and verification reports are retained in `/private/tmp/mons-firebase-cleanup-release`.

## Auth/recovery Firebase cleanup

Released on September 10, 2026 with API version `d9deacf7-eaaf-45b2-9db5-aadaf9f0b122` serving 100% of traffic. Cleanup commit `80529839e` removes identity's Firebase client construction and routes prize recovery through a D1-only store with mandatory event-lease guards. Public contracts, schemas, shared credentials, gameplay storage, and Queue payloads are unchanged. The candidate preserves the already-deployed prize catalog from API version `0f093d66-d08b-4adf-8912-88efc9ff9efd`; unrelated frontend styling was not released.

The complete validation gate passed all 3,089 tests, including 503 Worker runtime tests. Runtime coverage rejects Firebase configuration access and outbound requests from default identity/recovery construction and verifies lease loss, frozen writes, retired prize copying, replay, and withdrawal races. Production API smoke and 12 authenticated profile-sync, compatibility-alias, linked-method, replay, and refresh checks passed against the same dedicated test profile. Its temporary session was revoked. No migration, trigger update, write freeze, Queue pause, or post-success observation was needed. Source hashes, baseline reconciliation, deployment proof, and validation evidence are retained in `/private/tmp/mons-auth-recovery-release-JttrZu`.

## Cloudflare browser session cutover

Frontend follow-up `c7e26d32-e548-4dde-898f-a92c38c55f34` was released on September 10, 2026 from commit `a73121312`. It preserves deferred logout intent, clears retired profile caches, offers retry after storage failures, and reloads the current route when another tab supersedes logout. Smoke tooling renews API credentials and validates every wager reconnect snapshot. Validation passed 3,076 repository tests and 12 isolated browser regressions, plus formatting, lint, typechecks, generated bindings, and the API dry run. Preview and production checks verified session persistence across reload, shared two-tab identity, logout reload and cleanup, replacement-session sharing, and rejection of retired refresh credentials. All temporary sessions were revoked, and live entry assets match the validated build. The frontend serves 100% of traffic. API version `92690fe4-84b8-463d-a009-e25fd3b35fcb` remains active: all 48 backend changes match its retained source manifest, no auth migrations are pending, the signing secret is present, and production API smoke passed. Evidence is retained in `/private/tmp/mons-session-final-release-EFDALD`.

Frontend follow-up `740feef3-dc9b-423c-a8aa-33e71f973287` uses conservative monotonic token deadlines so device clock errors do not block sign-in or delay renewal. Logout recovery now includes preliminary storage failures. Lifecycle verification renews match and metadata sockets while preserving snapshot validation. All 650 client tests, 376 tooling tests, and five isolated real-browser regressions passed before release; the final sanitized-close-diagnostic test brings focused lifecycle coverage to 55 passing tests. Production browser checks passed with clocks ten minutes ahead/behind and after clock changes, and live assets match the validated build. The frontend serves 100% of traffic; the API is unchanged. Live lifecycle verification remains unsuccessful: the existing API closes the host match socket after join with `1011; Match source unavailable`. Three isolated attempts cleaned up their test sessions. This server closure is not treated as a passing expiry-renewal check. Evidence is retained in `/private/tmp/mons-session-clock-fixes-o5CFRt`.

Frontend follow-up `b8ff1fcb-095d-4316-a196-7a375593d8e7` invalidates credentials when browser storage is cleared and reloads a stopped tab when a newer session supersedes logout cleanup. Storage observations are ordered locally without a schema change. Wager verification now renews tokens and reconnects expired sockets during long runs; lifecycle cleanup retries transient session-revocation failures. All 639 client tests, 369 tooling tests, and three isolated real-browser regressions passed. Production browser checks verified that old cached/refresh handles fail after IndexedDB clearing, no old refresh request is issued, and a replacement session survives reload and is shared across tabs. The frontend serves 100% of traffic; the API version is unchanged. Evidence is retained in `/private/tmp/mons-session-fixes-oUwtBY`.

Released on September 9, 2026 with API version `92690fe4-84b8-463d-a009-e25fd3b35fcb` and frontend version `9e6ec443-6547-4b44-be47-cd27802dbe63`, each serving 100% of traffic. The complete validation gate passed all 3,016 tests. The frontend notice follow-up passed all 632 client tests and an isolated real React/Chrome regression that verifies the message survives until the sign-in panel displays it. Production checks verified session replay, refresh, revocation, rejection of a previously valid Firebase token, permanent precreation revocation, and recovery of the same linked profile from a new session. All 18 gameplay lifecycle checks and 18 real-browser checks passed, including native IndexedDB persistence, two tabs, live moves/reconnect, logout outbox survival and recovery, and absence of browser Firebase requests. Live entry assets matched the validated build. Controlled games were ended, recorded test sessions revoked, and the temporary legacy Firebase guest deleted. Evidence is retained in `/private/tmp/mons-session-release-dYWgqJ`.

This release replaces browser Firebase Auth with persistent sessions in `AUTH_STATE_DB.anonymous_sessions` and five-minute Worker-issued access JWTs. It has an immediate cutoff, no Firebase token bridge, and no inactivity expiry. Linked users sign in again to recover their existing profiles; unlinked old guest identities cannot be recovered. Existing Firebase users, D1 profile ownership, active RTDB matches, and backend service-account credentials remain intact. Earlier release sections below describe their historical authentication behavior.

Prepare the additive `0004_anonymous_sessions.sql` migration, `SESSION_JWT_KEYS` secret, complete `npm run check:all` validation, both builds, adapted smoke fixtures, and both candidate uploads before cutover. Session credentials and signing keys belong only in protected files or Cloudflare secrets, never logs or source. The keyring format is documented in [cloud operations](../cloud/README.md#browser-sessions). Do not expose new sessions until the migration and keyring are ready. Preserve the migration and keyring in subsequent repairs.

Promote the exact API candidate to 100%, verify create/refresh/revoke and Firebase-token rejection, then promptly promote the prepared frontend without rebuilding. Already-loaded old clients cannot authenticate and may need a manual reload; the new frontend clears old identity-bound state and prompts linked users to sign in again. API-first promotion necessarily creates a short interval in which the old frontend cannot authenticate. Do not retain dual token acceptance to hide this interval.

Run the adapted `smoke:api` and isolated `smoke:invite-lifecycle`. Tooling now creates and revokes Cloudflare sessions. Protected token-only fixtures contain `{ "accessToken": "<Cloudflare-JWT>" }`. For API smokes that can outlast the token, also include `uid`, `sessionId`, numeric `accessExpiresAtMs`, and `refreshToken` from that same session; the smoke renews access before protected requests and retains the existing session. Refreshable wager fixtures use version 2 and must be prepared afresh or reauthenticated with their existing generated test wallet. Cloudflare tokens must never be sent to RTDB. Lifecycle source reads use the exact public match paths; live direct-write probes verify unauthenticated denials, while Firebase emulator tests independently verify authenticated rules and timer fences.

Run the browser regressions with `node --test test/sessionLifecycle.browser.mjs test/sessionResetNotice.browser.mjs`, setting `MONS_PLAYWRIGHT_PATH` to an installed Playwright module and `MONS_BROWSER_EXECUTABLE` to Chrome when they are not available through normal module/browser discovery. They start isolated local Vite servers and intercept every external request.

Verify real-browser guest creation, reload persistence, linked-profile recovery, two-tab logout, gameplay/reconnect, and no browser Firebase Auth requests. Use controlled clocks for five-minute expiration tests; do not add an observation window. Keep writes and Queues active, retain the Durable Object namespace and snapshots, and deploy no Firebase rules or triggers unless separately changed. After sessions are issued, rollback only to session-compatible versions or repair forward. Record promoted IDs and verification evidence after the checks pass.

## Live match delivery release

Frontend follow-up `ea0edde3-36a1-4929-bc1e-280ee22b4c4c` ingests both actor histories before applying terminal updates, preserving the last move when a combined snapshot also contains surrender. Regression coverage includes both colors, delivery orders, historical views, and session changes. All 596 client tests and 41 lifecycle-tool tests passed. The strengthened production lifecycle smoke passed all 18 checks and now rejects reconnect snapshots below the previously verified revision. Temporary accounts were deleted. The frontend serves 100% of traffic and its production assets match the tested build; API version `2fb35b2d-520f-43b7-8201-a4fa4a01d534` remains unchanged. Evidence is retained in `/private/tmp/mons-match-sync-fixes-ZADmGx`.

Released on September 9, 2026 with API version `2fb35b2d-520f-43b7-8201-a4fa4a01d534` and frontend version `dc469b34-4472-45db-9494-ee0a044ef6ca`, each serving 100% of traffic. The complete validation gate passed 2,891 tests. The production API smoke and all 18 isolated lifecycle checks passed. Three-session browser checks verified actual moves, takebacks and cumulative replay, spectator HTTP recovery, socket reconnect and reload, visible timers, surrender, rematch navigation, reversed colors, and moves in the new match, with no browser RTDB requests or runtime exceptions. A focused rematch check completed verification after correcting the browser driver's response-body handling during navigation; deployed application code remained unchanged. Production HTML and application bundles matched the uploaded candidate. All temporary test series were ended and their anonymous sessions deleted; fixture wagers remained empty. Release evidence and the combined verification report are retained in `/private/tmp/mons-match-sync-release-npYzjh`.

Live match delivery moves browser subscriptions to `mons-match-sync-v1` and revisioned HTTP snapshots in the existing `InviteReactions` namespace. RTDB remains the canonical active-match store and retains the atomic `matchTimerClaims` fence; Firebase Auth and current database rules remain unchanged. The derived match snapshot table is additive and uses the existing SQLite storage. No D1 migration, namespace lifecycle change, backfill, trigger update, write freeze, or Queue pause is required.

Run the complete validation gate for the shared protocol and stateful channel changes. Cover mutation notifications, admission/read races, missed notifications, source failures, hibernation, reconnects, and the shared alarm alongside existing reaction v1/v2, presentation, metadata, and wager behavior. Prepare the frontend through `npm run deploy -- preview`, which performs its build/checks and uploads a candidate. Record the current API/frontend versions and upload the validated API candidate before promoting either Worker. API version preview URLs remain disabled and unavailable for this Durable Object Worker.

Promote the explicit API Version ID to 100%, then run:

```sh
npm run smoke:api -- --base-url https://api.mons.link
npm run smoke:invite-lifecycle -- --base-url https://api.mons.link --output /secure/unique-live-match-report.json
```

The lifecycle smoke creates its own manual invite and two temporary anonymous sessions. It opens a match socket while the host waits, requires the guest's creation to arrive live, and verifies host, guest, and public spectator snapshots. It checks cumulative moves/takebacks, reordered requests, exact replay, surrender, host/guest rematch creation, and reconnect snapshots plus heartbeat. Socket checks must pass against direct RTDB source evidence before HTTP snapshot reads can refresh the object. Existing move/status/timer write-denial probes remain active. The smoke never calls automatch, rating, prize, event, or Telegram endpoints; it ends the same series, closes every socket, deletes both temporary accounts, and writes an exclusive mode-0600 report containing fixture IDs and passed checks.

Promote the prepared frontend's exact Version ID without rebuilding. In an isolated game, verify two-player and spectator updates, rapid moves/takebacks, surrender and timer displays, rematch navigation, and same-match reload/reconnect. Confirm browser network activity uses the Cloudflare match socket and HTTP recovery with no Realtime Database subscription or fallback. Preserve existing auth referrer restrictions; when a preview cannot authenticate, complete live browser verification on `mons.link` after promotion.

Keep gameplay and Queue delivery active. Preserve existing per-request and per-socket timeouts, allow necessary propagation and retries, and finish when the standard and affected-feature checks pass without an observation window. Record the promoted Version IDs and verification evidence after the release is verified.

A previous frontend remains compatible because RTDB reads and canonical state are preserved. Once the new frontend has been served, retain an API version supporting its match socket and HTTP snapshot routes even if the frontend is rolled back: already-open new tabs continue running. Repairs must preserve the existing namespace, derived match revisions, socket attachments, and other channel behavior.

## Firebase profile-claim mirroring retirement

Frontend follow-up `b2239c52-b9b7-4bd5-bc97-c214e662e9e7` retries temporary profile-restoration failures with backoff capped at 30 seconds and immediate reconnect/visible-page wakeups. Retries pause while offline or hidden, stop for authoritative absence, and cannot overwrite a newer sign-in. All 565 client tests passed. Isolated production browser checks simulated sync and profile-lookup outages and verified automatic recovery in the same document through both timer and reconnect paths, without new Firebase Auth requests. Live assets matched the candidate; the API version remained unchanged. Evidence is retained in `/private/tmp/mons-auth-retry-HqIsnu`.

Released on September 9, 2026 with API version `433dbdab-a6c8-4144-acfc-72becb5bcfc0` and frontend version `7e533a66-1a20-4d96-8054-d36c2058b257`, each serving 100% of traffic. The complete validation gate passed 2,797 tests. Production API checks verified both sync URLs repeatedly, authentication requirements, unchanged stored Firebase claims, and completed catch-up jobs remaining absent. Isolated browser checks verified canonical sign-in restoration, reload, and cross-login invite entry with the correct actor and role, without legacy sync calls, claim-specific token refreshes, fixture mutations, or browser errors. Production HTML and application bundles matched the uploaded frontend candidate. Evidence is retained in `/private/tmp/mons-claim-retirement-HnncXT`.

Canonical profile synchronization uses `POST /auth/profile/sync`; `POST /auth/profile-claim/sync` remains a compatibility alias with the same response, authentication, maintenance gates, and rate-limit bucket. Both routes read canonical D1 ownership and preserve profile repair, username assignment, recovery barriers, and dispatch of existing profile-link catch-up jobs. Runtime code no longer reads, creates, updates, or deletes Firebase `profileId` claims. Existing stored claims remain untouched; Firebase anonymous sessions and normal token refresh continue.

Prepare both candidates and the complete validation gate before promotion. Verify existing protected authentication fixtures, record their canonical ownership and catch-up progress, and record the current Worker versions. Promote the API first, run the standard API smoke, and exercise both sync routes repeatedly. Verify canonical responses, preserved catch-up request IDs/cursors, completed jobs remaining absent, and unchanged Firebase claims. Promote the prepared frontend version, then verify sign-in restoration, reload, and cross-login invite entry without claim-specific token refreshes. Keep the new API route available for the updated frontend.

This is a routine compatible code release. No account sweep, D1 migration, Firebase rules change, secret deletion, trigger update, write freeze, or Queue pause is required. Preserve retained Firebase records and normal scheduled recovery. Finish after the required API and browser checks pass; record the deployed versions and evidence location below.

## Firebase profile-link retirement

Released on September 9, 2026 with API version `7aa7d0e4-e03f-402b-8dcf-225f1e3a2bbc` serving 100% of traffic and the tested Firebase database rules deployed. The complete validation gate passed after updating its outdated profile-shadow documentation assertion. Production checks verified repeated authenticated claim synchronization, preserved token claims, completed catch-up jobs staying absent, and the retained RTDB profile copy remaining unchanged. Deployed rules matched the tested candidate; anonymous and authenticated reads of retained invite, profile, reaction, and wager paths were denied while Worker reads succeeded. The isolated lifecycle verified moves, takebacks, replay, rematches, surrender, and timer protections; live subscriptions received nine updates across three match subscriptions from both temporary players. The test series was ended and both temporary Auth sessions deleted. Evidence is retained in `/private/tmp/mons-profile-copy-retirement-xpnZjo`.

This release retires runtime access to `players/{uid}/profile` and direct client access to those links and all `invites/{inviteId}` descendants, including retained reactions and wagers. Firebase Auth and `profileId` token claims remain active. Claim repair reads canonical D1 ownership and dispatches only the existing profile-link catch-up job; it never reconstructs or restarts work from an RTDB copy. Canonical ownership transactions already preserve previous-owner cleanup atomically. Existing RTDB values remain untouched, and live match subscriptions, scoped moves, surrender, and timer-claim fencing remain active.

Before promotion, verify that profile migration `0015_finalize_profile_migrations.sql` is applied, canonical profile control is active, and invite-source control is active with backend `d1`. No schema migration, backfill, frontend release, resource provisioning, or trigger change is required. Keep writes and Queue delivery running under the routine release policy.

Run `npm run check:all`, prepare protected authentication fixtures, record the existing API deployment and Firebase rules, and upload the validated API candidate. Promote its explicit version to 100%, then run the standard API smoke and authenticated profile-claim synchronization checks. Verify repeated synchronization preserves existing catch-up generations/cursors or completed-job absence.

Deploy the tested rules through `npm run deploy:firebase -- --project mons-link`. Verify that direct invite/profile reads are denied while Worker profile/invite APIs and two-player move/subscription behavior succeed. Compare the deployed rules with the tested candidate and record the released API version and verification results. Older clients that read these retired paths must update. Retain the new API and restrictive rules as the baseline for subsequent repairs; finish once required checks pass.

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

Create mode-`0600` smoke fixtures outside the repository: a refreshable auth fixture with `accessToken`, `uid`, `sessionId`, `accessExpiresAtMs`, and `refreshToken` from the existing linked session, and a profile fixture containing `{"loginId":"<alternate-login-uid>","profileId":"<canonical-profile-id>","invite":{"id":"<existing-invite-id>","actorUid":"<stored-host-or-guest-uid>","role":"host"},"historicalMatch":{"inviteId":"<existing-historical-invite-id>","matchId":"<existing-historical-match-id>"}}`. Use `guest` when appropriate. The token subject must equal `loginId`; `actorUid` must be a different login owned by the same D1 profile. Use a known non-null D1 historical snapshot. The frozen-reservation smoke also needs that linked participant.

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

The cutover completed on September 8, 2026. All 4,572 existing invite records were imported and verified with source/import digest `e72239f6dd17623eff01ff52d42fab283000ccb507e74e5394c06fb2bc186b0b`, then activated at invite-source epoch 1 on API version `df89c91c-8bf2-4277-99fb-fbee1c7fc837`. Invite, session/automatch, and event gates were restored to their prior active states; Queue delivery continued throughout. Full repository validation and production API, metadata, wager, reaction/presentation, and isolated game lifecycle checks passed. The lifecycle check confirmed new invitations have no RTDB metadata shadow, preserved live match writes and timer rules, and removed its temporary Auth sessions. Protected evidence is retained in `/private/tmp/mons-invite-cutover-T2Wqvt`. Subsequent compatible releases use the routine release path and retain D1 invite authority.

For an orphaned invite-source admission, `npm run manage:invite-source -- --status` includes the total count and up to 100 admission tuples, ordered by creation time and UUID. Runtime acquisition/release failure logs also identify the admission. Inspect exactly one with `--inspect-admission <UUID> --directory /private/admission-evidence`. This saves an immutable inspection and a separate `-evidence.json` template in a user-owned 0700 directory outside the repository, with 0600 files. Preserve the inspection and complete the template's `requestFinishedAtMs`, `completionEvidence.reference` and `explanation`, and `sourceReconciliation` fields. The source proof requires `scopeComplete: true`, a reference and explanation covering all original request effects and receipts, and `sources: [{inviteId, digest}]` for every affected invite. Each digest is SHA-256 of the shared `canonicalJson(normalizeInviteSource(value))`, or `canonicalJson(null)` for an absent source, read from the current authority. Set `noSourceEffects: true` with an empty source list only when the investigation proves no source work was dispatched, such as a confirmed acquisition failure before the callback started. A request timeout, elapsed time, or zero pending intents alone proves neither completion nor reconciliation.

Run `npm run manage:invite-source -- --reconcile-admission --evidence /private/admission-evidence/<completed-evidence-file>.json`. Recovery checks the exact inspected admission tuple and unchanged writer controls, current source digests, and absence of session intents/resources/locks, event intents (including uncertain/dead records), and event leases. Other admission rows remain untouched and do not prevent separate reconciliation of multiple crash orphans. Recovery never changes gates or expires work; it requires D1 authority and supports active or partially frozen gates. After an uncertain delete response, retry the same evidence file and retain its matching protected pre-delete artifact and completion receipt. A missing row without matching pre-delete evidence is rejected. Terminal output contains identifiers and digests, never source payloads.

The initial source scan, import, activation, and migration gate-restoration commands are retired. The existing `invite_sources` records, activation evidence, and historical SQL migrations remain intact. Retained Firebase invite data is never a fallback. Current session transitions publish invite metadata and operation receipts in D1 while preserving create-only Firebase match writes.

### Account-link game discovery cutover

The cutover completed on September 8, 2026: 9,664 resolved game mappings across 2,681 Firebase player records were verified and activated in D1. API version `51cc6aa9-7bab-4ab7-b788-33705f4049cc` includes the follow-up fix that lets ordinary session writes reach their existing journal. Use this version or a later capture-aware build for rollback; earlier cutover builds incorrectly rejected ordinary game creation. Current source requires active D1 discovery and has no Firebase discovery fallback. Later compatible changes use the routine API release path. The initial migration operations are retired.

`npm run manage:login-match-discovery -- --status` reports authority, capture enforcement, and row counts by provenance/resolution. Preserve the capture guard, immutable source evidence, pending catch-up jobs, and current event-discovery repair. Active match reads remain in Firebase; discovery reads use D1. Historical migrations `0014` through `0016` remain unchanged.

### Automatch persistence cutover

The initial cutover completed on September 7, 2026 with API version `ba859dbe-c595-4b4d-8ec0-766b094e4065`. Production uses the active D1 backend. Later compatible automatch fixes use the routine API release path; the retained maintenance controls require a concrete recovery need.

Automatch entries, Telegram lifecycle sources, session projection outboxes, operation receipts, and receipt expiration markers use `PROFILE_GAMES_DB`. Live match records and timer claims retain their Firebase authority. Initial staging, source scans, imports, activation, RTDB reset, and legacy admission reconciliation are retired. Preserve the existing tables, activation evidence, and historical migration files.

`npm run manage:automatch-state -- --status` reports current control and admission counts. For a concrete D1 repair, use `--freeze --candidate-version-id <currently-deployed-version>`, then `--resume --candidate-version-id <repair-version>` after promoting the repair. These commands retain deployment checks, guarded gate changes, and unresolved-work checks. They never reset activated data and are not part of routine releases.

Inspect retained work with `npm run manage:automatch-state -- --inspect-admissions --directory /secure/automatch-admission-audit`, then use `--reconcile-admission --evidence /secure/audited-admission.json` after establishing request completion and comparing every scoped source target. Keep evidence outside the repository in an owned mode-0700 directory with mode-0600 files. Never delete admissions merely because they are old.

Admission inspection and reconciliation support D1-backed admissions only. D1 `prepared` rows still require completed-request and scoped source evidence; that phase does not prove no work was dispatched. If the investigation proves no source work was dispatched, set `noSourceEffects: true` with `sources: []`, completed-request evidence, and a `scopeEvidence` reference and explanation establishing the empty scope. Recorded source targets cannot be bypassed this way. Canonical D1 receipts and outboxes remain readable, while retired Firebase invite evidence stays blocked.

Current D1 admission recovery may read exact `players/{uid}/matches/{matchId}` Firebase proofs using the existing explicit credential provider. Retired Firebase invite scans and RTDB admission recovery are rejected. The runtime journal retains resource reservations beyond execution-lease expiry. Match creation never overwrites an existing match; D1 finalization publishes invite/source/outbox/receipt changes once. Retries and the five-minute Cron recover the same v2 operation. Completed historical rows remain intact.

`npm run smoke:invite-lifecycle -- --base-url https://api.mons.link` defaults to durable storage and creates temporary anonymous sessions and its own manual invite. It checks create/join/rematch/end replay, HTTP and authenticated WebSocket snapshots, moves/takebacks/replay, surrender, timer deadline replay, reconnects, and retired Firebase read/write denial. It ends its series and revokes its sessions. It never calls automatch, rating, prize, event, or Telegram endpoints. An optional `--output /secure/unique-report.json` writes a new protected report; use a unique path for each run. Explicit `--match-storage rtdb` is retained only for historical preparation tooling, not current production.

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

### Match appearance authority migration

Follow-up API version `a445685e-972b-4407-a902-c38bdfee73cd` was released on September 10, 2026 at 100%. Socket admission refreshes committed actors inside the Durable Object and rechecks if an actor updates during the lookup, then sends the snapshot and attaches the socket without another asynchronous gap. Additive migration `0023_match_presentation_insert_guards.sql` blocks authority replacement and conflicting registration inserts while preserving duplicate retries. All 1,514 API tests and five archive SQL tests passed, followed by standard API smoke, 15 live appearance checks, and three existing-match reconnect checks. Production trigger definitions match the reviewed migration; authority evidence and all twelve retained source exceptions are unchanged. Test sessions were revoked and the test series ended. No trigger configuration change, write freeze, or Queue pause was needed. Evidence is retained in `/private/tmp/mons-appearance-fixes-lX5ZbE`.

Activated on September 10, 2026 at 12:48:58 UTC with API version `e5903394-e6ff-4b0f-82b7-2724a853b7a5` serving 100% of traffic. Additive migrations `0021_match_presentations.sql` and `0022_match_presentation_source_exceptions.sql` are applied, and the one-way appearance control is `durable`. The existing EventProgress Workflow registration was refreshed to version `c6f1d8d2-b9d2-4007-952a-554e9d16b640` for new instances; existing pinned instances and settings were preserved. No frontend, Firebase rules, namespace replacement, write freeze, or Queue pause was needed.

The complete baseline contains 9,762 physical match records across 2,740 players: 9,750 canonical actor records were initialized and registered, six linked-login copies were retained as alias evidence, and six incompatible records were archived separately with their complete original JSON. None of the twelve nonparticipant copies grants live registration. Fresh verification covered 9,766 records across 2,742 players, including four acknowledged creations during capture, and checked all 9,754 live registrations before activation. Nine metadata-only guest references remained absent and retained host-only presentation. Firebase originals and immutable gameplay snapshot seeds remain intact. Migration `d6285c90-df10-4cbf-835c-148bc3613c7d` binds source digest `72e80cc717249c591d8a867683aaa7a095321cb675c6db599435e119268f7002` and verification digest `4ce3a8415ec3009d609d94765ebd009c62efaecbca93916373b6775d65c30d37`.

The complete final validation gate passed all 3,183 tests, including 527 Worker runtime and 445 operator/tooling tests. After activation, standard API smoke, 15 isolated appearance checks, 18 gameplay lifecycle checks, and three existing-match read-only checks passed. These verified creation, joins, pending/ensured/accepted rematches, appearance updates, operation replay, reconnects, gameplay snapshot compatibility, and cleanup. Separate production checks confirmed exact canonical membership for the linked-login fixture, all nine unchanged host-only presentations with absent guest snapshots, six preserved archives, and no live exception registrations. Valid signed migration import and readback requests both return `410 migration-retired`. Test series were ended, sockets closed, and temporary sessions revoked. Protected source manifests, resumable receipts, provider/version proofs, and verification reports are retained in `/var/folders/cz/m4rxwj814l35cw0zm3yht7180000gn/T/mons-match-appearance-release-7NhKLv`. Subsequent repairs preserve Durable Object authority with no Firebase appearance fallback.

`npm run manage:match-presentations -- --status` reports durable authority, actor registration counts, and retained alias/archive evidence counts. Initial capture, inventory, import, verification, and activation commands are retired. Historical SQL migrations and all protected manifests, receipts, source exceptions, Firebase originals, and Durable Object live/frozen state remain intact.

Current creation requires actor registration and immutable Durable Object seed evidence. HTTP reads, v2 socket admission, avatar projection, and archive capture require registered Durable Object appearance; missing registered state fails retryably. There is no pre-durable Firebase seed fallback. Public APIs, v1/v2 reaction protocols, existing RPC methods, and the retired migration endpoint contract are unchanged.

After a relevant API release, verify isolated waiting-host/join/rematch appearance initialization, emoji/aura updates and replay, paired v2 reconnect snapshots, and unchanged historical appearance. Use existing protected fixtures or temporary manual games; do not create public events or send announcements.

### Read-only reaction smoke

Choose an existing paired invite explicitly. This smoke uses no auth fixture, publishes no reaction, and never selects a game automatically:

```sh
npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>
```

The smoke connects as a spectator with `Origin: https://mons.link`, validates the versioned snapshot and invite membership of any reaction entries, sends only the application heartbeat, disconnects, and repeats to verify reconnect delivery. Each connection has a ten-second deadline and a 4 KiB message limit; redirects are disabled and output excludes reaction contents. An empty snapshot passes. A pending or missing invite, origin/upgrade rejection, malformed message, missing heartbeat, or premature disconnect fails the command. Run it on the API custom domain after a release affecting reactions; when maintenance paused writes, run it before resuming them. The default `smoke:api` command remains unchanged and never broadcasts reactions to a live game.

Adding `--match-id <existing-match-id>` explicitly selects v2. The smoke requires successful v2 protocol negotiation, validates the selected match's presentation snapshot and any arriving presentation events within a 16 KiB envelope, and repeats after reconnect. The larger response bound accommodates maximum-length legacy match IDs; presentation mutation bodies retain a 4 KiB limit. The smoke never sends a presentation mutation, logs cosmetic values, or imports historical records. The server reads only registered Durable Object state and never initializes appearance from Firebase while serving a snapshot. Omitting `--match-id` retains the v1 reaction-only smoke.

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

`historical_match_read_failed` is the handled public-history 503 signal; `--status error` covers uncaught Worker failures and limits, not handled 5xx responses. Any required-history smoke failure, archive conflict, recurring Queue failure, or new history 5xx requires freezing affected writes and repairing forward. Active match synchronization uses canonical invite Durable Object records and timer claims.

## Event transition receipt D1 cutover

Released September 9, 2026 with API version `6260dc9f-98cb-48b3-8eff-550f528254c0` serving 100%. All three historical V1 receipts were imported and verified against the unchanged Firebase source; receipt authority is active in D1. Both preserved event-progress Workflow instances use version `3fafbe01-1d83-4e11-ae21-163681bc4b31`, retaining their original IDs, payloads, outbox timestamps, and September 13 sleeps at 16:00 and 20:00 UTC. Event writes resumed in D1 at freeze generation 4, and unrelated writer gates and Queue delivery were unchanged.

The complete validation lanes passed 2,946 tests, including 470 Worker runtime tests and 354 tooling tests. Authenticated read-only production API/current-event/ended-event checks passed before the cutover and after event writes resumed. The operator handled deletion/startup propagation through saved evidence and bounded readback; no public test event or announcement was created. Protected exports, validation logs, deployment proof, Workflow evidence, and the final readback are retained in `/private/tmp/mons-event-receipts-UKVKxM`.

`0019_event_transition_receipts.sql` adds immutable effect acknowledgments and a one-way receipt control in `mons-link-profile-games`. The new `event_transition_receipts` rows acknowledge completed Firebase match effects; the existing `invite_event_effect_receipts` rows separately acknowledge the atomic D1 invite/discovery commit. Do not delete either receipt stage or reinterpret historical V1 receipts as executable transitions.

`npm run manage:event-transition-receipts -- --status` retains authority, maintenance counts, deployed-version/Workflow visibility, and operator-lock reporting. Initial migration freeze/export/import/verification/activation, rollback, Workflow recreation, and gate-restoration commands are retired. Preserve all receipts and historical migrations, including the existing operator-lock table. An unexpected retained lock requires investigation using its protected evidence; elapsed time alone does not establish completion. Current event incidents use the event maintenance and recovery operations below.

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

Recover only a named expired admission after confirming its request finished. Never bulk-delete admissions. Pending transitions retry while preserving their fences; fix the implementation or unavailable dependency forward, and do not detach, delete, or dead-letter the intent. Successful transition receipts are immutable coordination evidence in `PROFILE_GAMES_DB.event_transition_receipts`; there is no scheduled receipt deletion. Do not restore `EVENT_DB` alone because event state, gameplay D1 receipts, and Durable Object match effects must remain consistent.

Validate current and ended events through the authenticated `--require-events` smoke. Its profile fixture includes `"events":{"currentId":"<scheduled-or-active-event-id>","endedId":"<ended-prize-event-id>","selectionPrizeId":"<selected-prize-id>","assignedPrizeId":"<assigned-prize-id>"}`. Use a visible, unwithdrawn assignment owned by that profile; add `selectionEventId` if the selection belongs to a different event. After verification, resume events and dependent stores, resume only Queues paused for maintenance, and repeat production smokes:

```sh
npm run manage:events -- --resume-d1
npm run manage:event-prize-withdrawals -- --resume
npm run manage:profile-canonical -- --resume
```

## Wager state D1 cutover

Wager source authority was activated in D1 on September 7, 2026, at epoch 1 with API version `4f7c875b-8821-42c6-b206-803a36e5b17a`. Activation evidence records 171 wagers, 275 resolution markers, and 276 imported aggregate rows, with equal source/import digest `a299bba08d68ab6794ae51c7f1f160af6b37059dbe460c6b21ef4ac3bcb71450`. The verified profile baseline digest is `dc2bccad355a89137a899286eb834202f2b453d85b76ab596ca31edff3b3470a`. These immutable import facts remain visible in the D1 activation record; current counts can increase through ordinary gameplay.

`PROFILE_DB.invite_wager_states` owns wager proposals, agreements, settlement state, and resolution markers. The existing reservation, balance, transfer, and queued-recovery contracts remain unchanged. Retained Firebase wager and resolution records never provide a fallback.

`npm run manage:wager-state -- --status` reports maintenance state, activation evidence, and current destination counts. The initial preflight, export, import, verification, and activation commands are retired. Current wager repairs use the reservation and canonical-profile maintenance operators. Preserve migration `0016`, stored records, and protected historical evidence.

For an affected routine release, use the existing read-only wager smoke with an explicit paired invite and protected auth fixture where required. The separate isolated `smoke:wagers` fixture workflow remains available for wager mutation changes. It uses dedicated test profiles and their own mined dust, preserves its credential fixture across retries, and never calls automatch, rating, event, or announcement endpoints.

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

`mons-link-profile-game-projection` owns rating, invite, automatch, event, and profile-link projections. `mons-link-telegram-projection` owns automatch, rating, and event Telegram projections. Profile-link catch-up jobs are written atomically with canonical ownership changes in `PROFILE_DB`; their Queue dispatch is recovered by the scheduled D1 sweep. Automatch and manual-session outboxes live in `PROFILE_GAMES_DB`; a durable transition journal coordinates create-only Durable Object match effects with canonical invite metadata, session receipts, and outboxes. Event transitions retain their own D1 intents and use idempotent invite-effect receipts after the invite-source cutover. Event and rating outboxes remain in their owning D1 databases. Do not purge Queues or delete pending jobs or outboxes during incidents.

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

Firebase releases update only Realtime Database rules. The final candidate denies all client reads and writes, including admin claims and retired scoped move/surrender overrides. Publish it only after strict durable match authority and Cloudflare reads are verified through the active-match cutover above. Retained source records and separately authorized privileged read-only IAM access remain intact.

```sh
npm run deploy:firebase -- --project mons-link --dry-run
npm run deploy:firebase -- --project mons-link
```

## IAM and secrets

The final Worker has no `FIREBASE_RTDB_URL`, `GAMEPLAY_SERVICE_ACCOUNT_EMAIL`, or `GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY` bindings and performs no default Firebase reads or writes. Firebase identity, Telegram, and gameplay service-account credentials are no longer runtime requirements. Retain historical Google accounts, keys, and protected evidence; removing a runtime binding does not authorize account or key deletion. Explicit admin/operator source inspection uses separately authorized read-only IAM access to the retained database. Deny-all Security Rules do not remove privileged IAM access, so preserve the cutover write fence and do not restore runtime database write privileges.

Keep X, Telegram bot credentials, Helius, Google private keys, and the event-prize wallet as encrypted Worker secrets. The `TELEGRAM_QUEUE_BRIDGE_SECRET` operator credential is also provisioned in a protected local file; see [cloud operations](../cloud/README.md#telegram-recovery-and-announcements). Automatic Sunday Mons prize announcements use the existing bot credentials and require no announcement bridge secret. Routine releases reuse existing encrypted values.

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the tracked auth maintenance switch. Change it through candidate upload, explicit Version ID promotion, and custom-domain smoke; do not create Dashboard overrides.

`mons-link-auth-recovery` is the only auth recovery Queue. Delivery is idempotent, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record. Auth origins are enforced in code.
