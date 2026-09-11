# mons cloud operations

Run commands from the repository root. See the [architecture and command map](../README.md) and [Cloudflare deployment guide](../scripts/deploy-cloudflare.md).

Routine compatible releases keep canonical writes and Queue delivery active. Prepare validated candidates, promote exact versions, and verify affected behavior. There is no overall release time limit and no verification-only wait or observation window longer than 60 seconds. Maintenance controls require a concrete schema, compatibility, lifecycle, or incident reason.

## Canonical data

`PROFILE_DB.profile_login_owners` is the sole source for login-to-profile ownership, including merge targets. Unreadable or inconsistent ownership fails closed. Profiles, ratings, recovery, wagers, and transaction guards live in profile D1; browser sessions and intents live in auth-state D1.

The invite Durable Object owns active match records and timer claims. Gameplay D1 owns actor/match routes, immutable archived records, invite metadata, automatch, session receipts, discovery, projection outboxes, and locks. Events, Telegram delivery, and prize withdrawals have their own D1 databases.

Preserve existing login IDs, applied SQL migrations, immutable snapshots, imported legacy match records, rating completions, source digests, and both event receipt stages. Stored compatibility formats are not permission to restart a completed migration or rewrite historical data.

## Browser sessions and profile recovery

Persistent browser sessions use five-minute Worker access tokens. Refresh and revocation are coordinated in D1. `POST /auth/profile/sync` resolves canonical ownership, repairs profile presentation, and dispatches existing catch-up jobs. The legacy `POST /auth/profile-claim/sync` URL remains a compatibility alias.

Canonical ownership changes create catch-up work atomically in D1. The scheduled sweep recovers Queue dispatch. Completed jobs stay absent; do not reset request IDs or replay cursors. `mons-link-auth-recovery` owns idempotent profile recovery. Investigate a stuck job without deleting it or purging its Queue.

`AUTH_MUTATIONS_DISABLED` is the tracked auth maintenance switch. Change it through candidate upload and explicit promotion. Auth intents are consume-once and revision-fenced; do not manually edit active rows.

## Setup

```sh
npm ci
npm ci --prefix cloud/runtime
npm ci --prefix cloud/admin
npm run check:all
```

The complete gate uses Node.js 24 or newer and needs no Java or external database emulator. Release commands use the empty `cloud/workers/api/release.env` and preserve encrypted Cloudflare secrets.

## Canonical profile maintenance

```sh
npm run manage:profile-canonical -- --status
```

Schema maintenance may require `--freeze`, affected Queue pauses, verification of drained admissions/leases, the reviewed D1 migration, and `PRAGMA foreign_key_check`. Resume only after required checks pass. The deployment guide contains store-specific commands. Routine code changes do not need this procedure. Never rewrite profile ownership, delete imported profile fields, or restore a coordinated database independently.

## Gameplay and operators

Moves, takebacks, timer starts/claims, surrender, and rematches use authenticated Worker APIs and typed Durable Object mutations. Cumulative delivery preserves prefixes, replay, status, and timer fences. Pending downstream effects remain durable and recover through the existing alarm.

`GET /matches/snapshot?playerId=…&matchId=…` resolves D1 routing and reads the exact canonical or archived match. An absent route returns `match: null`; unavailable canonical state is an error. Public historical pairs come solely from D1 and never backfill on reads.

```sh
npm run manage:match-state -- --status
npm run manage:match-state -- --inspect-admissions --directory <new-private-output-directory>
npm run manage:invite-source -- --status
npm run manage:automatch-state -- --status
npm run manage:login-match-discovery -- --status
npm run manage:match-presentations -- --status
npm run manage:wager-state -- --status
npm run manage:event-transition-receipts -- --status
```

Match inspection reads its import identity from D1 and writes an immutable protected report; original migration files are not required. Completed migration phases and source-proof operations are rejected. Invite and automatch inspection/reconciliation retain exact canonical-record evidence and current D1 recovery safeguards. Do not clear unexplained admissions or locks.

## Live delivery and appearance

