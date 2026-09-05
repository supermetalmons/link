const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  spawnSync,
}: typeof import("node:child_process") = require("node:child_process");
const {
  existsSync,
  readFileSync,
}: typeof import("node:fs") = require("node:fs");
const { resolve }: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const typescript: typeof import("typescript") = require("typescript");

type PackageManifest = {
  name?: string;
  main?: string;
  private?: boolean;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  exports?: Record<string, string>;
};

type WranglerConfig = {
  name?: string;
  account_id?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  preview_urls?: boolean;
  assets?: Record<string, unknown>;
  routes?: Array<Record<string, unknown>>;
  secrets?: { required?: string[] };
  vars?: Record<string, string>;
  d1_databases?: Array<Record<string, unknown>>;
  durable_objects?: Record<string, unknown>;
  exports?: Record<string, unknown>;
  migrations?: Array<Record<string, unknown>>;
  ratelimits?: Array<Record<string, unknown>>;
  queues?: Record<string, unknown>;
  workflows?: Array<Record<string, unknown>>;
  triggers?: Record<string, unknown>;
  observability?: Record<string, unknown>;
};

const repositoryRoot = resolve(__dirname, "..");

function readText(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

function readJsonc(relativePath: string): WranglerConfig {
  const parsed = typescript.parseConfigFileTextToJson(
    relativePath,
    readText(relativePath),
  );
  if (parsed.error) {
    assert.fail(
      typescript.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
    );
  }
  return parsed.config as WranglerConfig;
}

test("Pages Wrangler configuration preserves its public route and asset contract", () => {
  const config = readJsonc("wrangler.jsonc");

  assert.equal(config.name, "mons-link");
  assert.equal(config.account_id, "e25f90fc073ea309b54b8b5144bf28e0");
  assert.equal(config.compatibility_date, "2026-08-05");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, true);
  assert.deepEqual(config.assets, {
    directory: "./build",
    not_found_handling: "single-page-application",
  });
  assert.deepEqual(config.routes, [
    { pattern: "mons.link", custom_domain: true },
  ]);
});

