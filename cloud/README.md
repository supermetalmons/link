# mons cloud operations

Run all commands from the repository root.

## Setup

`npm install -g firebase-tools`

Provision or rotate the Telegram bot token before the production release:

`firebase functions:secrets:set TELEGRAM_BOT_TOKEN --config cloud/firebase.json --project mons-link`

Verify that every Functions runtime service account that enqueues Telegram tasks has `roles/cloudtasks.enqueuer`, can act as the task service account, and has `roles/cloudfunctions.invoker` on `telegramDeliveryWorker`.

## Live Firebase operations

These commands deploy Firebase services or export live authentication data.

Deploy Realtime Database rules, every exported function, then Firestore rules and indexes through the production release driver:

`npm run deploy:firebase -- --project mons-link`

Full releases finish the Functions phase with a forced manifest reconciliation. This removes deployed Firebase-managed Functions that are no longer exported locally. Positional maintenance deployments do not prune other Functions.

Preview the same release without starting any Firebase process:

`npm run deploy:firebase -- --project mons-link --dry-run`

Change only the quota-oriented function batch size:

`npm run deploy:firebase -- --project mons-link --batch-size 5`

Deploy a single function for maintenance:

`npm --prefix cloud/functions run deploy:safe -- verifyEthAddress --project mons-link`

## Telegram delivery recovery

Ambiguous sends stay at `telegramMessages/{messageKey}/delivery/status = uncertain` and are never retried automatically. Resolve one by writing a new unique `requestId` under `telegramMessages/{messageKey}/manualRecovery` with one of these payloads:

- `{ "requestId": "...", "action": "confirm-send-absent" }` when Telegram did not create the message.
- `{ "requestId": "...", "action": "confirm-send-applied", "messageId": 123 }` when Telegram created it.
- `{ "requestId": "...", "action": "abandon" }` to retain the audit record and stop delivery.

The recovery dispatcher is idempotent by `requestId`. Retry-window exhaustion remains visible through `delivery/deadLetterAtMs`, and failed stale-message cleanup remains visible under `delivery/orphanedDeletes`.

`AUTH_EXPORT_PATH="$(mktemp)" && firebase auth:export "$AUTH_EXPORT_PATH" --config cloud/firebase.json --project mons-link --format=json && echo "Exported to $AUTH_EXPORT_PATH"`

## Admin address listing

Authenticate with Application Default Credentials before running the address commands:

`gcloud auth application-default login`

`npm --prefix cloud/admin start`

`npm --prefix cloud/admin start -- --project mons-link --out-eth /tmp/eth_addresses.txt --out-sol /tmp/sol_addresses.txt`

## Auth rollout configuration

These are configuration values, not standalone shell commands.

`AUTH_DISABLE_APPLE_VERIFY=true`

`AUTH_DISABLE_X_VERIFY=true`

`AUTH_DISABLE_UNLINK=true`

`AUTH_DISABLE_MERGE=true`
