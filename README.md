# mons.link

mons.link is a browser game backed by Cloudflare sessions, D1, SQLite Durable Objects, and two Cloudflare Workers.

## Project map

| Path                    | Responsibility                                                    | Runtime                  |
| ----------------------- | ----------------------------------------------------------------- | ------------------------ |
| `src/`                  | React UI, game orchestration, sessions, assets, and API clients   | Vite / browser           |
| `test/`                 | Client behavior and contract tests                                | Node                     |
| `cloud/runtime/src/`    | TypeScript source for portable logic and shared contracts         | Compiled to CommonJS     |
| `cloud/runtime/`        | Generated portable runtime modules and declarations               | CommonJS / Worker bundle |
| `cloud/runtime/shared/` | Generated `@mons/shared` package and direct subpath exports       | Browser and backend      |
| `cloud/workers/api/`    | API Worker, Durable Objects, D1 schemas, Queues, and Workflows    | Cloudflare               |
| `cloud/tests/`          | Portable runtime behavior tests                                   | Node                     |
| `cloud/admin/`          | Explicit canonical D1 reads and signed operator commands          | Node                     |
| `scripts/`              | Validation, candidate releases, smokes, and maintenance operators | Node                     |

## Runtime architecture

The frontend Worker serves `mons.link`; the API Worker serves `api.mons.link`. Persistent sessions live in `AUTH_STATE_DB`, with five-minute Worker-issued access tokens. `PROFILE_DB.profile_login_owners` maps login IDs to canonical profiles. Startup requests `bootstrapIdentity=1` with session creation or refresh to read the verified profile alongside the token, before loading the main application. `GET /auth/identity` provides the same read-only profile lookup. `POST /auth/profile/sync` provides explicit canonical profile repair and restoration. Startup uses the verified identity route; unavailable inline enrichment falls back to a read-only identity request.

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

Edit portable runtime code in `cloud/runtime/src/`, including shared rules in `cloud/runtime/src/shared/`. Run `npm run generate:runtime` after edits and commit the generated JavaScript and declarations alongside the source. For active development, run `npm run watch:runtime` in a second terminal. The existing CommonJS modules and `@mons/shared` import paths remain the consumer interface.

## Commands

| Command                                    | Purpose                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `npm start`                                | Start Vite development mode.                                                            |
| `npm run check`                            | Run client lint, typecheck, and tests.                                                  |
| `npm run build`                            | Validate and build the frontend into `build/`.                                          |
| `npm run check:api`                        | Validate Worker formatting, lint, types, tests, generated bindings, and upload dry-run. |
| `npm run check:tooling`                    | Validate deployment, maintenance, admin, and architecture tooling.                      |
| `npm run test:runtime`                     | Run portable runtime tests.                                                             |
| `npm run generate:runtime`                 | Compile checked runtime source and update generated modules and declarations.           |
| `npm run check:runtime`                    | Lint runtime source, typecheck it, and reject stale, missing, or orphaned outputs.      |
| `npm run watch:runtime`                    | Regenerate runtime outputs as source files change.                                      |
| `npm run check:all`                        | Run the complete repository gate.                                                       |
| `npm run inspect:state -- --domain wagers` | Inspect wager activation, maintenance, and retained state.                              |
| `npm run manage:match-state -- --status`   | Inspect canonical gameplay authority and retained evidence.                             |
| `npm run manage:invite-source -- --status` | Inspect invite authority and unresolved-work counts.                                    |
| `npm run upload:api`                       | Upload an API candidate without sending production traffic.                             |
| `npm run deploy -- preview`                | Build, validate, and upload a frontend candidate.                                       |
| `npm run repo-clean`                       | Apply the documented destructive branch/worktree cleanup policy.                        |

Production release and maintenance procedures are in [Cloudflare deployment](scripts/deploy-cloudflare.md). Telegram recovery and admin operations are in [cloud operations](cloud/README.md).

Routine releases have no overall time limit. Prepare validated candidates, promote exact versions, and verify affected behavior. Allow necessary provider propagation and retries, keep writes and Queues running, and finish after required checks pass. Do not add verification-only waits or observation windows longer than 60 seconds.

No build or test command implies a release. Public reaction sockets use `mons-reactions-v2` with an explicit match ID. Stored historical formats remain supported independently of retired client protocols. `repo-clean` deletes non-kept branches, worktrees, and stashes; inspect its documented policy before use.

## Package boundaries

`@mons/shared` is the only local runtime package dependency at the root. It preserves direct subpath exports and browser-safe CommonJS modules with matching generated declarations. All portable runtime implementations and types originate in `cloud/runtime/src/`; edit that source instead of generated files. Frontend builds, API upload dry-runs, and API candidate uploads check generation freshness before proceeding. Portable runtime modules and admin tools remain separately installable; TypeScript and framework declarations are development dependencies. Provider-specific historical values are confined to compatibility codecs, applied migrations, and explicit regression guards.
