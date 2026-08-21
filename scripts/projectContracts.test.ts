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
  ratelimits?: Array<Record<string, unknown>>;
  queues?: Record<string, unknown>;
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
  assert.equal(config.preview_urls, true);
  assert.deepEqual(config.routes, [
    { pattern: "api.mons.link", custom_domain: true },
  ]);
  assert.deepEqual(config.vars, {
    AUTH_DISABLE_X_VERIFY: "false",
    FIREBASE_RTDB_URL: "https://mons-link-default-rtdb.firebaseio.com",
  });
  assert.deepEqual(config.secrets, {
    required: [
      "FIRESTORE_SERVICE_ACCOUNT_EMAIL",
      "FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY",
      "GAMEPLAY_SERVICE_ACCOUNT_EMAIL",
      "GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY",
      "HELIUS_RPC_API_KEY",
      "RATING_SERVICE_ACCOUNT_EMAIL",
      "RATING_SERVICE_ACCOUNT_PRIVATE_KEY",
      "TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_EXTRA_CHAT_ID",
      "TELEGRAM_FIREBASE_SERVICE_ACCOUNT_EMAIL",
      "TELEGRAM_FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY",
      "TELEGRAM_QUEUE_BRIDGE_SECRET",
      "USERNAME_SERVICE_ACCOUNT_EMAIL",
      "USERNAME_SERVICE_ACCOUNT_PRIVATE_KEY",
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
  ]);
  assert.deepEqual(config.queues, {
    producers: [
      {
        binding: "TELEGRAM_DELIVERY_QUEUE",
        queue: "mons-link-telegram-delivery",
      },
      {
        binding: "TELEGRAM_PROJECTION_QUEUE",
        queue: "mons-link-telegram-projection",
      },
    ],
    consumers: [
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
    ],
  });
  assert.deepEqual(config.triggers, { crons: ["*/5 * * * *"] });
  assert.deepEqual(config.observability, {
    enabled: true,
    logs: {
      enabled: true,
      head_sampling_rate: 0.1,
      invocation_logs: false,
      persist: true,
    },
    traces: { enabled: false },
  });
});

test("Wrangler release environment contains no active values", () => {
  const activeLines = readText("cloud/workers/api/release.env")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.deepEqual(activeLines, []);
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
    "dry-run:api",
    "check:api:core",
    "check:api",
    "deploy:api",
    "deploy:api:triggers",
    "format:check:tooling",
    "lint:tooling",
    "typecheck:tooling",
    "test:tooling",
    "check:tooling:core",
    "check:tooling",
    "check:all",
    "announceEventPrizes",
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
  assert.deepEqual(
    {
      build: rootPackage.scripts?.build,
      preview: rootPackage.scripts?.preview,
      "types:api": rootPackage.scripts?.["types:api"],
      "types:api:check": rootPackage.scripts?.["types:api:check"],
      "dry-run:api": rootPackage.scripts?.["dry-run:api"],
      "deploy:api": rootPackage.scripts?.["deploy:api"],
      "deploy:api:triggers": rootPackage.scripts?.["deploy:api:triggers"],
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
      "deploy:api":
        "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/deploy-cloudflare-api.ts",
      "deploy:api:triggers":
        "node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/deploy-cloudflare-api.ts triggers",
      "prepare:firebase":
        "npm --prefix cloud/functions ci && npm --prefix cloud/functions test",
      "deploy:firebase":
        "npm run prepare:firebase && node cloud/functions/scripts/deploy-safe.js --include-non-functions",
      deploy: "node --experimental-strip-types scripts/deploy-cloudflare.ts",
      "repo-clean": "bash scripts/repo-clean.sh",
    },
  );
  assert.deepEqual(functionsPackage.scripts, {
    serve: "firebase emulators:start --only functions",
    shell: "firebase functions:shell",
    start: "npm run shell",
    test: "node --experimental-strip-types --test ../tests/*.test.js",
    deploy: "npm test && npm run deploy:safe -- --include-non-functions",
    "deploy:safe": "node ./scripts/deploy-safe.js",
    logs: "firebase functions:log",
  });
  assert.deepEqual(adminPackage.scripts, {
    "requeue:telegram": "node requeueTelegramDelivery.js",
    "smoke:telegram": "node smokeTelegramDelivery.js",
    start: "node listAddresses.js",
    "shooting:alert": "node shootingStarAlert.js",
  });
  assert.equal(apiPackage.private, true);
  assert.equal(apiPackage.type, "module");
  assert.equal(rootPackage.dependencies?.jose, "^6.2.7");

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
    "./game-variants": "./game-variants.js",
    "./ids": "./ids.js",
    "./match-protocol": "./match-protocol.js",
    "./mining": "./mining.js",
    "./navigation": "./navigation.js",
    "./nfts": "./nfts.js",
    "./profiles": "./profiles.js",
    "./ratings": "./ratings.js",
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
    resolve(repositoryRoot, "cloud/workers/api/src/index.ts"),
  ) as Record<string, unknown>;
  const exportNames = Object.keys(worker)
    .filter((name) => name !== "__esModule")
    .sort();

  assert.deepEqual(
    exportNames,
    ["default", "extractIdFromJsonUri", "handleFetch", "handleRequest"].sort(),
  );
  assert.equal(typeof worker.extractIdFromJsonUri, "function");
  assert.equal(typeof worker.handleRequest, "function");
  assert.equal(
    typeof (worker.default as { fetch?: unknown } | undefined)?.fetch,
    "function",
  );
});

