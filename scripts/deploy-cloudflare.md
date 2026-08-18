# Cloudflare deployment

See the repository [architecture and command map](../README.md) for local validation lanes. Firebase releases, Telegram recovery, and admin operations are documented in [cloud operations](../cloud/README.md).

## Frontend

- Use Node.js 24 or newer.
- Install dependencies: `npm install`
- Copy `.env.example` to `.env.local` for optional local overrides.
- Run the local development server: `npm start`
- Build the production frontend: `npm run build`

## Deployment

The frontend is an asset-only Cloudflare Worker named `mons-link`. Firebase
Authentication, Realtime Database, Firestore, and Cloud Functions remain
independently deployed to Firebase.

- Validate the frontend build and Wrangler configuration without authenticating:
  `npm run deploy -- dry-run`
- Upload a non-production Worker version:
  `npm run deploy -- preview --token-file /path/to/cloudflare-token`
- Build, upload, and immediately deploy a new production Worker version:
  `npm run deploy -- production`
- Smoke-test the unique Version Preview URL printed by Wrangler, then promote the
  Version ID printed by the same command to `mons.link`:
  `npm run deploy -- production --version-id <candidate-version-id> --token-file /path/to/cloudflare-token`

The token file must contain only a scoped Cloudflare API token. Alternatively,
set `CLOUDFLARE_API_TOKEN` in the invoking shell. The deploy helper removes
Cloudflare credentials, Wrangler settings, and local `VITE_*` overrides from the
frontend build environment. Vite writes to `build`, the helper sets
`VITE_BUILD_DATETIME`, and only passes the token to the Wrangler subprocess.
Candidate builds therefore use the committed Firebase and Apple client
fallbacks; no Worker runtime variables are required.

Production with `--version-id` does not rebuild or upload assets. It promotes the
already tested Version ID, so the preview and production artifacts are
identical. Without `--version-id`, the helper builds and uploads a fresh version,
reads its generated ID from Wrangler's structured output, and deploys it at 100%
traffic. Use the unique version URL for smoke testing rather than a reusable
preview alias. If the preview upload fails, stop before production. Always use
the unmodified pinned Wrangler; do not work around an asset upload error by
borrowing another Worker's asset namespace.

Routine releases do not change routes or domains. If `wrangler.jsonc` routing is
changed, review that change separately and apply it with
`node_modules/.bin/wrangler triggers deploy --config wrangler.jsonc`.

To roll back, provide `CLOUDFLARE_API_TOKEN`, inspect
`node_modules/.bin/wrangler deployments list --config wrangler.jsonc`, and run
`node_modules/.bin/wrangler rollback <known-good-production-version-id> --config wrangler.jsonc`.
Always supply a version ID so the selected rollback target is explicit and can
be checked before it receives production traffic.

The former Amplify app and CloudFront DNS target were retired after the
migration, so application rollbacks must use an explicit Worker version.

There is currently no `.well-known` asset in this frontend. SPA fallback can
serve `index.html` with HTTP 200 for a missing path, so status alone does not
prove that a future `.well-known` file exists. If one is added under
`public/.well-known/`, verify its response body and content type during smoke
testing.

## NFT API

The NFT lookup API is a separate Worker named `mons-link-api`, configured in
`cloud/workers/api/wrangler.jsonc` and served from `api.mons.link`. Its release
does not change the frontend Worker or its `mons.link` route.

- Generate its binding types: `npm run types:api`
- Run its complete local validation: `npm run check:api`
- Upload, validate, and smoke-test an undeployed candidate:
  `npm run deploy:api -- preview --smoke-sol <known-wallet> --token-file /path/to/cloudflare-token`
- Promote that exact candidate and smoke-test the custom domain:
  `npm run deploy:api -- production --version-id <candidate-version-id> --smoke-sol <known-wallet> --token-file /path/to/cloudflare-token`

`HELIUS_RPC_API_KEY` is a required encrypted Worker secret. Keep its value out
of source, Wrangler configuration, shell arguments, and logs. Routine version
uploads inherit the existing encrypted secret, and Wrangler rejects an upload
when a name declared in `secrets.required` is missing. Do not create or pass a
Helius secrets file during routine releases.

The release helper passes the tracked, comment-only
`cloud/workers/api/release.env` to Wrangler with `--env-file`. This file must
remain free of values and credentials; it exists only to prevent release
commands from automatically loading developer `.env` or `.env.local` files.
Cloudflare authentication still comes from `--token-file` or the invoking
shell as described below.