test("API Wrangler configuration preserves its route, secrets, and bindings", () => {
  const config = readJsonc("cloud/workers/api/wrangler.jsonc");

  assert.equal(config.name, "mons-link-api");
  assert.equal(config.account_id, "e25f90fc073ea309b54b8b5144bf28e0");
  assert.equal(config.main, "src/index.ts");
  assert.equal(config.compatibility_date, "2026-08-09");
  assert.deepEqual(config.compatibility_flags, ["nodejs_compat"]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [
    { pattern: "api.mons.link", custom_domain: true },
  ]);
  assert.deepEqual(config.exports, {
    InviteReactions: { type: "durable-object", storage: "sqlite" },
  });
  assert.deepEqual(config.durable_objects, {
    bindings: [{ name: "INVITE_REACTIONS", class_name: "InviteReactions" }],
  });
  assert.equal(config.migrations, undefined);
  assert.deepEqual(config.workflows, [
    {
      binding: "EVENT_PROGRESS_WORKFLOW",
      name: "mons-link-event-progress",
      class_name: "EventProgressWorkflow",
    },
    {
      binding: "EVENT_PRIZE_WITHDRAWAL_WORKFLOW",
      name: "mons-link-event-prize-withdrawal",
      class_name: "EventPrizeWithdrawalWorkflow",
    },
  ]);
  assert.deepEqual(Object.keys(config.vars || {}).sort(), [
    "APPLE_AUDIENCES",
    "AUTH_MUTATIONS_DISABLED",
    "FIREBASE_RTDB_URL",
  ]);
  assert.equal(config.vars?.APPLE_AUDIENCES, "link.mons");
  assert.match(config.vars?.AUTH_MUTATIONS_DISABLED || "", /^(?:true|false)$/);
  assert.equal(
    config.vars?.FIREBASE_RTDB_URL,
    "https://mons-link-default-rtdb.firebaseio.com",
  );
  assert.deepEqual(config.d1_databases, [
    {
      binding: "PROFILE_GAMES_DB",
      database_name: "mons-link-profile-games",
      database_id: "6bca5681-364e-473f-a2b3-bcd66140c560",
      migrations_dir: "migrations",
    },
    {
      binding: "AUTH_STATE_DB",
      database_name: "mons-link-auth-state",
      database_id: "4defcd85-d1cf-4306-af4e-fb3cca5e1970",
      migrations_dir: "auth-state-migrations",
    },
    {
      binding: "TELEGRAM_DB",
      database_name: "mons-link-telegram",
      database_id: "71b03cec-ffc1-42fd-a36e-0320369af85a",
      migrations_dir: "telegram-migrations",
    },
    {
      binding: "EVENT_PRIZE_WITHDRAWALS_DB",
      database_name: "mons-link-event-prize-withdrawals",
      database_id: "3815453d-a81b-441c-b941-bcdf78c52cf3",
      migrations_dir: "event-prize-withdrawal-migrations",
    },
    {
      binding: "PROFILE_DB",
      database_name: "mons-link-profiles",
      database_id: "15a77eea-19da-45a7-8433-9b4a22d371da",
      migrations_dir: "profile-migrations",
    },
    {
      binding: "EVENT_DB",
      database_name: "mons-link-events",
      database_id: "1638d8f3-2890-4bf2-9b8a-16bb197e2b3b",
      migrations_dir: "event-migrations",
    },
  ]);
  assert.deepEqual(config.secrets, {
    required: [
      "FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL",
      "FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY",
      "GAMEPLAY_SERVICE_ACCOUNT_EMAIL",
      "GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY",
      "HELIUS_RPC_API_KEY",
      "EVENT_PRIZE_ADMIN_PRIVATE_KEY",
      "TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_EXTRA_CHAT_ID",
      "TELEGRAM_FIREBASE_SERVICE_ACCOUNT_EMAIL",
      "TELEGRAM_FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY",
      "TELEGRAM_QUEUE_BRIDGE_SECRET",
      "X_CLIENT_ID",
      "X_CLIENT_SECRET",
    ],
  });
  assert.deepEqual(config.ratelimits, [
    {
      name: "NFT_RATE_LIMITER",
      namespace_id: "1616095643",
      simple: { limit: 10, period: 60 },
    },
    {
      name: "AUTH_RATE_LIMITER",
      namespace_id: "1616095644",
      simple: { limit: 20, period: 60 },
    },
    {
      name: "REACTION_RATE_LIMITER",
      namespace_id: "1616095645",
      simple: { limit: 60, period: 60 },
    },
  ]);
  assert.deepEqual(config.queues, {
    producers: [
      {
        binding: "AUTH_RECOVERY_QUEUE",
        queue: "mons-link-auth-recovery",
      },
      {
        binding: "TELEGRAM_DELIVERY_QUEUE",
        queue: "mons-link-telegram-delivery",
      },
      {
        binding: "TELEGRAM_PROJECTION_QUEUE",
        queue: "mons-link-telegram-projection",
      },
      {
        binding: "PROFILE_GAME_PROJECTION_QUEUE",
        queue: "mons-link-profile-game-projection",
      },
    ],
    consumers: [
      {
        queue: "mons-link-auth-recovery",
        max_batch_size: 1,
        max_batch_timeout: 1,
        max_retries: 100,
        retry_delay: 60,
        max_concurrency: 1,
      },
      {
        queue: "mons-link-telegram-delivery",
        max_batch_size: 1,
        max_batch_timeout: 0,
        max_retries: 100,
        dead_letter_queue: "mons-link-telegram-delivery-dlq",
        max_concurrency: 1,
      },
      {
        queue: "mons-link-telegram-projection",
        max_batch_size: 5,
        max_batch_timeout: 1,
        max_retries: 20,
        dead_letter_queue: "mons-link-telegram-projection-dlq",
        max_concurrency: 5,
      },
      {
        queue: "mons-link-profile-game-projection",
        max_batch_size: 1,
        max_batch_timeout: 1,
        max_retries: 100,
        max_concurrency: 5,
      },
    ],
  });
  assert.deepEqual(config.triggers, { crons: ["*/5 * * * *"] });
  assert.deepEqual(config.observability, {
    enabled: true,
    head_sampling_rate: 0.1,
    logs: {
      enabled: true,
      head_sampling_rate: 0.1,
      invocation_logs: false,
      persist: true,
    },
    traces: { enabled: false },
  });
  const serialized = JSON.stringify(config);
  for (const retired of [
    "FIRESTORE_SERVICE_ACCOUNT_",
    "RATING_SERVICE_ACCOUNT_",
    "USERNAME_SERVICE_ACCOUNT_",
    "PROFILE_STORAGE_MODE",
    "PROFILE_READ_MODE",
    "PROFILE_ACTIVATION_LOGIN_UID",
    "PROFILE_PROJECTION_QUEUE",
    "mons-link-profile-projection",
  ]) {
    assert.equal(serialized.includes(retired), false, retired);
  }
});

