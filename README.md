# mons.link

mons.link is a browser game backed by Firebase and two Cloudflare Workers. The repository keeps the browser, backend, shared contracts, operational tools, and deployment drivers in their existing runtime boundaries.

## Project map

| Path                      | Responsibility                                                                | Runtime                       |
| ------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| `src/`                    | React UI, game orchestration, Firebase client, assets, and browser services   | Vite / browser                |
| `test/`                   | Client behavior and contract tests                                            | Node test runner              |
| `cloud/functions/`        | Callable, HTTP, task, schedule, and database-triggered backend functions      | Firebase Functions / CommonJS |
| `cloud/functions/shared/` | Browser-safe `@mons/shared/*` contract subpaths                               | CommonJS package              |
| `cloud/workers/api/`      | NFT, profile, leaderboard, gameplay, event, ratings, mining, auth, and X APIs | Cloudflare Workers            |
| `cloud/admin/`            | Manually invoked production administration tools                              | Node / Firebase Admin         |
| `scripts/`                | Deployment, repository maintenance, architecture, and tooling contracts       | Node and Bash                 |

The frontend Worker is configured by `wrangler.jsonc`. The API Worker has its independent configuration under `cloud/workers/api/`. Firebase configuration, rules, indexes, and deployment entrypoints remain under `cloud/`.

## Setup and development

Use Node.js 24 or newer, then install the pinned root and Functions dependencies:

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

| Command                 | Purpose                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run check:api`     | Format, lint, typecheck, test, type-generation check, and dry-run the API Worker.                                        |
| `npm run check:tooling` | Validate deployment drivers, project contracts, admin parsing, repository cleanup fixtures, and dependency architecture. |
| `npm run check:all`     | Run the repository-wide validation gate, including Firebase Functions tests.                                             |
| `npm run format:check`  | Check repository formatting without writing files.                                                                       |

### Deployment and maintenance

| Command                                                    | Purpose                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run deploy -- dry-run`                                | Build and validate the frontend Worker without authentication.                             |
| `npm run deploy:api -- preview ...`                        | Upload and smoke-test an API candidate.                                                    |
| `npm run deploy:firebase -- --project mons-link --dry-run` | Preview the complete Firebase release plan.                                                |
| `npm run repo-clean`                                       | Apply the documented destructive branch/worktree cleanup policy to the current repository. |

Production deployment commands, token handling, smoke checks, and rollback procedures are documented in [Cloudflare deployment](scripts/deploy-cloudflare.md). Firebase release, Telegram recovery, and admin operations are documented in [cloud operations](cloud/README.md).

`repo-clean` intentionally deletes non-kept local and remote branches, worktrees, and stashes. Its policy is tested only in disposable temporary repositories; review `scripts/repo-clean.sh` before invoking it in a real checkout.

## Package boundaries

- `@mons/shared` is the only local runtime package dependency at the root and preserves its public subpath exports for both browser and backend consumers.
- Firebase Functions remain a separate CommonJS package with their own install, test, and safe-deployment lifecycle.
- Cloud admin tools remain independently installable so Firebase Admin credentials are never required for browser or Worker development.
- TypeScript and framework type declarations are build-only root development dependencies.

No release command is implied by a build or test command. Use the documented dry-run modes before any authenticated operation.
