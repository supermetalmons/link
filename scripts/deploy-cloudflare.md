# Cloudflare deployment

Run commands from the repository root with Node.js 24 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Queues, Workflows, consumers, and Cron schedule.
- `cloud/workers/api/release.env` stays empty. It prevents release commands from loading developer environment files.
- Encrypted secrets stay in Cloudflare. Their required names are declared in the API Wrangler configuration.
- Do not edit production Worker configuration in the Cloudflare Dashboard. Review and deploy the tracked configuration.

Authenticate locally with `npx wrangler login`, or provide `CLOUDFLARE_API_TOKEN` through the release environment. Never put credentials in command arguments, source files, or logs. Set or rotate Worker secrets interactively:

```sh
npx wrangler secret put <NAME> --config cloud/workers/api/wrangler.jsonc
```

## Validation

Install dependencies with `npm ci`, then run:

```sh
npm run check:all
```

This validates the frontend, API Worker, Wrangler types and configuration, tooling, and Firebase functions.

## API Worker release

Upload and smoke a version before it receives traffic:

```sh
npm run upload:api
npm run smoke:api -- --base-url <version-preview-url> --smoke-sol <known-wallet>
```

Record the Version ID printed by Wrangler. Promote that exact version, apply reviewed triggers, and smoke production:

```sh
npm run promote:api -- --version-id <version-id>
npm run deploy:api:triggers
npm run smoke:api -- --base-url https://api.mons.link --smoke-sol <known-wallet>
```

`upload:api` uses `wrangler versions upload --strict`; it does not send traffic to the candidate. `promote:api` deploys the explicit Version ID to 100% of traffic without prompting. `deploy:api:triggers` applies the tracked route, Cron, and Queue consumer configuration. Routine code-only releases may omit the trigger command when that configuration is unchanged.

`mons-link-profile-game-projection` is the permanent rating, automatch, and event projector Queue. Automatch mutations atomically persist `profileGameProjectionOutbox/automatch/{inviteId}` before enqueueing. Event mutations accumulate every pre-mutation owner under `profileGameProjectionOutbox/event/{eventId}` in the same RTDB commit as the event and use a separate per-event projection lock. The five-minute Worker schedule repairs malformed automatch and event markers, preserving recoverable cleanup owners, repairs rating completion markers, claims pending markers by `lastQueuedAtMs`, and re-enqueues all three task kinds. Monitor Queue consumption, pending marker age, `event_profile_game_projection_*`, and `profile_game_projection_*` logs.

The retired Firebase function `projectProfileGamesOnAutomatchQueueWritten` must not remain deployed in steady state. Deploy the Realtime Database index, promote the Worker version, and then reconcile the Firebase Functions manifest. For rollback, restore and deploy the Firebase trigger from the pre-cutover revision before rolling the API Worker back.

The retired Firebase function `projectProfileGamesOnEventWritten` must not remain deployed in steady state. During cutover, deploy the RTDB index while the Firebase trigger remains live, promote the Worker, and run the production sample reconciliation before reconciling the Firebase Functions manifest. Run the same reconciliation after deletion to prove Cloudflare-only ownership. For rollback after deletion, restore and deploy the trigger from the recorded pre-cutover revision before rolling the API Worker back; retain pending outboxes and the RTDB index.

`mons-link-telegram-projection` owns automatch, rating, and event Telegram projections. Event mutations persist `telegramProjectionOutbox/event/{eventId}` and increment a durable per-event generation before enqueueing. The consumer serializes each event with `eventTelegramProjectionLocks`, generation-fences desired and projection-state commits, advances state only after dispatch succeeds, and clears only the exact request marker it processed. The five-minute schedule claims pending markers by `updatedAtMs`; monitor `firstQueuedAtMs`, `telegram_projection_queue_*`, and `telegram_projection_event_sweep_failed`.

The retired Firebase functions `projectEventTelegramOnCreated` and `projectEventTelegramOnUpdated` must not remain deployed in steady state. A rollback briefly restores the compatible database rules and both functions from the pre-cutover source before rolling the API Worker back, so every event mutation always has a projector owner.

The `mons-link-event-progress` Workflow owns scheduled event starts and retriable event synchronization. The five-minute Worker schedule reconciles `eventProgressOutbox` records and scheduled events with deterministic Workflow instances. Inspect a production instance with:

```sh
npx wrangler workflows instances describe mons-link-event-progress latest --config cloud/workers/api/wrangler.jsonc
```

Before retiring the legacy Firebase event-progress functions, verify that `processEventProgress` has no pending Cloud Tasks and that `eventProgressFallback` is empty. The Cloudflare outbox is private and indexed by `lastQueuedAtMs` for bounded recovery sweeps.

Rollback always targets a reviewed Version ID:

```sh
npx wrangler rollback <known-good-version-id> --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
```

## Frontend release

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

## Browser mutation cutover

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