test("ephemeral auth state does not use Firestore collection paths", () => {
  for (const path of [
    "cloud/workers/api/src/authIdentity.ts",
    "cloud/workers/api/src/authMutations.ts",
    "cloud/workers/api/src/authRoutes.ts",
    "cloud/workers/api/src/authProfileRepository.ts",
    "cloud/workers/api/src/xCallback.ts",
  ]) {
    assert.doesNotMatch(readText(path), /authIntents|xAuthRedirectFlows/);
  }
});

test("Wrangler release environment contains no active values", () => {
  const activeLines = readText("cloud/workers/api/release.env")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.deepEqual(activeLines, []);
});

test("Firebase configuration deploys only Realtime Database rules", () => {
  const config = readJson<Record<string, unknown>>("cloud/firebase.json");
  assert.equal(Object.hasOwn(config, "functions"), false);
  assert.equal(typeof config.database, "object");
  assert.equal(Object.hasOwn(config, "firestore"), false);
  for (const path of [
    "cloud/firestore.rules",
    "cloud/firestore.indexes.json",
    "scripts/migrate-profile-reads.ts",
    "scripts/migrate-profile-canonical.ts",
    "cloud/admin/_admin.js",
    "cloud/admin/cleanupAuthMethodRevocations.js",
  ]) {
    assert.equal(existsSync(resolve(repositoryRoot, path)), false, path);
  }
});

