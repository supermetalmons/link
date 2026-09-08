import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  createFirebaseTokenProvider,
  createWranglerRunner,
  digest,
  privateDirectory,
  readPrivateJson,
  readResponseJson,
  writePrivateImmutable,
  type SqlRunner,
} from "./manage-wager-state.ts";

const require = createRequire(import.meta.url);
const { matchDiscoverySortKey, resolveMatchDiscoveryInvite } =
  require("../cloud/functions/shared/login-match-discovery.js") as {
    matchDiscoverySortKey(value: string): string;
    resolveMatchDiscoveryInvite(
      value: string,
      hasInvite: (inviteId: string) => Promise<boolean>,
    ): Promise<{ inviteId: string | null; resolution: Resolution }>;
  };
const { parser } = require("stream-json") as {
  parser(options: Record<string, boolean>): Transform;
};
const ROOT = resolve(import.meta.dirname, "..");
const DATABASE = "mons-link-profile-games";
const FIREBASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const PAGE_SIZE = 200;
const BATCH_SIZE = 100;
const VERSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
type Resolution = "resolved" | "missing" | "ambiguous";
type JsonRecord = Record<string, unknown>;
type Operation =
  "status" | "preflight" | "export" | "import" | "verify" | "activate";
type Arguments = {
  operation: Operation;
  directory?: string;
  firebaseCredentials?: string;
  candidateVersionId?: string;
};
type DiscoveryRow = {
  loginUid: string;
  matchId: string;
  matchSortKey: string;
  inviteId: string | null;
  resolution: Resolution;
};
type StoredRow = DiscoveryRow & { provenance: "capture" | "backfill" };
type PageProof = { file: string; digest: string; count: number };
type Inventory = {
  path: string;
  count: number;
  digest: string;
  pages: PageProof[];
};
type PlayerExport = {
  loginUid: string;
  inventory: Inventory;
  pages: PageProof[];
};
type Manifest = {
  schemaVersion: 1;
  exportId: string;
  createdAtMs: number;
  captureVersionId: string;
  captureStartedAtMs: number;
  players: Inventory;
  invites: Inventory;
  playerExports: PageProof[];
  playerCount: number;
  matchCount: number;
  sourceDigest: string;
};
type Control = {
  discovery_backend: "rtdb" | "d1";
  capture_enforced: 0 | 1;
  capture_version_id: string | null;
  capture_started_at_ms: number | null;
  import_id: string | null;
  source_digest: string | null;
  imported_at_ms: number | null;
  verified_at_ms: number | null;
  verification_digest: string | null;
};
type Dependencies = {
  run: SqlRunner;
  now(): number;
  log(value: JsonRecord): void;
  assertDeployment(versionId: string): Promise<void>;
  streamKeys(path: string): AsyncIterable<string>;
  inviteExists(inviteId: string): Promise<boolean>;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid discovery record");
  return value as JsonRecord;
}

function key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 768 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!;
      return code > 0x1f && code !== 0x7f && !".#$/[]".includes(character);
    })
  );
}

function parseArgs(argv: string[]): Arguments {
  const operation = argv[0]?.replace(/^--/, "") as Operation;
  if (
    !["status", "preflight", "export", "import", "verify", "activate"].includes(
      operation,
    )
  )
    throw new Error(
      "choose --status, --preflight, --export, --import, --verify or --activate",
    );
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !value ||
      value.startsWith("--") ||
      options.has(option) ||
      ![
        "--directory",
        "--firebase-credentials",
        "--candidate-version-id",
      ].includes(option)
    )
      throw new Error("invalid login-match discovery arguments");
    options.set(option, value);
  }
  const directory = options.get("--directory");
  const firebaseCredentials = options.get("--firebase-credentials");
  const candidateVersionId = options.get("--candidate-version-id");
  if (operation === "status" && options.size)
    throw new Error("status takes no options");
  if (operation !== "status" && (!directory || !isAbsolute(directory)))
    throw new Error(
      "an absolute private --directory outside the repository is required",
    );
  if (
    ["preflight", "verify", "activate"].includes(operation) &&
    (!candidateVersionId || !VERSION.test(candidateVersionId))
  )
    throw new Error(
      "preflight, verify and activate require the exact --candidate-version-id",
    );
  if (
    candidateVersionId &&
    !["preflight", "verify", "activate"].includes(operation)
  )
    throw new Error(
      "candidate version is only valid for preflight, verify and activate",
    );
  if (
    ["export", "verify", "activate"].includes(operation) &&
    (!firebaseCredentials || !isAbsolute(firebaseCredentials))
  )
    throw new Error(
      "an explicit absolute --firebase-credentials file is required for source scanning",
    );
  if (
    firebaseCredentials &&
    !["export", "verify", "activate"].includes(operation)
  )
    throw new Error("this operation does not read Firebase credentials");
  return { operation, directory, firebaseCredentials, candidateVersionId };
}

