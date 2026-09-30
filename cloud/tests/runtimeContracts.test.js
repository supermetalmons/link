"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const runtimeDirectory = path.resolve(__dirname, "../runtime");
const sharedDirectory = path.join(runtimeDirectory, "shared");

const expectedSharedExports = {
  "./auth": "./auth.js",
  "./event-prizes": "./event-prizes.js",
  "./events": "./events.js",
  "./game-bootstrap": "./game-bootstrap.js",
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
  "./session-bootstrap": "./session-bootstrap.js",
  "./solana": "./solana.js",
  "./timers": "./timers.js",
  "./usernames": "./usernames.js",
  "./wagers": "./wagers.js",
  "./x-redirect": "./x-redirect.js",
};

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

test("keeps standard-specific Solana SDKs out of portable module loading", () => {
  const script = `
    require(${JSON.stringify(path.join(runtimeDirectory, "eventPrizes/solana.js"))});
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

test("preserves every portable runtime and shared value export", () => {
  const expected = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/runtime-value-exports.json"),
      "utf8",
    ),
  );
  for (const [modulePath, exports] of Object.entries(expected)) {
    assert.deepEqual(
      Object.keys(require(path.join(runtimeDirectory, modulePath))).sort(),
      exports,
      modulePath,
    );
  }
});

test("preserves event command identities, replacement order, and serialized plans", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/runtime-wire-compatibility.json"),
      "utf8",
    ),
  );
  const {
    eventCommandIdentity,
    eventField,
    getEventField,
    mergeEventPlans,
  } = require("../runtime/eventCommands");
  assert.deepEqual(
    fixture.eventPlan.map(eventCommandIdentity),
    fixture.eventCommandIdentities,
  );
  const replacement = eventField("event-é", "status", "ended");
  assert.deepEqual(replacement, fixture.replacement);
  const merged = mergeEventPlans(fixture.eventPlan, [replacement]);
  assert.equal(JSON.stringify(merged), fixture.mergedPlanJson);
  assert.equal(getEventField(merged, "event-é", "status"), "ended");
  assert.equal(getEventField(merged, "missing", "status"), undefined);
});

test("preserves Telegram task identities and both compatibility call forms", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/runtime-wire-compatibility.json"),
      "utf8",
    ),
  );
  const {
    buildTelegramDeliveryTaskId,
    normalizeTaskPayload,
  } = require("../runtime/telegram/taskIdentity");
  for (const { payload, taskId } of fixture.telegramTasks) {
    assert.equal(buildTelegramDeliveryTaskId(payload), taskId);
    assert.deepEqual(normalizeTaskPayload(payload), payload);
  }
  const { payload, taskId } = fixture.telegramTasks[0];
  assert.equal(
    buildTelegramDeliveryTaskId(
      payload.messageKey,
      payload.revision,
      payload.generation,
    ),
    taskId,
  );
  assert.throws(
    () => normalizeTaskPayload({ ...payload, taskKind: "rate-limit-proof" }),
    { message: "complete rate-limit proof is required" },
  );
});

test("shared generated outputs work as a standalone copied dependency", () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mons-shared-consumer-")),
  );
  const packageDirectory = path.join(directory, "node_modules/@mons/shared");
  try {
    fs.cpSync(sharedDirectory, packageDirectory, {
      recursive: true,
      filter(source) {
        if (fs.statSync(source).isDirectory()) {
          return !["src", "node_modules"].includes(path.basename(source));
        }
        return (
          path.basename(source) === "package.json" ||
          source.endsWith(".js") ||
          source.endsWith(".d.ts")
        );
      },
    });
    const consumer = path.join(directory, "consumer.cjs");
    fs.writeFileSync(
      consumer,
      String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const expected = ${JSON.stringify(expectedSharedExports)};
const packageDirectory = path.join(__dirname, "node_modules/@mons/shared");
const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
assert.deepEqual(manifest.exports, expected);
assert.equal(fs.existsSync(path.join(packageDirectory, "src")), false);
for (const [subpath, target] of Object.entries(expected)) {
  const name = "@mons/shared/" + subpath.slice(2);
  assert.equal(require.resolve(name), path.resolve(packageDirectory, target));
  assert.equal(typeof require(name), "object", name);
}
const ids = require("@mons/shared/ids");
assert.equal(ids.buildAutoInviteId(() => 0), "auto_aaaaaaaaaaa");
assert.equal(ids.isSafeRecordKey("valid_key"), true);
assert.equal(ids.isSafeRecordKey("bad/key"), false);
const events = require("@mons/shared/events");
assert.equal(events.getEventBracketSize(5), 8);
assert.equal(events.buildEventMatchKey(2, 3), "2_3");
assert.equal(require("@mons/shared/usernames").buildUsernameLookupKey(" Player "), "player");
assert.deepEqual(require("@mons/shared/match-protocol").buildFreshMatchRecord({
  color: "white", emojiId: 7, aura: null, seed: { gameVariant: "Classic", fen: "seed" },
}), {
  version: 2, color: "white", emojiId: 7, aura: null, gameVariant: "Classic", fen: "seed",
  status: "", flatMovesString: "", timer: "",
});
for (const filename of fs.readdirSync(packageDirectory, { recursive: true })) {
  const fullPath = path.join(packageDirectory, filename);
  if (!fs.statSync(fullPath).isFile()) continue;
  assert.ok(filename === "package.json" || filename.endsWith(".js") || filename.endsWith(".d.ts"));
  if (!filename.endsWith(".d.ts")) continue;
  const declaration = fs.readFileSync(fullPath, "utf8").replace(/^\/\/ Generated[^\n]*\n/, "");
  assert.doesNotMatch(declaration, /(?:^|["'])[^"'\n]*\bsrc\//m, filename);
  assert.doesNotMatch(declaration, /\b(?:NodeJS|NodeRequire|NodeModule|Buffer|D1Database(?:Session)?|DurableObject[A-Za-z]*|WorkerEntrypoint|ExecutionContext|Workflow(?:Step|Event|Entrypoint|Instance)|Umi|PublicKey)\b/, filename);
  assert.doesNotMatch(declaration, /<reference\s+(?:types|path)=/, filename);
  for (const match of declaration.matchAll(/\b(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    assert.ok(specifier.startsWith("./"), filename + ": " + specifier);
    const target = path.resolve(path.dirname(fullPath), specifier.replace(/\.js$/, ".d.ts"));
    assert.ok(target.startsWith(packageDirectory + path.sep), target);
    assert.equal(fs.existsSync(target), true, target);
  }
}
for (const filename of Object.keys(require.cache)) {
  assert.ok(filename === __filename || filename.startsWith(packageDirectory + path.sep), filename);
}
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--permission", `--allow-fs-read=${directory}`, consumer],
      {
        cwd: directory,
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