test("deployment CLIs preserve their offline modes", () => {
  const { parseArgs: parseApiArgs } = require(
    resolve(repositoryRoot, "scripts/deploy-cloudflare-api.ts"),
  ) as {
    parseArgs: (argv: string[]) => Record<string, unknown>;
  };
  const { parseArgs: parseFirebaseArgs } = require(
    resolve(repositoryRoot, "cloud/functions/scripts/deploy-safe.js"),
  ) as {
    parseArgs: (argv: string[]) => Record<string, unknown>;
  };
  const wallet = "11111111111111111111111111111111";
  const versionId = "4da38b82-96db-472c-8856-a2e72d34079d";

  assert.deepEqual(parseApiArgs(["preview", "--smoke-sol", wallet]), {
    mode: "preview",
    smokeSol: wallet,
    secretsFile: undefined,
    tokenFile: undefined,
    versionId: undefined,
  });
  assert.deepEqual(
    parseApiArgs([
      "production",
      "--version-id",
      versionId,
      "--smoke-sol",
      wallet,
    ]),
    {
      mode: "production",
      smokeSol: wallet,
      tokenFile: undefined,
      versionId,
    },
  );
  assert.deepEqual(parseApiArgs(["triggers"]), {
    mode: "triggers",
    tokenFile: undefined,
  });
  assert.throws(
    () => parseApiArgs(["dry-run"]),
    /preview, production, or triggers/,
  );

  assert.deepEqual(
    parseFirebaseArgs([
      "--dry-run",
      "--include-non-functions",
      "--project",
      "mons-link",
    ]),
    {
      batchSize: 10,
      dryRun: true,
      includeNonFunctions: true,
      project: "mons-link",
      functionNames: [],
    },
  );

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

test("operations documentation cross-links package and deployment guides", () => {
  const rootReadme = readText("README.md");
  const cloudReadme = readText("cloud/README.md");
  const deployGuide = readText("scripts/deploy-cloudflare.md");

  assert.match(
    rootReadme,
    /\[Cloudflare deployment\]\(scripts\/deploy-cloudflare\.md\)/,
  );
  assert.match(rootReadme, /\[cloud operations\]\(cloud\/README\.md\)/);
  assert.match(
    cloudReadme,
    /\[Cloudflare deployment guide\]\(\.\.\/scripts\/deploy-cloudflare\.md\)/,
  );
  assert.match(deployGuide, /\[cloud operations\]\(\.\.\/cloud\/README\.md\)/);
  assert.equal(existsSync(resolve(repositoryRoot, "cloud/.prettierrc")), false);
  assert.equal(existsSync(resolve(repositoryRoot, ".prettierrc")), true);
});