async function* parseShallowKeys(source: Readable): AsyncGenerator<string> {
  const tokens = parser({
    packKeys: false,
    packStrings: false,
    packNumbers: false,
  });
  let streamFailure: unknown;
  const completed = pipeline(source, tokens).catch((error: unknown) => {
    streamFailure = error;
    tokens.destroy(
      error instanceof Error ? error : new Error("shallow stream failed"),
    );
  });
  let root: "unset" | "object" | "complete" = "unset";
  let pendingKey: string | null = null;
  let buildingKey = false;
  let bytes = 0;
  try {
    for await (const raw of tokens) {
      const token = raw as { name: string; value?: string };
      if (root === "unset" && token.name === "nullValue") {
        root = "complete";
        continue;
      }
      if (root === "unset" && token.name === "startObject") {
        root = "object";
        continue;
      }
      if (root !== "object") throw new Error("invalid shallow root");
      if (token.name === "startKey" && pendingKey === null) {
        pendingKey = "";
        buildingKey = true;
      } else if (token.name === "stringChunk" && buildingKey) {
        pendingKey += token.value || "";
        if (Buffer.byteLength(pendingKey!) > 768)
          throw new Error("oversized Firebase key");
      } else if (token.name === "endKey" && buildingKey) {
        buildingKey = false;
        if (!key(pendingKey)) throw new Error("invalid Firebase key");
      } else if (
        token.name === "trueValue" &&
        pendingKey !== null &&
        !buildingKey
      ) {
        bytes += Buffer.byteLength(pendingKey);
        if (bytes > 1024 * 1024 * 1024)
          throw new Error("shallow inventory exceeds 1 GiB; incomplete export");
        yield pendingKey;
        pendingKey = null;
      } else if (token.name === "endObject" && pendingKey === null) {
        root = "complete";
      } else throw new Error("non-shallow or malformed Firebase inventory");
    }
    await completed;
    if (streamFailure) throw streamFailure;
    if (root !== "complete") throw new Error("incomplete shallow inventory");
  } finally {
    source.destroy();
    tokens.destroy();
    await completed;
  }
}

function filePath(directory: string, file: string): string {
  if (!/^[a-z0-9-]+\.json$/.test(file))
    throw new Error("invalid artifact path");
  return resolve(directory, file);
}

function readProof<T>(directory: string, proof: PageProof): T {
  if (
    !HASH.test(proof.digest) ||
    !Number.isSafeInteger(proof.count) ||
    proof.count < 0
  )
    throw new Error("invalid page proof");
  const value = readPrivateJson(filePath(directory, proof.file));
  if (digest(value) !== proof.digest)
    throw new Error("artifact digest mismatch");
  return value as T;
}

function publish(
  directory: string,
  file: string,
  value: unknown,
  count: number,
): PageProof {
  writePrivateImmutable(filePath(directory, file), value);
  return { file, digest: digest(value), count };
}

