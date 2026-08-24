# Cloudflare deployment

Run commands from the repository root with Node.js 24 or newer. Firebase operations are documented in [cloud operations](../cloud/README.md).

## Source of truth

- `wrangler.jsonc` owns the frontend Worker configuration.
- `cloud/workers/api/wrangler.jsonc` owns the API Worker routes, variables, bindings, Queues, consumers, and Cron schedule.
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

## IAM and secrets

Use the dedicated Google identities already named by the required Worker secrets. Routine releases reuse their encrypted credentials; key creation and role changes are provisioning work, not deployment steps.

- The auth identity named by `FIRESTORE_SERVICE_ACCOUNT_*` uses default-database-conditioned Datastore permissions plus `firebaseauth.users.get`, `firebaseauth.users.update`, `firebasedatabase.instances.get`, and `firebasedatabase.instances.update` for claim recovery.
- The username identity uses only default-database-conditioned Datastore get, create, delete, list, and update permissions.
- The rating role uses the same database condition without entity delete.
- The gameplay identity has project-level `firebasedatabase.instances.get` and `firebasedatabase.instances.update`; its Firestore delete permission is conditioned on the default database.
- Do not broaden these roles to Editor or Owner. Revoke an old service-account key only after its replacement Worker version is healthy.
- Keep X, Telegram, Helius, and Google private-key values only as encrypted Worker secrets. `TELEGRAM_QUEUE_BRIDGE_SECRET` and `TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET` are distinct credentials.

The API smoke command covers NFT lookup, one auth route, the X callback, and one internal route without performing an authenticated mutation.

## Auth migration

This section is temporary and applies only to the pre-cutover migration.

### Permanent controls

- `AUTH_MUTATIONS_DISABLED` is the single tracked maintenance switch. When `true`, all provider verification, unlink, claim sync, X flow, X callback, and related auth mutations fail closed.
- `mons-link-auth-recovery` is the only auth recovery Queue. It has no auth recovery DLQ. Queue delivery is idempotent and the scheduled sweep re-enqueues stale `authRecoveryJobs`.
- Auth origins are enforced in code. There is no deployment-time SIWE domain list.

Create the Queue once before the first auth candidate upload:

```sh
npx wrangler queues create mons-link-auth-recovery
```

### Prepare

1. Confirm production cutover has not started and run `npm run check:all`.
2. Create a detached rollback worktree from the known-good `main` commit and keep it unchanged until acceptance:

   ```sh
   git worktree add --detach <rollback-worktree> main
   npm ci --prefix <rollback-worktree>/cloud/functions
   npm --prefix <rollback-worktree>/cloud/functions test
   ```

3. Securely retain the reviewed legacy Functions environment values needed by that worktree, and verify the required Worker secrets and least-privilege IAM bindings.
4. Set `AUTH_MUTATIONS_DISABLED` to `true` in `cloud/workers/api/wrangler.jsonc`, run `npm run types:api` and `npm run check:all`, review that change, upload it with `npm run upload:api`, smoke its version-preview URL, and record the Version ID. Do not promote it yet.

### Maintenance and data conversion

Start the auth-mutation maintenance window with the reviewed full Firebase release. This deploys the merge-aware projectors and prunes the five legacy auth callables:

```sh
npm run deploy:firebase -- --project mons-link --confirm-auth-prune
```

Wait two minutes for in-flight callable requests. Then preview and execute each bounded page of the legacy converter and both reconcilers:

```sh
npm run convert:legacy-auth-recovery -- --project mons-link --limit 20 --dry-run
npm run convert:legacy-auth-recovery -- --project mons-link --limit 20 --execute

npm run reconcile:merge-projections -- --project mons-link --limit 20 --dry-run
npm run reconcile:merge-projections -- --project mons-link --limit 20 --execute

npm run reconcile:wager-settlement-merges -- --project mons-link --limit 20 --dry-run
npm run reconcile:wager-settlement-merges -- --project mons-link --limit 20 --execute
```

For a result with `nextCursor`, repeat the matching dry-run and execute commands with `--after <nextCursor>`. A blocker or wager `reviewRequired` makes the pass unclean but does not invalidate its forward cursor. Record and resolve every blocker, using the wager reconciler's explicit `--resolve` mode when needed.

Run each converter dry-run immediately before its matching execute page, then continue with the execute result's cursor. Dry-run and execute parity assumes the same database state.

After reaching the end, rerun all three tools from the beginning. Continue until complete dry-run and execute passes report no conversion work, blocked projections, or manual review.

### Promote and drain

1. Promote the recorded disabled API Version ID with `npm run promote:api -- --version-id <version-id>`.
2. Apply the tracked consumer and triggers with `npm run deploy:api:triggers`.
3. Smoke `https://api.mons.link` for route health and verify that the promoted Version ID is the reviewed disabled candidate. The unauthenticated smoke does not prove the switch value.
4. Wait until `authRecoveryJobs` is empty and the recovery Queue has drained. Investigate a stuck job; do not purge the Queue or delete the job to force completion.
5. Rerun the converter and both reconcilers from the beginning and require clean terminal passes.
6. Set the tracked `AUTH_MUTATIONS_DISABLED` value to `false`, run `npm run types:api` and `npm run check:all`, upload and smoke a new candidate, then promote that exact Version ID.
7. Smoke production auth behavior, then release and smoke the frontend.

### Rollback

If rollback is required after the recovery consumer is attached, detach it without purging the Queue:

```sh
npx wrangler queues consumer remove mons-link-auth-recovery mons-link-api --config cloud/workers/api/wrangler.jsonc
```

Roll back the frontend and API to recorded known-good Version IDs. Restore the reviewed legacy Functions environment in the prepared worktree, then redeploy the five compatibility callables:

```sh
npm --prefix <rollback-worktree>/cloud/functions run deploy:safe -- \
  verifySolanaAddress verifyEthAddress verifyAppleToken \
  completeXRedirectAuth unlinkAuthMethod --project mons-link
```

Keep buffered recovery messages intact. Reattach the consumer only after a compatible Worker is promoted again.

### Retire migration code

After provider, unlink, merge, replay, projection, and wager checks pass in production:

- Delete the legacy converter and profile/wager reconciliation CLIs, their npm scripts, migration-only exports, and their tests.
- Delete compatibility for old backlogs, pending fields, merge locks, and recovery cursors.
- Remove `--confirm-auth-prune` and this cutover/rollback section.
- Retain the single recovery-job model, one recovery Queue, `AUTH_MUTATIONS_DISABLED`, live projection safeguards, and the normal release procedure above.
