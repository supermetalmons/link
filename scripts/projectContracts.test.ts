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
  version_metadata?: { binding: string };
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
  assert.deepEqual(config.compatibility_flags, [
    "nodejs_compat",
    "enable_request_signal",
  ]);
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
    "API_MAINTENANCE",
    "APPLE_AUDIENCES",
    "AUTH_MUTATIONS_DISABLED",
    "D1_MIGRATION_RUN_ID",
    "EVENT_DB_BOOKMARK_EPOCH",
  ]);
  assert.equal(config.version_metadata?.binding, "CF_VERSION_METADATA");
  assert.match(config.vars?.API_MAINTENANCE || "", /^(?:true|false)$/);
  assert.match(config.vars?.D1_MIGRATION_RUN_ID || "", /^[A-Za-z0-9_-]*$/);
  assert.equal(
    config.vars?.EVENT_DB_BOOKMARK_EPOCH,
    config.d1_databases?.find((binding) => binding.binding === "EVENT_DB")
      ?.database_id,
  );
  assert.equal(config.vars?.APPLE_AUDIENCES, "link.mons");
  assert.match(config.vars?.AUTH_MUTATIONS_DISABLED || "", /^(?:true|false)$/);
  assert.equal(config.vars?.FIREBASE_RTDB_URL, undefined);
  assert.deepEqual(config.d1_databases, [
    {
      binding: "PROFILE_GAMES_DB",
      database_name: "mons-link-profile-games-enam",
      database_id: "aea8a323-ba3b-4f1e-9a34-32c5a5b85a39",
      migrations_dir: "migrations",
    },
    {
      binding: "AUTH_STATE_DB",
      database_name: "mons-link-auth-state-enam",
      database_id: "1f8a45b0-e01f-402a-8f83-699254387c5a",
      migrations_dir: "auth-state-migrations",
    },
    {
      binding: "TELEGRAM_DB",
      database_name: "mons-link-telegram-enam",
      database_id: "1cf2a7f7-e6d3-4f79-a30d-6151fb6e218b",
      migrations_dir: "telegram-migrations",
    },
    {
      binding: "EVENT_PRIZE_WITHDRAWALS_DB",
      database_name: "mons-link-event-prize-withdrawals-enam",
      database_id: "2b1b5ada-ae99-4d05-8cbb-63f968d06f4c",
      migrations_dir: "event-prize-withdrawal-migrations",
    },
    {
      binding: "PROFILE_DB",
      database_name: "mons-link-profiles-enam",
      database_id: "f4115f7f-e9bf-42d6-8a21-eca6837c168d",
      migrations_dir: "profile-migrations",
    },
    {
      binding: "EVENT_DB",
      database_name: "mons-link-events-enam",
      database_id: "446cba4b-31c0-4c5e-8daa-af7d235fbe0f",
      migrations_dir: "event-migrations",
    },
  ]);
  assert.deepEqual(config.secrets, {
    required: [
      "SESSION_JWT_KEYS",
      "HELIUS_RPC_API_KEY",
      "EVENT_PRIZE_ADMIN_PRIVATE_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_EXTRA_CHAT_ID",
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
      name: "MOVE_RATE_LIMITER",
      namespace_id: "1616095646",
      simple: { limit: 120, period: 60 },
    },
    {
      name: "REACTION_RATE_LIMITER",
      namespace_id: "1616095645",
      simple: { limit: 60, period: 60 },
    },
    {
      name: "MATCH_SYNC_RATE_LIMITER",
      namespace_id: "1616095647",
      simple: { limit: 600, period: 60 },
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
        binding: "WAGER_SETTLEMENT_QUEUE",
        queue: "mons-link-wager-settlement",
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
        queue: "mons-link-wager-settlement",
        max_batch_size: 1,
        max_batch_timeout: 0,
        max_retries: 100,
        dead_letter_queue: "mons-link-wager-settlement-dlq",
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

test("retired provider tools and migration entry points stay removed", () => {
  for (const path of [
    "cloud/firebase.json",
    "cloud/.firebaserc",
    "cloud/database.rules.json",
    "scripts/deploy-firebase.ts",
    "scripts/match-state-provider.ts",
    "scripts/match-state-manifest.ts",
    "cloud/workers/api/src/matchStateMigrationRoute.ts",
    "cloud/workers/api/src/matchPresentationMigrationRoute.ts",
    "cloud/workers/api/test/legacyFirebaseRtdb.ts",
    "cloud/workers/api/test/legacyGoogleAuth.ts",
  ])
    assert.equal(existsSync(resolve(repositoryRoot, path)), false, path);
  const manifest = readJson<PackageManifest>("package.json");
  for (const name of [
    "firebase",
    "firebase-admin",
    "firebase-functions",
    "firebase-tools",
    "@firebase/rules-unit-testing",
  ]) {
    assert.equal(manifest.dependencies?.[name], undefined, name);
    assert.equal(manifest.devDependencies?.[name], undefined, name);
  }
  for (const name of [
    "prepare:firebase",
    "deploy:firebase",
    "test:database-rules",
  ]) {
    assert.equal(manifest.scripts?.[name], undefined, name);
  }
  assert.doesNotMatch(
    manifest.scripts?.["check:all"] || "",
    /firebase|emulators|java/i,
  );
});

test("package manifests preserve public scripts and deployment command vectors", () => {
  const rootPackage = readJson<PackageManifest>("package.json");
  const runtimePackage = readJson<PackageManifest>(
    "cloud/runtime/package.json",
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
    "check:tooling:core",
    "check:tooling",
    "check:all",
    "recover:telegram",
    "repo-clean",
    "format",
    "format:check",
    "deploy",
    "latest:root",
    "latest:runtime",
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
  assert.equal(rootPackage.scripts?.announceEventPrizes, undefined);
  assert.equal(
    existsSync(resolve(repositoryRoot, "cloud/admin/announceEventPrizes.js")),
    false,
  );
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
      deploy: "node --experimental-strip-types scripts/deploy-cloudflare.ts",
      "repo-clean": "bash scripts/repo-clean.sh",
    },
  );
  assert.equal(runtimePackage.main, undefined);
  assert.equal(
    existsSync(resolve(repositoryRoot, "cloud/runtime/index.js")),
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
  assert.deepEqual(runtimePackage.scripts, {
    test: "node --experimental-strip-types --test ../tests/*.test.js",
  });
  assert.equal(runtimePackage.dependencies?.["firebase-admin"], undefined);
  assert.equal(adminPackage.dependencies?.["firebase-admin"], undefined);
  assert.deepEqual(adminPackage.scripts, {
    "recover:telegram": "node recoverTelegramDelivery.js",
    start: "node listAddresses.js",
    "shooting:alert": "node shootingStarAlert.js",
  });
  assert.equal(apiPackage.private, true);
  assert.equal(apiPackage.type, "module");
  assert.equal(rootPackage.dependencies?.jose, "^6.2.12");
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
  const runtimePackage = readJson<PackageManifest>(
    "cloud/runtime/package.json",
  );
  const sharedPackage = readJson<PackageManifest>(
    "cloud/runtime/shared/package.json",
  );
  const expectedExports = {
    "./auth": "./auth.js",
    "./event-prizes": "./event-prizes.js",
    "./events": "./events.js",
    "./game-sessions": "./game-sessions.js",
    "./game-variants": "./game-variants.js",
    "./ids": "./ids.js",
    "./invite-metadata": "./invite-metadata.js",
    "./invite-wagers": "./invite-wagers.js",
    "./match-protocol": "./match-protocol.js",
    "./match-presentation": "./match-presentation.js",
    "./match-sync": "./match-sync.js",
    "./mining": "./mining.js",
    "./navigation": "./navigation.js",
    "./nfts": "./nfts.js",
    "./profiles": "./profiles.js",
    "./ratings": "./ratings.js",
    "./reactions": "./reactions.js",
    "./rematches": "./rematches.js",
    "./session-auth": "./session-auth.js",
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
    "file:cloud/runtime/shared",
  );
  assert.equal(runtimePackage.dependencies?.["@mons/shared"], "file:shared");

  for (const target of Object.values(expectedExports)) {
    const implementationPath = resolve(
      repositoryRoot,
      "cloud/runtime/shared",
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

test("operations documentation keeps candidate releases and canonical recovery explicit", () => {
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
  const section = (heading: string) => {
    const start = guide.indexOf(`## ${heading}\n`);
    assert.notEqual(start, -1, heading);
    const end = guide.indexOf("\n## ", start + heading.length + 4);
    return guide.slice(start, end < 0 ? undefined : end);
  };
  const policy = section("Release policy");
  assert.match(policy, /Routine releases have no overall time limit/);
  assert.match(
    policy,
    /verification-only waits or observation windows longer than 60 seconds/,
  );
  const release = section("API Worker release");
  const steps = [
    "npm run upload:api",
    "npm run promote:api -- --version-id <version-id>",
    "npm run smoke:api -- --base-url https://api.mons.link",
  ];
  let previous = -1;
  for (const step of steps) {
    const index = release.indexOf(step);
    assert.ok(index > previous, step);
    previous = index;
  }
  assert.doesNotMatch(
    release,
    /npm run manage:[^\n]*--(?:freeze|resume)|queues (?:pause|resume)-delivery/,
  );
  assert.match(
    release,
    /Production API `workers_dev` and `preview_urls` remain disabled/,
  );
  assert.match(
    section("Canonical operators"),
    /--inspect-admissions --directory <new-private-output-directory>/,
  );
  assert.match(
    section("Canonical operators"),
    /reads the import identity from D1/,
  );
  for (const command of [
    "manage:events",
    "manage:wager-reservations",
    "manage:event-prize-withdrawals",
    "manage:profile-canonical",
  ])
    assert.ok(guide.includes(command), command);
  assert.match(guide, /PRAGMA foreign_key_check/);
  assert.match(guide, /Never bulk-delete admissions/);
  assert.match(
    guide,
    /Successful transition receipts are immutable coordination evidence/,
  );
  for (const document of [rootReadme, cloudReadme, guide])
    assert.doesNotMatch(
      document,
      /npm run deploy:firebase|npm run test:database-rules|cloud\/functions/,
    );
});

test("profile synchronization uses the D1 Worker route and preserves the legacy alias", () => {
  const authApi = readText("src/services/authApi.ts");
  const authRoutes = readText("cloud/workers/api/src/authRoutes.ts");

  assert.match(authApi, /\/auth\/profile\/sync/);
  assert.doesNotMatch(authApi, /\/auth\/profile-claim\/sync/);
  assert.match(authRoutes, /pathname === "\/auth\/profile\/sync"/);
  assert.match(authRoutes, /pathname === "\/auth\/profile-claim\/sync"/);
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