function openSpool(directory: string): { db: DatabaseSync; close(): void } {
  const path = resolve(directory, `spool-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode = MEMORY; PRAGMA temp_store = FILE; CREATE TABLE keys (key TEXT PRIMARY KEY, sort_key TEXT NOT NULL UNIQUE) WITHOUT ROWID;",
  );
  return {
    db,
    close() {
      db.close();
      rmSync(path, { force: true });
    },
  };
}

async function inventory(
  directory: string,
  path: string,
  dependencies: Dependencies,
): Promise<Inventory> {
  const prefix = `keys-${digest(path)}`;
  const manifestFile = `${prefix}-complete.json`;
  if (existsSync(filePath(directory, manifestFile))) {
    const stored = readPrivateJson(
      filePath(directory, manifestFile),
    ) as Inventory;
    if (stored.path !== path) throw new Error("inventory path conflict");
    for (const _key of inventoryKeys(directory, stored)) void _key;
    return stored;
  }
  const spool = openSpool(directory);
  const scanId = randomUUID();
  try {
    const insert = spool.db.prepare(
      "INSERT INTO keys (key, sort_key) VALUES (?, ?)",
    );
    let count = 0;
    for await (const value of dependencies.streamKeys(path)) {
      if (!key(value)) throw new Error("invalid source key");
      insert.run(value, matchDiscoverySortKey(value));
      count++;
    }
    const pages: PageProof[] = [];
    const hash = createHash("sha256");
    let cursor = "";
    for (;;) {
      const values = spool.db
        .prepare(
          "SELECT key, sort_key FROM keys WHERE sort_key > ? ORDER BY sort_key LIMIT ?",
        )
        .all(cursor, PAGE_SIZE) as Array<{ key: string; sort_key: string }>;
      if (!values.length) break;
      const keys = values.map((value) => value.key);
      for (const value of keys) hash.update(canonicalJson(value) + "\n");
      pages.push(
        publish(
          directory,
          `${prefix}-${scanId}-${pages.length}.json`,
          keys,
          keys.length,
        ),
      );
      cursor = values.at(-1)!.sort_key;
    }
    const result: Inventory = {
      path,
      pages,
      count,
      digest: hash.digest("hex"),
    };
    writePrivateImmutable(filePath(directory, manifestFile), result);
    return result;
  } finally {
    spool.close();
  }
}

function* inventoryKeys(
  directory: string,
  inventory: Inventory,
): Generator<string> {
  const hash = createHash("sha256");
  let previous = "";
  let count = 0;
  for (const proof of inventory.pages) {
    const values = readProof<unknown[]>(directory, proof);
    if (
      !Array.isArray(values) ||
      values.length !== proof.count ||
      values.length > PAGE_SIZE
    )
      throw new Error("invalid inventory page");
    for (const value of values) {
      if (!key(value) || matchDiscoverySortKey(value) <= previous)
        throw new Error("unordered source inventory");
      previous = matchDiscoverySortKey(value);
      hash.update(canonicalJson(value) + "\n");
      count++;
      yield value;
    }
  }
  if (count !== inventory.count || hash.digest("hex") !== inventory.digest)
    throw new Error("incomplete inventory proof");
}

function parseRow(value: unknown): DiscoveryRow {
  const row = record(value);
  if (
    !key(row.loginUid) ||
    !key(row.matchId) ||
    row.matchSortKey !== matchDiscoverySortKey(row.matchId) ||
    !["resolved", "missing", "ambiguous"].includes(String(row.resolution)) ||
    (row.resolution === "resolved" ? !key(row.inviteId) : row.inviteId !== null)
  )
    throw new Error("invalid discovery row");
  return row as DiscoveryRow;
}

function* exportedRows(
  directory: string,
  manifest: Manifest,
): Generator<DiscoveryRow> {
  const hash = createHash("sha256");
  let count = 0;
  let players = 0;
  const expectedPlayers = inventoryKeys(directory, manifest.players);
  for (const proof of manifest.playerExports) {
    const player = readProof<PlayerExport>(directory, proof);
    if (
      !key(player.loginUid) ||
      expectedPlayers.next().value !== player.loginUid ||
      player.inventory.path !== `players/${player.loginUid}/matches`
    )
      throw new Error("player inventory coverage mismatch");
    const expectedMatches = inventoryKeys(directory, player.inventory);
    let playerCount = 0;
    for (const pageProof of player.pages) {
      const rows = readProof<unknown[]>(directory, pageProof);
      if (
        !Array.isArray(rows) ||
        rows.length !== pageProof.count ||
        rows.length > PAGE_SIZE
      )
        throw new Error("invalid discovery page");
      for (const raw of rows) {
        const row = parseRow(raw);
        if (
          row.loginUid !== player.loginUid ||
          expectedMatches.next().value !== row.matchId
        )
          throw new Error("match inventory coverage mismatch");
        hash.update(canonicalJson(row) + "\n");
        count++;
        playerCount++;
        yield row;
      }
    }
    if (
      !expectedMatches.next().done ||
      playerCount !== player.inventory.count ||
      proof.count !== playerCount
    )
      throw new Error("incomplete player export");
    players++;
  }
  if (
    !expectedPlayers.next().done ||
    players !== manifest.playerCount ||
    count !== manifest.matchCount ||
    hash.digest("hex") !== manifest.sourceDigest
  )
    throw new Error("incomplete export manifest");
}

function loadExport(directory: string): Manifest {
  const manifest = readPrivateJson(
    filePath(directory, "manifest.json"),
  ) as Manifest;
  if (
    manifest.schemaVersion !== 1 ||
    !VERSION.test(manifest.exportId) ||
    !VERSION.test(manifest.captureVersionId) ||
    !HASH.test(manifest.sourceDigest) ||
    manifest.players.path !== "players" ||
    manifest.invites.path !== "invites"
  )
    throw new Error("invalid export manifest");
  for (const _key of inventoryKeys(directory, manifest.invites)) void _key;
  for (const _row of exportedRows(directory, manifest)) void _row;
  return manifest;
}

async function readControl(dependencies: Dependencies): Promise<Control> {
  const rows = await dependencies.run(
    "SELECT * FROM login_match_discovery_control WHERE singleton = 1",
    DATABASE,
  );
  const row = record(rows[0]);
  if (
    !["rtdb", "d1"].includes(String(row.discovery_backend)) ||
    ![0, 1].includes(Number(row.capture_enforced))
  )
    throw new Error("discovery control schema is unavailable");
  return row as Control;
}

async function assertCapture(
  dependencies: Dependencies,
  manifest?: Manifest,
): Promise<Control> {
  const control = await readControl(dependencies);
  if (
    control.capture_enforced !== 1 ||
    !control.capture_version_id ||
    !VERSION.test(control.capture_version_id) ||
    !Number.isSafeInteger(control.capture_started_at_ms)
  )
    throw new Error(
      "run capture preflight after promoting the capture-aware API",
    );
  if (
    manifest &&
    (manifest.captureVersionId !== control.capture_version_id ||
      manifest.captureStartedAtMs !== control.capture_started_at_ms)
  )
    throw new Error("capture evidence changed");
  await dependencies.assertDeployment(control.capture_version_id);
  const gates = await dependencies.run(
    "SELECT (SELECT backend FROM automatch_runtime_control WHERE singleton = 1) AS backend, (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'login_match_discovery_completion_guard') AS trigger_count",
    DATABASE,
  );
  if (gates[0]?.backend !== "d1" || gates[0]?.trigger_count !== 1)
    throw new Error(
      "D1 automatch and the capture completion guard are required",
    );
  return control;
}

async function preflight(
  directory: string,
  versionId: string,
  dependencies: Dependencies,
): Promise<void> {
  await dependencies.assertDeployment(versionId);
  const gates = await dependencies.run(
    "SELECT (SELECT backend FROM automatch_runtime_control WHERE singleton = 1) AS backend, (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'login_match_discovery_completion_guard') AS trigger_count",
    DATABASE,
  );
  if (gates[0]?.backend !== "d1" || gates[0]?.trigger_count !== 1)
    throw new Error(
      "apply reviewed discovery migrations and require active D1 automatch first",
    );
  const timestamp = dependencies.now();
  const changed = await dependencies.run(
    "UPDATE login_match_discovery_control SET capture_enforced = 1, capture_version_id = ?, capture_started_at_ms = ? WHERE singleton = 1 AND capture_enforced = 0 AND discovery_backend = 'rtdb' RETURNING singleton",
    DATABASE,
    [versionId, timestamp],
  );
  const control = await assertCapture(dependencies);
  if (control.capture_version_id !== versionId)
    throw new Error("capture version cannot be replaced during this migration");
  writePrivateImmutable(filePath(directory, "capture-evidence.json"), {
    schemaVersion: 1,
    captureVersionId: versionId,
    captureStartedAtMs: control.capture_started_at_ms,
    automatchBackend: "d1",
    completionGuard: "login_match_discovery_completion_guard",
  });
  dependencies.log({
    operation: "preflight",
    captureEnforced: true,
    changed: changed.length === 1,
    versionId,
  });
}

async function exportSource(
  directory: string,
  dependencies: Dependencies,
  allowActivated = false,
): Promise<Manifest> {
  const control = await assertCapture(dependencies);
  if (control.discovery_backend !== "rtdb" && !allowActivated)
    throw new Error("activated discovery cannot be reimported");
  if (existsSync(filePath(directory, "manifest.json")))
    return loadExport(directory);
  const sessionPath = filePath(directory, "export-session.json");
  if (!existsSync(sessionPath))
    writePrivateImmutable(sessionPath, {
      exportId: randomUUID(),
      createdAtMs: dependencies.now(),
      captureVersionId: control.capture_version_id,
      captureStartedAtMs: control.capture_started_at_ms,
    });
  const session = record(readPrivateJson(sessionPath));
  if (
    session.captureVersionId !== control.capture_version_id ||
    session.captureStartedAtMs !== control.capture_started_at_ms
  )
    throw new Error("export capture generation changed");
  const players = await inventory(directory, "players", dependencies);
  const invites = await inventory(directory, "invites", dependencies);
  const spool = openSpool(directory);
  try {
    const insert = spool.db.prepare(
      "INSERT INTO keys (key, sort_key) VALUES (?, ?)",
    );
    for (const inviteId of inventoryKeys(directory, invites))
      insert.run(inviteId, matchDiscoverySortKey(inviteId));
    const hasInvite = async (inviteId: string) =>
      Boolean(
        spool.db.prepare("SELECT key FROM keys WHERE key = ?").get(inviteId),
      );
    const resolveCapturedMappings = async (rows: DiscoveryRow[]) => {
      for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
        const candidates = rows
          .slice(offset, offset + BATCH_SIZE)
          .filter(
            (row) =>
              row.resolution === "resolved" &&
              row.inviteId !== row.matchId.trim(),
          );
        if (!candidates.length) continue;
        const pending = await dependencies.run(
          `SELECT 1 AS pending FROM game_session_transitions t, json_each(t.payload_json, '$.creations') c
          WHERE t.status = 'pending' AND json_extract(c.value, '$.path') IN (
            SELECT 'players/' || json_extract(p.value, '$[0]') || '/matches/' || json_extract(p.value, '$[1]') FROM json_each(?) p
          ) LIMIT 1`,
          DATABASE,
          [
            JSON.stringify(
              candidates.map((row) => [row.loginUid, row.matchId]),
            ),
          ],
        );
        if (pending.length)
          throw new Error(
            "pending session transitions must capture discovery mappings before export; retry",
          );
        const captured = new Map(
          (await readRows(candidates, dependencies)).map((row) => [
            canonicalJson([row.loginUid, row.matchId]),
            row,
          ]),
        );
        for (const row of candidates) {
          const target = captured.get(
            canonicalJson([row.loginUid, row.matchId]),
          );
          if (
            target?.provenance !== "capture" ||
            target.resolution !== "resolved"
          ) {
            const exactInviteId = row.matchId.trim();
            if (await dependencies.inviteExists(exactInviteId))
              row.inviteId = exactInviteId;
            continue;
          }
          if (target.inviteId === row.inviteId) continue;
          if (await hasInvite(target.inviteId!))
            throw new Error("conflicting captured discovery mapping");
          row.inviteId = target.inviteId;
        }
      }
    };
    const playerExports: PageProof[] = [];
    const hash = createHash("sha256");
    let matchCount = 0;
    const exportPlayer = async (
      loginUid: string,
    ): Promise<{ player: PlayerExport; proof: PageProof }> => {
      const prefix = `player-${digest(loginUid)}`;
      const playerFile = `${prefix}-complete.json`;
      let player: PlayerExport;
      if (existsSync(filePath(directory, playerFile))) {
        player = readPrivateJson(
          filePath(directory, playerFile),
        ) as PlayerExport;
      } else {
        const matches = await inventory(
          directory,
          `players/${loginUid}/matches`,
          dependencies,
        );
        const pages: PageProof[] = [];
        let rows: DiscoveryRow[] = [];
        const publishRows = async () => {
          if (!rows.length) return;
          const file = `${prefix}-${pages.length}.json`;
          if (existsSync(filePath(directory, file))) {
            const stored = readPrivateJson(filePath(directory, file));
            if (!Array.isArray(stored) || stored.length !== rows.length)
              throw new Error("invalid resumed discovery page");
            rows = stored.map((value, index) => {
              const row = parseRow(value);
              if (
                row.loginUid !== rows[index].loginUid ||
                row.matchId !== rows[index].matchId ||
                row.matchSortKey !== rows[index].matchSortKey
              )
                throw new Error("resumed discovery page coverage mismatch");
              return row;
            });
          } else await resolveCapturedMappings(rows);
          pages.push(publish(directory, file, rows, rows.length));
          rows = [];
        };
        for (const matchId of inventoryKeys(directory, matches)) {
          rows.push({
            loginUid,
            matchId,
            matchSortKey: matchDiscoverySortKey(matchId),
            ...(await resolveMatchDiscoveryInvite(matchId, hasInvite)),
          });
          if (rows.length === PAGE_SIZE) await publishRows();
        }
        await publishRows();
        player = { loginUid, inventory: matches, pages };
        writePrivateImmutable(filePath(directory, playerFile), player);
      }
      return {
        player,
        proof: {
          file: playerFile,
          digest: digest(player),
          count: player.inventory.count,
        },
      };
    };
    let group: string[] = [];
    const flush = async () => {
      const outcomes = await Promise.allSettled(group.map(exportPlayer));
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const outcome of outcomes) {
        if (outcome.status !== "fulfilled")
          throw new Error("incomplete player export group");
        for (const page of outcome.value.player.pages)
          for (const row of readProof<DiscoveryRow[]>(directory, page)) {
            hash.update(canonicalJson(parseRow(row)) + "\n");
            matchCount++;
          }
        playerExports.push(outcome.value.proof);
      }
      group = [];
      if (
        playerExports.length % 100 < outcomes.length ||
        playerExports.length === players.count
      )
        dependencies.log({
          operation: "export",
          playerCount: playerExports.length,
          matchCount,
        });
    };
    for (const loginUid of inventoryKeys(directory, players)) {
      group.push(loginUid);
      if (group.length === 8) await flush();
    }
    if (group.length) await flush();
    const manifest: Manifest = {
      schemaVersion: 1,
      exportId: String(session.exportId),
      createdAtMs: Number(session.createdAtMs),
      captureVersionId: String(session.captureVersionId),
      captureStartedAtMs: Number(session.captureStartedAtMs),
      players,
      invites,
      playerExports,
      playerCount: players.count,
      matchCount,
      sourceDigest: hash.digest("hex"),
    };
    await assertCapture(dependencies, manifest);
    writePrivateImmutable(filePath(directory, "manifest.json"), manifest);
    return loadExport(directory);
  } finally {
    spool.close();
  }
}

function storedRow(value: unknown): StoredRow {
  const row = record(value);
  if (row.provenance !== "capture" && row.provenance !== "backfill")
    throw new Error("invalid index provenance");
  return {
    ...parseRow({
      loginUid: row.login_uid,
      matchId: row.match_id,
      matchSortKey: row.match_sort_key,
      inviteId: row.invite_id,
      resolution: row.resolution,
    }),
    provenance: row.provenance,
  };
}

function compatible(source: DiscoveryRow, target: StoredRow): boolean {
  return (
    source.loginUid === target.loginUid &&
    source.matchId === target.matchId &&
    source.matchSortKey === target.matchSortKey &&
    ((source.inviteId === target.inviteId &&
      source.resolution === target.resolution) ||
      (source.resolution !== "resolved" &&
        target.resolution === "resolved" &&
        target.provenance === "capture"))
  );
}

async function readRows(
  rows: DiscoveryRow[],
  dependencies: Dependencies,
): Promise<StoredRow[]> {
  if (!rows.length) return [];
  if (rows.length > BATCH_SIZE)
    throw new Error("oversized discovery query batch");
  return (
    await dependencies.run(
      "SELECT * FROM login_match_discovery WHERE (login_uid, match_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))",
      DATABASE,
      [JSON.stringify(rows.map((row) => [row.loginUid, row.matchId]))],
    )
  ).map(storedRow);
}

async function checkRows(
  rows: DiscoveryRow[],
  dependencies: Dependencies,
): Promise<StoredRow[]> {
  const stored = await readRows(rows, dependencies);
  const byKey = new Map(
    stored.map((row) => [canonicalJson([row.loginUid, row.matchId]), row]),
  );
  for (const row of rows) {
    const target = byKey.get(canonicalJson([row.loginUid, row.matchId]));
    if (!target || !compatible(row, target))
      throw new Error(
        "missing or conflicting discovery mapping; reconcile without overwriting",
      );
  }
  return stored;
}

async function importSource(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  const control = await assertCapture(dependencies, manifest);
  if (control.discovery_backend !== "rtdb")
    throw new Error("activated discovery cannot be imported");
  const began = await dependencies.run(
    "UPDATE login_match_discovery_control SET import_id = ?, source_digest = ?, source_player_count = ?, source_match_count = ? WHERE singleton = 1 AND discovery_backend = 'rtdb' AND capture_enforced = 1 AND (import_id IS NULL OR import_id = ?) RETURNING singleton",
    DATABASE,
    [
      manifest.exportId,
      manifest.sourceDigest,
      manifest.playerCount,
      manifest.matchCount,
      manifest.exportId,
    ],
  );
  if (began.length !== 1)
    throw new Error("another immutable export already owns the import");
  let batch: DiscoveryRow[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await dependencies.run(
      "WITH incoming AS (SELECT value FROM json_each(?)) INSERT INTO login_match_discovery (login_uid, match_id, match_sort_key, invite_id, resolution, provenance, indexed_at_ms) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), 'backfill', ? FROM incoming WHERE EXISTS (SELECT 1 FROM login_match_discovery_control WHERE singleton = 1 AND discovery_backend = 'rtdb' AND capture_enforced = 1 AND import_id = ?) ON CONFLICT(login_uid, match_id) DO NOTHING",
      DATABASE,
      [
        JSON.stringify(
          batch.map((row) => [
            row.loginUid,
            row.matchId,
            row.matchSortKey,
            row.inviteId,
            row.resolution,
          ]),
        ),
        manifest.createdAtMs,
        manifest.exportId,
      ],
    );
    await checkRows(batch, dependencies);
    batch = [];
  };
  for (const row of exportedRows(directory, manifest)) {
    batch.push(row);
    if (batch.length === BATCH_SIZE) await flush();
  }
  await flush();
  const done = await dependencies.run(
    "UPDATE login_match_discovery_control SET imported_at_ms = ? WHERE singleton = 1 AND import_id = ? AND source_digest = ? AND discovery_backend = 'rtdb' RETURNING singleton",
    DATABASE,
    [dependencies.now(), manifest.exportId, manifest.sourceDigest],
  );
  if (done.length !== 1) throw new Error("import completion was not confirmed");
}

async function assertJournal(
  dependencies: Dependencies,
  startedAtMs: number,
): Promise<void> {
  const counts = await dependencies.run(
    `SELECT
    (SELECT count(*) FROM game_session_transitions WHERE status = 'pending') AS pending,
    (SELECT count(*) FROM game_session_transitions t, json_each(t.payload_json, '$.creations') c
      WHERE t.status = 'completed' AND t.updated_at_ms >= ? AND NOT EXISTS (
        SELECT 1 FROM login_match_discovery d WHERE d.login_uid = substr(json_extract(c.value, '$.path'), 9, instr(substr(json_extract(c.value, '$.path'), 9), '/') - 1)
          AND d.match_id = substr(json_extract(c.value, '$.path'), instr(substr(json_extract(c.value, '$.path'), 9), '/') + 17)
          AND d.invite_id = t.invite_id AND d.resolution = 'resolved')) AS missing`,
    DATABASE,
    [startedAtMs],
  );
  if (counts[0]?.missing !== 0)
    throw new Error(
      "completed session transition is missing captured discovery rows",
    );
  if (counts[0]?.pending !== 0)
    throw new Error(
      "pending session transitions must reconcile before verification or activation",
    );
}

async function verifySource(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<{
  liveMatchCount: number;
  capturedExtras: number;
  digest: string;
  liveSourceDigest: string;
  liveInventoryDirectory: string;
}> {
  const liveInventoryDirectory = `verification-source-${randomUUID()}`;
  const liveDirectory = privateDirectory(
    resolve(directory, liveInventoryDirectory),
  );
  const liveManifest = await exportSource(liveDirectory, dependencies, true);
  const spool = openSpool(directory);
  try {
    spool.db.exec(
      "CREATE TABLE baseline (login_uid TEXT, match_id TEXT, row_json TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(login_uid, match_id)) WITHOUT ROWID;",
    );
    const baselineInsert = spool.db.prepare(
      "INSERT INTO baseline (login_uid, match_id, row_json) VALUES (?, ?, ?)",
    );
    for (const row of exportedRows(directory, manifest))
      baselineInsert.run(row.loginUid, row.matchId, canonicalJson(row));
    let liveMatchCount = 0;
    let capturedExtras = 0;
    let batch: DiscoveryRow[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const stored = await checkRows(batch, dependencies);
      const byKey = new Map(
        stored.map((row) => [canonicalJson([row.loginUid, row.matchId]), row]),
      );
      for (const row of batch) {
        const baseline = spool.db
          .prepare(
            "SELECT row_json FROM baseline WHERE login_uid = ? AND match_id = ?",
          )
          .get(row.loginUid, row.matchId) as { row_json: string } | undefined;
        const target = byKey.get(canonicalJson([row.loginUid, row.matchId]))!;
        if (baseline) {
          if (!compatible(parseRow(JSON.parse(baseline.row_json)), target))
            throw new Error(
              "source resolution changed incompatibly during capture",
            );
          spool.db
            .prepare(
              "UPDATE baseline SET seen = 1 WHERE login_uid = ? AND match_id = ?",
            )
            .run(row.loginUid, row.matchId);
        } else {
          if (target.provenance !== "capture")
            throw new Error(
              "new source match lacks durable capture provenance",
            );
          capturedExtras++;
        }
        liveMatchCount++;
      }
      batch = [];
    };
    for (const row of exportedRows(liveDirectory, liveManifest)) {
      batch.push(row);
      if (batch.length === BATCH_SIZE) await flush();
    }
    await flush();
    if (
      (
        spool.db
          .prepare("SELECT count(*) AS count FROM baseline WHERE seen = 0")
          .get() as { count: number }
      ).count
    )
      throw new Error(
        "exported match keys disappeared from Firebase; preserve and reconcile evidence",
      );
    let cursorLogin = "";
    let cursorMatch = "";
    for (;;) {
      const rows = (
        await dependencies.run(
          "SELECT * FROM login_match_discovery WHERE (login_uid, match_sort_key) > (?, ?) ORDER BY login_uid, match_sort_key LIMIT 100",
          DATABASE,
          [cursorLogin, cursorMatch],
        )
      ).map(storedRow);
      if (!rows.length) break;
      for (const row of rows) {
        const baseline = spool.db
          .prepare(
            "SELECT row_json FROM baseline WHERE login_uid = ? AND match_id = ?",
          )
          .get(row.loginUid, row.matchId) as { row_json: string } | undefined;
        if (
          baseline
            ? !compatible(parseRow(JSON.parse(baseline.row_json)), row)
            : row.provenance !== "capture"
        )
          throw new Error(
            "unexpected destination backfill row or conflicting mapping",
          );
      }
      cursorLogin = rows.at(-1)!.loginUid;
      cursorMatch = rows.at(-1)!.matchSortKey;
    }
    const result = {
      sourceDigest: manifest.sourceDigest,
      liveSourceDigest: liveManifest.sourceDigest,
      liveMatchCount,
      capturedExtras,
    };
    return {
      liveMatchCount,
      capturedExtras,
      digest: digest(result),
      liveSourceDigest: liveManifest.sourceDigest,
      liveInventoryDirectory,
    };
  } finally {
    spool.close();
  }
}

async function verify(
  directory: string,
  manifest: Manifest,
  versionId: string,
  dependencies: Dependencies,
): Promise<void> {
  const control = await assertCapture(dependencies, manifest);
  if (
    versionId !== manifest.captureVersionId ||
    control.import_id !== manifest.exportId ||
    control.source_digest !== manifest.sourceDigest ||
    control.imported_at_ms === null
  )
    throw new Error(
      "verification requires the imported export and capture candidate",
    );
  const result = await verifySource(directory, manifest, dependencies);
  await assertCapture(dependencies, manifest);
  await assertJournal(dependencies, manifest.captureStartedAtMs);
  const verifiedAtMs = dependencies.now();
  const rows = await dependencies.run(
    "UPDATE login_match_discovery_control SET verified_at_ms = ?, verification_digest = ? WHERE singleton = 1 AND capture_enforced = 1 AND import_id = ? AND source_digest = ? AND capture_version_id = ? RETURNING singleton",
    DATABASE,
    [
      verifiedAtMs,
      result.digest,
      manifest.exportId,
      manifest.sourceDigest,
      versionId,
    ],
  );
  if (rows.length !== 1) throw new Error("verification proof was not recorded");
  publish(
    directory,
    `verification-${verifiedAtMs}-${randomUUID()}.json`,
    {
      schemaVersion: 1,
      exportId: manifest.exportId,
      versionId,
      verifiedAtMs,
      ...result,
    },
    result.liveMatchCount,
  );
  dependencies.log({ operation: "verify", ...result });
}

async function activate(
  directory: string,
  manifest: Manifest,
  versionId: string,
  dependencies: Dependencies,
): Promise<void> {
  const current = await assertCapture(dependencies, manifest);
  if (current.discovery_backend === "d1") {
    if (
      current.import_id !== manifest.exportId ||
      current.source_digest !== manifest.sourceDigest ||
      current.verified_at_ms === null
    )
      throw new Error("activated discovery belongs to different evidence");
    dependencies.log({ operation: "activate", alreadyActivated: true });
    return;
  }
  await verify(directory, manifest, versionId, dependencies);
  const activated = await dependencies.run(
    `UPDATE login_match_discovery_control SET discovery_backend = 'd1', activated_at_ms = ?
    WHERE singleton = 1 AND discovery_backend = 'rtdb' AND capture_enforced = 1 AND import_id = ? AND source_digest = ? AND capture_version_id = ? AND verified_at_ms IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM game_session_transitions WHERE status = 'pending')
    AND NOT EXISTS (SELECT 1 FROM game_session_transitions t, json_each(t.payload_json, '$.creations') c
      WHERE t.status = 'completed' AND t.updated_at_ms >= capture_started_at_ms AND NOT EXISTS (
        SELECT 1 FROM login_match_discovery d WHERE d.login_uid = substr(json_extract(c.value, '$.path'), 9, instr(substr(json_extract(c.value, '$.path'), 9), '/') - 1)
          AND d.match_id = substr(json_extract(c.value, '$.path'), instr(substr(json_extract(c.value, '$.path'), 9), '/') + 17)
          AND d.invite_id = t.invite_id AND d.resolution = 'resolved')) RETURNING singleton`,
    DATABASE,
    [dependencies.now(), manifest.exportId, manifest.sourceDigest, versionId],
  );
  if (activated.length !== 1)
    throw new Error(
      "activation not confirmed; inspect capture and pending transitions, then retry",
    );
  dependencies.log({ operation: "activate", activated: true });
}

async function manageLoginMatchDiscovery(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "status") {
    const control = await readControl(dependencies);
    const counts = await dependencies.run(
      "SELECT provenance, resolution, count(*) AS count FROM login_match_discovery GROUP BY provenance, resolution",
      DATABASE,
    );
    dependencies.log({ operation: "status", control, counts });
    return;
  }
  const directory = privateDirectory(args.directory!);
  if (args.operation === "preflight")
    return preflight(directory, args.candidateVersionId!, dependencies);
  if (args.operation === "export") {
    const manifest = await exportSource(directory, dependencies);
    dependencies.log({
      operation: "export",
      exportId: manifest.exportId,
      playerCount: manifest.playerCount,
      matchCount: manifest.matchCount,
      sourceDigest: manifest.sourceDigest,
    });
    return;
  }
  const manifest = loadExport(directory);
  if (args.operation === "import") {
    await importSource(directory, manifest, dependencies);
    dependencies.log({ operation: "import", matchCount: manifest.matchCount });
    return;
  }
  if (args.operation === "verify")
    return verify(directory, manifest, args.candidateVersionId!, dependencies);
  return activate(directory, manifest, args.candidateVersionId!, dependencies);
}

function createProductionDependencies(
  credentialsPath?: string,
  fetcher = fetch,
): Dependencies {
  const token = credentialsPath
    ? createFirebaseTokenProvider(credentialsPath)
    : null;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const typescript = require("typescript") as typeof import("typescript");
  const parsed = typescript.parseConfigFileTextToJson(
    resolve(ROOT, "cloud/workers/api/wrangler.jsonc"),
    readFileSync(resolve(ROOT, "cloud/workers/api/wrangler.jsonc"), "utf8"),
  );
  const accountId = record(parsed.config).account_id;
  if (
    parsed.error ||
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accountId)
  )
    throw new Error("invalid tracked Cloudflare account");
  const cloudflare = async (path: string) => {
    if (!apiToken)
      throw new Error(
        "CLOUDFLARE_API_TOKEN is required for migration evidence and writes",
      );
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    const payload = record(await readResponseJson(response));
    if (payload.success !== true)
      throw new Error("Cloudflare evidence request failed");
    return record(payload.result);
  };
  return {
    run: createWranglerRunner({ apiToken, fetcher }),
    now: Date.now,
    log: (value) => console.log(JSON.stringify(value)),
    async assertDeployment(versionId) {
      const result = await cloudflare(
        "workers/scripts/mons-link-api/deployments",
      );
      const deployments = result.deployments;
      const first = Array.isArray(deployments) ? record(deployments[0]) : {};
      const versions = first.versions;
      if (
        !Array.isArray(versions) ||
        versions.length !== 1 ||
        record(versions[0]).version_id !== versionId ||
        record(versions[0]).percentage !== 100
      )
        throw new Error(
          "capture candidate must be the sole 100% deployed API version",
        );
      const subdomain = await cloudflare(
        "workers/scripts/mons-link-api/subdomain",
      );
      if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
        throw new Error(
          "Worker subdomain and version previews must remain disabled",
        );
    },
    async *streamKeys(path) {
      if (!token)
        throw new Error(
          "explicit Firebase service-account credentials are required",
        );
      if (
        path !== "players" &&
        path !== "invites" &&
        !/^players\/[^/]+\/matches$/.test(path) &&
        !/^invites\/[^/]+$/.test(path)
      )
        throw new Error("unsupported discovery source path");
      const url = new URL(
        `${FIREBASE_ROOT}/${path.split("/").map(encodeURIComponent).join("/")}.json`,
      );
      url.searchParams.set("shallow", "true");
      const response = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${await token()}`,
          Accept: "application/json",
        },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok || !response.body)
        throw new Error(
          "Firebase inventory request failed; export remains incomplete",
        );
      yield* parseShallowKeys(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ),
      );
    },
    async inviteExists(inviteId) {
      if (!key(inviteId)) throw new Error("invalid discovery invite key");
      let exists = false;
      for await (const field of this.streamKeys(`invites/${inviteId}`)) {
        void field;
        exists = true;
      }
      return exists;
    },
  };
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "manage:login-match-discovery --status | --preflight --directory /secure/discovery --candidate-version-id <deployed-version> | --export --directory /secure/discovery --firebase-credentials /secure/firebase.json | --import --directory /secure/discovery | --verify|--activate --directory /secure/discovery --firebase-credentials /secure/firebase.json --candidate-version-id <deployed-version>",
    );
    return;
  }
  const args = parseArgs(argv);
  await manageLoginMatchDiscovery(
    args,
    createProductionDependencies(args.firebaseCredentials),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "discovery migration failed; inspect retained evidence",
    );
    process.exitCode = 1;
  });
}

export {
  parseArgs,
  parseShallowKeys,
  inventory,
  inventoryKeys,
  loadExport,
  exportedRows,
  compatible,
  manageLoginMatchDiscovery,
  createProductionDependencies,
  type Dependencies,
  type DiscoveryRow,
  type StoredRow,
};
