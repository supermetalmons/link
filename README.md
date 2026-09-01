# mons.link

mons.link is a browser game backed by Firebase Auth, Realtime Database, and two Cloudflare Workers. The repository keeps the browser, backend, shared contracts, operational tools, and deployment drivers in their existing runtime boundaries.

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

The frontend Worker is configured by `wrangler.jsonc`. The API Worker has its independent configuration under `cloud/workers/api/`. Firebase Auth and Realtime Database remain active, while canonical profile, auth-state, Telegram, projection, and withdrawal data are D1-backed. Realtime Database rules live under `cloud/`; Firestore and Firebase Functions are not deployed.

## Setup and development

Use Node.js 24 and Java 21 or newer, then install the pinned root and Functions dependencies:

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
| `npm run upload:api`                                       | Upload an API candidate without sending it production traffic.                             |
| `npm run deploy:firebase -- --project mons-link --dry-run` | Preview the Realtime Database rules release.                                               |
| `npm run repo-clean`                                       | Apply the documented destructive branch/worktree cleanup policy to the current repository. |

Production deployment commands, token handling, smoke checks, schema maintenance, and incident freezes are documented in [Cloudflare deployment](scripts/deploy-cloudflare.md). Firebase release, Telegram recovery, and admin operations are documented in [cloud operations](cloud/README.md).

`repo-clean` intentionally deletes non-kept local and remote branches, worktrees, and stashes. Its policy is tested only in disposable temporary repositories; review `scripts/repo-clean.sh` before invoking it in a real checkout.

## Package boundaries

- `@mons/shared` is the only local runtime package dependency at the root and preserves its public subpath exports for both browser and backend consumers.
- Portable CommonJS cloud modules stay separately installable for their test lifecycle and Worker bundling boundaries.
- Cloud admin tools remain independently installable and use explicit read-only D1 credentials.
- TypeScript and framework type declarations are build-only root development dependencies.

No release command is implied by a build or test command. Production changes use candidate uploads, explicit version promotion, and documented smoke checks.