The helper uses the pinned local Wrangler, requires an explicit production
version, and does not upload from production mode. Its smoke checks cover CORS,
the exact empty-wallet response, and a non-empty wallet that exercises Helius.
The wallet is sent only in the POST body and is not printed. Pass
`CLOUDFLARE_API_TOKEN` in the invoking shell instead of `--token-file` when
preferred.

The API accepts only `POST /nfts` plus CORS preflight requests. Request bodies
larger than 4096 bytes return `400`, as do malformed JSON, invalid field types,
and invalid non-empty Solana addresses. The Helius secret must remain in
Firebase because event prize withdrawals also use it. Helius response bodies
over 8 MiB are rejected as generic provider failures.

Routine releases do not change routes or domains. If the API `routes`
configuration is intentionally changed, review it separately and apply it with
`npm run deploy:api:triggers -- --token-file /path/to/cloudflare-token`, or set
`CLOUDFLARE_API_TOKEN` in the invoking shell and omit `--token-file`.

## X OAuth callback

The API Worker also serves `GET https://api.mons.link/auth/x/callback`. It
exchanges the X authorization code, reads and updates the existing
`xAuthRedirectFlows` Firestore document through the Firestore REST API, and
redirects to the flow's validated `mons.link` return URL. The flow creator and
completion callable remain in Firebase. No Cloudflare storage resource is used.

Register `https://api.mons.link/auth/x/callback` as an exact callback URI in the
X application before deploying the Firebase flow-creator change. X client IDs,
client secrets, authorization codes, access tokens, PKCE verifiers, service
account keys, and raw flow IDs must not appear in source, arguments, or logs.

Create a dedicated Google service account and project custom role for the
callback. The role must contain only `datastore.entities.get` and
`datastore.entities.update`, and its project binding must be conditioned on the
default `mons-link` Firestore database:

```sh
gcloud iam roles create monsLinkXCallback --project mons-link --title="mons.link X callback" --permissions=datastore.entities.get,datastore.entities.update --stage=GA
gcloud iam service-accounts create mons-link-x-callback --project mons-link --display-name="mons.link X callback"
gcloud projects add-iam-policy-binding mons-link --member="serviceAccount:mons-link-x-callback@mons-link.iam.gserviceaccount.com" --role="projects/mons-link/roles/monsLinkXCallback" --condition='expression=resource.name=="projects/mons-link/databases/(default)",title=default-firestore-only'
gcloud iam service-accounts keys create /secure/mons-link-x-callback.json --project mons-link --iam-account=mons-link-x-callback@mons-link.iam.gserviceaccount.com
```

Prepare an untracked dotenv file outside the repository containing the existing
X application credentials and the `client_email` and `private_key` values from
the generated service-account key:

```dotenv
X_CLIENT_ID=...
X_CLIENT_SECRET=...
FIRESTORE_SERVICE_ACCOUNT_EMAIL=mons-link-x-callback@mons-link.iam.gserviceaccount.com
FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Upload the first candidate with those secrets attached to that undeployed
version:

```sh
npm run deploy:api -- preview --smoke-sol <known-wallet> --secrets-file /secure/mons-link-x-callback.env --token-file /path/to/cloudflare-token
```

The secrets file is accepted only in preview mode and is passed directly to
`wrangler versions upload`; the release helper never reads or prints it.
Existing secrets omitted from the file, including `HELIUS_RPC_API_KEY`, remain
attached. Delete the local secrets file and the downloaded service-account JSON
after the candidate has been promoted and the values are stored as encrypted
Worker secrets.

Preview and production smoke checks cover the NFT API, callback routing without
a state value, and a random absent state that proves Google OAuth and Firestore
read access. A real X code is intentionally not used by automated smoke checks.
After production promotion, exercise X sign-in and settings linking manually,
including provider denial.

This migration uses an immediate cutover. Deploy and smoke-test the Worker
candidate first, then deploy the Firebase release that writes the new callback
URI and reconciles away the former `xAuthRedirectCallback` function. Flows
opened against the former Firebase URI may fail and must be retried. After
verification, remove the former URI from X and remove the obsolete Firebase-side
`X_CLIENT_SECRET` configuration.

For rollback, retain the pre-cutover Firebase commit and the prior API Worker
version ID. Restore the former callback URI in X, redeploy the callback export
from that commit, then roll back the API Worker if needed.

## Firebase deployment

- Deploy the complete Firebase release: `npm run deploy:firebase -- --project mons-link`
- See `cloud/README.md` for dry-run, batch-size, and maintenance commands.
