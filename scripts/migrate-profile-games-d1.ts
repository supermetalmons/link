import type { ProcessEnvironment } from "./cloudflare/runtime.ts";

const { readFileSync }: typeof import("node:fs") = require("node:fs");
const { resolve }: typeof import("node:path") = require("node:path");
const typescript: typeof import("typescript") = require("typescript");
type D1Projection = {
  entity_type: string;
  list_sort_at_ms: number;
  payload_json: string;
  profile_id: string;
  projection_id: string;
  sort_bucket: number;
  status: string;
  updated_at_ms: number;
  version: number;
};
const { encodeProfileGameProjection } =
  require("../cloud/workers/api/src/profileGamesD1.ts") as {
    encodeProfileGameProjection(
      profileId: string,
      projectionId: string,
      data: Record<string, unknown>,
    ): D1Projection;
  };
const { readCloudflareApiToken } = require("./cloudflare/runtime.ts") as {
  readCloudflareApiToken(input: {
    tokenFile?: string;
    environment: ProcessEnvironment;
    readFile: (path: string, encoding: "utf8") => string;
    includeReadError?: boolean;
  }): string;
};

const FIRESTORE_PAGE_SIZE = 400;
const D1_BATCH_SIZE = 100;
const DATABASE_NAME = "mons-link-profile-games";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const USAGE =
  "Usage: npm run migrate:profile-games -- <backfill|verify|cleanup-firestore> [--project <id>] [--token-file <path>] [--dry-run|--execute]";

type Command = "backfill" | "cleanup-firestore" | "verify";
type Options = {
  adminArgs: string[];
  command: Command;
  execute: boolean;
  tokenFile?: string;
};
type ProjectionMap = Map<string, D1Projection>;
type WranglerConfig = {
  account_id?: string;
  d1_databases?: Array<{
    database_id?: string;
    database_name?: string;
  }>;
  vars?: { PROFILE_GAMES_STORAGE_MODE?: string };
};
type D1ApiEnvelope = {
  errors?: Array<{ message?: unknown }>;
  result?: Array<{
    success?: boolean;
    results?: unknown[];
  }>;
  success?: boolean;
};

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new TypeError(`${flag}: ${USAGE}`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const command = argv[0];
  if (
    command !== "backfill" &&
    command !== "verify" &&
    command !== "cleanup-firestore"
  ) {
    throw new TypeError(USAGE);
  }
  const options: Options = { adminArgs: [], command, execute: false };
  let modeSet = false;
  const valueFlags = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--dry-run" || flag === "--execute") {
      if (modeSet || command === "verify") throw new TypeError(USAGE);
      modeSet = true;
      options.execute = flag === "--execute";
      continue;
    }
    if (flag !== "--project" && flag !== "--token-file") {
      throw new TypeError(USAGE);
    }
    if (valueFlags.has(flag)) throw new TypeError(USAGE);
    valueFlags.add(flag);
    const value = readValue(argv, index, flag);
    index += 1;
    if (flag === "--project") options.adminArgs.push(flag, value);
    else options.tokenFile = value;
  }
  return options;
}

function readWranglerConfig(): {
  accountId: string;
  databaseId: string;
  storageMode: string;
} {
  const absolute = resolve(__dirname, "..", CONFIG_PATH);
  const parsed = typescript.parseConfigFileTextToJson(
    absolute,
    readFileSync(absolute, "utf8"),
  );
  if (parsed.error) {
    throw new Error(
      typescript.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
    );
  }
  const config = parsed.config as WranglerConfig;
  const database = config.d1_databases?.find(
    (candidate) => candidate.database_name === DATABASE_NAME,
  );
  if (!config.account_id || !database?.database_id) {
    throw new Error("D1 configuration is incomplete.");
  }
  return {
    accountId: config.account_id,
    databaseId: database.database_id,
    storageMode: config.vars?.PROFILE_GAMES_STORAGE_MODE || "",
  };
}

function projectionKey(profileId: string, projectionId: string): string {
  return `${profileId}\u0000${projectionId}`;
}

