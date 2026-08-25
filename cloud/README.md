# mons cloud operations

Run commands from the repository root. See the repository [architecture and command map](../README.md) for package boundaries and the [Cloudflare deployment guide](../scripts/deploy-cloudflare.md) for API release, maintenance, and rollback procedures.

Firebase retains event functions, event-progress rating projection, and the existing Firebase data stores. The API Worker owns auth, profile and leaderboard reads, username mutation, mining, gameplay, event participation, X callback, and Worker-backed Telegram delivery.

## Setup

```sh
npm ci
npm ci --prefix cloud/functions
npm ci --prefix cloud/admin
npm install -g firebase-tools
```

Use Application Default Credentials for admin tools:

```sh
gcloud auth application-default login
```

## Firebase releases

Preview the complete release without starting a Firebase process:

```sh
npm run deploy:firebase -- --project mons-link --dry-run
```

Deploy Realtime Database rules, exported functions, Firestore rules, and indexes, then reconcile the deployed Functions manifest:

```sh
npm run deploy:firebase -- --project mons-link
```

The full release reconciles deployed Functions with the current export manifest. Review the dry-run first. Use a positional maintenance deployment when full reconciliation is not intended:

```sh
npm --prefix cloud/functions run deploy:safe -- <function-name> --project mons-link
```

## Auth maintenance and recovery

`AUTH_MUTATIONS_DISABLED` in `cloud/workers/api/wrangler.jsonc` is the only auth maintenance switch. Change and release it as reviewed Worker configuration; do not create environment-specific copies or Dashboard overrides.

`mons-link-auth-recovery` is the permanent recovery Queue. Its consumer applies `authRecoveryJobs` idempotently, and the scheduled sweep re-enqueues stale jobs. Investigate a stuck job without purging the Queue or deleting its job record.

## Auth cooldown cleanup

Preview indexed expired records, then execute the same cleanup:

```sh
node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --dry-run
node cloud/admin/cleanupAuthMethodRevocations.js --project mons-link --execute
```

## Telegram recovery and announcements

Restore protected operator credentials only when needed:

```sh
umask 077
firebase functions:secrets:access TELEGRAM_QUEUE_BRIDGE_SECRET --project mons-link > /secure/telegram-queue-bridge-secret
firebase functions:secrets:access TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET --project mons-link > /secure/telegram-announcement-secret
```

The Queue bridge and announcement bridge are separate credentials.

Ambiguous sends remain `uncertain` and are never retried automatically. Preview and execute one reviewed recovery action:

```sh
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link --execute
```

Use `confirm-send-applied --message-id <telegram-message-id>` when Telegram created the message, or `abandon` to retain the audit record and stop delivery.

Smoke the event-prize route without publishing, then run the confirmed operation:

```sh
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret --smoke
npm run announceEventPrizes -- --bridge-secret-file /secure/telegram-announcement-secret
```

An uncertain Telegram response requires checking the group before retrying.

## Other admin tools

List profile addresses:

```sh
npm --prefix cloud/admin start -- --project mons-link --out-eth /tmp/eth_addresses.txt --out-sol /tmp/sol_addresses.txt
```

Publish GP, MP, or shooting-star leaderboard messages through the Queue bridge:

```sh
node cloud/admin/topGpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
node cloud/admin/topMpWithEmojis.js 25 --bridge-secret-file /secure/telegram-queue-bridge-secret
npm --prefix cloud/admin run shooting:alert -- --bridge-secret-file /secure/telegram-queue-bridge-secret --project mons-link
```
