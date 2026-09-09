# mons.link

mons.link is a browser game backed by Firebase Auth, Cloudflare D1, Realtime Database for active gameplay, and two Cloudflare Workers. The repository keeps the browser, backend, shared contracts, operational tools, and deployment drivers in their existing runtime boundaries.

## Project map

| Path                      | Responsibility                                                                               | Runtime            |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| `src/`                    | React UI, game orchestration, Firebase client, assets, and browser services                  | Vite / browser     |
| `test/`                   | Client behavior and contract tests                                                           | Node test runner   |
| `cloud/functions/`        | Portable backend modules shared with the API Worker                                          | CommonJS           |
| `cloud/functions/shared/` | Browser-safe `@mons/shared/*` contract subpaths                                              | CommonJS package   |
| `cloud/workers/api/`      | NFT, profile, customization, leaderboard, gameplay, event, ratings, mining, auth, and X APIs | Cloudflare Workers |
| `cloud/admin/`            | Manually invoked production administration tools                                             | Node / D1          |
| `scripts/`                | Deployment, repository maintenance, architecture, and tooling contracts                      | Node and Bash      |

The frontend Worker is configured by `wrangler.jsonc`. The API Worker has its independent configuration under `cloud/workers/api/`. Firebase Auth remains active, and Realtime Database retains active match synchronization and timer-claim fences. Invite metadata moves through the separately controlled `PROFILE_GAMES_DB.invite_sources` authority. Voice and sticker reactions use one SQLite-backed `InviteReactions` Durable Object per invite with public read-only WebSocket subscriptions and authenticated HTTP publishing. Canonical event, profile, auth-state, Telegram, projection, withdrawal, wager state and reservations, automatch queue and lifecycle, session receipt, game-session lock, and timer-start data are D1-backed. Session lifecycle transitions preserve create-only Firebase match effects and commit D1 invite metadata with their receipts and outboxes. Event transitions use durable receipts across the event and gameplay databases. Navigation is served from the Worker and profile-game D1 cache without an RTDB reconstruction fallback. Realtime Database rules live under `cloud/`; Firestore and Firebase Functions are not deployed.

Move submission and surrender use the authenticated `POST /matches/move` and `POST /matches/surrender` APIs. The Worker authorizes the match actor through canonical ownership and changes only the permitted fields with restricted Firebase transactions. Move delivery journals pending actions in the tab, including takebacks, and sends cumulative histories with FEN checkpoints. The Worker can recover missing intermediate actions, acknowledge older requests without rolling state backward, and preserve concurrent timer/status changes. Pending actions survive same-match reconnects and reloads; dependent game mutations wait for delivery. Realtime Database rules enforce timer-claim fencing at commit and reject direct browser move and status writes. Live match subscriptions remain in Firebase. Older clients must update to submit moves and surrender.

Reconnect recovery and post-retry move verification read individual matches through the public `GET /matches/snapshot?playerId=…&matchId=…` API. The Worker reads the exact public Firebase match path without credentials and returns only validated match fields with caching disabled. Only an absent source record returns `match: null`; source failures and malformed records return an error. Browser move submissions use the API; live match subscriptions continue to use Realtime Database.

The same Durable Object owns live per-match emoji/aura updates, with revisioned HTTP mutations and v2 WebSocket snapshots. Firebase match records retain immutable appearance seeds. Historical D1 pairs capture appearance once during archival; later live changes do not alter those snapshots. The API and frontend must be released before the Firebase rules cutover that blocks legacy cosmetic writes.

Invite/lobby and rematch reads use the API's metadata snapshots and a separate `mons-invite-metadata-v1` WebSocket subscription in the existing invite Durable Object. Wager reads use invite-wide HTTP snapshots and `mons-invite-wagers-v1`, preserving historical rematch displays while excluding internal settlement records. After invite-source activation, invite metadata is canonical in `mons-link-profile-games` D1; wager proposals, agreements, settlement state, and resolution markers remain canonical in `mons-link-profiles` D1. The Worker combines these sources without a Firebase fallback. Server mutations request immediate updates, and a shared alarm refreshes each subscribed invite every five seconds to recover missed notifications. Browser Realtime Database subscriptions remain only for live matches.