function parseProjectionPath(path: string): {
  profileId: string;
  projectionId: string;
} {
  const match = path.match(/^users\/([^/]+)\/games\/([^/]+)$/);
  if (!match) throw new Error(`Invalid profile game path: ${path}`);
  return { profileId: match[1], projectionId: match[2] };
}

function responseError(value: D1ApiEnvelope): Error {
  const message = value.errors?.find(
    (error) => typeof error.message === "string",
  )?.message;
  return new Error(
    typeof message === "string" ? message : "D1 request failed.",
  );
}

async function queryD1(
  input: {
    accountId: string;
    databaseId: string;
    token: string;
  },
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<D1ApiEnvelope> {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  let value: D1ApiEnvelope;
  try {
    value = (await response.json()) as D1ApiEnvelope;
  } catch {
    throw new Error("D1 returned an invalid response.");
  }
  if (!response.ok || value.success !== true) throw responseError(value);
  if (value.result?.some((result) => result.success !== true)) {
    throw responseError(value);
  }
  return value;
}

function backfillQuery(row: D1Projection) {
  return {
    sql: `
      INSERT INTO profile_game_projections (
        profile_id,
        projection_id,
        entity_type,
        status,
        sort_bucket,
        list_sort_at_ms,
        updated_at_ms,
        version,
        payload_json
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM profile_game_projection_tombstones
        WHERE profile_id = ? AND projection_id = ?
      )
      ON CONFLICT (profile_id, projection_id) DO NOTHING
    `,
    params: [
      row.profile_id,
      row.projection_id,
      row.entity_type,
      row.status,
      String(row.sort_bucket),
      String(row.list_sort_at_ms),
      String(row.updated_at_ms),
      row.payload_json,
      row.profile_id,
      row.projection_id,
    ],
  };
}

async function readFirestoreProjections(
  firestore: any,
  documentId: unknown,
): Promise<ProjectionMap> {
  const projections: ProjectionMap = new Map();
  let cursor = "";
  while (true) {
    let query = firestore
      .collectionGroup("games")
      .orderBy(documentId)
      .limit(FIRESTORE_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      const { profileId, projectionId } = parseProjectionPath(
        document.ref.path,
      );
      const row = encodeProfileGameProjection(
        profileId,
        projectionId,
        document.data() || {},
      );
      projections.set(projectionKey(profileId, projectionId), row);
    }
    if (snapshot.size < FIRESTORE_PAGE_SIZE) break;
    cursor = snapshot.docs.at(-1)?.ref.path || "";
    if (!cursor) throw new Error("Firestore pagination made no progress.");
  }
  return projections;
}

function parseD1Rows(value: D1ApiEnvelope): D1Projection[] {
  const rows = value.result?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error("D1 rows were missing.");
  return rows.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("D1 row was invalid.");
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.profile_id !== "string" ||
      typeof row.projection_id !== "string" ||
      typeof row.entity_type !== "string" ||
      typeof row.status !== "string" ||
      typeof row.payload_json !== "string"
    ) {
      throw new Error("D1 row was invalid.");
    }
    return {
      profile_id: row.profile_id,
      projection_id: row.projection_id,
      entity_type: row.entity_type,
      status: row.status,
      sort_bucket: Number(row.sort_bucket),
      list_sort_at_ms: Number(row.list_sort_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
      version: Number(row.version),
      payload_json: row.payload_json,
    };
  });
}

async function readD1Projections(input: {
  accountId: string;
  databaseId: string;
  token: string;
}): Promise<ProjectionMap> {
  const projections: ProjectionMap = new Map();
  let profileId = "";
  let projectionId = "";
  while (true) {
    const value = await queryD1(input, {
      sql: `
        SELECT *
        FROM profile_game_projections
        WHERE profile_id > ? OR (profile_id = ? AND projection_id > ?)
        ORDER BY profile_id ASC, projection_id ASC
        LIMIT ?
      `,
      params: [profileId, profileId, projectionId, String(FIRESTORE_PAGE_SIZE)],
    });
    const rows = parseD1Rows(value);
    rows.forEach((row) =>
      projections.set(projectionKey(row.profile_id, row.projection_id), row),
    );
    if (rows.length < FIRESTORE_PAGE_SIZE) break;
    const last = rows.at(-1);
    if (!last) throw new Error("D1 pagination made no progress.");
    profileId = last.profile_id;
    projectionId = last.projection_id;
  }
  return projections;
}

