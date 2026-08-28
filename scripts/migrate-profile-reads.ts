import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isPlayerProfile } from "@mons/shared/profiles";
import {
  createProfileProjection,
  PROFILE_PROJECTION_SCHEMA_VERSION,
  profileProjectionDigest,
  type ProfileProjection,
} from "../cloud/workers/api/src/profileProjectionModel.ts";

type MigrationMode = "dry-run" | "execute" | "verify";
type JsonRecord = Record<string, unknown>;

type FirestoreTimestamp = {
  nanoseconds: number;
  seconds: number;
};

type FirestoreDocument = {
  data(): JsonRecord;
  id: string;
  updateTime: FirestoreTimestamp;
};

type FirestoreQuerySnapshot = {
  docs: FirestoreDocument[];
  empty: boolean;
};

type FirestoreQuery = {
  get(): Promise<FirestoreQuerySnapshot>;
  limit(value: number): FirestoreQuery;
  orderBy(field: unknown): FirestoreQuery;
  startAfter(document: FirestoreDocument): FirestoreQuery;
};

type FirestoreDatabase = {
  collection(name: string): FirestoreQuery;
};

type FirestoreFactory = (() => FirestoreDatabase) & {
  FieldPath: { documentId(): unknown };
};

const requireFromScript = createRequire(import.meta.url);
const adminSupport: {
  addApplicationDefaultCredentialHelp(error: unknown): unknown;
  admin: { firestore: FirestoreFactory };
  cleanupAdmin(): Promise<void>;
  initAdmin(args: string[]): boolean;
} = requireFromScript("../cloud/admin/_admin.js");

const DATABASE_NAME = "mons-link-profiles";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const FIREBASE_PROJECT = "mons-link";
const PAGE_SIZE = 250;
const PROFILE_METADATA_PAGE_SIZE = 1_000;
const LOGIN_VERIFY_PAGE_SIZE = 1_000;
export const MAX_PROFILE_VERIFY_BATCH_BYTES = 1_000_000;
export const MAX_PROFILE_VERIFY_BATCH_ROWS = 100;

type D1Parameter = null | number | string;

export type D1Statement = {
  params?: D1Parameter[];
  sql: string;
};

type D1Client = {
  query(statements: D1Statement[]): Promise<JsonRecord[][]>;
};

type Options = {
  mode: MigrationMode;
  project: string;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function parseArgs(argv: string[]): Options {
  let mode: MigrationMode = "dry-run";
  let project = FIREBASE_PROJECT;
  let modeSet = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--execute" || arg === "--verify") {
      if (modeSet) {
        throw new Error("choose one migration mode");
      }
      modeSet = true;
      mode = arg.slice(2) as MigrationMode;
      continue;
    }
    if (arg === "--project") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("missing project");
      }
      project = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (project !== FIREBASE_PROJECT) {
    throw new Error(`profile migration only supports ${FIREBASE_PROJECT}`);
  }
  return { mode, project };
}

function updateTime(timestamp: FirestoreTimestamp): string {
  if (
    !Number.isSafeInteger(timestamp.seconds) ||
    !Number.isSafeInteger(timestamp.nanoseconds) ||
    timestamp.nanoseconds < 0 ||
    timestamp.nanoseconds >= 1_000_000_000
  ) {
    throw new Error("invalid Firestore update timestamp");
  }
  const whole = new Date(timestamp.seconds * 1_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "");
  return `${whole}.${String(timestamp.nanoseconds).padStart(9, "0")}Z`;
}

async function readSourceProfiles(): Promise<ProfileProjection[]> {
  const firestore = adminSupport.admin.firestore();
  let query = firestore
    .collection("users")
    .orderBy(adminSupport.admin.firestore.FieldPath.documentId())
    .limit(PAGE_SIZE);
  const projections: ProfileProjection[] = [];
  while (true) {
    const page = await query.get();
    if (page.empty) {
      return projections;
    }
    for (const document of page.docs) {
      projections.push(
        await createProfileProjection({
          profileId: document.id,
          fields: document.data(),
          updateTime: updateTime(document.updateTime),
        }),
      );
    }
    const last = page.docs.at(-1);
    if (!last || page.docs.length < PAGE_SIZE) {
      return projections;
    }
    query = firestore
      .collection("users")
      .orderBy(adminSupport.admin.firestore.FieldPath.documentId())
      .startAfter(last)
      .limit(PAGE_SIZE);
  }
}

