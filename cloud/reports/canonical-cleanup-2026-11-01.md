# Canonical cleanup — 2026-11-01

The final safeguard pass completed at 2026-11-01T10:28:20.594567+00:00. Both previously excluded rooms now have verified cleanup receipts, and the five HTTP admission records have been retired with their unknown outcomes preserved. The final API is `c522b04f-068e-4d30-be60-62469ed20358`.

The original online cleanup completed at 2026-10-31T23:39:38.118Z. All 5,007 approved Durable Objects passed physical cleanup and readback. The application remained active at generation 3, data epoch 1, with no global maintenance or canonical Queue pause.

| Release evidence                   | Version                                |
| ---------------------------------- | -------------------------------------- |
| Final source candidate A           | `4166dbf5-64ad-403e-91c2-d28243ada185` |
| Secret-removal candidate B         | `a8f9d23c-4111-435e-ae22-ba253f29cfef` |
| Original final API C               | `7cd39d3f-0262-4e56-8e90-e157b3d79d15` |
| Temporary read-only inspector      | `8ce346fa-87a1-4283-839b-fbcc9627aa5f` |
| Inspector secret-removal candidate | `440179d7-e84a-4461-a931-f0ca6fd0bc75` |
| Initial inspection restoration     | `32886da9-db7d-4b36-bca6-951c8069a38a` |
| Scoped cleanup candidate           | `2f2173db-7559-4ddc-a893-2c8884f02288` |
| Cleanup secret-removal candidate   | `d68e7507-6d73-496c-85aa-6b4bc499d5bd` |
| Final API, serving 100%            | `c522b04f-068e-4d30-be60-62469ed20358` |
| Event progress Workflow            | `5dda8b1b-a6ee-4a30-a14f-163b03ad399c` |
| Prize withdrawal Workflow          | `131f771f-f6b4-4c07-b739-ed9e39589ba0` |

## Final safeguards and closure — 2026-11-01

Nine additive migrations installed permanent safeguards across the six D1 databases. Thirty exact request-retirement markers reject subsequent writes by the five retired identities; the central database also rejects new child admissions and identity reuse. Central activation checked the five original rows and zero current-generation RPC admissions atomically. After all six database fences were verified, one native D1 batch preserved the original records in an immutable retirement receipt and removed precisely the five active rows. Their recorded outcome is **write authority retired; business outcome unknown; accepted independent work preserved**. Invocation termination and successful business completion are not claimed.

Three immutable room registries and 42 INSERT/UPDATE guards cover 21 typed reference tables. Current code rejects either retired room before mutation-lock acquisition and retries generated automatch collisions. The writer review verified historical direct and opaque identity closure, exclusion from generation-3 activation, and subsequent write paths. It did not infer safety from substring searches or expand exclusions to shared player balances.

