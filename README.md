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

The frontend Worker serves `mons.link`; the API Worker serves `api.mons.link`. Persistent sessions live in `AUTH_STATE_DB`, with five-minute Worker-issued access tokens. `PROFILE_DB.profile_login_owners_canonical` maps login IDs to canonical profiles. Startup requests `bootstrapIdentity=1` with session creation or refresh to read the verified profile alongside the token, before loading the main application. `GET /auth/identity` provides the same read-only profile lookup. `POST /auth/profile/sync` provides explicit canonical profile repair and restoration. Startup uses the verified identity route; unavailable inline enrichment falls back to a read-only identity request.

The existing per-invite `InviteReactions` Durable Object owns active matches, timer claims, reactions, and live appearance. It delivers revisioned match, metadata, wager, reaction, and presentation snapshots over HTTP and WebSockets. Match routes and immutable archived records remain in gameplay D1. A missing route returns `match: null`; an existing route with unavailable canonical state returns a retryable error.

Timer starts use verified local storage in the invite object. Fresh rooms initialize atomically; existing rooms require verified layout metadata and permanent writer guards. See [canonical timer storage](scripts/deploy-cloudflare.md#canonical-timer-storage) for its invariants and release checks.

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

| Command                                    | Purpose                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `npm start`                                | Start Vite development mode.                                                             |
| `npm run check`                            | Run client lint, typecheck, and tests.                                                   |
| `npm run build`                            | Validate and build the frontend into `build/`.                                           |
| `npm run check:api`                        | Validate Worker formatting, lint, types, tests, generated bindings, and upload dry-run.  |
| `npm run check:tooling`                    | Validate deployment, maintenance, admin, and architecture tooling.                       |
| `npm run test:runtime`                     | Run portable runtime tests.                                                              |
| `npm run generate:runtime`                 | Compile checked runtime source and update generated modules and declarations.            |
| `npm run check:runtime`                    | Lint runtime source, typecheck it, and reject stale, missing, or orphaned outputs.       |
| `npm run watch:runtime`                    | Regenerate runtime outputs as source files change.                                       |
| `npm run check:unused`                     | Check unused files, exports, types, and dependencies, including production reachability. |
| `npm run check:all`                        | Run the complete repository gate.                                                        |
| `npm run inspect:state -- --domain wagers` | Inspect wager activation, maintenance, and retained state.                               |
| `npm run manage:match-state -- --status`   | Inspect canonical gameplay authority and retained evidence.                              |
| `npm run manage:invite-source -- --status` | Inspect invite authority and unresolved-work counts.                                     |
| `npm run upload:api`                       | Upload an API candidate without sending production traffic.                              |
| `npm run deploy -- preview`                | Build, validate, and upload a frontend candidate.                                        |
| `npm run repo-clean`                       | Apply the documented destructive branch/worktree cleanup policy.                         |

Production release and maintenance procedures are in [Cloudflare deployment](scripts/deploy-cloudflare.md). Telegram recovery and admin operations are in [cloud operations](cloud/README.md). The [canonical cleanup report](cloud/reports/canonical-cleanup-2026-11-01.md) preserves the completed migration history and evidence.

No build or test command implies a release. Public reaction sockets use `mons-reactions-v2` with an explicit match ID. Stored historical formats remain supported independently of retired client protocols. `repo-clean` deletes non-kept branches, worktrees, and stashes; inspect its documented policy before use.

## Package boundaries

`@mons/shared` is the only local runtime package dependency at the root. It preserves direct subpath exports and browser-safe CommonJS modules with matching generated declarations. All portable runtime implementations and types originate in `cloud/runtime/src/`; edit that source instead of generated files. Frontend builds, API upload dry-runs, and API candidate uploads check generation freshness before proceeding. Portable runtime modules and admin tools remain separately installable; TypeScript and framework declarations are development dependencies. Provider-specific historical values are confined to compatibility codecs, applied migrations, and explicit regression guards.

The complete gate reaches `check:runtime` through the API dry-run's npm lifecycle hook. Compiler coverage follows those hooks so runtime tests stay checked without repeating the runtime validation lane, and rejects runs with hooks disabled (`ignore-scripts`). Browser suites in `test/*.browser.mjs` run separately from the Node tests in `check:all`.

## Unused-code checks

`npm run check:unused` runs pinned Knip against the complete repository, then checks production-only file reachability. Both passes must be clean. Tests count as consumers in the first pass; the second catches application modules kept alive only by tests. Duplicate aliases are outside this gate's scope.

`knip.json` lists browser and Web Worker entrypoints, Cloudflare's Worker exports, executable operator/admin commands, the Vite event-metadata build plugin, test runners, and browser-injected harnesses and Vite replacements. Keep this list aligned with actual consumers; do not add whole source directories as entries to suppress findings. Explicit production entries also appear in the full graph, so redundant-pattern hints are hidden; unused-code findings still fail the command.

Runtime and shared-package TypeScript `rootDir`/`outDir` settings map generated imports back to authored source. Generated JavaScript and declarations are not independent project files; the shared package's public subpath exports remain supported entrypoints. Generation freshness is enforced separately by `check:runtime`.

The only symbol-level exceptions use `@knipExternal` with their hidden consumer documented: `AppSessionManager.transition` and `bottomControlsPort.toggleReactionPicker` are called by injected browser fixtures; `shinyCardModels.UndoIntent` is used by a generated TypeScript probe. New exceptions require a concrete consumer, not an outstanding-findings baseline. `scripts/unused-code.test.ts` verifies clean entrypoints and source mapping, seeded unused files/exports/dependencies, and test-only module detection.