export function profileImportStatements(
  projection: ProfileProjection,
  projectedAtMs: number,
): D1Statement[] {
  const profileId = projection.profile.id;
  const { nanos, seconds } = projection.sourceVersion;
  const schemaVersion = projection.schemaVersion;
  const activeVersionParams: D1Parameter[] = [
    profileId,
    seconds,
    nanos,
    schemaVersion,
    seconds,
    nanos,
  ];
  const activeVersionSql = `
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profile_id = ?
        AND source_update_seconds = ?
        AND source_update_nanos = ?
        AND projection_schema_version = ?
        AND projection_schema_source_seconds = ?
        AND projection_schema_source_nanos = ?
        AND is_deleted = 0
    )
  `;
  return [
    {
      sql: `
        INSERT INTO profiles (
          profile_id, payload_json, merged_into_profile_id,
          rating_sort, mana_points_sort, dust_sort, slime_sort, gum_sort,
          metal_sort, ice_sort, source_update_seconds, source_update_nanos,
          source_digest, projected_at_ms, is_deleted,
          projection_schema_version, projection_schema_source_seconds,
          projection_schema_source_nanos, rating_sort_present,
          mana_points_sort_present, dust_sort_present, slime_sort_present,
          gum_sort_present, metal_sort_present, ice_sort_present
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (profile_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          merged_into_profile_id = excluded.merged_into_profile_id,
          rating_sort = excluded.rating_sort,
          mana_points_sort = excluded.mana_points_sort,
          dust_sort = excluded.dust_sort,
          slime_sort = excluded.slime_sort,
          gum_sort = excluded.gum_sort,
          metal_sort = excluded.metal_sort,
          ice_sort = excluded.ice_sort,
          source_update_seconds = excluded.source_update_seconds,
          source_update_nanos = excluded.source_update_nanos,
          source_digest = excluded.source_digest,
          projected_at_ms = excluded.projected_at_ms,
          is_deleted = 0,
          projection_schema_version = excluded.projection_schema_version,
          projection_schema_source_seconds = excluded.projection_schema_source_seconds,
          projection_schema_source_nanos = excluded.projection_schema_source_nanos,
          rating_sort_present = excluded.rating_sort_present,
          mana_points_sort_present = excluded.mana_points_sort_present,
          dust_sort_present = excluded.dust_sort_present,
          slime_sort_present = excluded.slime_sort_present,
          gum_sort_present = excluded.gum_sort_present,
          metal_sort_present = excluded.metal_sort_present,
          ice_sort_present = excluded.ice_sort_present
        WHERE excluded.source_update_seconds > profiles.source_update_seconds
          OR (
            excluded.source_update_seconds = profiles.source_update_seconds
            AND (
              excluded.source_update_nanos > profiles.source_update_nanos
              OR (
                excluded.source_update_nanos = profiles.source_update_nanos
                AND excluded.projection_schema_version >= profiles.projection_schema_version
                AND profiles.is_deleted = 0
              )
            )
          )
      `,
      params: [
        profileId,
        JSON.stringify(projection.profile),
        projection.mergedIntoProfileId,
        projection.sortValues.rating,
        projection.sortValues.mp,
        projection.sortValues.dust,
        projection.sortValues.slime,
        projection.sortValues.gum,
        projection.sortValues.metal,
        projection.sortValues.ice,
        seconds,
        nanos,
        projection.digest,
        projectedAtMs,
        schemaVersion,
        seconds,
        nanos,
        Number(projection.sortPresence.rating),
        Number(projection.sortPresence.mp),
        Number(projection.sortPresence.dust),
        Number(projection.sortPresence.slime),
        Number(projection.sortPresence.gum),
        Number(projection.sortPresence.metal),
        Number(projection.sortPresence.ice),
      ],
    },
    {
      sql: `DELETE FROM profile_logins_v2 WHERE profile_id = ? AND ${activeVersionSql}`,
      params: [profileId, ...activeVersionParams],
    },
    {
      sql: `
        INSERT OR IGNORE INTO profile_logins_v2 (
          login_uid, profile_id, projection_schema_version
        )
        SELECT CAST(value AS TEXT), ?, ? FROM json_each(?)
        WHERE ${activeVersionSql}
      `,
      params: [
        profileId,
        schemaVersion,
        JSON.stringify(projection.logins),
        ...activeVersionParams,
      ],
    },
    {
      sql: `
        DELETE FROM profile_projection_failures
        WHERE profile_id = ?
          AND (
            source_update_seconds < ?
            OR (
              source_update_seconds = ?
              AND (
                source_update_nanos < ?
                OR (
                  source_update_nanos = ?
                  AND projection_schema_version <= ?
                )
              )
            )
          )
      `,
      params: [profileId, seconds, seconds, nanos, nanos, schemaVersion],
    },
  ];
}

