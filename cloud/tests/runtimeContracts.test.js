"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const functionsDirectory = path.resolve(__dirname, "../functions");
const functionsIndexPath = path.join(functionsDirectory, "index.js");
const sharedDirectory = path.join(functionsDirectory, "shared");

const callableExportNames = ["withdrawEventPrize"];

const httpExportNames = [];

const taskQueueExportNames = [];

const eventExportNames = [
  "projectProfileGamesOnInviteCreated",
  "projectProfileGamesOnInviteGuestIdChanged",
  "projectProfileGamesOnInviteGuestRematchesChanged",
  "projectProfileGamesOnInviteHostRematchesChanged",
  "projectProfileGamesOnMatchCreated",
];

const expectedExportNames = [
  ...callableExportNames,
  ...httpExportNames,
  ...taskQueueExportNames,
  ...eventExportNames,
].sort();

const expectedSharedExports = {
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

const isResetValue = (value) => value?.constructor?.name === "ResetValue";

const compactObject = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) =>
        entry !== null && entry !== undefined && !isResetValue(entry),
    ),
  );

const runtimeContract = (trigger, config = {}) => ({
  platform: "gcfv2",
  trigger,
  config,
});

const callableContract = (config = {}) =>
  runtimeContract({ type: "callable" }, config);

const eventContract = ({ eventType, pathPatterns, retry, filters }) =>
  runtimeContract({
    type: "event",
    eventType,
    pathPatterns,
    retry,
    ...(filters ? { filters } : {}),
  });

const taskQueueContract = (config, retry, rateLimits) =>
  runtimeContract(
    {
      type: "taskQueue",
      retry,
      rateLimits,
    },
    config,
  );

const expectedEndpointContracts = Object.fromEntries(
  callableExportNames.map((name) => [name, callableContract()]),
);

Object.assign(expectedEndpointContracts, {
  withdrawEventPrize: callableContract({
    availableMemoryMb: 512,
    timeoutSeconds: 120,
    maxInstances: 3,
    concurrency: 1,
    secrets: ["EVENT_PRIZE_ADMIN_PRIVATE_KEY", "HELIUS_RPC_API_KEY"],
  }),
  projectProfileGamesOnInviteCreated: eventContract({
    eventType: "google.firebase.database.ref.v1.created",
    pathPatterns: { ref: "invites/{inviteId}", instance: "*" },
    retry: true,
  }),
  projectProfileGamesOnInviteGuestIdChanged: eventContract({
    eventType: "google.firebase.database.ref.v1.written",
    pathPatterns: { ref: "invites/{inviteId}/guestId", instance: "*" },
    retry: true,
  }),
  projectProfileGamesOnInviteHostRematchesChanged: eventContract({
    eventType: "google.firebase.database.ref.v1.written",
    pathPatterns: {
      ref: "invites/{inviteId}/hostRematches",
      instance: "*",
    },
    retry: true,
  }),
  projectProfileGamesOnInviteGuestRematchesChanged: eventContract({
    eventType: "google.firebase.database.ref.v1.written",
    pathPatterns: {
      ref: "invites/{inviteId}/guestRematches",
      instance: "*",
    },
    retry: true,
  }),
  projectProfileGamesOnMatchCreated: eventContract({
    eventType: "google.firebase.database.ref.v1.created",
    pathPatterns: {
      ref: "players/{loginUid}/matches/{matchId}",
      instance: "*",
    },
    retry: true,
  }),
});

const normalizeEndpoint = (endpoint) => {
  const config = compactObject({
    availableMemoryMb: endpoint.availableMemoryMb,
    timeoutSeconds: endpoint.timeoutSeconds,
    minInstances: endpoint.minInstances,
    maxInstances: endpoint.maxInstances,
    concurrency: endpoint.concurrency,
    cpu: endpoint.cpu,
    ingressSettings: endpoint.ingressSettings,
    serviceAccountEmail: endpoint.serviceAccountEmail,
    vpc: endpoint.vpc,
  });

  if (endpoint.secretEnvironmentVariables?.length) {
    config.secrets = endpoint.secretEnvironmentVariables
      .map(({ key }) => key)
      .sort();
  }

  if (Object.keys(endpoint.labels || {}).length) {
    config.labels = endpoint.labels;
  }

  let trigger;
  if (endpoint.callableTrigger) {
    trigger = { type: "callable" };
  } else if (endpoint.httpsTrigger) {
    trigger = {
      type: "http",
      invoker: [...(endpoint.httpsTrigger.invoker || [])].sort(),
    };
  } else if (endpoint.taskQueueTrigger) {
    trigger = {
      type: "taskQueue",
      retry: compactObject(endpoint.taskQueueTrigger.retryConfig || {}),
      rateLimits: compactObject(endpoint.taskQueueTrigger.rateLimits || {}),
    };
  } else if (endpoint.eventTrigger) {
    const filters = endpoint.eventTrigger.eventFilters || {};
    trigger = {
      type: "event",
      eventType: endpoint.eventTrigger.eventType,
      pathPatterns: endpoint.eventTrigger.eventFilterPathPatterns || {},
      retry: endpoint.eventTrigger.retry,
      ...(Object.keys(filters).length ? { filters } : {}),
    };
  } else {
    throw new Error("Unsupported Firebase endpoint trigger");
  }

  return runtimeContract(trigger, config);
};

test("preserves the Firebase deployment export ABI", () => {
  const deployedFunctions = require(functionsIndexPath);
  assert.equal(expectedExportNames.length, 6);
  assert.deepEqual(Object.keys(deployedFunctions).sort(), expectedExportNames);
});

test("preserves normalized Firebase endpoint contracts", () => {
  const deployedFunctions = require(functionsIndexPath);
  const actualContracts = Object.fromEntries(
    Object.entries(deployedFunctions).map(([name, callable]) => [
      name,
      normalizeEndpoint(callable.__endpoint),
    ]),
  );

  assert.deepEqual(actualContracts, expectedEndpointContracts);
});

test("preserves the @mons/shared subpath export map and declarations", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sharedDirectory, "package.json"), "utf8"),
  );

  assert.equal(packageJson.name, "@mons/shared");
  assert.deepEqual(packageJson.exports, expectedSharedExports);

  for (const target of Object.values(expectedSharedExports)) {
    const implementationPath = path.join(sharedDirectory, target);
    const declarationPath = implementationPath.replace(/\.js$/, ".d.ts");
    assert.equal(fs.existsSync(implementationPath), true, implementationPath);
    assert.equal(fs.existsSync(declarationPath), true, declarationPath);
  }
});

test("keeps standard-specific Solana SDKs out of entry-point loading", () => {
  const script = `
    require(${JSON.stringify(functionsIndexPath)});
    const forbidden = [
      "/node_modules/@metaplex-foundation/mpl-core/",
      "/node_modules/@metaplex-foundation/mpl-bubblegum/",
    ];
    const loaded = Object.keys(require.cache).filter((modulePath) =>
      forbidden.some((fragment) => modulePath.includes(fragment))
    );
    if (loaded.length > 0) {
      throw new Error(loaded.join("\\n"));
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