Account-link game discovery uses only the activated `PROFILE_GAMES_DB.login_match_discovery` index, with no Firebase discovery fallback. It covers login UIDs independently of profile ownership, including games played anonymously before account linking. Its original migration streamed protected Firebase key inventories while gameplay and Queues stayed active. See [the completed discovery cutover](scripts/deploy-cloudflare.md#account-link-game-discovery-cutover). Legacy discovery, automatch, and wager migration scans reject retained Firebase invite data once invite-source D1 is activated.

The [invite-source cutover](scripts/deploy-cloudflare.md#invite-source-d1-cutover) uses `npm run manage:invite-source` to preserve every invite, prove the import, and activate D1 under narrowly scoped writer gates. It leaves Queue delivery, Firebase Auth, live matches, timer fences, and manual-game timers running; event-game timeout claims pause while the event gate is frozen. Its candidate must be the sole deployed API version, with no nonterminal event-progress Workflow instances. No frontend, Durable Object namespace, or Firebase rules release is required.

The initial wager-state migration used the [single-freeze cutover](scripts/deploy-cloudflare.md#wager-state-d1-cutover). Retained Firebase invites, reactions, wagers, and profile links now deny client reads and writes, including clients with admin claims. Current clients use Worker APIs for these records. Firebase profile links are no longer read or maintained by runtime code; canonical ownership transactions in D1 own profile-link catch-up. Firebase Auth and its compatibility claims remain active. Later compatible releases use the routine release path.

## Setup and development

Use Node.js 24 and Java 21 or newer, then install the pinned root and portable backend dependencies:

```sh
npm ci
npm ci --prefix cloud/functions
npm start
```

Copy `.env.example` to `.env.local` only when local overrides are needed. Local environment files and credentials are not release inputs.

## Command map

### Client

| Command                   | Purpose                                        |
| ------------------------- | ---------------------------------------------- |
| `npm start`               | Start Vite development mode.                   |
| `npm run test:client`     | Run all client Node tests.                     |
| `npm run test:nft-client` | Run the retained public NFT-client test lane.  |
| `npm run check`           | Run client lint, typecheck, and tests.         |
| `npm run build`           | Validate and build the frontend into `build/`. |

### API and tooling

| Command                                        | Purpose                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run check:api`                            | Format, lint, typecheck, test, type-generation check, and dry-run the API Worker.                                        |
| `npm run check:tooling`                        | Validate deployment drivers, project contracts, admin parsing, repository cleanup fixtures, and dependency architecture. |
| `npm run manage:profile-canonical -- --status` | Read the canonical D1 writer-control state without exposing profile data.                                                |
| `npm run test:database-rules`                  | Run structural gameplay authorization against the Realtime Database emulator.                                            |
| `npm run check:all`                            | Run the repository-wide validation gate, including portable cloud runtime tests.                                         |
| `npm run format:check`                         | Check repository formatting without writing files.                                                                       |

### Deployment and maintenance

| Command                                                    | Purpose                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run deploy -- dry-run`                                | Build and validate the frontend Worker without authentication.                             |
| `npm run manage:invite-source -- --status`                 | Read invite authority, writer gates, and unresolved-work counts.                           |
| `npm run upload:api`                                       | Upload an API candidate without sending it production traffic.                             |
| `npm run deploy:firebase -- --project mons-link --dry-run` | Preview the Realtime Database rules release.                                               |
| `npm run repo-clean`                                       | Apply the documented destructive branch/worktree cleanup policy to the current repository. |

Production deployment commands, token handling, smoke checks, schema maintenance, and incident freezes are documented in [Cloudflare deployment](scripts/deploy-cloudflare.md). Firebase release, Telegram recovery, and admin operations are documented in [cloud operations](cloud/README.md).

Routine releases have no overall time limit: prepare validated candidates, then promote and verify the affected behavior, allowing necessary work and provider propagation to take the time they need. Do not add verification-only waits or observation windows longer than 60 seconds; finish once the required checks pass. Keep writes and Queues running; fixed drain waits and extended monitoring belong only to a concrete coordinated-maintenance requirement. Resolve uncertain provider outcomes and report failed checks rather than treating elapsed time alone as a release failure.

`repo-clean` intentionally deletes non-kept local and remote branches, worktrees, and stashes. Its policy is tested only in disposable temporary repositories; review `scripts/repo-clean.sh` before invoking it in a real checkout.

## Package boundaries

- `@mons/shared` is the only local runtime package dependency at the root and preserves its public subpath exports for both browser and backend consumers.
- Portable CommonJS cloud modules stay separately installable for their test lifecycle and Worker bundling boundaries.
- Cloud admin tools remain independently installable and use explicit read-only D1 credentials.
- TypeScript and framework type declarations are build-only root development dependencies.

No release command is implied by a build or test command. Production changes use candidate uploads, explicit version promotion, and targeted live checks. The initial reaction Durable Object namespace bootstrap and final Firebase rules cutover are historical one-time maintenance procedures; ordinary compatible releases use the routine path.