async function readD1Tombstones(input: {
  accountId: string;
  databaseId: string;
  token: string;
}): Promise<Map<string, number>> {
  const value = await queryD1(input, {
    sql: `SELECT profile_id, projection_id, deleted_at_ms
          FROM profile_game_projection_tombstones`,
    params: [],
  });
  const rows = value.result?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error("D1 tombstones were missing.");
  return new Map(
    rows.map((candidate) => {
      const row = candidate as Record<string, unknown>;
      if (
        typeof row.profile_id !== "string" ||
        typeof row.projection_id !== "string" ||
        !Number.isFinite(Number(row.deleted_at_ms))
      ) {
        throw new Error("D1 tombstone was invalid.");
      }
      return [
        projectionKey(row.profile_id, row.projection_id),
        Number(row.deleted_at_ms),
      ];
    }),
  );
}

function compareProjectionMaps(firestore: ProjectionMap, d1: ProjectionMap) {
  const missing: string[] = [];
  const extra: string[] = [];
  const mismatched: string[] = [];
  for (const [key, expected] of firestore) {
    const actual = d1.get(key);
    if (!actual) missing.push(key);
    else if (
      expected.entity_type !== actual.entity_type ||
      expected.status !== actual.status ||
      expected.sort_bucket !== actual.sort_bucket ||
      expected.list_sort_at_ms !== actual.list_sort_at_ms ||
      expected.updated_at_ms !== actual.updated_at_ms ||
      expected.payload_json !== actual.payload_json
    ) {
      mismatched.push(key);
    }
  }
  for (const key of d1.keys()) {
    if (!firestore.has(key)) extra.push(key);
  }
  return {
    firestore: firestore.size,
    d1: d1.size,
    missing: missing.sort(),
    extra: extra.sort(),
    mismatched: mismatched.sort(),
  };
}

function isFirestoreProjectionSafeToDelete(
  expected: D1Projection,
  actual: D1Projection | undefined,
  deletedAtMs: number | undefined,
): boolean {
  if (actual) {
    if (actual.updated_at_ms > expected.updated_at_ms) return true;
    if (
      actual.updated_at_ms === expected.updated_at_ms &&
      actual.entity_type === expected.entity_type &&
      actual.status === expected.status &&
      actual.sort_bucket === expected.sort_bucket &&
      actual.list_sort_at_ms === expected.list_sort_at_ms &&
      actual.payload_json === expected.payload_json
    ) {
      return true;
    }
  }
  return Boolean(deletedAtMs && deletedAtMs >= expected.updated_at_ms);
}

async function backfill(
  projections: ProjectionMap,
  input: { accountId: string; databaseId: string; token: string },
): Promise<number> {
  const rows = Array.from(projections.values());
  let written = 0;
  for (let index = 0; index < rows.length; index += D1_BATCH_SIZE) {
    const batch = rows.slice(index, index + D1_BATCH_SIZE).map(backfillQuery);
    await queryD1(input, { batch });
    written += batch.length;
  }
  return written;
}

