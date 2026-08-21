# Telegram delivery migration

Run every command from the repository root. Keep API tokens, service-account
keys, the Telegram token, chat ID, and bridge secret outside the repository.

## Provisioning

Create the Cloudflare queues before uploading a Worker version:

```sh
node_modules/.bin/wrangler queues create mons-link-telegram-delivery --config cloud/workers/api/wrangler.jsonc
node_modules/.bin/wrangler queues create mons-link-telegram-delivery-dlq --config cloud/workers/api/wrangler.jsonc
node_modules/.bin/wrangler queues update mons-link-telegram-delivery-dlq --message-retention-period-secs 1209600 --config cloud/workers/api/wrangler.jsonc
node_modules/.bin/wrangler queues create mons-link-telegram-projection --config cloud/workers/api/wrangler.jsonc
node_modules/.bin/wrangler queues create mons-link-telegram-projection-dlq --config cloud/workers/api/wrangler.jsonc
node_modules/.bin/wrangler queues update mons-link-telegram-projection-dlq --message-retention-period-secs 1209600 --config cloud/workers/api/wrangler.jsonc
```

Existing installations should skip the delivery Queue commands and create only
the projection Queue and its DLQ.

Create the dedicated Google identity and grant only the two RTDB permissions
used by the Worker:

```sh
gcloud iam roles create monsLinkTelegramDelivery --project mons-link --title="mons.link Telegram delivery" --permissions=firebasedatabase.instances.get,firebasedatabase.instances.update --stage=GA
gcloud iam service-accounts create mons-link-telegram-delivery --project mons-link --display-name="mons.link Telegram delivery"
gcloud projects add-iam-policy-binding mons-link --member="serviceAccount:mons-link-telegram-delivery@mons-link.iam.gserviceaccount.com" --role="projects/mons-link/roles/monsLinkTelegramDelivery"
gcloud iam service-accounts keys create /secure/mons-link-telegram-delivery.json --project mons-link --iam-account=mons-link-telegram-delivery@mons-link.iam.gserviceaccount.com
```

Generate one random 32-byte bridge secret. Store the same value as the
Cloudflare `TELEGRAM_QUEUE_BRIDGE_SECRET` and the Firebase
`TELEGRAM_QUEUE_BRIDGE_SECRET`; set the Firebase value interactively:

```sh
firebase functions:secrets:set TELEGRAM_QUEUE_BRIDGE_SECRET --config cloud/firebase.json --project mons-link
```

Prepare an untracked secrets file containing the five new Worker secrets:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_EXTRA_CHAT_ID=...
TELEGRAM_FIREBASE_SERVICE_ACCOUNT_EMAIL=mons-link-telegram-delivery@mons-link.iam.gserviceaccount.com
TELEGRAM_FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
TELEGRAM_QUEUE_BRIDGE_SECRET=...
```

Delete the downloaded Google key and secrets file after their values have been
stored as encrypted Worker secrets.

## Hard cutover

Upload and smoke-test a candidate without applying Queue triggers, then promote
that exact version:

```sh
npm run deploy:api -- preview --smoke-sol <known-wallet> --secrets-file /secure/mons-link-telegram-delivery.env --token-file /secure/cloudflare-token
npm run deploy:api -- production --version-id <candidate-version-id> --smoke-sol <known-wallet> --token-file /secure/cloudflare-token
```

Deploy the retained Firebase producer triggers. New wake-ups will accumulate in
Cloudflare while the former Cloud Tasks queue drains:

```sh
npm --prefix cloud/functions run deploy:safe -- dispatchTelegramDelivery dispatchTelegramManualRecovery --project mons-link
firebase functions:list --project mons-link
gcloud tasks queues list --project mons-link --location <function-region>
gcloud tasks list --project mons-link --location <function-region> --queue <telegram-delivery-queue>
```

Do not purge the Firebase queue. Once its task list is empty, attach the
Cloudflare consumer and run the delete-only smoke. The smoke never calls the
Telegram API and removes its temporary RTDB record:

```sh
npm run deploy:api:triggers -- --token-file /secure/cloudflare-token
npm run smoke:telegram -- --project mons-link
```

Confirm that `mons-link-telegram-delivery` returns to zero backlog and that the
DLQ is empty. After a normal production Telegram update succeeds, retire the
old function:

```sh
firebase functions:delete telegramDeliveryWorker --region <function-region> --project mons-link --force
```

Delete the former empty Cloud Tasks queue only if Firebase leaves it behind.

## Projection cutover

Automatch and non-event rating projections use the dedicated
`mons-link-telegram-projection` Queue. Automatch mutations persist a pending
RTDB outbox record in the same multipath update as their Telegram source.
Non-event rating transactions persist their pending projection state in the
completed Firestore rating record. Failed immediate Queue wake-ups therefore do
not fail gameplay and are recovered by the five-minute Worker schedule.

Deploy and promote the Worker while the existing Firebase automatch and rating
projectors remain active. Apply the reviewed Queue and schedule triggers, then
exercise one pending automatch, one cancellation, one match, and one completed
rating:

```sh
firebase deploy --only database,firestore:indexes --config cloud/firebase.json --project mons-link
npm run deploy:api -- preview --smoke-sol <known-wallet> --token-file /secure/cloudflare-token
npm run deploy:api -- production --version-id <candidate-version-id> --smoke-sol <known-wallet> --token-file /secure/cloudflare-token
npm run deploy:api:triggers -- --token-file /secure/cloudflare-token
```

Wait for the `ratingUpdates` index to finish building before attaching the
schedule trigger.

Confirm that `telegramProjectionOutbox/automatch` contains no pending record for
the exercised invites, completed rating records reach
`telegramProjectionState = done`, the projection Queue returns to zero backlog,
and no projection outbox remains pending. The existing desired-revision
dispatcher should then deliver the resulting `telegramMessages` revisions
normally.

After that dual-run validation, deploy the complete Firebase release. The
release removes `projectAutomatchTelegramMessages` and retains
`projectRatingTelegramUpdates` only for event-progress requests:

```sh
npm run deploy:firebase -- --project mons-link
firebase functions:list --project mons-link
```

## Recovery and rollback

Preview the wake-ups reconstructed from current RTDB state before sending them:

```sh
npm run requeue:telegram -- --target cloudflare --project mons-link --dry-run
npm run requeue:telegram -- --target firebase --project mons-link --dry-run
```

For Cloudflare execution, place only the bridge secret in an external file:

```sh
npm run requeue:telegram -- --target cloudflare --project mons-link --bridge-secret-file /secure/telegram-bridge-secret --execute
```

To roll back, pause Cloudflare delivery, restore and deploy the previous
Firebase worker and producer code, replay current state to Firebase Tasks, then
remove the Cloudflare consumer trigger and promote the recorded API version.
The Firebase replay command is:

```sh
npm run requeue:telegram -- --target firebase --project mons-link --execute
```

For projection rollback, restore both Firebase projector exports, then replay
and drain every pending source before detaching
`mons-link-telegram-projection` or rolling back the API Worker:

```sh
npm --prefix cloud/admin run replay:telegram-projections -- --project mons-link --dry-run
npm --prefix cloud/admin run replay:telegram-projections -- --project mons-link --execute
npm run requeue:telegram -- --target firebase --project mons-link --execute
```

Verify that the RTDB and Firestore pending counts are zero before detaching the
Cloudflare projection consumer.