test("package manifests preserve public scripts and deployment command vectors", () => {
  const rootPackage = readJson<PackageManifest>("package.json");
  const functionsPackage = readJson<PackageManifest>(
    "cloud/functions/package.json",
  );
  const adminPackage = readJson<PackageManifest>("cloud/admin/package.json");
  const apiPackage = readJson<PackageManifest>(
    "cloud/workers/api/package.json",
  );
  const rootScriptNames = [
    "start",
    "lint",
    "typecheck",
    "test:nft-client",
    "test:client",
    "check",
    "build",
    "preview",
    "types:api",
    "types:api:check",
    "format:check:api",
    "lint:api",
    "typecheck:api",
    "test:api",
    "test:api:runtime",
    "dry-run:api",
    "check:api:core",
    "check:api",
    "upload:api",
    "promote:api",
    "deploy:api:triggers",
    "smoke:api",
    "format:check:tooling",
    "lint:tooling",
    "typecheck:tooling",
    "test:tooling",
    "test:database-rules",
    "check:tooling:core",
    "check:tooling",
    "check:all",
    "announceEventPrizes",
    "recover:telegram",
    "repo-clean",
    "format",
    "format:check",
    "prepare:firebase",
    "deploy:firebase",
    "deploy",
    "latest:root",
    "latest:functions",
    "latest:admin",
    "latest",
  ];

  for (const scriptName of rootScriptNames) {
    assert.equal(
      typeof rootPackage.scripts?.[scriptName],
      "string",
      scriptName,
    );
  }
  assert.equal(rootPackage.scripts?.["migrate:profile-reads"], undefined);
  assert.equal(rootPackage.scripts?.["migrate:profile-canonical"], undefined);
  assert.equal(rootPackage.scripts?.["backfill:historical-matches"], undefined);
  assert.deepEqual(
    {
      build: rootPackage.scripts?.build,
      preview: rootPackage.scripts?.preview,
      "types:api": rootPackage.scripts?.["types:api"],
      "types:api:check": rootPackage.scripts?.["types:api:check"],
      "dry-run:api": rootPackage.scripts?.["dry-run:api"],
      "upload:api": rootPackage.scripts?.["upload:api"],
      "promote:api": rootPackage.scripts?.["promote:api"],
      "deploy:api:triggers": rootPackage.scripts?.["deploy:api:triggers"],
      "smoke:api": rootPackage.scripts?.["smoke:api"],
      "manage:event-prize-withdrawals":
        rootPackage.scripts?.["manage:event-prize-withdrawals"],
      "manage:events": rootPackage.scripts?.["manage:events"],
      "manage:profile-canonical":
        rootPackage.scripts?.["manage:profile-canonical"],
      "prepare:firebase": rootPackage.scripts?.["prepare:firebase"],
      "deploy:firebase": rootPackage.scripts?.["deploy:firebase"],
      deploy: rootPackage.scripts?.deploy,
      "repo-clean": rootPackage.scripts?.["repo-clean"],
    },
    {
      build: "npm run check && vite build",
      preview: "vite preview",
      "types:api":
        "wrangler types cloud/workers/api/worker-configuration.d.ts --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env",
      "types:api:check":
        "wrangler types cloud/workers/api/worker-configuration.d.ts --check --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env",
      "dry-run:api":
        "wrangler versions upload --dry-run --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env",
      "upload:api":
        "wrangler versions upload --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env",
      "promote:api":
        "wrangler versions deploy --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --percentage 100 --yes",
      "deploy:api:triggers":
        "wrangler triggers deploy --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env",
      "smoke:api":
        "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/smoke-cloudflare-api.ts",
      "manage:event-prize-withdrawals":
        "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/manage-event-prize-withdrawals.ts",
      "manage:events":
        "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/manage-events.ts",
      "manage:profile-canonical":
        "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/manage-profile-canonical.ts",
      "prepare:firebase":
        "npm --prefix cloud/functions ci && npm --prefix cloud/functions test",
      "deploy:firebase":
        "npm run prepare:firebase && node --experimental-strip-types scripts/deploy-firebase.ts",
      deploy: "node --experimental-strip-types scripts/deploy-cloudflare.ts",
      "repo-clean": "bash scripts/repo-clean.sh",
    },
  );
  assert.equal(functionsPackage.main, undefined);
  assert.equal(
    existsSync(resolve(repositoryRoot, "cloud/functions/index.js")),
    false,
  );
  for (const [command, filename] of [
    ["telegram-d1", "telegram-delivery"],
    ["events-d1", "events-d1"],
    ["gameplay-coordination", "gameplay-coordination"],
    ["profile-link-catchup", "profile-link-catchup"],
    ["rating-completions", "rating-completions"],
    ["wager-reservations", "wager-reservations"],
  ]) {
    assert.equal(rootPackage.scripts?.[`migrate:${command}`], undefined);
    for (const suffix of [".ts", ".test.ts"]) {
      assert.equal(
        existsSync(
          resolve(repositoryRoot, `scripts/migrate-${filename}${suffix}`),
        ),
        false,
      );
    }
  }
  assert.deepEqual(functionsPackage.scripts, {
    test: "node --experimental-strip-types --test ../tests/*.test.js",
  });
  assert.equal(functionsPackage.dependencies?.["firebase-admin"], undefined);
  assert.equal(adminPackage.dependencies?.["firebase-admin"], undefined);
  assert.deepEqual(adminPackage.scripts, {
    "recover:telegram": "node recoverTelegramDelivery.js",
    start: "node listAddresses.js",
    "shooting:alert": "node shootingStarAlert.js",
  });
  assert.equal(apiPackage.private, true);
  assert.equal(apiPackage.type, "module");
  assert.equal(rootPackage.dependencies?.jose, "^6.2.10");
  assert.equal(rootPackage.dependencies?.["@spruceid/siwe-parser"], "3.0.0");

  for (const packageName of [
    "@types/node",
    "@types/react",
    "@types/react-dom",
    "typescript",
  ]) {
    assert.equal(rootPackage.dependencies?.[packageName], undefined);
    assert.equal(typeof rootPackage.devDependencies?.[packageName], "string");
  }
});

