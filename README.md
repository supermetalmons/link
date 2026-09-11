# mons.link

mons.link is a browser game backed by Cloudflare sessions, D1, SQLite Durable Objects, and two Cloudflare Workers.

## Project map

| Path                    | Responsibility                                                    | Runtime                  |
| ----------------------- | ----------------------------------------------------------------- | ------------------------ |
| `src/`                  | React UI, game orchestration, sessions, assets, and API clients   | Vite / browser           |
| `test/`                 | Client behavior and contract tests                                | Node                     |
| `cloud/runtime/`        | Portable event, prize, Telegram, and projection logic             | CommonJS / Worker bundle |
| `cloud/runtime/shared/` | Deterministic rules and wire contracts consumed as `@mons/shared` | Browser and backend      |
| `cloud/workers/api/`    | API Worker, Durable Objects, D1 schemas, Queues, and Workflows    | Cloudflare               |
| `cloud/tests/`          | Portable runtime behavior tests                                   | Node                     |
| `cloud/admin/`          | Explicit canonical D1 reads and signed operator commands          | Node                     |
| `scripts/`              | Validation, candidate releases, smokes, and maintenance operators | Node                     |

## Runtime architecture

The frontend Worker serves `mons.link`; the API Worker serves `api.mons.link`. Persistent sessions live in `AUTH_STATE_DB`, with five-minute Worker-issued access tokens. `PROFILE_DB.profile_login_owners` maps login IDs to canonical profiles. `POST /auth/profile/sync` restores canonical ownership and existing catch-up work; the legacy `POST /auth/profile-claim/sync` URL remains a compatibility alias.

The existing per-invite `InviteReactions` Durable Object owns active matches, timer claims, reactions, and live appearance. It delivers revisioned match, metadata, wager, reaction, and presentation snapshots over HTTP and WebSockets. Match routes and immutable archived records remain in gameplay D1. A missing route returns `match: null`; an existing route with unavailable canonical state returns a retryable error.

Move and surrender APIs authorize the canonical actor and use typed Durable Object mutations. Cumulative moves and takebacks preserve replay, timer fences, and committed downstream effects. Browser journals survive same-match reconnects and reloads. Session transitions coordinate create-only match effects with D1 invite metadata, receipts, and outboxes.

Invite metadata, automatch, profile-game discovery and projections, wagers and reservations, events, prize withdrawals, and Telegram delivery use D1. Scheduled sweeps and Queues recover durable work. Historical match pairs, rating-completion records, existing IDs, applied SQL migrations, and serialized receipt formats remain application data and must be preserved.

## Setup and development

Use Node.js 24 or newer:

```sh
npm ci
npm ci --prefix cloud/runtime
npm start
```

Copy `.env.example` to `.env.local` only when local overrides are needed. Developer environment files and credentials are not release inputs.

## Commands

| Command                                    | Purpose                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `npm start`                                | Start Vite development mode.                                                            |
| `npm run check`                            | Run client lint, typecheck, and tests.                                                  |
| `npm run build`                            | Validate and build the frontend into `build/`.                                          |
| `npm run check:api`                        | Validate Worker formatting, lint, types, tests, generated bindings, and upload dry-run. |
| `npm run check:tooling`                    | Validate deployment, maintenance, admin, and architecture tooling.                      |
| `npm run test:runtime`                     | Run portable runtime tests.                                                             |
| `npm run check:all`                        | Run the complete repository gate.                                                       |
| `npm run manage:match-state -- --status`   | Inspect canonical gameplay authority and retained evidence.                             |
| `npm run manage:invite-source -- --status` | Inspect invite authority and unresolved-work counts.                                    |
| `npm run upload:api`                       | Upload an API candidate without sending production traffic.                             |
| `npm run deploy -- preview`                | Build, validate, and upload a frontend candidate.                                       |
| `npm run repo-clean`                       | Apply the documented destructive branch/worktree cleanup policy.                        |

Production release and maintenance procedures are in [Cloudflare deployment](scripts/deploy-cloudflare.md). Telegram recovery and admin operations are in [cloud operations](cloud/README.md).

Routine releases have no overall time limit. Prepare validated candidates, promote exact versions, and verify affected behavior. Allow necessary provider propagation and retries, keep writes and Queues running, and finish after required checks pass. Do not add verification-only waits or observation windows longer than 60 seconds.

No build or test command implies a release. Preserve public contracts for already-loaded clients. `repo-clean` deletes non-kept branches, worktrees, and stashes; inspect its documented policy before use.

## Package boundaries

`@mons/shared` is the only local runtime package dependency at the root. It preserves direct subpath exports and browser-safe CommonJS modules with matching declarations. Portable runtime modules and admin tools remain separately installable; TypeScript and framework declarations are development dependencies. Provider-specific historical values are confined to compatibility codecs, applied migrations, and explicit regression guards.