async function deleteFirestoreProjections(
  firestore: any,
  d1: ProjectionMap,
  tombstones: Map<string, number>,
  documentId: unknown,
): Promise<number> {
  let deleted = 0;
  let cursor = "";
  while (true) {
    let query = firestore
      .collectionGroup("games")
      .orderBy(documentId)
      .limit(FIRESTORE_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    const batch = firestore.batch();
    for (const document of snapshot.docs) {
      const { profileId, projectionId } = parseProjectionPath(
        document.ref.path,
      );
      const expected = encodeProfileGameProjection(
        profileId,
        projectionId,
        document.data() || {},
      );
      const actual = d1.get(projectionKey(profileId, projectionId));
      const deletedAtMs = tombstones.get(
        projectionKey(profileId, projectionId),
      );
      if (!isFirestoreProjectionSafeToDelete(expected, actual, deletedAtMs)) {
        throw new Error("D1 is older than a Firestore projection.");
      }
      batch.delete(document.ref, { lastUpdateTime: document.updateTime });
    }
    if (snapshot.size > 0) {
      await batch.commit();
      deleted += snapshot.size;
    }
    if (snapshot.size < FIRESTORE_PAGE_SIZE) break;
    cursor = snapshot.docs.at(-1)?.ref.path || "";
    if (!cursor) throw new Error("Firestore cleanup made no progress.");
  }
  return deleted;
}

async function main(
  argv = process.argv.slice(2),
  environment: ProcessEnvironment = process.env,
) {
  const options = parseArgs(argv);
  const adminHelper = require("../cloud/admin/_admin.js");
  if (!adminHelper.initAdmin(options.adminArgs)) {
    throw new Error(adminHelper.ADC_FAILURE_MESSAGE);
  }
  try {
    const firestore = adminHelper.admin.firestore();
    const documentId = adminHelper.admin.firestore.FieldPath.documentId();
    let firestoreProjections = await readFirestoreProjections(
      firestore,
      documentId,
    );
    if (options.command === "backfill" && !options.execute) {
      const result = {
        command: options.command,
        execute: false,
        firestore: firestoreProjections.size,
      };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const token = readCloudflareApiToken({
      tokenFile: options.tokenFile,
      environment,
      readFile: readFileSync,
      includeReadError: true,
    });
    const d1Config = readWranglerConfig();
    const d1Input = {
      accountId: d1Config.accountId,
      databaseId: d1Config.databaseId,
      token,
    };
    if (options.command === "backfill") {
      const written = await backfill(firestoreProjections, d1Input);
      const result = {
        command: options.command,
        execute: true,
        firestore: firestoreProjections.size,
        submitted: written,
      };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    let d1Projections = await readD1Projections(d1Input);
    if (options.command === "cleanup-firestore") {
      const tombstones = await readD1Tombstones(d1Input);
      const unsafe = Array.from(firestoreProjections).filter(
        ([key, expected]) => {
          const actual = d1Projections.get(key);
          const deletedAtMs = tombstones.get(key);
          return !isFirestoreProjectionSafeToDelete(
            expected,
            actual,
            deletedAtMs,
          );
        },
      ).length;
      if (!options.execute) {
        const result = {
          command: options.command,
          execute: false,
          firestore: firestoreProjections.size,
          d1: d1Projections.size,
          unsafe,
        };
        console.log(JSON.stringify(result, null, 2));
        if (unsafe > 0) process.exitCode = 1;
        return result;
      }
      if (d1Config.storageMode !== "d1") {
        throw new Error("Firestore cleanup requires D1-primary mode.");
      }
      if (unsafe > 0) {
        throw new Error("D1 is older than Firestore; cleanup refused.");
      }
      const deleted = await deleteFirestoreProjections(
        firestore,
        d1Projections,
        tombstones,
        documentId,
      );
      const result = { command: options.command, execute: true, deleted };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    let comparison = compareProjectionMaps(firestoreProjections, d1Projections);
    let clean =
      comparison.missing.length === 0 &&
      comparison.extra.length === 0 &&
      comparison.mismatched.length === 0;
    if (options.command === "verify" && !clean) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      [firestoreProjections, d1Projections] = await Promise.all([
        readFirestoreProjections(firestore, documentId),
        readD1Projections(d1Input),
      ]);
      comparison = compareProjectionMaps(firestoreProjections, d1Projections);
      clean =
        comparison.missing.length === 0 &&
        comparison.extra.length === 0 &&
        comparison.mismatched.length === 0;
    }
    if (options.command === "verify") {
      const result = {
        command: options.command,
        execute: false,
        clean,
        comparison,
      };
      console.log(JSON.stringify(result, null, 2));
      if (!clean) process.exitCode = 1;
      return result;
    }
    throw new Error("Unsupported migration command.");
  } catch (error) {
    throw adminHelper.addApplicationDefaultCredentialHelp(error);
  } finally {
    await adminHelper.cleanupAdmin();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  compareProjectionMaps,
  isFirestoreProjectionSafeToDelete,
  main,
  parseArgs,
};