export function assertMigrationCommandSucceeded(result: {
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: unknown;
  stdout: unknown;
}): void {
  if (result.status === 0) {
    return;
  }
  throw new Error(
    result.signal
      ? "profile D1 command terminated"
      : `profile D1 command exited ${result.status ?? "without status"}`,
  );
}

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  assertMigrationCommandSucceeded(result);
  return String(result.stdout);
}

function cloudflareToken(): string {
  const environmentToken = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  if (environmentToken) {
    return environmentToken;
  }
  const output = run(resolve("node_modules/.bin/wrangler"), [
    "auth",
    "token",
    "--json",
    "--config",
    CONFIG_PATH,
    "--env-file",
    RELEASE_ENV_PATH,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error("invalid Cloudflare authentication response");
  }
  const token = record(parsed)?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("missing Cloudflare authentication token");
  }
  return token.trim();
}

function profileD1Coordinates(): { accountId: string; databaseId: string } {
  const typescript = requireFromScript("typescript") as {
    parseConfigFileTextToJson(
      path: string,
      value: string,
    ): { config?: unknown; error?: unknown };
  };
  const config = typescript.parseConfigFileTextToJson(
    CONFIG_PATH,
    readFileSync(resolve(CONFIG_PATH), "utf8"),
  );
  if (config.error) {
    throw new Error("invalid profile D1 configuration");
  }
  const parsed = record(config.config);
  const accountId = parsed?.account_id;
  const databases = parsed?.d1_databases;
  const database = Array.isArray(databases)
    ? databases.find((value) => record(value)?.database_name === DATABASE_NAME)
    : null;
  const databaseId = record(database)?.database_id;
  if (
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    typeof databaseId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(databaseId)
  ) {
    throw new Error("invalid profile D1 configuration");
  }
  return { accountId, databaseId };
}