The two rooms independently matched preserved source and discarded staging records. Each executed raw storage reads in the qualified new implementation, establishing local writer replacement under [Cloudflare's storage uniqueness guarantee](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness). Every purge and receipt operation additionally verified the six live schemas and controls, exact retirement markers and receipt, and the three room registries. No caller-supplied exclusion assertion was accepted.

The selective transactions removed **62 obsolete table instances and 29 payload rows** across the two rooms. Each transaction checked the exact original state, removed only its approved footprint and committed an immutable cleanup receipt. Seven existing protected control/receipt tables per room and their retained guards were preserved; one cleanup-receipt table was added per room. Closed generation-2 controls, protected state digests and namespaces were retained. No KV keys or namespace were deleted. Both subsequent receipt calls returned `already-purged` with the expected protected-state digests.

The temporary endpoint, RPC capability and production secret were removed, and the local temporary secret was deleted. Final code matched the validated permanent bundle. Live room receipt readbacks occurred before capability removal; their protected response artifacts were verified afterward. The 5,007 earlier cleanup receipts were checked as historical archives, not represented as new live storage reads.

All required validation lanes passed after correcting two historical test fixtures that applied later migrations to older schemas. The initial `check:all` invocation did not pass unchanged in one run. The final lanes cover 1,498 client tests, 2,221 API unit tests, 2,382 native tests, 443 tooling tests and 698 shared-runtime tests, plus type, lint, generated-binding and bundle checks. The temporary candidate passed 2,248 API unit cases after its private RPC contract fixture was updated, and 22 focused native cases covering its verifier, inspection and atomic cleanup.

Final production verification passed public API and protected-admin authenticated reads, all 17 isolated gameplay lifecycle checks, six-database safeguard readback, and all 14 retired-endpoint probes. Both retired room IDs returned authenticated 404 responses without creating scoped locks, transitions, invites or mutation receipts. The application stayed active at generation 3, data epoch 1; all six canonical Queues remained unpaused, both Workflow versions remained unchanged, and workers.dev/version previews remained disabled. The persistent admin session and normal authentication policy were preserved.

No global generation change, write freeze, Queue pause, financial adjustment or Firebase operation was performed. Firebase's eligible obsolete-data cleanup remains separately deferred pending account access.

Final protected verification evidence SHA-256: `02e70d54d57906eaf694e1e8152e8cbc90b44839512f8c3f202e8a09abec65e3`.

## Initial publication and inspection — 2026-11-01

Commit `181e5152ae71b4d252183c30548e657f0343d165` published the migration and cleanup to `main` with 1,263 explicitly reviewed paths. The unused recovery inventory was removed from the active working tree after its protected archive was verified. Applied SQL migrations and private exports were preserved; credentials and logs were not committed.

The initial scoped follow-up retained both excluded rooms and performed no additional room deletion. A temporary manifest-bound inspector read both rooms without initializing gameplay or changing controls. Their source exports matched the preserved evidence across 42 tables and 24 rows. Both retained closed generation-2 controls, no alarms or sockets, and stable before/after state. Initially unclassified trigger names were resolved against the historical fence generator.

The dependency scan searched 15 specifically bound room identifiers across all 135 application tables and found only two historical import receipts, which remain protected evidence. The scan alone does not rule out unknown opaque relationships. At that stage, local fences rejected business writes, but complete exclusion of latent privileged writers and new cross-database references had not been established. Transition intents and resource records could precede the room mutation, so the local fence alone did not establish durable exclusion across stores. These unmet prerequisites blocked both purges; no purge capability or new deletion receipt was created. At that stage, the five uncertain HTTP admissions were left intact, with no completion inferred from age.

The inspector and its secret were removed through candidate upload, qualification and promotion. That restored API (`32886da9-db7d-4b36-bca6-951c8069a38a`) was byte-identical to the previously validated baseline, and its configuration matched that baseline without the inspection secret. The local temporary secret was also deleted. The two canonical Workflow versions remained unchanged, all six canonical Queues remained unpaused, and the application remained active at generation 3, data epoch 1.

Restoration verification passed the public API check, protected-admin authenticated history, event and frozen-wager reads, and all 17 isolated gameplay lifecycle checks covering moves, takebacks, replay, timers, rematches, reconnects and temporary-session cleanup. The persistent admin session was preserved. All 14 retired-endpoint probes returned 404, including the inspection endpoint and benign requests naming the old inspector version. Production workers.dev and version previews remain disabled. All 5,007 prior cleanup receipt/readback proofs were revalidated from protected evidence; this follow-up did not perform live bulk reads or repeat their deletion. An initial authenticated invocation mistakenly selected a maintenance-only check requiring frozen profile writes; the active-mode rerun passed without changing production controls.

Firebase cleanup remains deferred until an account can access `mons-link`. Its authorized scope is eligible obsolete data only, not project deletion. Financial records, authentication/revocation state, recovery evidence and protected archives remain preserved.

Follow-up protected evidence SHA-256: `957a7b66218ceb49794ccbadc2a7b0e79e1c33fd54dddbac199bf0a624c27578`.

## Original cleanup results

Removed storage and resources:

| Item                                | Verified result                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Cold D1 source tables               | 60 across six databases                                                                                     |
| D1 timer retirement, migration 0039 | Two empty tables, their exclusive index and eight triggers                                                  |
| Old DO storage                      | 75,712 table instances across 5,002 objects; five additional objects received empty-source cleanup receipts |
| Preserved source export             | 56,006 archived DO rows; exact source/schema expectations were checked before deletion                      |
| Retired source infrastructure       | Six Queues, three DLQs, six consumers and two Workflows                                                     |
| Temporary Workers                   | One read-batch Worker removed; the previously retired profile helper confirmed absent                       |

D1 foreign-key checks passed and applied migration history was retained. The 5,005 timer-handoff rows and 10,791 ownership rows were preserved byte-for-byte. Canonical business records, balances and holds, ownership, sessions/revocations, historical matches, replay receipts, retirement/reconciliation evidence and protected source exports remain retained. Durable Object namespace/class identity, canonical timers, alarms, deadlines, KV, socket attachments and permanent writer/admission safeguards were preserved.

The original pass kept the two approved room exclusions unchanged; no new exclusion was introduced. Five previously captured uncertain HTTP admissions were left untouched, with no completion inferred from age. A retained old rating continuation may fail on obsolete timer cleanup after table retirement; its committed rating and recovery markers remain intact. Historical February recovery can require current request replay, and automatic completion is not claimed.

Public API contracts and authentication policy remain unchanged. The protected persistent admin session was preserved. This cleanup does not refund wagers, resolve withdrawals, resend Telegram operations or restart retired jobs. Google/Firebase project deletion remains outside this cleanup; eligible obsolete-data cleanup is deferred pending account access.

Source and validation:

- The archived baseline contains 2,022 source files; the strict release snapshot contains 1,853 and the final release snapshot contains 1,847. Relative to baseline, 205 paths were removed (including 151 scripts), 30 added and 192 retained paths modified. The final stage separately removed 11 temporary files, added five permanent writer/fixture files and modified 14. The 205 and 11 removal counts are not additive.
- All required strict validation stages passed after correcting three test-only fixtures. The original single `check:all` invocation exited 1; it did not pass unchanged in one run.
- The final candidate passed its affected checks, including 2,217 API unit tests, 2,355 native tests, 16 project-contract tests and independent review.
- Final production checks passed: public API; protected-admin identity and authenticated history/events/frozen-wager reads; a fresh isolated invite/timer/replay/rematch/takeback/socket lifecycle; reaction, metadata and wager socket reads; the read-only withdrawal preflight; and all ten retired-endpoint probes.
- Active wager mutation coverage is reused explicitly from the actual seven-step strict-stage run: 84 wager-related files are byte-identical and permanent writer SQL/guards/mutation digests are preserved. No active wager mutation on final API C is claimed.
- The final API has no temporary cleanup/migration secret bindings. Retired private GET/POST routes returned 404, including benign requests naming excluded old Worker versions. Production workers.dev and version previews remain disabled.
- The read-batch helper deletion was confirmed by provider inventory and settings/version/subdomain 404s. Its historical preview returned Cloudflare error 1101 with HTTP 500 and no application response; that preview is not reported as a 404.

Removed D1 tables:

| Database binding                 | Removed table names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PROFILE_GAMES_DB                 | `automatch_entries`, `automatch_live_tickets`, `automatch_pending_enqueues`, `automatch_telegram_projection_outbox`, `automatch_telegram_projection_outbox_recovery3`, `automatch_telegram_sources`, `game_session_mutation_receipts`, `game_session_projection_outbox`, `game_session_projection_outbox_recovery3`, `game_session_transition_resources`, `historical_match_pairs`, `invite_sources`, `login_match_discovery`, `match_presentation_registrations`, `match_presentation_source_exceptions`, `match_state_legacy_claims`, `match_state_legacy_records`, `match_state_routes`, `match_timer_starts`, `profile_game_projections`, `game_session_transitions` |
| PROFILE_DB                       | `invite_wager_states`, `legacy_rating_completions`, `profile_auth_methods`, `profile_auth_operations`, `profile_auth_recovery_quarantine`, `profile_auth_recovery_quarantine_recovery3`, `profile_february_opponents`, `profile_link_catchup_quarantine`, `profile_link_catchup_quarantine_recovery3`, `profile_login_owners`, `profile_merge_targets`, `rating_projection_recovery_quarantine`, `wager_frozen_operations`, `wager_settlements`, `profile_auth_recovery_jobs`, `profile_auth_recovery_jobs_recovery3`, `profile_link_catchup_jobs`, `profile_link_catchup_jobs_recovery3`, `rating_updates`, `wager_frozen_balances`, `profile_records`                  |
| AUTH_STATE_DB                    | `x_redirect_flows`, `auth_intents`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| EVENT_DB                         | `event_prize_selections`, `event_profile_game_projection_outboxes`, `event_profile_game_projection_outboxes_recovery3`, `event_progress_outboxes`, `event_progress_outboxes_recovery3`, `event_telegram_projection_outboxes`, `event_telegram_projection_outboxes_recovery3`, `event_telegram_projection_state`, `event_transition_intents`, `profile_event_prize_revisions`, `profile_event_prizes`, `event_records`                                                                                                                                                                                                                                                    |
| EVENT_PRIZE_WITHDRAWALS_DB       | `event_prize_withdrawals`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| TELEGRAM_DB                      | `telegram_delivery_control`, `telegram_event_prize_announcements`, `telegram_messages`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PROFILE_GAMES_DB, migration 0039 | `match_timer_starts_canonical`, `timer_storage_handoff_delete_context`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Removed old Durable Object table names:

`frozen_match_presentations`, `invite_metadata`, `invite_refresh_schedule`, `invite_wagers`, `latest_reactions`, `match_presentation_seeds`, `match_presentations`, `match_state_claims`, `match_state_effects`, `match_state_effects_recovery3`, `match_state_event_receipts`, `match_state_records`, `match_state_revisions`, `match_state_source`, `match_state_timer_cohorts`, `match_state_timer_starts`, `match_sync_snapshots`.

Retired resource names:

- Source Queues: `mons-link-auth-recovery`, `mons-link-event-profile-game-projection`, `mons-link-profile-game-projection`, `mons-link-telegram-delivery`, `mons-link-telegram-projection`, `mons-link-wager-settlement`.
- Source DLQs: `mons-link-telegram-delivery-dlq`, `mons-link-telegram-projection-dlq`, `mons-link-wager-settlement-dlq`.
- Consumers: `mons-link-auth-recovery`, `mons-link-event-profile-game-projection`, `mons-link-profile-game-projection`, `mons-link-telegram-delivery`, `mons-link-telegram-projection`, `mons-link-wager-settlement`.
- Workflows: `mons-link-event-progress`, `mons-link-event-prize-withdrawal`.
- Temporary Worker removed: `mons-link-read-batch-fa934812`; already-absent helper: `mons-link-profile-stage-20261029-y4sh1-kz`.

<details><summary>Removed baseline source paths (205)</summary>

- `cloud/admin/_d1.js`
- `cloud/admin/leaderboardCli.js`
- `cloud/admin/listAddresses.js`
- `cloud/admin/recoverTelegramDelivery.js`
- `cloud/admin/shootingStarAlert.js`
- `cloud/admin/telegramQueueCli.js`
- `cloud/admin/topGpWithEmojis.js`
- `cloud/admin/topMpWithEmojis.js`
- `cloud/canonical-data-inventory.json`
- `cloud/runtime/migration-auth.d.ts`
- `cloud/runtime/migration-auth.js`
- `cloud/runtime/migration-commands.d.ts`
- `cloud/runtime/migration-commands.js`
- `cloud/runtime/migration-object.d.ts`
- `cloud/runtime/migration-object.js`
- `cloud/runtime/src/migration-auth.ts`
- `cloud/runtime/src/migration-commands.ts`
- `cloud/runtime/src/migration-object.ts`
- `cloud/workers/api/runtime/matchTimerStartRecovery.test.ts`
- `cloud/workers/api/runtime/migrationApiVerification.test.ts`
- `cloud/workers/api/runtime/migrationD1Control.test.ts`
- `cloud/workers/api/runtime/migrationObjectControl.test.ts`
- `cloud/workers/api/runtime/migrationObjectExport.test.ts`
- `cloud/workers/api/runtime/migrationRealStage.test.ts`
- `cloud/workers/api/runtime/migrationTimerExport.test.ts`
- `cloud/workers/api/runtime/orphanTimerCancellationRoute.test.ts`
- `cloud/workers/api/runtime/orphanTimerCancellationRuntime.test.ts`
- `cloud/workers/api/src/eventCompatibilityCodec.ts`
- `cloud/workers/api/src/matchTimerStartSweep.ts`
- `cloud/workers/api/src/migrationApiVerification.ts`
- `cloud/workers/api/src/migrationCapability.ts`
- `cloud/workers/api/src/migrationControlCommands.ts`
- `cloud/workers/api/src/migrationControlRoute.ts`
- `cloud/workers/api/src/migrationControlSchema.ts`
- `cloud/workers/api/src/migrationD1Control.ts`
- `cloud/workers/api/src/migrationObjectControl.ts`
- `cloud/workers/api/src/migrationObjectExport.ts`
- `cloud/workers/api/src/migrationObjectRuntime.ts`
- `cloud/workers/api/src/migrationReadRoute.ts`
- `cloud/workers/api/src/migrationRetirement.ts`
- `cloud/workers/api/src/migrationStage.ts`
- `cloud/workers/api/src/migrationTimerExport.ts`
- `cloud/workers/api/src/migrationWriteCapability.ts`
- `cloud/workers/api/src/orphanTimerCancellation.ts`
- `cloud/workers/api/src/orphanTimerCancellationRuntime.ts`
- `cloud/workers/api/src/profileCanonical/retainedRecords.ts`
- `cloud/workers/api/src/sourceRecoveryObjectSchema.ts`
- `cloud/workers/api/test/matchTimerStartSweep.test.ts`
- `cloud/workers/api/test/migrationControlCommands.test.ts`
- `cloud/workers/api/test/orphanTimerCancellation.test.ts`
- `scripts/automatch-admission-cancellation.test.ts`
- `scripts/automatch-admission-cancellation.ts`
- `scripts/cancel-automatch-admissions.ts`
- `scripts/canonical-migration-admission-proof.test.ts`
- `scripts/canonical-migration-artifact-volume.test.ts`
- `scripts/canonical-migration-auth-state.test.ts`
- `scripts/canonical-migration-auth.test.ts`
- `scripts/canonical-migration-authorized-discard-coordinator.test.ts`
- `scripts/canonical-migration-batch-proxy.test.ts`
- `scripts/canonical-migration-business-timers.test.ts`
- `scripts/canonical-migration-candidate-discard.test.ts`
- `scripts/canonical-migration-cli-run.test.ts`
- `scripts/canonical-migration-cli.ts`
- `scripts/canonical-migration-concurrency.test.ts`
- `scripts/canonical-migration-conversion-family.test.ts`
- `scripts/canonical-migration-coordination.test.ts`
- `scripts/canonical-migration-coordinator.test.ts`
- `scripts/canonical-migration-coverage-retry.test.ts`
- `scripts/canonical-migration-discard-d1-absence.test.ts`
- `scripts/canonical-migration-discard-d1.test.ts`
- `scripts/canonical-migration-discard-disposition.test.ts`
- `scripts/canonical-migration-driver.test.ts`
- `scripts/canonical-migration-emoji-range.test.ts`
- `scripts/canonical-migration-empty-table-batch.test.ts`
- `scripts/canonical-migration-event-controls.test.ts`
- `scripts/canonical-migration-event-progress.test.ts`
- `scripts/canonical-migration-events.test.ts`
- `scripts/canonical-migration-execution-lock.test.ts`
- `scripts/canonical-migration-export.test.ts`
- `scripts/canonical-migration-frozen-rehearsal.test.ts`
- `scripts/canonical-migration-gameplay.test.ts`
- `scripts/canonical-migration-locked-execution.test.ts`
- `scripts/canonical-migration-match-appearance.test.ts`
- `scripts/canonical-migration-match-controls.test.ts`
- `scripts/canonical-migration-matches.test.ts`
- `scripts/canonical-migration-operator-continuation.test.ts`
- `scripts/canonical-migration-original-recovery.test.ts`
- `scripts/canonical-migration-prepare.test.ts`
- `scripts/canonical-migration-prepare.ts`
- `scripts/canonical-migration-private-bridge.test.ts`
- `scripts/canonical-migration-profile-stage-bridge.test.ts`
- `scripts/canonical-migration-profiles.test.ts`
- `scripts/canonical-migration-provider-operations.test.ts`
- `scripts/canonical-migration-reaction-orphan.test.ts`
- `scripts/canonical-migration-read-request.test.ts`
- `scripts/canonical-migration-real.test.ts`
- `scripts/canonical-migration-refresh-schedule.test.ts`
- `scripts/canonical-migration-retained-match-import.test.ts`
- `scripts/canonical-migration-retirement-plan.test.ts`
- `scripts/canonical-migration-run.ts`
- `scripts/canonical-migration-scale.test.ts`
- `scripts/canonical-migration-snapshot-continuation.test.ts`
- `scripts/canonical-migration-source-version.test.ts`
- `scripts/canonical-migration-staging-continuation.test.ts`
- `scripts/canonical-migration-staging-manifest-size.test.ts`
- `scripts/canonical-migration-staging.test.ts`
- `scripts/canonical-migration-telegram.test.ts`
- `scripts/canonical-migration-wager-plan.test.ts`
- `scripts/canonical-migration-wagers.test.ts`
- `scripts/canonical-migration-withdrawals.test.ts`
- `scripts/canonical-migration-workflow-absence-provider.test.ts`
- `scripts/canonical-migration-workflow-retirement-proof.test.ts`
- `scripts/canonical-migration.md`
- `scripts/canonical-migration.test.ts`
- `scripts/canonical-migration/admissionProof.ts`
- `scripts/canonical-migration/applicationRecords.ts`
- `scripts/canonical-migration/artifacts.ts`
- `scripts/canonical-migration/authState.ts`
- `scripts/canonical-migration/batch-proxy/batchRead.ts`
- `scripts/canonical-migration/batch-proxy/descriptor.json`
- `scripts/canonical-migration/batch-proxy/index.ts`
- `scripts/canonical-migration/batch-proxy/prepared-scope.json`
- `scripts/canonical-migration/batch-proxy/wrangler.jsonc`
- `scripts/canonical-migration/batchProxy.ts`
- `scripts/canonical-migration/businessTimerPlan.ts`
- `scripts/canonical-migration/candidateDiscard.ts`
- `scripts/canonical-migration/candidateRehearsal.ts`
- `scripts/canonical-migration/captureReuse.ts`
- `scripts/canonical-migration/checkpoint.ts`
- `scripts/canonical-migration/concurrency.ts`
- `scripts/canonical-migration/controlClient.ts`
- `scripts/canonical-migration/converterRegistry.ts`
- `scripts/canonical-migration/coordination.ts`
- `scripts/canonical-migration/coordinator.ts`
- `scripts/canonical-migration/discard-control/index.ts`
- `scripts/canonical-migration/discard-control/wrangler.jsonc.template`
- `scripts/canonical-migration/discardD1.ts`
- `scripts/canonical-migration/discardD1Absence.ts`
- `scripts/canonical-migration/discardDisposition.ts`
- `scripts/canonical-migration/driver.ts`
- `scripts/canonical-migration/emptyTableBatchBridge.ts`
- `scripts/canonical-migration/eventControls.ts`
- `scripts/canonical-migration/eventProgress.ts`
- `scripts/canonical-migration/events.proposed.sql`
- `scripts/canonical-migration/events.ts`
- `scripts/canonical-migration/executionLock.ts`
- `scripts/canonical-migration/exporter.ts`
- `scripts/canonical-migration/frozenRehearsal.ts`
- `scripts/canonical-migration/gameplay.ts`
- `scripts/canonical-migration/historical-object-schemas/match-import-staging.sql`
- `scripts/canonical-migration/index.ts`
- `scripts/canonical-migration/inventory.ts`
- `scripts/canonical-migration/legacyWagerFrozen.ts`
- `scripts/canonical-migration/lockedExecution.ts`
- `scripts/canonical-migration/manifest.ts`
- `scripts/canonical-migration/matchControls.ts`
- `scripts/canonical-migration/matchRows.ts`
- `scripts/canonical-migration/matches.ts`
- `scripts/canonical-migration/operatorImplementationContinuation.ts`
- `scripts/canonical-migration/originalRecoveryPlan.ts`
- `scripts/canonical-migration/privateBridge.ts`
- `scripts/canonical-migration/profileInvariants.ts`
- `scripts/canonical-migration/profileStageBridge.ts`
- `scripts/canonical-migration/profileStageBridgeDescriptor.ts`
- `scripts/canonical-migration/profileStageBridgeProtocol.ts`
- `scripts/canonical-migration/profileStageBridgeWorker.ts`
- `scripts/canonical-migration/profiles.ts`
- `scripts/canonical-migration/providerOperations.ts`
- `scripts/canonical-migration/readRequest.ts`
- `scripts/canonical-migration/readRows.ts`
- `scripts/canonical-migration/readinessFiles.ts`
- `scripts/canonical-migration/records.ts`
- `scripts/canonical-migration/recoveryCapture.ts`
- `scripts/canonical-migration/rehearsal.ts`
- `scripts/canonical-migration/releaseChecks.ts`
- `scripts/canonical-migration/retirementPlan.ts`
- `scripts/canonical-migration/snapshotContinuation.ts`
- `scripts/canonical-migration/sourceVersion.ts`
- `scripts/canonical-migration/stagingContinuation.ts`
- `scripts/canonical-migration/stagingPlan.ts`
- `scripts/canonical-migration/targetCatalog.ts`
- `scripts/canonical-migration/targetRecords.ts`
- `scripts/canonical-migration/telegram.ts`
- `scripts/canonical-migration/telegramCleanup.ts`
- `scripts/canonical-migration/topology.ts`
- `scripts/canonical-migration/transport.ts`
- `scripts/canonical-migration/validation.ts`
- `scripts/canonical-migration/wagers.ts`
- `scripts/canonical-migration/withdrawals.ts`
- `scripts/canonical-migration/workflowRetirementProof.ts`
- `scripts/manage-application-admissions.test.ts`
- `scripts/manage-application-admissions.ts`
- `scripts/manage-blocked-scheduled-admission.test.ts`
- `scripts/manage-orphan-timers.test.ts`
- `scripts/manage-orphan-timers.ts`
- `scripts/match-presentation-source-exceptions.test.ts`
- `scripts/operator/applicationAdmissionReconciliation.ts`
- `scripts/operator/automatchCancellationRecords.ts`
- `scripts/operator/blockedScheduledAdmissionReconciliation.ts`
- `scripts/operator/orphanTimerCancellation.ts`
- `scripts/test-fixtures/canonicalCoverageReplay.mjs`
- `src/connection/eventMappers.ts`
- `src/utils/sessionStorageCompatibility.d.ts`
- `src/utils/sessionStorageCompatibility.js`
- `test/browserStorageCompatibility.test.mjs`

</details>

<details><summary>Removed temporary final-stage paths (11; not additive)</summary>

- `cloud/workers/api/runtime/canonicalStorageCleanup.test.ts`
- `cloud/workers/api/runtime/timerHandoffStore.test.ts`
- `cloud/workers/api/src/canonicalCleanupAuthorization.ts`
- `cloud/workers/api/src/canonicalCleanupCommands.ts`
- `cloud/workers/api/src/canonicalCleanupRoute.ts`
- `cloud/workers/api/src/canonicalCleanupScope.ts`
- `cloud/workers/api/src/canonicalStorageCleanup.ts`
- `cloud/workers/api/src/timerHandoffRecords.ts`
- `cloud/workers/api/src/timerHandoffSql.ts`
- `cloud/workers/api/src/timerHandoffStore.ts`
- `cloud/workers/api/test/canonicalCleanupAuthorization.test.ts`

</details>

Protected evidence index SHA-256: `d457b593e78c79d98fb7d293aeb831f8ff0a9779230f794ab0eff59327bf8582`. The index retains recomputed artifact references separately; this report contains no credentials, business rows or private filesystem paths.

The initial report was included in migration commit `181e5152a`, and the initial inspection outcome was published in report-only commit `22f454f45`. This final update accompanies the permanent safeguards. No additional observation window was added after the required checks passed.