Invite metadata uses `/invites/:inviteId/metadata` and its `mons-invite-metadata-v1` socket. Wager snapshots use `/invites/:inviteId/wagers` and `mons-invite-wagers-v1`. Match snapshots use the existing `mons-match-sync-v1` channel. These channels have separate revisions, admission checks, and broadcasts in the same Durable Object.

Paired invites allow spectators. Pending open invites require authentication; pending private invites require canonical host ownership. Metadata never exposes passwords, another login's operation ID, or private wager bookkeeping. The browser discards stale revisions and recovers through bounded HTTP reads when sockets are unavailable.

Reaction v1 and presentation v2 retain their protocol contracts and hibernating attachments. Registered actor existence and canonical Durable Object state are required for appearance reads. Appearance updates preserve operation-ID replay and expected revisions; immutable historical appearances do not change when live cosmetics change.

The shared alarm recovers missed notifications and pending durable effects. Preserve its namespace, records, revisions, and per-channel ownership. `smoke:invite-lifecycle`, `smoke:reactions`, and `smoke:invite-metadata` verify the corresponding canonical behavior. Lifecycle checks own their temporary sessions and games and clean them up.

## Events, wagers, and withdrawals

Event control supports `d1` and `frozen`. The event-progress Workflow owns scheduled starts and retriable synchronization; existing instances retain their IDs, payloads, and versioned code during compatible releases. Event mutation intents and both receipt stages preserve exact replay and cross-database consistency. Never bulk-delete admissions or detach pending intents.

`PROFILE_DB.invite_wager_states` owns proposals, agreements, settlement state, and resolution markers. Reserved balances, consumed operation tombstones, pending settlements, and replay records are current application data. Current wager incidents use `manage:wager-reservations` and canonical-profile maintenance. Reconcile uncertain effects before settling an expired admission.

Prize withdrawals retain D1 leases, destination identity, signed transaction bytes, exact signature recovery, and completion records. Freeze affected storage before a schema change or terminating an instance. The read-only withdrawal Workflow preflight validates wallet identity and RPC access without sending a transaction. Never manually rewrite assigned prizes or replay a possibly completed transfer.

## Telegram recovery and announcements

Event Telegram projection runs through `mons-link-telegram-projection`. Every supported API or Workflow mutation writes `EVENT_DB.event_telegram_projection_outboxes` and increments the generation in `event_telegram_projection_state` atomically with the event update. The five-minute Worker schedule recovers pending markers; all event mutations pass through the canonical Worker repository.

Event creation accepts `telegramAnnouncements` with three required booleans: `invite` sends the initial invite, `matches` sends event start and match updates, and `results` sends final results. The creation UI defaults all three to false. These settings take precedence over the legacy `announceOnTelegram` boolean, which still maps to all three options for older requests and records. Release API support before the frontend that sends these settings; no database migration is needed.

When `invite` is false, joins and postponements cannot send an invite. A confirmed delivery receipt for `event:<event-id>:upcoming`, with instance `event:<event-id>:upcoming:v2` and destination `community`, permits edit-only updates; a missing message is never replaced automatically. Manual invite sending remains a separate future operation. That sender must record the canonical delivery receipt and enqueue event projection after confirmation to refresh participants immediately; otherwise the next event mutation picks it up. Start/match updates and final results work independently of invite delivery.

The Queue operator bridge credential is provisioned in the protected local file `/Users/ivan/.config/mons-link/secrets/telegram-queue`. Pass its path explicitly with `--bridge-secret-file`; commands require this explicit credential and use no environment fallback.

Delivery and recovery records live in the `mons-link-telegram` D1 database. Ambiguous sends remain `uncertain` and are never retried automatically. Preview and execute one reviewed recovery action through the signed Worker command endpoint:

```sh
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue
npm run recover:telegram -- --message-key <key> --action confirm-send-absent --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue --execute
```

Use `confirm-send-applied --message-id <telegram-message-id>` when Telegram created the message, or `abandon` to retain the audit record and stop delivery.