function createD1Client(): D1Client {
  const { accountId, databaseId } = profileD1Coordinates();
  const token = cloudflareToken();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return {
    async query(statements) {
      const response = await fetch(url, {
        body: JSON.stringify({ batch: statements }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new Error("invalid profile D1 response");
      }
      const root = record(parsed);
      const result = root?.result;
      if (
        !response.ok ||
        root?.success !== true ||
        !Array.isArray(result) ||
        result.length !== statements.length
      ) {
        throw new Error("profile D1 query failed");
      }
      return result.map((entry) => {
        const queryResult = record(entry);
        if (queryResult?.success !== true) {
          throw new Error("profile D1 query failed");
        }
        const rows = queryResult.results;
        return Array.isArray(rows)
          ? rows.filter((value): value is JsonRecord => Boolean(record(value)))
          : [];
      });
    },
  };
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function projectionDigest(projections: ProfileProjection[]): string {
  const hash = createHash("sha256");
  for (const projection of [...projections].sort((left, right) =>
    compareUtf8(left.profile.id, right.profile.id),
  )) {
    hash.update(projection.profile.id);
    hash.update(":");
    hash.update(projection.digest);
    hash.update("\n");
  }
  return hash.digest("hex");
}

type LoginMapping = {
  loginUid: string;
  profileId: string;
};

type ProfileSourceVersion = {
  nanos: number;
  profileId: string;
  schemaVersion: number;
  seconds: number;
};

export function profileSourceVersionDigest(
  versions: ProfileSourceVersion[],
): string {
  const hash = createHash("sha256");
  for (const version of [...versions].sort((left, right) =>
    compareUtf8(left.profileId, right.profileId),
  )) {
    hash.update(
      JSON.stringify([
        version.profileId,
        version.seconds,
        version.nanos,
        version.schemaVersion,
      ]),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function profileLoginMappingDigest(mappings: LoginMapping[]): string {
  const hash = createHash("sha256");
  for (const mapping of [...mappings].sort((left, right) => {
    const profileOrder = compareUtf8(left.profileId, right.profileId);
    return profileOrder || compareUtf8(left.loginUid, right.loginUid);
  })) {
    hash.update(JSON.stringify([mapping.profileId, mapping.loginUid]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("invalid D1 profile projection");
  }
  return parsed;
}

function booleanFlag(value: unknown): boolean {
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) {
    throw new Error("invalid D1 profile projection");
  }
  return parsed === 1;
}

type ProfileVerificationRow = {
  payloadBytes: number;
  profileId: string;
};

export function profileVerificationBatches<T extends ProfileVerificationRow>(
  rows: T[],
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.payloadBytes) || row.payloadBytes < 0) {
      throw new Error("invalid D1 profile projection");
    }
    if (
      batch.length > 0 &&
      (batch.length >= MAX_PROFILE_VERIFY_BATCH_ROWS ||
        bytes + row.payloadBytes > MAX_PROFILE_VERIFY_BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += row.payloadBytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

async function queryRows(
  client: D1Client,
  statement: D1Statement,
): Promise<JsonRecord[]> {
  const result = await client.query([statement]);
  return result[0] || [];
}

async function d1Digest(client: D1Client): Promise<{
  digest: string;
  loginDigest: string;
  logins: number;
  profiles: number;
  versionDigest: string;
}> {
  const countRows = await queryRows(client, {
    sql: "SELECT (SELECT COUNT(*) FROM profiles WHERE is_deleted = 0) AS profiles, (SELECT COUNT(*) FROM profile_logins_v2) AS logins, (SELECT COUNT(*) FROM profile_projection_failures) AS failures",
  });
  const profiles = Number(countRows[0]?.profiles);
  const logins = Number(countRows[0]?.logins);
  if (
    !Number.isSafeInteger(profiles) ||
    profiles < 0 ||
    !Number.isSafeInteger(logins) ||
    logins < 0 ||
    Number(countRows[0]?.failures) !== 0
  ) {
    throw new Error("profile D1 contains invalid projections");
  }
  const mappings: LoginMapping[] = [];
  let mappingCursor: LoginMapping | null = null;
  while (true) {
    const rows = await queryRows(client, {
      sql: `
        SELECT profile_id, login_uid, projection_schema_version
        FROM profile_logins_v2
        ${
          mappingCursor
            ? "WHERE profile_id COLLATE BINARY > ? OR (profile_id = ? AND login_uid COLLATE BINARY > ?)"
            : ""
        }
        ORDER BY profile_id COLLATE BINARY, login_uid COLLATE BINARY
        LIMIT ${LOGIN_VERIFY_PAGE_SIZE}
      `,
      params: mappingCursor
        ? [
            mappingCursor.profileId,
            mappingCursor.profileId,
            mappingCursor.loginUid,
          ]
        : [],
    });
    for (const row of rows) {
      if (
        Number(row.projection_schema_version) !==
        PROFILE_PROJECTION_SCHEMA_VERSION
      ) {
        throw new Error("invalid D1 profile projection");
      }
      mappings.push({
        profileId: String(row.profile_id),
        loginUid: String(row.login_uid),
      });
    }
    if (rows.length < LOGIN_VERIFY_PAGE_SIZE) {
      break;
    }
    const last = mappings.at(-1);
    if (!last) {
      throw new Error("invalid D1 profile projection");
    }
    mappingCursor = last;
  }
  const loginsByProfile = new Map<string, string[]>();
  for (const mapping of mappings) {
    const profileLogins = loginsByProfile.get(mapping.profileId) || [];
    profileLogins.push(mapping.loginUid);
    loginsByProfile.set(mapping.profileId, profileLogins);
  }
  const hash = createHash("sha256");
  const versions: ProfileSourceVersion[] = [];
  let profileCursor: string | null = null;
  while (true) {
    const rows = await queryRows(client, {
      sql: `
        SELECT profile_id, length(CAST(payload_json AS BLOB)) AS payload_bytes,
          merged_into_profile_id, rating_sort, mana_points_sort, dust_sort,
          slime_sort, gum_sort, metal_sort, ice_sort, source_update_seconds,
          source_update_nanos, source_digest, projection_schema_version,
          projection_schema_source_seconds, projection_schema_source_nanos,
          rating_sort_present, mana_points_sort_present, dust_sort_present,
          slime_sort_present, gum_sort_present, metal_sort_present,
          ice_sort_present
        FROM profiles
        WHERE is_deleted = 0
          ${profileCursor ? "AND profile_id COLLATE BINARY > ?" : ""}
        ORDER BY profile_id COLLATE BINARY
        LIMIT ${PROFILE_METADATA_PAGE_SIZE}
      `,
      params: profileCursor ? [profileCursor] : [],
    });
    const verificationRows = rows.map((row) => ({
      payloadBytes: Number(row.payload_bytes),
      profileId: String(row.profile_id),
      row,
    }));
    const payloads = new Map<string, unknown>();
    for (const batch of profileVerificationBatches(verificationRows)) {
      const payloadRows = await queryRows(client, {
        sql: `
          SELECT profile_id, payload_json
          FROM profiles
          WHERE is_deleted = 0
            AND profile_id IN (${batch.map(() => "?").join(", ")})
          ORDER BY profile_id COLLATE BINARY
        `,
        params: batch.map(({ profileId }) => profileId),
      });
      for (const payloadRow of payloadRows) {
        const profileId = String(payloadRow.profile_id);
        if (payloads.has(profileId)) {
          throw new Error("invalid D1 profile projection");
        }
        try {
          payloads.set(
            profileId,
            JSON.parse(String(payloadRow.payload_json)) as unknown,
          );
        } catch {
          throw new Error("invalid D1 profile projection");
        }
      }
    }
    for (const { profileId, row } of verificationRows) {
      const profile = payloads.get(profileId);
      if (!isPlayerProfile(profile) || profile.id !== profileId) {
        throw new Error("invalid D1 profile projection");
      }
      const seconds = Number(row.source_update_seconds);
      const nanos = Number(row.source_update_nanos);
      const schemaVersion = Number(row.projection_schema_version);
      if (
        !Number.isSafeInteger(seconds) ||
        !Number.isSafeInteger(nanos) ||
        nanos < 0 ||
        nanos >= 1_000_000_000 ||
        schemaVersion !== PROFILE_PROJECTION_SCHEMA_VERSION ||
        Number(row.projection_schema_source_seconds) !== seconds ||
        Number(row.projection_schema_source_nanos) !== nanos
      ) {
        throw new Error("invalid D1 profile projection");
      }
      versions.push({ profileId, schemaVersion, seconds, nanos });
      const mergedIntoProfileId =
        row.merged_into_profile_id === null ||
        row.merged_into_profile_id === undefined
          ? null
          : String(row.merged_into_profile_id);
      const sortValues = {
        rating: nullableNumber(row.rating_sort),
        mp: nullableNumber(row.mana_points_sort),
        dust: nullableNumber(row.dust_sort),
        slime: nullableNumber(row.slime_sort),
        gum: nullableNumber(row.gum_sort),
        metal: nullableNumber(row.metal_sort),
        ice: nullableNumber(row.ice_sort),
      };
      const sortPresence = {
        rating: booleanFlag(row.rating_sort_present),
        mp: booleanFlag(row.mana_points_sort_present),
        dust: booleanFlag(row.dust_sort_present),
        slime: booleanFlag(row.slime_sort_present),
        gum: booleanFlag(row.gum_sort_present),
        metal: booleanFlag(row.metal_sort_present),
        ice: booleanFlag(row.ice_sort_present),
      };
      if (
        Object.entries(sortPresence).some(
          ([key, present]) =>
            !present && sortValues[key as keyof typeof sortValues] !== null,
        )
      ) {
        throw new Error("invalid D1 profile projection");
      }
      const actualDigest = await profileProjectionDigest({
        profile,
        logins: [...(loginsByProfile.get(profileId) || [])].sort(),
        mergedIntoProfileId,
        schemaVersion,
        sortPresence,
        sortValues,
      });
      if (String(row.source_digest) !== actualDigest) {
        throw new Error("invalid D1 profile projection");
      }
      hash.update(profileId);
      hash.update(":");
      hash.update(actualDigest);
      hash.update("\n");
    }
    if (rows.length < PROFILE_METADATA_PAGE_SIZE) {
      break;
    }
    const last = verificationRows.at(-1);
    if (!last) {
      throw new Error("invalid D1 profile projection");
    }
    profileCursor = last.profileId;
  }
  return {
    profiles,
    logins,
    digest: hash.digest("hex"),
    loginDigest: profileLoginMappingDigest(mappings),
    versionDigest: profileSourceVersionDigest(versions),
  };
}

function sourceSummary(projections: ProfileProjection[]) {
  return {
    profiles: projections.length,
    logins: projections.reduce(
      (total, projection) => total + projection.logins.length,
      0,
    ),
    digest: projectionDigest(projections),
    versionDigest: profileSourceVersionDigest(
      projections.map((projection) => ({
        profileId: projection.profile.id,
        schemaVersion: projection.schemaVersion,
        seconds: projection.sourceVersion.seconds,
        nanos: projection.sourceVersion.nanos,
      })),
    ),
    loginDigest: profileLoginMappingDigest(
      projections.flatMap((projection) =>
        projection.logins.map((loginUid) => ({
          loginUid,
          profileId: projection.profile.id,
        })),
      ),
    ),
  };
}

function assertVerificationMatch(
  source: ReturnType<typeof sourceSummary>,
  target: Awaited<ReturnType<typeof d1Digest>>,
): void {
  if (
    target.profiles !== source.profiles ||
    target.logins !== source.logins ||
    target.digest !== source.digest ||
    target.loginDigest !== source.loginDigest ||
    target.versionDigest !== source.versionDigest
  ) {
    throw new Error("profile D1 verification mismatch");
  }
}

export async function execute(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (!adminSupport.initAdmin(["--project", options.project])) {
    throw new Error("failed to initialize Firebase Admin");
  }
  try {
    if (options.mode === "dry-run") {
      const projections = await readSourceProfiles();
      for (const projection of projections) {
        profileImportStatements(projection, 1);
      }
      const source = sourceSummary(projections);
      console.log(JSON.stringify({ mode: options.mode, ...source }));
      return;
    }
    const client = createD1Client();
    if (options.mode === "execute") {
      const projections = await readSourceProfiles();
      const projectedAtMs = Date.now();
      for (const projection of projections) {
        await client.query(profileImportStatements(projection, projectedAtMs));
      }
    }
    let previous = "";
    let target: Awaited<ReturnType<typeof d1Digest>> | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const source = sourceSummary(await readSourceProfiles());
      const currentTarget = await d1Digest(client);
      assertVerificationMatch(source, currentTarget);
      const fingerprint = JSON.stringify({ source, target: currentTarget });
      if (pass === 1 && fingerprint !== previous) {
        throw new Error("profile D1 verification was not stable");
      }
      previous = fingerprint;
      target = currentTarget;
    }
    if (!target) {
      throw new Error("profile D1 verification failed");
    }
    console.log(
      JSON.stringify({ mode: options.mode, verified: true, ...target }),
    );
  } catch (error) {
    throw adminSupport.addApplicationDefaultCredentialHelp(error);
  } finally {
    await adminSupport.cleanupAdmin();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  execute().catch((error) => {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  });
}