test("shared package preserves every direct export subpath", () => {
  const rootPackage = readJson<PackageManifest>("package.json");
  const functionsPackage = readJson<PackageManifest>(
    "cloud/functions/package.json",
  );
  const sharedPackage = readJson<PackageManifest>(
    "cloud/functions/shared/package.json",
  );
  const expectedExports = {
    "./auth": "./auth.js",
    "./event-prizes": "./event-prizes.js",
    "./events": "./events.js",
    "./game-sessions": "./game-sessions.js",
    "./game-variants": "./game-variants.js",
    "./ids": "./ids.js",
    "./match-protocol": "./match-protocol.js",
    "./mining": "./mining.js",
    "./navigation": "./navigation.js",
    "./nfts": "./nfts.js",
    "./profiles": "./profiles.js",
    "./ratings": "./ratings.js",
    "./reactions": "./reactions.js",
    "./rematches": "./rematches.js",
    "./solana": "./solana.js",
    "./timers": "./timers.js",
    "./usernames": "./usernames.js",
    "./wagers": "./wagers.js",
    "./x-redirect": "./x-redirect.js",
  };

  assert.equal(sharedPackage.name, "@mons/shared");
  assert.equal(sharedPackage.private, true);
  assert.equal(sharedPackage.type, "commonjs");
  assert.deepEqual(sharedPackage.exports, expectedExports);
  assert.equal(
    rootPackage.dependencies?.["@mons/shared"],
    "file:cloud/functions/shared",
  );
  assert.equal(functionsPackage.dependencies?.["@mons/shared"], "file:shared");

  for (const target of Object.values(expectedExports)) {
    const implementationPath = resolve(
      repositoryRoot,
      "cloud/functions/shared",
      target,
    );
    const declarationPath = implementationPath.replace(/\.js$/, ".d.ts");
    assert.equal(existsSync(implementationPath), true, implementationPath);
    assert.equal(existsSync(declarationPath), true, declarationPath);
  }
});

test("API Worker preserves its runtime export surface", () => {
  const worker = require(
    resolve(repositoryRoot, "cloud/workers/api/src/workerHandler.ts"),
  ) as Record<string, unknown>;
  const exportNames = Object.keys(worker)
    .filter((name) => name !== "__esModule")
    .sort();

  assert.deepEqual(
    exportNames,
    [
      "default",
      "extractIdFromJsonUri",
      "handleFetch",
      "handleRequest",
      "handleScheduled",
    ].sort(),
  );
  assert.equal(typeof worker.extractIdFromJsonUri, "function");
  assert.equal(typeof worker.handleRequest, "function");
  assert.equal(
    typeof (worker.default as { fetch?: unknown } | undefined)?.fetch,
    "function",
  );
});

test("remaining deployment CLIs preserve their offline modes", () => {
  const { parseArgs: parseFirebaseArgs } = require(
    resolve(repositoryRoot, "scripts/deploy-firebase.ts"),
  ) as {
    parseArgs: (argv: string[]) => Record<string, unknown>;
  };
  assert.deepEqual(parseFirebaseArgs(["--dry-run", "--project", "mons-link"]), {
    dryRun: true,
    project: "mons-link",
  });

  const frontendHelp = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      resolve(repositoryRoot, "scripts/deploy-cloudflare.ts"),
      "--help",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
    },
  );
  assert.equal(frontendHelp.status, 0, frontendHelp.stderr);
  assert.equal(frontendHelp.stderr, "");
  assert.match(frontendHelp.stdout, /npm run deploy -- dry-run/);
  assert.match(frontendHelp.stdout, /npm run deploy -- preview/);
  assert.match(frontendHelp.stdout, /npm run deploy -- production/);
});

