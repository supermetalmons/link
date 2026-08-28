import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isPlayerProfile } from "@mons/shared/profiles";
import {
  createProfileProjection,
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
const IMPORT_BATCH_SIZE = 100;
export const MAX_D1_IMPORT_STATEMENT_BYTES = 90_000;
export const PROFILE_VERIFY_PAGE_SIZE = 5;

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

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function sqlNumber(value: number | null): string {
  return value === null ? "NULL" : String(value);
}

export function buildImportSql(
  projections: ProfileProjection[],
  projectedAtMs: number,
): string {
  const statements: string[] = [];
  for (const projection of projections) {
    const profileId = sqlText(projection.profile.id);
    const version = `profile_id = ${profileId} AND source_update_seconds = ${projection.sourceVersion.seconds} AND source_update_nanos = ${projection.sourceVersion.nanos} AND is_deleted = 0`;
    statements.push(
      `INSERT INTO profiles (profile_id, payload_json, merged_into_profile_id, rating_sort, mana_points_sort, dust_sort, slime_sort, gum_sort, metal_sort, ice_sort, source_update_seconds, source_update_nanos, source_digest, projected_at_ms, is_deleted) VALUES (${profileId}, ${sqlText(JSON.stringify(projection.profile))}, ${projection.mergedIntoProfileId ? sqlText(projection.mergedIntoProfileId) : "NULL"}, ${sqlNumber(projection.sortValues.rating)}, ${sqlNumber(projection.sortValues.mp)}, ${sqlNumber(projection.sortValues.dust)}, ${sqlNumber(projection.sortValues.slime)}, ${sqlNumber(projection.sortValues.gum)}, ${sqlNumber(projection.sortValues.metal)}, ${sqlNumber(projection.sortValues.ice)}, ${projection.sourceVersion.seconds}, ${projection.sourceVersion.nanos}, ${sqlText(projection.digest)}, ${projectedAtMs}, 0) ON CONFLICT (profile_id) DO UPDATE SET payload_json = excluded.payload_json, merged_into_profile_id = excluded.merged_into_profile_id, rating_sort = excluded.rating_sort, mana_points_sort = excluded.mana_points_sort, dust_sort = excluded.dust_sort, slime_sort = excluded.slime_sort, gum_sort = excluded.gum_sort, metal_sort = excluded.metal_sort, ice_sort = excluded.ice_sort, source_update_seconds = excluded.source_update_seconds, source_update_nanos = excluded.source_update_nanos, source_digest = excluded.source_digest, projected_at_ms = excluded.projected_at_ms, is_deleted = 0 WHERE excluded.source_update_seconds > profiles.source_update_seconds OR (excluded.source_update_seconds = profiles.source_update_seconds AND excluded.source_update_nanos >= profiles.source_update_nanos AND profiles.is_deleted = 0);`,
      `DELETE FROM profile_logins WHERE profile_id = ${profileId} AND EXISTS (SELECT 1 FROM profiles WHERE ${version});`,
      `INSERT OR IGNORE INTO profile_logins (login_uid, profile_id) SELECT CAST(value AS TEXT), ${profileId} FROM json_each(${sqlText(JSON.stringify(projection.logins))}) WHERE EXISTS (SELECT 1 FROM profiles WHERE ${version});`,
      `DELETE FROM profile_projection_failures WHERE profile_id = ${profileId} AND (source_update_seconds < ${projection.sourceVersion.seconds} OR (source_update_seconds = ${projection.sourceVersion.seconds} AND source_update_nanos <= ${projection.sourceVersion.nanos}));`,
    );
  }
  if (
    statements.some(
      (statement) =>
        Buffer.byteLength(statement, "utf8") > MAX_D1_IMPORT_STATEMENT_BYTES,
    )
  ) {
    throw new Error("profile projection exceeds D1 import statement limit");
  }
  return `${statements.join("\n")}\n`;
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

function wranglerArgs(args: string[]): string[] {
  return [
    "d1",
    "execute",
    DATABASE_NAME,
    "--remote",
    "--config",
    CONFIG_PATH,
    "--env-file",
    RELEASE_ENV_PATH,
    ...args,
  ];
}

function d1Rows(command: string): JsonRecord[] {
  const output = run(resolve("node_modules/.bin/wrangler"), [
    ...wranglerArgs(["--command", command]),
    "--json",
  ]);
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("invalid D1 response");
  }
  const entry = parsed.find(
    (value) => record(value) && Array.isArray(record(value)?.results),
  );
  const results = record(entry)?.results;
  return Array.isArray(results)
    ? results.filter((value): value is JsonRecord => Boolean(record(value)))
    : [];
}

function projectionDigest(projections: ProfileProjection[]): string {
  const hash = createHash("sha256");
  for (const projection of [...projections].sort((left, right) =>
    left.profile.id < right.profile.id
      ? -1
      : left.profile.id > right.profile.id
        ? 1
        : 0,
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
  seconds: number;
};

export function profileSourceVersionDigest(
  versions: ProfileSourceVersion[],
): string {
  const hash = createHash("sha256");
  for (const version of [...versions].sort((left, right) =>
    left.profileId < right.profileId
      ? -1
      : left.profileId > right.profileId
        ? 1
        : 0,
  )) {
    hash.update(
      JSON.stringify([version.profileId, version.seconds, version.nanos]),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function profileLoginMappingDigest(mappings: LoginMapping[]): string {
  const hash = createHash("sha256");
  for (const mapping of [...mappings].sort((left, right) => {
    const profileOrder = left.profileId.localeCompare(right.profileId);
    return profileOrder || left.loginUid.localeCompare(right.loginUid);
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

async function d1Digest(): Promise<{
  digest: string;
  loginDigest: string;
  logins: number;
  profiles: number;
  versionDigest: string;
}> {
  const countRows = d1Rows(
    "SELECT (SELECT COUNT(*) FROM profiles WHERE is_deleted = 0) AS profiles, (SELECT COUNT(*) FROM profile_logins) AS logins, (SELECT COUNT(*) FROM profile_projection_failures) AS failures",
  );
  const profiles = Number(countRows[0]?.profiles);
  const logins = Number(countRows[0]?.logins);
  if (Number(countRows[0]?.failures) !== 0) {
    throw new Error("profile D1 contains invalid projections");
  }
  const mappings: LoginMapping[] = [];
  let offset = 0;
  while (true) {
    const rows = d1Rows(
      `SELECT profile_id, login_uid FROM profile_logins ORDER BY profile_id, login_uid LIMIT 1000 OFFSET ${offset}`,
    );
    for (const row of rows) {
      mappings.push({
        profileId: String(row.profile_id),
        loginUid: String(row.login_uid),
      });
    }
    if (rows.length < 1_000) {
      break;
    }
    offset += rows.length;
  }
  const loginsByProfile = new Map<string, string[]>();
  for (const mapping of mappings) {
    const profileLogins = loginsByProfile.get(mapping.profileId) || [];
    profileLogins.push(mapping.loginUid);
    loginsByProfile.set(mapping.profileId, profileLogins);
  }
  const hash = createHash("sha256");
  const versions: ProfileSourceVersion[] = [];
  offset = 0;
  while (true) {
    const rows = d1Rows(
      `SELECT profile_id, payload_json, merged_into_profile_id, rating_sort, mana_points_sort, dust_sort, slime_sort, gum_sort, metal_sort, ice_sort, source_update_seconds, source_update_nanos, source_digest FROM profiles WHERE is_deleted = 0 ORDER BY profile_id LIMIT ${PROFILE_VERIFY_PAGE_SIZE} OFFSET ${offset}`,
    );
    for (const row of rows) {
      const profileId = String(row.profile_id);
      let profile: unknown;
      try {
        profile = JSON.parse(String(row.payload_json)) as unknown;
      } catch {
        throw new Error("invalid D1 profile projection");
      }
      if (!isPlayerProfile(profile) || profile.id !== profileId) {
        throw new Error("invalid D1 profile projection");
      }
      const seconds = Number(row.source_update_seconds);
      const nanos = Number(row.source_update_nanos);
      if (
        !Number.isSafeInteger(seconds) ||
        !Number.isSafeInteger(nanos) ||
        nanos < 0 ||
        nanos >= 1_000_000_000
      ) {
        throw new Error("invalid D1 profile projection");
      }
      versions.push({ profileId, seconds, nanos });
      const mergedIntoProfileId =
        row.merged_into_profile_id === null ||
        row.merged_into_profile_id === undefined
          ? null
          : String(row.merged_into_profile_id);
      const actualDigest = await profileProjectionDigest({
        profile,
        logins: [...(loginsByProfile.get(profileId) || [])].sort(),
        mergedIntoProfileId,
        sortValues: {
          rating: nullableNumber(row.rating_sort),
          mp: nullableNumber(row.mana_points_sort),
          dust: nullableNumber(row.dust_sort),
          slime: nullableNumber(row.slime_sort),
          gum: nullableNumber(row.gum_sort),
          metal: nullableNumber(row.metal_sort),
          ice: nullableNumber(row.ice_sort),
        },
      });
      if (String(row.source_digest) !== actualDigest) {
        throw new Error("invalid D1 profile projection");
      }
      hash.update(profileId);
      hash.update(":");
      hash.update(actualDigest);
      hash.update("\n");
    }
    if (rows.length < PROFILE_VERIFY_PAGE_SIZE) {
      break;
    }
    offset += rows.length;
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
      buildImportSql(projections, 1);
      const source = sourceSummary(projections);
      console.log(JSON.stringify({ mode: options.mode, ...source }));
      return;
    }
    if (options.mode === "execute") {
      const projections = await readSourceProfiles();
      const directory = mkdtempSync(join(tmpdir(), "mons-link-profiles-"));
      try {
        const projectedAtMs = Date.now();
        for (
          let index = 0;
          index < projections.length;
          index += IMPORT_BATCH_SIZE
        ) {
          const path = join(directory, `profiles-${index}.sql`);
          writeFileSync(
            path,
            buildImportSql(
              projections.slice(index, index + IMPORT_BATCH_SIZE),
              projectedAtMs,
            ),
            { mode: 0o600 },
          );
          run(resolve("node_modules/.bin/wrangler"), [
            ...wranglerArgs(["--file", path]),
            "--yes",
          ]);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    let previous = "";
    let target: Awaited<ReturnType<typeof d1Digest>> | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const source = sourceSummary(await readSourceProfiles());
      const currentTarget = await d1Digest();
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
