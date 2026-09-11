# mons.link

mons.link is a browser game backed by Cloudflare sessions, D1, SQLite Durable Objects for active gameplay, and two Cloudflare Workers. The repository keeps the browser, backend, shared contracts, operational tools, and deployment drivers in their existing runtime boundaries.

## Project map

| Path                      | Responsibility                                                                               | Runtime            |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| `src/`                    | React UI, game orchestration, session client, assets, and browser services                   | Vite / browser     |
| `test/`                   | Client behavior and contract tests                                                           | Node test runner   |
| `cloud/functions/`        | Portable backend modules shared with the API Worker                                          | CommonJS           |
| `cloud/functions/shared/` | Browser-safe `@mons/shared/*` contract subpaths                                              | CommonJS package   |
| `cloud/workers/api/`      | NFT, profile, customization, leaderboard, gameplay, event, ratings, mining, auth, and X APIs | Cloudflare Workers |
| `cloud/admin/`            | Manually invoked production administration tools                                             | Node / D1          |
| `scripts/`                | Deployment, repository maintenance, architecture, and tooling contracts                      | Node and Bash      |

The frontend Worker is configured by `wrangler.jsonc`. The API Worker has its independent configuration under `cloud/workers/api/`. Cloudflare issues browser sessions. The per-invite `InviteReactions` Durable Object owns both participants' canonical match records, timer claims, and live snapshot delivery. Invite metadata moves through the separately controlled `PROFILE_GAMES_DB.invite_sources` authority. Voice and sticker reactions use one SQLite-backed `InviteReactions` Durable Object per invite with public read-only WebSocket subscriptions and authenticated HTTP publishing. Canonical event, profile, auth-state, Telegram, projection, withdrawal, wager state and reservations, automatch queue and lifecycle, session receipt, game-session lock, and timer-start data are D1-backed. Session lifecycle transitions preserve idempotent create-only Durable Object match effects and commit D1 invite metadata with their receipts and outboxes. Event transitions use durable receipts across the event and gameplay databases. Navigation is served from the Worker and profile-game D1 cache without an RTDB reconstruction fallback. Retained Realtime Database data is historical evidence; its client rules under `cloud/` deny all reads and writes. Firestore and Firebase Functions are not deployed.

Move submission and surrender use the authenticated `POST /matches/move` and `POST /matches/surrender` APIs. The Worker authorizes the match actor through canonical ownership and changes only permitted fields through typed Durable Object operations. Move delivery journals pending actions in the tab, including takebacks, and sends cumulative histories with FEN checkpoints. The Worker can recover missing intermediate actions, acknowledge older requests without rolling state backward, and preserve concurrent timer/status changes. Pending actions survive same-match reconnects and reloads; dependent game mutations wait for delivery. The Durable Object commits terminal timer claims atomically with their durable effects and fences competing moves and surrenders. Timer starts retain their existing D1 first-deadline markers and revalidate both records before committing. Live match subscriptions use the invite Durable Object through `mons-match-sync-v1`. Older clients must update to submit moves and surrender.

Reconnect recovery and post-retry move verification read individual matches through the public `GET /matches/snapshot?playerId=…&matchId=…` API. The Worker resolves the exact actor/match route in D1 and reads canonical Durable Object data, or the immutable D1 archive for retained orphan records. It returns only validated match fields with caching disabled and never falls back to Firebase. Only an absent source record returns `match: null`; source failures and malformed records return an error. Live match delivery uses `GET /invites/:inviteId/matches/:matchId/socket` with `mons-match-sync-v1`; the corresponding `/snapshot` endpoint provides revisioned HTTP recovery for both players together. The browser has no Realtime Database subscription or delivery fallback.

The same Durable Object owns live per-match emoji/aura updates, with revisioned HTTP mutations and v2 WebSocket snapshots. Canonical match records retain immutable appearance seeds. Historical D1 pairs capture appearance once during archival; later live changes do not alter those snapshots. Actor registration and live/history appearance use Durable Object authority; Direct Firebase access remains blocked.

Invite/lobby and rematch reads use the API's metadata snapshots and a separate `mons-invite-metadata-v1` WebSocket subscription in the existing invite Durable Object. Wager reads use invite-wide HTTP snapshots and `mons-invite-wagers-v1`, preserving historical rematch displays while excluding internal settlement records. After invite-source activation, invite metadata is canonical in `mons-link-profile-games` D1; wager proposals, agreements, settlement state, and resolution markers remain canonical in `mons-link-profiles` D1. The Worker combines these sources without a Firebase fallback. Server mutations request immediate updates. One shared alarm reconciles subscribed live matches every second and invite metadata/wagers every five seconds to recover missed notifications. Each channel keeps independent snapshots and revisions. Match mutations and reads use Durable Object authority exclusively; routine operations do not write cutover admission records.

Account-link game discovery uses only the activated `PROFILE_GAMES_DB.login_match_discovery` index, with no Firebase discovery fallback. It covers login UIDs independently of profile ownership, including games played anonymously before account linking. Its original migration streamed protected Firebase key inventories while gameplay and Queues stayed active. See [the completed discovery cutover](scripts/deploy-cloudflare.md#account-link-game-discovery-cutover). Initial discovery, automatch, and wager migration commands are retired; their status and current recovery operations remain available.

The [invite-source cutover](scripts/deploy-cloudflare.md#invite-source-d1-cutover) is complete. `npm run manage:invite-source -- --status` reports D1 authority and unresolved-work counts; admission inspection and reconciliation remain available for current recovery. Session transitions require D1 invite authority and publish v2 intents while preserving idempotent create-only match effects in Durable Objects. The completed migration commands are retired.

The completed wager-state migration is recorded in the [cutover history](scripts/deploy-cloudflare.md#wager-state-d1-cutover). Retained Firebase invites, reactions, wagers, and profile links now deny client reads and writes, including clients with admin claims. Current clients use Worker APIs for these records. Firebase profile links are no longer read or maintained by runtime code; canonical ownership transactions in D1 own profile-link catch-up. Later compatible releases use the routine release path.

Cloudflare issues persistent anonymous sessions backed by `AUTH_STATE_DB` and five-minute access tokens. Firebase browser sessions are retired with an immediate cutoff and no token bridge. Returning linked users sign in again to recover their canonical profile; old unlinked guest identities are not recovered. Firebase custom `profileId` claims are retired from the browser and Worker runtime; existing stored claims remain untouched. Current clients use `POST /auth/profile/sync` to resolve canonical D1 ownership, repair profile presentation, and dispatch existing D1 catch-up work. The legacy `POST /auth/profile-claim/sync` URL remains a compatibility alias for the same D1 operation. Neither route looks up Firebase accounts or changes their claims.

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
| `npm run test:database-rules`                  | Verify deny-all Firebase client rules and retained privileged evidence access against the emulator.                      |
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