test("operations documentation describes current releases and D1 maintenance", () => {
  const rootReadme = readText("README.md");
  const cloudReadme = readText("cloud/README.md");
  const guide = readText("scripts/deploy-cloudflare.md");
  assert.match(
    rootReadme,
    /\[Cloudflare deployment\]\(scripts\/deploy-cloudflare\.md\)/,
  );
  assert.match(rootReadme, /\[cloud operations\]\(cloud\/README\.md\)/);
  assert.match(
    cloudReadme,
    /\[Cloudflare deployment guide\]\(\.\.\/scripts\/deploy-cloudflare\.md\)/,
  );
  assert.match(
    cloudReadme,
    /`PROFILE_DB\.profile_login_owners` is the sole source/,
  );
  assert.match(
    cloudReadme,
    /custom `profileId` claims and RTDB `players\/\{uid\}\/profile` links are non-authoritative compatibility shadows/,
  );
  for (const document of [rootReadme, cloudReadme, guide]) {
    assert.doesNotMatch(
      document,
      /npm run migrate:|--return-to-firebase|--activate-d1|--recover-import|functions:secrets:access|wrangler rollback/,
    );
  }
  const apiRelease = guide.slice(
    guide.indexOf("## API Worker release"),
    guide.indexOf("## Canonical profile D1 maintenance"),
  );
  let previousStepIndex = -1;
  for (const step of [
    "npm run manage:profile-canonical -- --freeze",
    "Wait at least 15 minutes",
    "GET https://api.cloudflare.com/client/v4/accounts/e25f90fc073ea309b54b8b5144bf28e0/workers/scripts/mons-link-api/subdomain",
    "Require `enabled: false` and `previews_enabled: false`",
    "npm run upload:api",
    "npm run promote:api -- --version-id <version-id>",
    "npm run deploy:api:triggers",
    "npm run smoke:api -- --base-url https://api.mons.link --read-only --require-history --require-wager-frozen-read --require-wager-storage-version",
    "npm run smoke:reactions -- --base-url https://api.mons.link --invite-id <existing-paired-invite-id>",
    "npm run manage:profile-canonical -- --resume",
  ]) {
    const stepIndex = apiRelease.indexOf(step);
    assert.ok(stepIndex > previousStepIndex, step);
    previousStepIndex = stepIndex;
  }
  assert.doesNotMatch(
    apiRelease,
    /<version-preview-url>|(?:previews_enabled|preview_urls)"?\s*:\s*true/,
  );
  assert.match(
    apiRelease,
    /Production API `workers_dev` and `preview_urls` remain disabled/,
  );
  assert.match(
    apiRelease,
    /Workers implementing a Durable Object do not receive version-preview URLs/,
  );
  assert.match(apiRelease, /alternate-login invite-role authorization/);
  assert.match(apiRelease, /Wait at least 15 minutes/);
  const reactionBootstrap = apiRelease.slice(
    apiRelease.indexOf("### Initial reaction namespace and cutover"),
    apiRelease.indexOf("### Read-only reaction smoke"),
  );
  assert.match(reactionBootstrap, /one-time exception to candidate upload/);
  assert.match(reactionBootstrap, /already-provisioned, unchanged class/);
  assert.match(reactionBootstrap, /Retain the API namespace/);
  assert.ok(
    reactionBootstrap.indexOf("wrangler deploy --dry-run --strict") <
      reactionBootstrap.indexOf("wrangler deploy --strict"),
  );
  assert.ok(
    reactionBootstrap.indexOf("wrangler deploy --strict") <
      reactionBootstrap.indexOf("Release the frontend next"),
  );
  assert.ok(
    reactionBootstrap.indexOf("Release the frontend next") <
      reactionBootstrap.indexOf("npm run deploy:firebase"),
  );
  assert.match(
    apiRelease,
    /npm run smoke:reactions -- --base-url https:\/\/api\.mons\.link --invite-id <existing-paired-invite-id>/,
  );
  assert.match(apiRelease, /publishes no reaction/);
  for (const queue of [
    "auth-recovery",
    "profile-game-projection",
    "telegram-projection",
    "telegram-delivery",
  ]) {
    assert.equal(
      apiRelease.includes(`queues pause-delivery mons-link-${queue}`),
      true,
    );
    assert.ok(
      apiRelease.indexOf(`queues pause-delivery mons-link-${queue}`) <
        apiRelease.indexOf("Wait at least 15 minutes"),
    );
    assert.equal(
      apiRelease.includes(`queues resume-delivery mons-link-${queue}`),
      true,
    );
  }
  for (const command of [
    "npm run manage:events -- --freeze",
    "npm run manage:events -- --resume-d1",
    "npm run manage:events -- --recover-stale-admission <admission-id>",
    "npm run manage:wager-reservations -- --recover-admission <admission-id> --confirm-request-finished --confirm-source-reconciled",
    "npm run manage:wager-reservations -- --resume-d1",
    "npm run manage:event-prize-withdrawals -- --freeze",
    "npm run deploy -- production --version-id <version-id>",
    "npm run deploy:firebase -- --project mons-link --dry-run",
    "PRAGMA foreign_key_check",
  ]) {
    assert.equal(guide.includes(command), true, command);
  }
  assert.match(
    guide,
    /workflows trigger mons-link-event-prize-withdrawal '\{"schemaVersion":1,"kind":"preflight"\}' --id "\$event_prize_preflight_id"/,
  );
  assert.match(
    guide,
    /workflows instances describe mons-link-event-prize-withdrawal "\$event_prize_preflight_id"/,
  );
  assert.match(guide, /Never bulk-delete admissions/);
  assert.match(
    guide,
    /Successful transition receipts are immutable coordination evidence/,
  );
  assert.match(guide, /missing snapshot returns `pair: null`/);
  assert.match(guide, /never reads RTDB or persists data/);
  assert.match(guide, /no RTDB recovery or backfill path/);
  assert.match(
    cloudReadme,
    /--bridge-secret-file \/Users\/ivan\/\.config\/mons-link\/secrets\/telegram-announcement/,
  );
  assert.match(
    cloudReadme,
    /--bridge-secret-file \/Users\/ivan\/\.config\/mons-link\/secrets\/telegram-queue/,
  );
});