The reminder timing update was released on September 8, 2026 in API version `7a94cfb8-550d-45c1-9ab1-4399ea9b6e11`. Use this or a later compatible version for rollback once four-hour jobs exist; it accepts both stored three-hour and four-hour schedules. Validation and release evidence is retained in `/private/tmp/mons-reminder-release-x51eqD`.

New Sunday Mons reminders send automatically four hours before the scheduled event start. Previously queued three-hour reminders retain their original schedule, and participant updates preserve the heading of already-sent messages. Only scheduled events with `isSundayMons === true` and a valid start time qualify; prizes are not required. The standalone HTML message goes to the community destination with notifications enabled and link previews disabled:

```text
sunday mons in 4 hours!

https://mons.link/event/{eventId} <tg-emoji emoji-id="5355002036817525409">&#11088;</tg-emoji>
```

The reminder includes the same participant list as the event-created message once at least two participants have joined. Both lists update as scheduled-event participants or their appearance change and freeze when the event starts. Reminder edits work independently of invite announcements and never replace a missing or deleted message.

To refresh an already sent reminder, submit exactly `{"kind":"event-reminder-refresh","eventId":"<event-id>"}` to `POST /internal/telegram/command` with the existing Telegram bridge timestamp and signature headers. The command accepts only a scheduled eligible Sunday Mons event with a confirmed reminder receipt; it returns `202` with the projection request ID and message key, or `409` when the event or receipt is ineligible. It adopts the saved reminder message under `event:<event-id>:reminder` without changing its original announcement receipt. Repeated refreshes remain edit-only. A `dispatch-deferred` response means the durable projection outbox is pending recovery by the existing sweep.

Sunday Mons prize announcements send automatically one hour before the scheduled event start and additionally require prizes in the shared catalog. The album keeps catalog prize order and spoiler-covers every photo. Its first caption uses the lowercased, HTML-escaped catalog collection name inside a Telegram spoiler, followed by `starting in 1 hour` and the event link with the same automatch custom emoji. Both notifications operate independently of the invite, matches, and results settings, and an eligible prize event can receive both.

`EVENT_PROGRESS_WORKFLOW` sleeps until each notification's target; the existing event progress sweep discovers eligible events and recovers pending dispatches. Event changes persist eligible scheduling markers atomically before dispatch. Events first discovered after a notification's target skip that notification; previously scheduled jobs have a 60-second delivery grace period. Before sending, the workflow checks the canonical event and any required prize catalog entry under the event lease. A postponement can schedule a new job for each unsent notification; superseded jobs do nothing.

Each event has one permanent delivery identity per notification kind. A confirmed reminder or prize album never resends, including after postponement. Only safely retryable Telegram failures can retry within the grace period; timeouts, interrupted sends, and ambiguous responses block automatic retries to prevent duplicates. Historical manual prize receipts remain valid. These announcements have no manual send trigger and require no separate announcement bridge credential. The initial reminder rollout requires only the API Worker and an additive Telegram D1 migration that records the notification kind and makes delivery uniqueness specific to each event and kind; no frontend or trigger deployment is needed. Live reminder participant lists require an API-only release with no additional database migration.

## Other admin tools

Canonical profile admin readers require an explicit `CLOUDFLARE_API_TOKEN` scoped to Account D1 Read for `mons-link-profiles`. They accept `frozen` and `active` and never use the Wrangler login token. Use a separate read-only operator token supplied through the process environment; do not place it in arguments or logs.

List profile addresses:

```sh
npm --prefix cloud/admin start -- --out-eth /secure/eth-addresses.txt --out-sol /secure/sol-addresses.txt
```

At least one output path is required. Address exports create new mode-`0600` files and refuse to overwrite an existing path; stdout contains counts only.

Publish GP, MP, or shooting-star leaderboard messages through the Queue bridge:

```sh
node cloud/admin/topGpWithEmojis.js 25 --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue
node cloud/admin/topMpWithEmojis.js 25 --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue
npm --prefix cloud/admin run shooting:alert -- --bridge-secret-file /Users/ivan/.config/mons-link/secrets/telegram-queue --project mons-link
```