test("profile claim synchronization uses the Worker route", () => {
  const authApi = readText("src/services/authApi.ts");

  assert.match(authApi, /\/auth\/profile-claim\/sync/);
});

test("browser customization and prize selection mutations use Worker routes", () => {
  const gameplayApi = readText("src/services/gameplayApi.ts");
  const profileApi = readText("src/services/profileApi.ts");
  const connection = readText("src/connection/connection.ts");

  assert.match(gameplayApi, /\/events\/prize-selections\/toggle/);
  assert.match(profileApi, /\/profiles\/custom/);
  assert.match(
    connection,
    /getUserBoundAuthTokenProvider\(\)[\s\S]{0,250}toggleEventPrizeSelectionViaApi/,
  );
  assert.match(connection, /field: "emojiAndAura"/);
  assert.doesNotMatch(connection, /profileCustomizationWrites/);
  assert.doesNotMatch(connection, /pendingProfileCustomizations/);
  assert.doesNotMatch(connection, /drainProfileCustomizations/);
  assert.doesNotMatch(connection, /\bupdateDoc\s*\(/);
  assert.doesNotMatch(
    connection,
    /runTransaction\([\s\S]{0,200}eventPrizeSelections/,
  );
});

test("browser event subscriptions use Worker polling without Firebase event paths", () => {
  const connection = readText("src/connection/connection.ts");
  const gameplayApi = readText("src/services/gameplayApi.ts");

  for (const retiredPath of [
    "eventPrizeSelections/",
    "profileEventPrizes/",
    "`events/${",
  ]) {
    assert.equal(connection.includes(retiredPath), false, retiredPath);
  }
  assert.match(gameplayApi, /\/events\/snapshot/);
  assert.match(gameplayApi, /\/events\/prizes/);
});

test("provider verification and auth mutations use Worker routes", () => {
  const authApi = readText("src/services/authApi.ts");
  for (const route of [
    "/auth/methods/apple/verify",
    "/auth/methods/eth/verify",
    "/auth/methods/sol/verify",
    "/auth/methods/unlink",
    "/auth/x/flows/complete",
  ]) {
    assert.match(authApi, new RegExp(route.replaceAll("/", "\\/")));
  }
});

test("client prize withdrawal uses only the Worker API", () => {
  const connection = readText("src/connection/connection.ts");
  const callableNames = Array.from(
    connection.matchAll(/httpsCallable\(\s*this\.functions\s*,\s*"([^"]+)"/g),
    (match) => match[1],
  ).sort();

  assert.equal(
    callableNames.length,
    Array.from(connection.matchAll(/\bhttpsCallable\s*\(/g)).length,
  );
  assert.deepEqual(callableNames, []);
  assert.doesNotMatch(connection, /firebase\/functions/);
  const eventPrizeApi = readText("src/services/eventPrizeApi.ts");
  assert.match(eventPrizeApi, /\/events\/prizes\/withdrawals/);
  assert.match(eventPrizeApi, /\/events\/prizes\/withdrawals\/status/);
});
