import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { AUTH_METHODS, type AuthMethodKey } from "@mons/shared/auth";
import { isSafeFirebaseKey } from "@mons/shared/ids";
import { MATERIAL_KEYS } from "@mons/shared/mining";
import {
  getProfileFallbackEmojiId,
  isPlayerProfile,
} from "@mons/shared/profiles";
import { buildUsernameLookupKey } from "@mons/shared/usernames";
import { MAX_PROFILE_MERGE_TARGET_HOPS } from "../cloud/functions/profileMergeTargets.js";
import {
  createProfileProjection,
  type ProfileProjection,
} from "../cloud/workers/api/src/profileProjectionModel.ts";
import { isCanonicalFirebaseUid } from "../cloud/workers/api/src/firebaseKeys.ts";

type MigrationMode = "dry-run" | "execute" | "verify" | "verify-d1";
type JsonRecord = Record<string, unknown>;
type D1Parameter = null | number | string;

export type D1Statement = {
  params: D1Parameter[];
  sql: string;
};

export type SourceTimestamp = {
  nanoseconds: number;
  seconds: number;
};

export type SourceDocument = {
  fields: JsonRecord;
  id: string;
  updateTime: SourceTimestamp | string;
};

type FirestoreDocument = {
  data(): JsonRecord;
  id: string;
  updateTime: SourceTimestamp;
};

type FirestoreQuerySnapshot = {
  docs: FirestoreDocument[];
  empty: boolean;
  size: number;
};

type FirestoreQuery = {
  get(): Promise<FirestoreQuerySnapshot>;
  limit(value: number): FirestoreQuery;
  orderBy(field: unknown): FirestoreQuery;
  startAfter(value: unknown): FirestoreQuery;
};

type FirestoreDatabase = {
  collection(name: string): FirestoreQuery;
};

type FirestoreFactory = (() => FirestoreDatabase) & {
  FieldPath: { documentId(): unknown };
};

type AdminSupport = {
  addApplicationDefaultCredentialHelp(error: unknown): unknown;
  admin: { firestore: FirestoreFactory };
  cleanupAdmin(): Promise<void>;
  initAdmin(args: string[]): boolean;
};

export type D1Client = {
  query(statements: D1Statement[]): Promise<JsonRecord[][]>;
};

export type MigrationOptions = {
  mode: MigrationMode;
  project: "mons-link";
};

export type MigrationExecutionDependencies = {
  addCredentialHelp?(error: unknown): unknown;
  cleanupFirebase?(): Promise<void>;
  createClient?(): D1Client;
  initializeFirebase?(args: string[]): boolean;
  log?(value: string): void;
  readSource?(): Promise<CanonicalDataset>;
};

export const CANONICAL_TABLES = [
  "profile_records",
  "profile_login_owners",
  "profile_auth_methods",
  "profile_merge_targets",
  "profile_february_opponents",
  "profile_auth_operations",
  "profile_auth_method_revocations",
  "profile_auth_method_cooldowns",
  "profile_auth_recovery_jobs",
  "rating_updates",
  "wager_settlements",
] as const;

export type CanonicalTable = (typeof CANONICAL_TABLES)[number];
export type CanonicalRow = Record<string, D1Parameter>;

export type CanonicalDataset = {
  indexValidation: {
    authMethodStale: number;
    authMethodValid: number;
    usernameStale: number;
    usernameValid: number;
  };
  tables: Record<CanonicalTable, CanonicalRow[]>;
};

export type CanonicalImportPlan = {
  batches: D1Statement[][];
  digest: string;
  statements: D1Statement[];
};

export type SourceCollections = {
  authMethodIndex?: SourceDocument[];
  authMethodRevocations?: SourceDocument[];
  authOps?: SourceDocument[];
  authProfileMethodCooldowns?: SourceDocument[];
  authRecoveryJobs?: SourceDocument[];
  profileMergeTargets?: SourceDocument[];
  ratingUpdates?: SourceDocument[];
  usernameIndex?: SourceDocument[];
  users: SourceDocument[];
  wagerSettlements?: SourceDocument[];
};

type VerificationSnapshot = {
  counts: Record<CanonicalTable, number>;
  fingerprint: string;
};

const requireFromScript = createRequire(import.meta.url);
const adminSupport: AdminSupport = requireFromScript(
  "../cloud/admin/_admin.js",
);
const FIREBASE_PROJECT = "mons-link";
const DATABASE_NAME = "mons-link-profiles";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const FIRESTORE_PAGE_SIZE = 250;
export const MAX_IMPORT_BATCH_STATEMENTS = 50;
export const MAX_IMPORT_BATCH_BYTES = 512 * 1024;
export const MAX_D1_QUERY_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_D1_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_D1_ROW_ESTIMATE_BYTES = 1_900_000;
export const MAX_D1_BOUND_PARAMETERS = 100;
export const MAX_D1_SQL_STATEMENT_BYTES = 100_000;
export const CANONICAL_IMPORT_PLAN_VERSION = 1;
export const TARGET_VERIFY_PAGE_SIZE = 250;
export const MAX_TARGET_VERIFY_PAGES = 10_000;
export const MAX_MIGRATABLE_PROFILE_MERGE_HOPS = MAX_PROFILE_MERGE_TARGET_HOPS;

const SOURCE_COLLECTION_NAMES = [
  "users",
  "usernameIndex",
  "authMethodIndex",
  "profileMergeTargets",
  "authOps",
  "authMethodRevocations",
  "authProfileMethodCooldowns",
  "authRecoveryJobs",
  "ratingUpdates",
  "wagerSettlements",
] as const;

const PROFILE_MODELED_FIELDS = new Set([
  "appleConsentAt",
  "appleConsentSource",
  "appleEmailMasked",
  "appleLinkedAt",
  "appleSub",
  "aura",
  "createdAtMs",
  "custom",
  "emoji",
  "eth",
  "feb2026UniqueOpponents",
  "feb2026UniqueOpponentsCount",
  "logins",
  "mergedAtMs",
  "mergedIntoProfileId",
  "mining",
  "nonce",
  "rating",
  "sol",
  "totalManaPoints",
  "updatedAtMs",
  "username",
  "usernameLookupKey",
  "win",
  "xConsentAt",
  "xConsentSource",
  "xLinkedAt",
  "xUserId",
  "xUsername",
]);

export const PROFILE_ARCHIVED_FIELDS = new Set([
  "address",
  "completedProblems",
  "createdAt",
  "mergedSourceProfileId",
  "profileVersion",
  "tutorialCompleted",
  "updatedAt",
]);

const PROFILE_CUSTOM_FIELDS = new Set([
  "aura",
  "cardBackgroundId",
  "cardStickers",
  "cardSubtitleId",
  "completedProblems",
  "emoji",
  "profileCounter",
  "profileMons",
  "tutorialCompleted",
]);

const TABLE_COLUMNS: Record<CanonicalTable, readonly string[]> = {
  profile_records: [
    "profile_id",
    "state",
    "revision",
    "payload_json",
    "gameplay_emoji_json",
    "username_key",
    "merged_into_profile_id",
    "legacy_fields_json",
    "created_at_ms",
    "updated_at_ms",
    "merged_at_ms",
    "rating_sort",
    "mana_points_sort",
    "nonce_sort",
    "dust_sort",
    "slime_sort",
    "gum_sort",
    "metal_sort",
    "ice_sort",
    "rating_sort_present",
    "mana_points_sort_present",
    "nonce_sort_present",
    "dust_sort_present",
    "slime_sort_present",
    "gum_sort_present",
    "metal_sort_present",
    "ice_sort_present",
    "win_present",
    "emoji_present",
  ],
  profile_login_owners: [
    "login_uid",
    "profile_id",
    "revision",
    "created_at_ms",
    "updated_at_ms",
  ],
  profile_auth_methods: [
    "method",
    "normalized_value",
    "profile_id",
    "raw_value",
    "apple_email_masked",
    "x_username",
    "linked_at_ms",
    "consent_at_ms",
    "consent_source",
    "revision",
    "created_at_ms",
    "updated_at_ms",
  ],
  profile_merge_targets: [
    "source_profile_id",
    "target_profile_id",
    "merged_at_ms",
    "op_id",
    "source_legacy_fields_json",
  ],
  profile_february_opponents: [
    "profile_id",
    "opponent_profile_id",
    "recorded_at_ms",
  ],
  profile_auth_operations: [
    "operation_id",
    "kind",
    "method",
    "login_uid",
    "status",
    "meta_json",
    "result_json",
    "error_code",
    "error_message",
    "started_at_ms",
    "updated_at_ms",
    "revision",
  ],
  profile_auth_method_revocations: [
    "method",
    "normalized_value",
    "profile_id",
    "scope",
    "unlinked_by_uid",
    "cooldown_ms",
    "started_at_ms",
    "retry_at_ms",
    "updated_at_ms",
    "revision",
  ],
  profile_auth_method_cooldowns: [
    "profile_id",
    "method",
    "scope",
    "unlinked_by_uid",
    "cooldown_ms",
    "started_at_ms",
    "retry_at_ms",
    "updated_at_ms",
    "revision",
  ],
  profile_auth_recovery_jobs: [
    "profile_id",
    "login_uids_json",
    "source_profile_ids_json",
    "source_phase",
    "prize_cursor",
    "phase_started_at_ms",
    "last_enqueued_at_ms",
    "created_at_ms",
    "updated_at_ms",
    "revision",
  ],
  rating_updates: [
    "operation_id",
    "payload_json",
    "status",
    "invite_id",
    "match_id",
    "player_id",
    "opponent_id",
    "player_profile_id",
    "opponent_profile_id",
    "owner_uid",
    "owner_token",
    "started_at_ms",
    "updated_at_ms",
    "lease_expires_at_ms",
    "completed_at_ms",
    "telegram_projection_state",
    "telegram_projection_updated_at_ms",
    "telegram_projection_version",
    "profile_game_projection_state",
    "profile_game_projection_updated_at_ms",
    "profile_game_projection_version",
    "event_progress_state",
    "event_progress_updated_at_ms",
    "event_progress_version",
    "revision",
  ],
  wager_settlements: [
    "operation_id",
    "fingerprint",
    "winner_profile_id",
    "loser_profile_id",
    "material",
    "count",
    "applied_at_ms",
    "revision",
  ],
};

const TABLE_KEYS: Record<CanonicalTable, readonly string[]> = {
  profile_records: ["profile_id"],
  profile_login_owners: ["login_uid"],
  profile_auth_methods: ["method", "normalized_value"],
  profile_merge_targets: ["source_profile_id"],
  profile_february_opponents: ["profile_id", "opponent_profile_id"],
  profile_auth_operations: ["operation_id"],
  profile_auth_method_revocations: ["method", "normalized_value"],
  profile_auth_method_cooldowns: ["profile_id", "method"],
  profile_auth_recovery_jobs: ["profile_id"],
  rating_updates: ["operation_id"],
  wager_settlements: ["operation_id"],
};

const TABLE_JSON_COLUMNS: Partial<Record<CanonicalTable, readonly string[]>> = {
  profile_records: [
    "payload_json",
    "gameplay_emoji_json",
    "legacy_fields_json",
  ],
  profile_merge_targets: ["source_legacy_fields_json"],
  profile_auth_operations: ["meta_json", "result_json"],
  profile_auth_recovery_jobs: ["login_uids_json", "source_profile_ids_json"],
  rating_updates: ["payload_json"],
};

const IMMUTABLE_TABLES = new Set<CanonicalTable>([
  "profile_merge_targets",
  "wager_settlements",
]);

export class ProfileCanonicalMigrationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ProfileCanonicalMigrationError";
  }
}

function fail(code: string): never {
  throw new ProfileCanonicalMigrationError(code);
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function exactString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  const normalized = cleanString(value);
  return normalized || null;
}

function hasMergeValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function hasLegacyPresentationValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function optionalRecord(
  parent: JsonRecord,
  key: string,
  code: string,
): JsonRecord {
  if (!Object.hasOwn(parent, key)) {
    return {};
  }
  const candidate = parent[key];
  const value = record(candidate);
  const prototype = value ? Object.getPrototypeOf(candidate) : null;
  if (!value || (prototype !== Object.prototype && prototype !== null)) {
    fail(code);
  }
  return value;
}

function assertNullableType(
  parent: JsonRecord,
  key: string,
  valid: (value: unknown) => boolean,
  code: string,
): void {
  if (!Object.hasOwn(parent, key) || parent[key] === null) {
    return;
  }
  if (!valid(parent[key])) {
    fail(code);
  }
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function nonnegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function profileMergeTargetId(fields: JsonRecord): string | null {
  if (
    !Object.hasOwn(fields, "mergedIntoProfileId") ||
    fields.mergedIntoProfileId === null ||
    fields.mergedIntoProfileId === undefined
  ) {
    return null;
  }
  try {
    return safeDocumentId(fields.mergedIntoProfileId);
  } catch {
    fail("malformed-profile-merge-target");
  }
}

function safeDocumentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !isSafeFirebaseKey(value) ||
    /^__.*__$/.test(value)
  ) {
    fail("malformed-document-id");
  }
  return value;
}

function safeLoginUid(value: unknown): string {
  if (!isCanonicalFirebaseUid(value)) {
    fail("malformed-login-uid");
  }
  return value;
}

function optionalDocumentId(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  try {
    return safeDocumentId(value);
  } catch {
    fail(code);
  }
}

function integer(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value)) {
    fail("malformed-integer-field");
  }
  return Number(value);
}

function nullableNonnegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("malformed-integer-field");
  }
  return Number(value);
}

function nonnegativeInteger(value: unknown, fallback = 0): number {
  const parsed = integer(value, fallback);
  if (parsed < 0) {
    fail("malformed-timestamp-field");
  }
  return parsed;
}

function sourceVersion(document: SourceDocument): SourceTimestamp {
  if (typeof document.updateTime === "string") {
    const match = document.updateTime.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/,
    );
    if (!match) {
      fail("malformed-source-update-time");
    }
    const milliseconds = Date.parse(`${match[1]}Z`);
    if (!Number.isFinite(milliseconds)) {
      fail("malformed-source-update-time");
    }
    return {
      seconds: Math.floor(milliseconds / 1_000),
      nanoseconds: Number((match[2] || "").padEnd(9, "0")),
    };
  }
  const seconds = document.updateTime.seconds;
  const nanoseconds = document.updateTime.nanoseconds;
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds >= 1_000_000_000
  ) {
    fail("malformed-source-update-time");
  }
  return { seconds, nanoseconds };
}

function sourceUpdateTime(document: SourceDocument): string {
  if (typeof document.updateTime === "string") {
    sourceVersion(document);
    return document.updateTime;
  }
  const version = sourceVersion(document);
  const whole = new Date(version.seconds * 1_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "");
  return `${whole}.${String(version.nanoseconds).padStart(9, "0")}Z`;
}

function sourceMillis(document: SourceDocument): number {
  const version = sourceVersion(document);
  const value =
    version.seconds * 1_000 + Math.floor(version.nanoseconds / 1_000_000);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("malformed-source-update-time");
  }
  return value;
}

function normalizeJson(value: unknown, depth = 0): unknown {
  if (depth > 32) {
    fail("json-value-too-deep");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("malformed-json-number");
    }
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry, depth + 1));
  }
  const object = record(value);
  if (!object) {
    fail("malformed-json-value");
  }
  if (typeof object.toMillis === "function") {
    const seconds = object.seconds;
    const nanoseconds = object.nanoseconds;
    if (
      !Number.isSafeInteger(seconds) ||
      !Number.isSafeInteger(nanoseconds) ||
      Number(nanoseconds) < 0 ||
      Number(nanoseconds) >= 1_000_000_000
    ) {
      fail("malformed-json-timestamp");
    }
    return { nanoseconds, seconds };
  }
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => [key, normalizeJson(object[key], depth + 1)]),
  );
}

function jsonText(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function nullableObjectJson(value: unknown, code: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const object = record(value);
  const prototype = object ? Object.getPrototypeOf(value) : null;
  if (!object || (prototype !== Object.prototype && prototype !== null)) {
    fail(code);
  }
  return jsonText(object);
}

function stringArray(value: unknown, code: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    fail(code);
  }
  return Array.from(new Set(value));
}

function uniqueStringArray(value: unknown, code: string): string[] {
  const values = stringArray(value, code);
  if (!Array.isArray(value) || values.length !== value.length) {
    fail(code);
  }
  return values;
}

function normalizeMethodValue(method: AuthMethodKey, value: unknown): string {
  const input = cleanString(value);
  if (!input) {
    return "";
  }
  if (method === "eth") {
    const normalized = input.toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : "";
  }
  if (method === "sol") {
    return input.length >= 20 && input.length <= 64 ? input : "";
  }
  if (method === "apple") {
    return input.length >= 6 ? input : "";
  }
  return /^\d+$/.test(input) ? input : "";
}

function methodField(method: AuthMethodKey): string {
  if (method === "apple") return "appleSub";
  if (method === "x") return "xUserId";
  return method;
}

function methodIndexId(method: AuthMethodKey, normalizedValue: string): string {
  return `${method}:${Buffer.from(normalizedValue).toString("base64url")}`;
}

function validateActiveProfileScalars(
  fields: JsonRecord,
  custom: JsonRecord,
  mining: JsonRecord,
  materials: JsonRecord,
): void {
  for (const key of [
    "username",
    "usernameLookupKey",
    "eth",
    "sol",
    "appleSub",
    "appleEmailMasked",
    "appleConsentSource",
    "xUserId",
    "xUsername",
    "xConsentSource",
    "aura",
  ]) {
    assertNullableType(
      fields,
      key,
      (value) => typeof value === "string",
      "malformed-active-profile-scalar",
    );
  }
  for (const key of [
    "nonce",
    "rating",
    "totalManaPoints",
    "feb2026UniqueOpponentsCount",
  ]) {
    assertNullableType(
      fields,
      key,
      finiteNumber,
      "malformed-active-profile-scalar",
    );
  }
  for (const key of [
    "createdAtMs",
    "updatedAtMs",
    "appleLinkedAt",
    "appleConsentAt",
    "xLinkedAt",
    "xConsentAt",
  ]) {
    assertNullableType(
      fields,
      key,
      nonnegativeSafeInteger,
      "malformed-active-profile-scalar",
    );
  }
  assertNullableType(
    fields,
    "win",
    (value) => typeof value === "boolean",
    "malformed-active-profile-scalar",
  );
  assertNullableType(
    fields,
    "emoji",
    (value) => typeof value === "string" || finiteNumber(value),
    "malformed-active-profile-scalar",
  );
  for (const key of ["aura", "cardStickers", "profileCounter", "profileMons"]) {
    assertNullableType(
      custom,
      key,
      (value) => typeof value === "string",
      "malformed-active-profile-custom-scalar",
    );
  }
  for (const key of ["cardBackgroundId", "cardSubtitleId"]) {
    assertNullableType(
      custom,
      key,
      finiteNumber,
      "malformed-active-profile-custom-scalar",
    );
  }
  assertNullableType(
    custom,
    "emoji",
    (value) => typeof value === "string" || finiteNumber(value),
    "malformed-active-profile-custom-scalar",
  );
  assertNullableType(
    custom,
    "tutorialCompleted",
    (value) => typeof value === "boolean",
    "malformed-active-profile-custom-scalar",
  );
  assertNullableType(
    custom,
    "completedProblems",
    (value) =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string"),
    "malformed-active-profile-custom-scalar",
  );
  assertNullableType(
    mining,
    "lastRockDate",
    (value) => typeof value === "string",
    "malformed-active-profile-mining-scalar",
  );
  for (const material of MATERIAL_KEYS) {
    assertNullableType(
      materials,
      material,
      finiteNumber,
      "malformed-active-profile-material-scalar",
    );
  }
  for (const key of ["appleConsentSource", "xConsentSource"]) {
    const source = nullableString(fields[key]);
    if (source && source !== "signin" && source !== "settings") {
      fail("malformed-active-profile-consent-source");
    }
  }
}

function validateProfileFieldShape(fields: JsonRecord): JsonRecord {
  const custom = optionalRecord(fields, "custom", "malformed-profile-custom");
  const mining = optionalRecord(fields, "mining", "malformed-profile-mining");
  if (
    Object.keys(mining).some(
      (key) => key !== "lastRockDate" && key !== "materials",
    )
  ) {
    fail("unknown-profile-mining-field");
  }
  const materials = optionalRecord(
    mining,
    "materials",
    "malformed-profile-materials",
  );
  if (
    Object.keys(materials).some((key) => !MATERIAL_KEYS.includes(key as never))
  ) {
    fail("unknown-profile-material-field");
  }
  stringArray(fields.logins, "malformed-profile-logins");
  stringArray(fields.feb2026UniqueOpponents, "malformed-february-opponents");
  assertNullableType(
    fields,
    "mergedAtMs",
    nonnegativeSafeInteger,
    "malformed-profile-merged-at",
  );
  const active = profileMergeTargetId(fields) === null;
  if (active) {
    if (
      hasLegacyPresentationValue(fields.aura) ||
      hasLegacyPresentationValue(fields.emoji) ||
      custom.emoji === ""
    ) {
      fail("ambiguous-active-profile-presentation");
    }
    validateActiveProfileScalars(fields, custom, mining, materials);
  }
  const archived = Object.fromEntries(
    Object.keys(fields)
      .filter(
        (key) =>
          PROFILE_ARCHIVED_FIELDS.has(key) || !PROFILE_MODELED_FIELDS.has(key),
      )
      .sort()
      .map((key) => [key, fields[key]]),
  );
  for (const key of ["aura", "emoji"] as const) {
    if (Object.hasOwn(fields, key)) {
      archived[key] = fields[key];
    }
  }
  const archivedCustom = Object.fromEntries(
    Object.keys(custom)
      .filter((key) => !PROFILE_CUSTOM_FIELDS.has(key))
      .sort()
      .map((key) => [key, custom[key]]),
  );
  if (Object.keys(archivedCustom).length > 0) {
    archived.custom = archivedCustom;
  }
  return archived;
}

function gameplayEmojiJson(fields: JsonRecord): string {
  const custom = optionalRecord(fields, "custom", "malformed-profile-custom");
  const value = Object.hasOwn(custom, "emoji") ? custom.emoji : fields.emoji;
  return jsonText(
    typeof value === "string" || finiteNumber(value) ? value : "",
  );
}

function emptyTables(): Record<CanonicalTable, CanonicalRow[]> {
  const tables = {} as Record<CanonicalTable, CanonicalRow[]>;
  for (const table of CANONICAL_TABLES) {
    tables[table] = [];
  }
  return tables;
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function primaryKey(table: CanonicalTable, row: CanonicalRow): string {
  return TABLE_KEYS[table]
    .map((column) => {
      const value = row[column];
      if (typeof value !== "string") {
        fail("malformed-canonical-primary-key");
      }
      return value;
    })
    .join("\u0000");
}

function sortDataset(dataset: CanonicalDataset): CanonicalDataset {
  for (const table of CANONICAL_TABLES) {
    dataset.tables[table].sort((left, right) =>
      compareText(primaryKey(table, left), primaryKey(table, right)),
    );
  }
  return dataset;
}

function rawNumericSort(
  fields: JsonRecord,
  key: string,
): { present: boolean; value: number | null } {
  if (!Object.hasOwn(fields, key)) {
    return { present: false, value: null };
  }
  if (fields[key] === null) {
    return { present: true, value: null };
  }
  if (!finiteNumber(fields[key])) {
    fail("malformed-profile-sort-field");
  }
  return { present: true, value: fields[key] as number };
}

function publicProfileRow(
  document: SourceDocument,
  projection: ProfileProjection,
  legacyFields: JsonRecord,
): CanonicalRow {
  const fields = document.fields;
  const mergedIntoProfileId = profileMergeTargetId(fields);
  const sourceTimeMs = sourceMillis(document);
  const createdAtMs =
    fields.createdAtMs === null || fields.createdAtMs === undefined
      ? sourceTimeMs
      : nonnegativeInteger(fields.createdAtMs);
  if (createdAtMs > sourceTimeMs) {
    fail("profile-created-after-source-update");
  }
  const mergedAtMs = mergedIntoProfileId
    ? nonnegativeInteger(fields.mergedAtMs, sourceTimeMs)
    : Object.hasOwn(fields, "mergedAtMs") && fields.mergedAtMs !== null
      ? nonnegativeInteger(fields.mergedAtMs)
      : null;
  const username = cleanString(fields.username);
  const computedUsernameKey = username ? buildUsernameLookupKey(username) : "";
  const storedUsernameKey = cleanString(fields.usernameLookupKey);
  if (storedUsernameKey && storedUsernameKey !== computedUsernameKey) {
    fail("username-key-mismatch");
  }
  const nonceSort = rawNumericSort(fields, "nonce");
  const custom = optionalRecord(fields, "custom", "malformed-profile-custom");
  const active = mergedIntoProfileId === null;
  return {
    profile_id: projection.profile.id,
    state: active ? "active" : "retiring",
    revision: 1,
    payload_json: jsonText(projection.profile),
    gameplay_emoji_json: gameplayEmojiJson(fields),
    username_key: active && computedUsernameKey ? computedUsernameKey : null,
    merged_into_profile_id: mergedIntoProfileId,
    legacy_fields_json: jsonText(legacyFields),
    created_at_ms: createdAtMs,
    updated_at_ms: sourceTimeMs,
    merged_at_ms: mergedAtMs,
    rating_sort: projection.sortValues.rating,
    mana_points_sort: projection.sortValues.mp,
    nonce_sort: nonceSort.value,
    dust_sort: projection.sortValues.dust,
    slime_sort: projection.sortValues.slime,
    gum_sort: projection.sortValues.gum,
    metal_sort: projection.sortValues.metal,
    ice_sort: projection.sortValues.ice,
    rating_sort_present: Number(projection.sortPresence.rating),
    mana_points_sort_present: Number(projection.sortPresence.mp),
    nonce_sort_present: Number(nonceSort.present),
    dust_sort_present: Number(projection.sortPresence.dust),
    slime_sort_present: Number(projection.sortPresence.slime),
    gum_sort_present: Number(projection.sortPresence.gum),
    metal_sort_present: Number(projection.sortPresence.metal),
    ice_sort_present: Number(projection.sortPresence.ice),
    win_present: Number(hasMergeValue(fields.win)),
    emoji_present: Number(hasMergeValue(custom.emoji)),
  };
}

function addProfileOwners(
  document: SourceDocument,
  profileRow: CanonicalRow,
  tables: CanonicalDataset["tables"],
  loginOwners: Map<string, string>,
  methodOwners: Map<string, string>,
  usernameOwners: Map<string, string>,
): void {
  const profileId = String(profileRow.profile_id);
  const active = profileRow.state === "active";
  const fields = document.fields;
  const logins = stringArray(fields.logins, "malformed-profile-logins");
  const sourceTimeMs = sourceMillis(document);
  const createdAtMs = Number(profileRow.created_at_ms);
  if (!active && logins.length > 0) {
    fail("retiring-profile-owns-login");
  }
  if (!active && cleanString(fields.username)) {
    fail("retiring-profile-owns-username");
  }
  for (const loginUid of active ? logins : []) {
    safeLoginUid(loginUid);
    if (loginOwners.has(loginUid)) {
      fail("duplicate-login-owner");
    }
    loginOwners.set(loginUid, profileId);
    tables.profile_login_owners.push({
      login_uid: loginUid,
      profile_id: profileId,
      revision: 1,
      created_at_ms: createdAtMs,
      updated_at_ms: sourceTimeMs,
    });
  }
  const usernameKey = profileRow.username_key;
  if (typeof usernameKey === "string") {
    if (usernameOwners.has(usernameKey)) {
      fail("duplicate-username-owner");
    }
    usernameOwners.set(usernameKey, profileId);
  }
  for (const method of AUTH_METHODS) {
    const field = methodField(method);
    const rawValue = cleanString(fields[field]);
    const normalizedValue = normalizeMethodValue(method, rawValue);
    if (
      active &&
      Object.hasOwn(fields, field) &&
      fields[field] !== null &&
      fields[field] !== undefined &&
      !rawValue
    ) {
      fail("malformed-profile-auth-method");
    }
    if (rawValue && !normalizedValue) {
      fail("malformed-profile-auth-method");
    }
    if (!active && normalizedValue) {
      fail("retiring-profile-owns-auth-method");
    }
    if (!active || !normalizedValue) {
      continue;
    }
    const key = `${method}\u0000${normalizedValue}`;
    if (methodOwners.has(key)) {
      fail("duplicate-auth-method-owner");
    }
    methodOwners.set(key, profileId);
    const providerPrefix =
      method === "apple" ? "apple" : method === "x" ? "x" : "";
    tables.profile_auth_methods.push({
      method,
      normalized_value: normalizedValue,
      profile_id: profileId,
      raw_value: rawValue,
      apple_email_masked:
        method === "apple" ? nullableString(fields.appleEmailMasked) : null,
      x_username: method === "x" ? nullableString(fields.xUsername) : null,
      linked_at_ms: providerPrefix
        ? nullableNonnegativeInteger(fields[`${providerPrefix}LinkedAt`])
        : createdAtMs,
      consent_at_ms: providerPrefix
        ? nullableNonnegativeInteger(fields[`${providerPrefix}ConsentAt`])
        : null,
      consent_source: providerPrefix
        ? nullableString(fields[`${providerPrefix}ConsentSource`])
        : null,
      revision: 1,
      created_at_ms: createdAtMs,
      updated_at_ms: sourceTimeMs,
    });
  }
  const opponents = stringArray(
    fields.feb2026UniqueOpponents,
    "malformed-february-opponents",
  );
  for (const opponentProfileId of opponents) {
    safeDocumentId(opponentProfileId);
    if (opponentProfileId === profileId) {
      fail("malformed-february-opponents");
    }
    tables.profile_february_opponents.push({
      profile_id: profileId,
      opponent_profile_id: opponentProfileId,
      recorded_at_ms: sourceTimeMs,
    });
  }
}

export function assertNoMergeCycles(targets: Map<string, string>): void {
  for (const source of targets.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = source;
    let followedTargets = 0;
    while (current) {
      if (seen.has(current)) {
        fail("profile-merge-cycle");
      }
      seen.add(current);
      const next = targets.get(current);
      if (!next) {
        break;
      }
      followedTargets += 1;
      if (followedTargets > MAX_MIGRATABLE_PROFILE_MERGE_HOPS) {
        fail("profile-merge-depth-exceeded");
      }
      current = next;
    }
  }
}

type MergeProfileState = {
  mergedIntoProfileId: string | null;
  state: "active" | "retiring";
};

function validateMergeTopology(
  profiles: Map<string, MergeProfileState>,
  targets: Map<string, string>,
): void {
  assertNoMergeCycles(targets);
  for (const [profileId, profile] of profiles) {
    const mappedTarget = targets.get(profileId) || null;
    if (profile.state === "active" && mappedTarget) {
      fail("active-profile-has-merge-target");
    }
    if (profile.state === "retiring" && !mappedTarget) {
      fail("retiring-profile-merge-target-missing");
    }
    if (
      profile.state === "retiring" &&
      mappedTarget !== profile.mergedIntoProfileId
    ) {
      fail("retiring-profile-merge-target-mismatch");
    }
  }
  for (const sourceProfileId of targets.keys()) {
    let terminalProfileId = sourceProfileId;
    while (targets.has(terminalProfileId)) {
      terminalProfileId = targets.get(terminalProfileId) || "";
    }
    const terminal = profiles.get(terminalProfileId);
    if (!terminal || terminal.state !== "active") {
      fail("profile-merge-terminal-missing");
    }
  }
}

function addMergeTargets(
  collections: SourceCollections,
  users: Map<string, SourceDocument>,
  tables: CanonicalDataset["tables"],
): void {
  const rows = new Map<string, CanonicalRow>();
  const profileLegacyFields = new Map(
    tables.profile_records.map((row) => [
      String(row.profile_id),
      String(row.legacy_fields_json),
    ]),
  );
  for (const document of collections.profileMergeTargets || []) {
    const sourceProfileId = safeDocumentId(document.id);
    if (
      document.fields.sourceProfileId !== undefined &&
      document.fields.sourceProfileId !== sourceProfileId
    ) {
      fail("profile-merge-source-mismatch");
    }
    if (rows.has(sourceProfileId)) {
      fail("duplicate-profile-merge-target");
    }
    const targetProfileId = safeDocumentId(document.fields.targetProfileId);
    rows.set(sourceProfileId, {
      source_profile_id: sourceProfileId,
      target_profile_id: targetProfileId,
      merged_at_ms: nonnegativeInteger(
        document.fields.mergedAtMs,
        sourceMillis(document),
      ),
      op_id: nullableString(document.fields.opId),
      source_legacy_fields_json:
        profileLegacyFields.get(sourceProfileId) || jsonText({}),
    });
  }
  const targets = new Map<string, string>();
  for (const [source, row] of rows) {
    targets.set(source, String(row.target_profile_id));
  }
  const profiles = new Map<string, MergeProfileState>();
  for (const [profileId, document] of users) {
    const mergedIntoProfileId = profileMergeTargetId(document.fields);
    profiles.set(profileId, {
      mergedIntoProfileId,
      state: mergedIntoProfileId ? "retiring" : "active",
    });
  }
  validateMergeTopology(profiles, targets);
  tables.profile_merge_targets.push(...rows.values());
}

function addAuthOperations(
  documents: SourceDocument[],
  tables: CanonicalDataset["tables"],
): void {
  for (const document of documents) {
    const fields = document.fields;
    const operationId = safeDocumentId(document.id);
    if (fields.opId !== undefined && fields.opId !== operationId) {
      fail("malformed-auth-operation");
    }
    const kind = cleanString(fields.kind);
    const method = cleanString(fields.method) as AuthMethodKey;
    const status = cleanString(fields.status);
    const loginUid = exactString(fields.uid);
    if (
      !["unlink", "verify"].includes(kind) ||
      !AUTH_METHODS.includes(method) ||
      !loginUid ||
      !["started", "success", "failed"].includes(status)
    ) {
      fail("malformed-auth-operation");
    }
    safeLoginUid(loginUid);
    const startedAtMs = nonnegativeInteger(fields.startedAtMs);
    const updatedAtMs = nonnegativeInteger(
      fields.updatedAtMs,
      sourceMillis(document),
    );
    if (updatedAtMs < startedAtMs) {
      fail("malformed-auth-operation");
    }
    tables.profile_auth_operations.push({
      operation_id: operationId,
      kind,
      method,
      login_uid: loginUid,
      status,
      meta_json: nullableObjectJson(fields.meta, "malformed-auth-operation"),
      result_json: nullableObjectJson(
        fields.result,
        "malformed-auth-operation",
      ),
      error_code: nullableString(fields.errorCode),
      error_message: nullableString(fields.errorMessage),
      started_at_ms: startedAtMs,
      updated_at_ms: updatedAtMs,
      revision: 1,
    });
  }
}

function parseAuthMethod(value: unknown): AuthMethodKey {
  const method = cleanString(value) as AuthMethodKey;
  if (!AUTH_METHODS.includes(method)) {
    fail("malformed-auth-method-record");
  }
  return method;
}

function addAuthMethodRevocations(
  documents: SourceDocument[],
  tables: CanonicalDataset["tables"],
): void {
  const keys = new Set<string>();
  for (const document of documents) {
    const fields = document.fields;
    const method = parseAuthMethod(fields.method);
    const normalizedValue = normalizeMethodValue(
      method,
      fields.normalizedValue,
    );
    const profileId = safeDocumentId(fields.profileId);
    const documentId = safeDocumentId(document.id);
    const expectedDocumentId = methodIndexId(method, normalizedValue);
    if (
      !normalizedValue ||
      documentId !== expectedDocumentId ||
      !["method", "profile-method"].includes(cleanString(fields.scope)) ||
      !exactString(fields.unlinkedByUid)
    ) {
      fail("malformed-auth-method-revocation");
    }
    safeLoginUid(fields.unlinkedByUid);
    const key = `${method}\u0000${normalizedValue}`;
    if (keys.has(key)) {
      fail("duplicate-auth-method-revocation");
    }
    keys.add(key);
    const cooldownMs = integer(fields.cooldownMs, -1);
    const startedAtMs = nonnegativeInteger(fields.startedAtMs);
    const retryAtMs = nonnegativeInteger(fields.retryAtMs);
    const updatedAtMs = nonnegativeInteger(
      fields.updatedAtMs,
      sourceMillis(document),
    );
    if (
      cooldownMs <= 0 ||
      retryAtMs < startedAtMs ||
      updatedAtMs < startedAtMs
    ) {
      fail("malformed-auth-method-revocation");
    }
    tables.profile_auth_method_revocations.push({
      method,
      normalized_value: normalizedValue,
      profile_id: profileId,
      scope: cleanString(fields.scope),
      unlinked_by_uid: exactString(fields.unlinkedByUid),
      cooldown_ms: cooldownMs,
      started_at_ms: startedAtMs,
      retry_at_ms: retryAtMs,
      updated_at_ms: updatedAtMs,
      revision: 1,
    });
  }
}

function addAuthMethodCooldowns(
  documents: SourceDocument[],
  tables: CanonicalDataset["tables"],
): void {
  const keys = new Set<string>();
  for (const document of documents) {
    const fields = document.fields;
    const method = parseAuthMethod(fields.method);
    const profileId = safeDocumentId(fields.profileId);
    const documentId = safeDocumentId(document.id);
    if (
      documentId !== `${profileId}:${method}` ||
      cleanString(fields.scope) !== "profile-method" ||
      !exactString(fields.unlinkedByUid)
    ) {
      fail("malformed-auth-method-cooldown");
    }
    safeLoginUid(fields.unlinkedByUid);
    const key = `${profileId}\u0000${method}`;
    if (keys.has(key)) {
      fail("duplicate-auth-method-cooldown");
    }
    keys.add(key);
    const cooldownMs = integer(fields.cooldownMs, -1);
    const startedAtMs = nonnegativeInteger(fields.startedAtMs);
    const retryAtMs = nonnegativeInteger(fields.retryAtMs);
    const updatedAtMs = nonnegativeInteger(
      fields.updatedAtMs,
      sourceMillis(document),
    );
    if (
      cooldownMs <= 0 ||
      retryAtMs < startedAtMs ||
      updatedAtMs < startedAtMs
    ) {
      fail("malformed-auth-method-cooldown");
    }
    tables.profile_auth_method_cooldowns.push({
      profile_id: profileId,
      method,
      scope: "profile-method",
      unlinked_by_uid: exactString(fields.unlinkedByUid),
      cooldown_ms: cooldownMs,
      started_at_ms: startedAtMs,
      retry_at_ms: retryAtMs,
      updated_at_ms: updatedAtMs,
      revision: 1,
    });
  }
}

function addAuthRecoveryJobs(
  documents: SourceDocument[],
  tables: CanonicalDataset["tables"],
): void {
  for (const document of documents) {
    const fields = document.fields;
    const profileId = safeDocumentId(document.id);
    const loginUids = uniqueStringArray(
      fields.loginUids,
      "malformed-auth-recovery-job",
    );
    const sourceProfileIds = uniqueStringArray(
      fields.sourceProfileIds,
      "malformed-auth-recovery-job",
    );
    const sourcePhase = cleanString(fields.sourcePhase);
    if (
      fields.profileId !== profileId ||
      !["prizes", "games", "finalize"].includes(sourcePhase) ||
      (fields.prizeCursor !== null && typeof fields.prizeCursor !== "string")
    ) {
      fail("malformed-auth-recovery-job");
    }
    loginUids.forEach(safeLoginUid);
    sourceProfileIds.forEach(safeDocumentId);
    const createdAtMs = nonnegativeInteger(fields.createdAtMs);
    const updatedAtMs = nonnegativeInteger(
      fields.updatedAtMs,
      sourceMillis(document),
    );
    if (updatedAtMs < createdAtMs) {
      fail("malformed-auth-recovery-job");
    }
    tables.profile_auth_recovery_jobs.push({
      profile_id: profileId,
      login_uids_json: jsonText(loginUids),
      source_profile_ids_json: jsonText(sourceProfileIds),
      source_phase: sourcePhase,
      prize_cursor:
        fields.prizeCursor === null ? null : cleanString(fields.prizeCursor),
      phase_started_at_ms: nonnegativeInteger(fields.phaseStartedAtMs, 0),
      last_enqueued_at_ms: nonnegativeInteger(fields.lastEnqueuedAtMs, 0),
      created_at_ms: createdAtMs,
      updated_at_ms: updatedAtMs,
      revision: 1,
    });
  }
}

function projectionState(value: unknown): string | null {
  const state = cleanString(value);
  if (!state) return null;
  if (!["pending", "done", "dead"].includes(state)) {
    fail("malformed-rating-projection-state");
  }
  return state;
}

function addRatingUpdates(
  documents: SourceDocument[],
  tables: CanonicalDataset["tables"],
): void {
  for (const document of documents) {
    const fields = document.fields;
    const operationId = safeDocumentId(document.id);
    const status = cleanString(fields.status);
    const inviteId = cleanString(fields.inviteId);
    const matchId = cleanString(fields.matchId);
    const playerId = exactString(fields.playerId);
    const opponentId = exactString(fields.opponentId);
    if (
      !["processing", "done"].includes(status) ||
      !inviteId ||
      !matchId ||
      !playerId ||
      !opponentId ||
      operationId !== `${inviteId}__${matchId}`
    ) {
      fail("malformed-rating-update");
    }
    const ownerUid = exactString(fields.ownerUid);
    const ownerToken = cleanString(fields.ownerToken);
    const startedAtMs = nonnegativeInteger(fields.startedAtMs);
    const updatedAtMs = nonnegativeInteger(
      fields.updatedAtMs,
      sourceMillis(document),
    );
    const leaseExpiresAtMs = nonnegativeInteger(fields.leaseExpiresAtMs);
    const completedAtMs = nullableNonnegativeInteger(fields.completedAtMs);
    const playerProfileId = optionalDocumentId(
      fields.playerProfileId,
      "malformed-rating-update",
    );
    const opponentProfileId = optionalDocumentId(
      fields.opponentProfileId,
      "malformed-rating-update",
    );
    if (
      !ownerUid ||
      !ownerToken ||
      updatedAtMs < startedAtMs ||
      leaseExpiresAtMs < startedAtMs ||
      (status === "processing" && completedAtMs !== null) ||
      (status === "done" &&
        (completedAtMs === null || completedAtMs < startedAtMs))
    ) {
      fail("malformed-rating-update");
    }
    tables.rating_updates.push({
      operation_id: operationId,
      payload_json: jsonText({
        ...fields,
        status,
        inviteId,
        matchId,
        playerId,
        opponentId,
        playerProfileId,
        opponentProfileId,
        ownerUid,
        ownerToken,
        startedAtMs,
        updatedAtMs,
        leaseExpiresAtMs,
        completedAtMs,
        telegramProjectionState: projectionState(
          fields.telegramProjectionState,
        ),
        telegramProjectionUpdatedAtMs: nullableNonnegativeInteger(
          fields.telegramProjectionUpdatedAtMs,
        ),
        telegramProjectionVersion: nullableNonnegativeInteger(
          fields.telegramProjectionVersion,
        ),
        profileGameProjectionState: projectionState(
          fields.profileGameProjectionState,
        ),
        profileGameProjectionUpdatedAtMs: nullableNonnegativeInteger(
          fields.profileGameProjectionUpdatedAtMs,
        ),
        profileGameProjectionVersion: nullableNonnegativeInteger(
          fields.profileGameProjectionVersion,
        ),
        eventProgressState: projectionState(fields.eventProgressState),
        eventProgressUpdatedAtMs: nullableNonnegativeInteger(
          fields.eventProgressUpdatedAtMs,
        ),
        eventProgressVersion: nullableNonnegativeInteger(
          fields.eventProgressVersion,
        ),
      }),
      status,
      invite_id: inviteId,
      match_id: matchId,
      player_id: playerId,
      opponent_id: opponentId,
      player_profile_id: playerProfileId,
      opponent_profile_id: opponentProfileId,
      owner_uid: ownerUid,
      owner_token: ownerToken,
      started_at_ms: startedAtMs,
      updated_at_ms: updatedAtMs,
      lease_expires_at_ms: leaseExpiresAtMs,
      completed_at_ms: completedAtMs,
      telegram_projection_state: projectionState(
        fields.telegramProjectionState,
      ),
      telegram_projection_updated_at_ms: nullableNonnegativeInteger(
        fields.telegramProjectionUpdatedAtMs,
      ),
      telegram_projection_version: nullableNonnegativeInteger(
        fields.telegramProjectionVersion,
      ),
      profile_game_projection_state: projectionState(
        fields.profileGameProjectionState,
      ),
      profile_game_projection_updated_at_ms: nullableNonnegativeInteger(
        fields.profileGameProjectionUpdatedAtMs,
      ),
      profile_game_projection_version: nullableNonnegativeInteger(
        fields.profileGameProjectionVersion,
      ),
      event_progress_state: projectionState(fields.eventProgressState),
      event_progress_updated_at_ms: nullableNonnegativeInteger(
        fields.eventProgressUpdatedAtMs,
      ),
      event_progress_version: nullableNonnegativeInteger(
        fields.eventProgressVersion,
      ),
      revision: 1,
    });
  }
}

function addWagerSettlements(
  documents: SourceDocument[],
  tables: CanonicalDataset["tables"],
): void {
  for (const document of documents) {
    const fields = document.fields;
    const operationId = safeDocumentId(document.id);
    const fingerprint = exactString(fields.fingerprint);
    const winnerProfileId = safeDocumentId(fields.winnerProfileId);
    const loserProfileId = safeDocumentId(fields.loserProfileId);
    const material = cleanString(fields.material);
    const count = integer(fields.count, -1);
    if (
      !fingerprint ||
      !MATERIAL_KEYS.includes(material as never) ||
      count <= 0
    ) {
      fail("malformed-wager-settlement");
    }
    tables.wager_settlements.push({
      operation_id: operationId,
      fingerprint,
      winner_profile_id: winnerProfileId,
      loser_profile_id: loserProfileId,
      material,
      count,
      applied_at_ms: nonnegativeInteger(fields.appliedAtMs),
      revision: 1,
    });
  }
}

export function validateLegacyIndexes(
  usernameIndexes: SourceDocument[],
  authMethodIndexes: SourceDocument[],
  usernameOwners: Map<string, string>,
  methodOwners: Map<string, string>,
): CanonicalDataset["indexValidation"] {
  const result = {
    authMethodStale: 0,
    authMethodValid: 0,
    usernameStale: 0,
    usernameValid: 0,
  };
  for (const document of usernameIndexes) {
    const key = cleanString(document.id);
    const profileId = cleanString(document.fields.profileId);
    const username = cleanString(document.fields.username);
    const normalized = username ? buildUsernameLookupKey(username) : key;
    if (key === normalized && usernameOwners.get(normalized) === profileId) {
      result.usernameValid += 1;
    } else {
      result.usernameStale += 1;
    }
  }
  for (const document of authMethodIndexes) {
    const method = cleanString(document.fields.method) as AuthMethodKey;
    const normalizedValue = AUTH_METHODS.includes(method)
      ? normalizeMethodValue(method, document.fields.normalizedValue)
      : "";
    const profileId = cleanString(document.fields.profileId);
    const key = normalizedValue ? `${method}\u0000${normalizedValue}` : "";
    if (
      key &&
      document.id === methodIndexId(method, normalizedValue) &&
      methodOwners.get(key) === profileId
    ) {
      result.authMethodValid += 1;
    } else {
      result.authMethodStale += 1;
    }
  }
  return result;
}

export async function buildCanonicalDataset(
  collections: SourceCollections,
): Promise<CanonicalDataset> {
  const tables = emptyTables();
  const users = new Map<string, SourceDocument>();
  const loginOwners = new Map<string, string>();
  const methodOwners = new Map<string, string>();
  const usernameOwners = new Map<string, string>();
  for (const document of collections.users) {
    const profileId = safeDocumentId(document.id);
    if (users.has(profileId)) {
      fail("duplicate-profile-record");
    }
    users.set(profileId, document);
    const legacyFields = validateProfileFieldShape(document.fields);
    const projection = await createProfileProjection({
      profileId,
      fields: document.fields,
      updateTime: sourceUpdateTime(document),
    }).catch(() => fail("malformed-profile-record"));
    const row = publicProfileRow(document, projection, legacyFields);
    tables.profile_records.push(row);
    addProfileOwners(
      document,
      row,
      tables,
      loginOwners,
      methodOwners,
      usernameOwners,
    );
  }
  addMergeTargets(collections, users, tables);
  addAuthOperations(collections.authOps || [], tables);
  addAuthMethodRevocations(collections.authMethodRevocations || [], tables);
  addAuthMethodCooldowns(collections.authProfileMethodCooldowns || [], tables);
  addAuthRecoveryJobs(collections.authRecoveryJobs || [], tables);
  addRatingUpdates(collections.ratingUpdates || [], tables);
  addWagerSettlements(collections.wagerSettlements || [], tables);
  const indexValidation = validateLegacyIndexes(
    collections.usernameIndex || [],
    collections.authMethodIndex || [],
    usernameOwners,
    methodOwners,
  );
  const dataset = sortDataset({ indexValidation, tables });
  validateCanonicalTarget(dataset);
  return dataset;
}

export function parseArgs(argv: string[]): MigrationOptions {
  let mode: MigrationMode = "dry-run";
  let modeSeen = false;
  let projectSeen = false;
  let project = FIREBASE_PROJECT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === "--dry-run" ||
      argument === "--execute" ||
      argument === "--verify" ||
      argument === "--verify-d1"
    ) {
      if (modeSeen) {
        fail("choose-one-migration-mode");
      }
      modeSeen = true;
      mode = argument.slice(2) as MigrationMode;
      continue;
    }
    if (argument === "--project") {
      const value = argv[++index];
      if (projectSeen || !value || value.startsWith("--")) {
        fail("invalid-project-option");
      }
      projectSeen = true;
      project = value;
      continue;
    }
    fail("unknown-migration-option");
  }
  if (project !== FIREBASE_PROJECT) {
    fail("unsupported-firebase-project");
  }
  return { mode, project: FIREBASE_PROJECT };
}

export function assertProductionFirestoreEnvironment(
  environment: { FIRESTORE_EMULATOR_HOST?: string } = process.env,
): void {
  if ((environment.FIRESTORE_EMULATOR_HOST || "").trim()) {
    fail("firestore-emulator-not-supported");
  }
}

export async function readKeysetCollection(
  firestore: FirestoreDatabase,
  fieldPath: unknown,
  collectionName: string,
  options: { pageSize?: number; startAfterId?: string } = {},
): Promise<{ documents: SourceDocument[]; lastDocumentId: string | null }> {
  const pageSize = options.pageSize || FIRESTORE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    fail("invalid-firestore-page-size");
  }
  let cursor = options.startAfterId || "";
  const documents: SourceDocument[] = [];
  while (true) {
    let query = firestore
      .collection(collectionName)
      .orderBy(fieldPath)
      .limit(pageSize);
    if (cursor) {
      query = query.startAfter(cursor);
    }
    const page = await query.get();
    if (page.empty) {
      break;
    }
    for (const document of page.docs) {
      documents.push({
        id: document.id,
        fields: document.data(),
        updateTime: document.updateTime,
      });
    }
    const last = page.docs.at(-1);
    if (!last) {
      fail("malformed-firestore-page");
    }
    cursor = last.id;
    if (page.size < pageSize) {
      break;
    }
  }
  return { documents, lastDocumentId: cursor || null };
}

async function readSourceCollections(): Promise<SourceCollections> {
  const firestore = adminSupport.admin.firestore();
  const fieldPath = adminSupport.admin.firestore.FieldPath.documentId();
  const pages = await Promise.all(
    SOURCE_COLLECTION_NAMES.map((collectionName) =>
      readKeysetCollection(firestore, fieldPath, collectionName),
    ),
  );
  return Object.fromEntries(
    SOURCE_COLLECTION_NAMES.map((collectionName, index) => [
      collectionName,
      pages[index].documents,
    ]),
  ) as SourceCollections;
}

export function estimateCanonicalRowBytes(
  table: CanonicalTable,
  row: CanonicalRow,
): number {
  const columns = TABLE_COLUMNS[table];
  if (
    Object.keys(row).length !== columns.length ||
    !columns.every((column) => Object.hasOwn(row, column))
  ) {
    fail("canonical-row-shape-mismatch");
  }
  return columns.reduce(
    (total, column) =>
      total +
      16 +
      (typeof row[column] === "string"
        ? Buffer.byteLength(row[column], "utf8")
        : 0),
    256,
  );
}

function assertCanonicalRowFitsD1(
  table: CanonicalTable,
  row: CanonicalRow,
): void {
  if (estimateCanonicalRowBytes(table, row) > MAX_D1_ROW_ESTIMATE_BYTES) {
    fail("canonical-row-too-large");
  }
}

function assertD1StatementFits(statement: D1Statement): void {
  if (Buffer.byteLength(statement.sql, "utf8") > MAX_D1_SQL_STATEMENT_BYTES) {
    fail("import-statement-too-large");
  }
  if (statement.params.length > MAX_D1_BOUND_PARAMETERS) {
    fail("import-statement-parameter-limit");
  }
}

export function buildUpsertStatement(
  table: CanonicalTable,
  row: CanonicalRow,
): D1Statement {
  const columns = TABLE_COLUMNS[table];
  assertCanonicalRowFitsD1(table, row);
  const keys = TABLE_KEYS[table];
  if (IMMUTABLE_TABLES.has(table)) {
    const statement = {
      sql: `
        INSERT INTO ${table} (${columns.join(", ")})
        VALUES (${columns.map(() => "?").join(", ")})
        ON CONFLICT (${keys.join(", ")}) DO NOTHING
      `,
      params: columns.map((column) => row[column]),
    };
    assertD1StatementFits(statement);
    return statement;
  }
  const updates = columns.filter((column) => !keys.includes(column));
  const assignments = updates.map((column) => `${column} = excluded.${column}`);
  const statement = {
    sql: `
      INSERT INTO ${table} (${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
      ON CONFLICT (${keys.join(", ")}) DO UPDATE SET
        ${assignments.join(",\n        ")}
    `,
    params: columns.map((column) => row[column]),
  };
  assertD1StatementFits(statement);
  return statement;
}

export function buildImportStatements(
  dataset: CanonicalDataset,
): D1Statement[] {
  return CANONICAL_TABLES.flatMap((table) =>
    dataset.tables[table].map((row) => buildUpsertStatement(table, row)),
  );
}

export function d1QueryRequestBytes(
  statements: readonly D1Statement[],
): number {
  return Buffer.byteLength(JSON.stringify({ batch: statements }));
}

export function batchImportStatements(
  statements: D1Statement[],
  limits: {
    maxBytes?: number;
    maxRequestBytes?: number;
    maxStatements?: number;
    prefixStatements?: readonly D1Statement[];
  } = {},
): D1Statement[][] {
  const maxBytes = limits.maxBytes || MAX_IMPORT_BATCH_BYTES;
  const maxRequestBytes = limits.maxRequestBytes || MAX_D1_QUERY_REQUEST_BYTES;
  const maxStatements = limits.maxStatements || MAX_IMPORT_BATCH_STATEMENTS;
  const prefixStatements = [...(limits.prefixStatements || [])];
  const batches: D1Statement[][] = [];
  let batch: D1Statement[] = [];
  for (const statement of statements) {
    if (
      d1QueryRequestBytes([...prefixStatements, statement]) > maxRequestBytes
    ) {
      fail("import-request-too-large");
    }
    const candidateRequestBytes = d1QueryRequestBytes([
      ...prefixStatements,
      ...batch,
      statement,
    ]);
    if (
      batch.length > 0 &&
      (batch.length >= maxStatements ||
        candidateRequestBytes > maxBytes ||
        candidateRequestBytes > maxRequestBytes)
    ) {
      batches.push(batch);
      batch = [];
    }
    batch.push(statement);
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function assertImportDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    fail("invalid-profile-import-digest");
  }
}

export function canonicalImportGuardStatement(digest: string): D1Statement {
  assertImportDigest(digest);
  return {
    sql: `
      INSERT INTO profile_transaction_guards (singleton)
      SELECT 0
      WHERE NOT EXISTS (
        SELECT 1
        FROM profile_canonical_control
        WHERE singleton = 1
          AND state = 'importing'
          AND import_digest = ?
          AND import_plan_version = ?
          AND imported_at_ms IS NULL
      )
    `,
    params: [digest, CANONICAL_IMPORT_PLAN_VERSION],
  };
}

export async function claimCanonicalImportPlan(
  client: D1Client,
  digest: string,
): Promise<void> {
  assertImportDigest(digest);
  await client.query([
    {
      sql: `
        UPDATE profile_canonical_control
        SET import_digest = COALESCE(import_digest, ?),
            import_plan_version = COALESCE(import_plan_version, ?)
        WHERE singleton = 1
          AND state = 'importing'
          AND imported_at_ms IS NULL
          AND (import_digest IS NULL OR import_digest = ?)
          AND (import_plan_version IS NULL OR import_plan_version = ?)
      `,
      params: [
        digest,
        CANONICAL_IMPORT_PLAN_VERSION,
        digest,
        CANONICAL_IMPORT_PLAN_VERSION,
      ],
    },
    canonicalImportGuardStatement(digest),
  ]);
}

async function readCanonicalControl(client: D1Client): Promise<JsonRecord> {
  const [rows] = await client.query([
    {
      sql: `
        SELECT state, import_digest, import_plan_version, imported_at_ms
        FROM profile_canonical_control
        WHERE singleton = ?
      `,
      params: [1],
    },
  ]);
  const control = rows.length === 1 ? record(rows[0]) : null;
  if (!control) {
    fail("profile-canonical-control-invalid");
  }
  return control;
}

export async function assertCanonicalImporting(
  client: D1Client,
  digest?: string,
): Promise<void> {
  const control = await readCanonicalControl(client);
  if (
    control.state !== "importing" ||
    control.imported_at_ms !== null ||
    (digest !== undefined &&
      (control.import_digest !== digest ||
        control.import_plan_version !== CANONICAL_IMPORT_PLAN_VERSION))
  ) {
    fail("profile-canonical-import-closed");
  }
}

export async function assertCanonicalFrozenForVerification(
  client: D1Client,
): Promise<void> {
  const control = await readCanonicalControl(client);
  if (
    control?.state !== "frozen" ||
    typeof control.import_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(control.import_digest) ||
    control.import_plan_version !== CANONICAL_IMPORT_PLAN_VERSION ||
    !nonnegativeSafeInteger(control.imported_at_ms)
  ) {
    fail("profile-canonical-verification-not-frozen");
  }
}

export async function assertCanonicalTargetEmpty(
  client: D1Client,
): Promise<void> {
  const results = await client.query(
    CANONICAL_TABLES.map((table) => ({
      sql: `SELECT COUNT(*) AS row_count FROM ${table}`,
      params: [],
    })),
  );
  if (
    results.some(
      (rows) =>
        rows.length !== 1 ||
        !nonnegativeSafeInteger(record(rows[0])?.row_count) ||
        Number(record(rows[0])?.row_count) !== 0,
    )
  ) {
    fail("profile-canonical-target-not-empty");
  }
}

export async function assertCanonicalImportPlanCompatible(
  client: D1Client,
  digest: string,
): Promise<void> {
  assertImportDigest(digest);
  const control = await readCanonicalControl(client);
  if (control.state !== "importing" || control.imported_at_ms !== null) {
    fail("profile-canonical-import-closed");
  }
  if (control.import_digest === null && control.import_plan_version === null) {
    await assertCanonicalTargetEmpty(client);
    return;
  }
  if (
    control.import_digest !== digest ||
    control.import_plan_version !== CANONICAL_IMPORT_PLAN_VERSION
  ) {
    fail("profile-canonical-import-plan-mismatch");
  }
}

export function buildCanonicalImportPlan(
  dataset: CanonicalDataset,
): CanonicalImportPlan {
  validateCanonicalTarget(dataset);
  const digest = verificationSnapshot(dataset).fingerprint;
  const guard = canonicalImportGuardStatement(digest);
  const statements = buildImportStatements(dataset);
  statements.forEach(assertD1StatementFits);
  const batches = batchImportStatements(statements, {
    maxBytes: MAX_IMPORT_BATCH_BYTES,
    maxRequestBytes: MAX_D1_QUERY_REQUEST_BYTES,
    maxStatements: MAX_IMPORT_BATCH_STATEMENTS - 1,
    prefixStatements: [guard],
  });
  return { batches, digest, statements };
}

export async function executeCanonicalImportPlan(
  client: D1Client,
  plan: CanonicalImportPlan,
): Promise<void> {
  const guard = canonicalImportGuardStatement(plan.digest);
  for (const batch of plan.batches) {
    await client.query([guard, ...batch]);
  }
}

export async function finalizeCanonicalImport(
  client: D1Client,
  digest: string,
): Promise<void> {
  const guard = canonicalImportGuardStatement(digest);
  await client.query([
    guard,
    {
      sql: `
        UPDATE profile_canonical_control
        SET state = 'frozen',
            imported_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1
          AND state = 'importing'
          AND import_digest = ?
          AND import_plan_version = ?
          AND imported_at_ms IS NULL
      `,
      params: [digest, CANONICAL_IMPORT_PLAN_VERSION],
    },
    {
      sql: `
        INSERT INTO profile_transaction_guards (singleton)
        SELECT 0 WHERE NOT EXISTS (
          SELECT 1 FROM profile_canonical_control
          WHERE singleton = 1
            AND state = 'frozen'
            AND import_digest = ?
            AND import_plan_version = ?
            AND imported_at_ms IS NOT NULL
        )
      `,
      params: [digest, CANONICAL_IMPORT_PLAN_VERSION],
    },
  ]);
}

function assertCommandSucceeded(result: {
  signal: NodeJS.Signals | null;
  status: number | null;
}): void {
  if (result.status !== 0) {
    fail(
      result.signal ? "wrangler-command-terminated" : "wrangler-command-failed",
    );
  }
}

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  assertCommandSucceeded(result);
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
    fail("invalid-cloudflare-authentication-response");
  }
  const token = cleanString(record(parsed)?.token);
  if (!token) {
    fail("missing-cloudflare-authentication-token");
  }
  return token;
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
    fail("invalid-profile-d1-configuration");
  }
  const parsed = record(config.config);
  const accountId = cleanString(parsed?.account_id);
  const database = Array.isArray(parsed?.d1_databases)
    ? parsed.d1_databases.find(
        (value) => record(value)?.database_name === DATABASE_NAME,
      )
    : null;
  const databaseId = cleanString(record(database)?.database_id);
  if (
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    !/^[a-f0-9-]{36}$/i.test(databaseId)
  ) {
    fail("invalid-profile-d1-configuration");
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
        parsed = JSON.parse(await readBoundedD1Response(response)) as unknown;
      } catch (error) {
        if (error instanceof ProfileCanonicalMigrationError) throw error;
        fail("invalid-profile-d1-response");
      }
      const root = record(parsed);
      const result = root?.result;
      if (
        !response.ok ||
        root?.success !== true ||
        !Array.isArray(result) ||
        result.length !== statements.length
      ) {
        fail("profile-d1-query-failed");
      }
      return result.map((entry) => {
        const queryResult = record(entry);
        if (queryResult?.success !== true) {
          fail("profile-d1-query-failed");
        }
        return Array.isArray(queryResult.results)
          ? queryResult.results.filter(
              (value): value is JsonRecord => record(value) !== null,
            )
          : [];
      });
    },
  };
}

export async function readBoundedD1Response(
  response: Response,
  maximumBytes = MAX_D1_RESPONSE_BYTES,
): Promise<string> {
  const declaredHeader = response.headers.get("Content-Length");
  const declaredBytes = declaredHeader === null ? 0 : Number(declaredHeader);
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    await response.body?.cancel();
    fail("profile-d1-response-too-large");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf8", { fatal: true });
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text + decoder.decode();
    }
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      fail("profile-d1-response-too-large");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function normalizeTargetRow(
  table: CanonicalTable,
  value: JsonRecord,
): CanonicalRow {
  const row: CanonicalRow = {};
  const jsonColumns = TABLE_JSON_COLUMNS[table] || [];
  for (const column of TABLE_COLUMNS[table]) {
    let entry = value[column];
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number"
    ) {
      fail("malformed-target-row");
    }
    let parameter: D1Parameter = entry;
    if (jsonColumns.includes(column) && typeof entry === "string") {
      try {
        parameter = jsonText(JSON.parse(entry) as unknown);
      } catch {
        fail("malformed-target-json");
      }
    }
    row[column] = parameter;
  }
  return row;
}

export function targetPageStatement(
  table: CanonicalTable,
  cursor: CanonicalRow | null,
  pageSize = TARGET_VERIFY_PAGE_SIZE,
): D1Statement {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    fail("invalid-target-page-size");
  }
  const keys = TABLE_KEYS[table];
  const params: D1Parameter[] = [];
  let where = "";
  if (cursor) {
    if (keys.length === 1) {
      where = `WHERE ${keys[0]} > ?`;
      params.push(cursor[keys[0]]);
    } else {
      where = `WHERE (${keys[0]} > ?) OR (${keys[0]} = ? AND ${keys[1]} > ?)`;
      params.push(cursor[keys[0]], cursor[keys[0]], cursor[keys[1]]);
    }
  }
  params.push(pageSize);
  return {
    sql: `
      SELECT ${TABLE_COLUMNS[table].join(", ")}
      FROM ${table}
      ${where}
      ORDER BY ${keys.join(", ")}
      LIMIT ?
    `,
    params,
  };
}

export async function readTargetTable(
  client: D1Client,
  table: CanonicalTable,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<CanonicalRow[]> {
  let pageSize = options.pageSize || TARGET_VERIFY_PAGE_SIZE;
  const maxPages = options.maxPages || MAX_TARGET_VERIFY_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    fail("invalid-target-page-limit");
  }
  const rows: CanonicalRow[] = [];
  let cursor: CanonicalRow | null = null;
  for (let page = 0; page < maxPages;) {
    let results: JsonRecord[][];
    try {
      results = await client.query([
        targetPageStatement(table, cursor, pageSize),
      ]);
    } catch (error) {
      if (
        error instanceof ProfileCanonicalMigrationError &&
        error.message === "profile-d1-response-too-large" &&
        pageSize > 1
      ) {
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        continue;
      }
      throw error;
    }
    const rawRows = results[0];
    if (!rawRows || rawRows.length > pageSize) {
      fail("malformed-target-page");
    }
    const nextRows = rawRows.map((row) => normalizeTargetRow(table, row));
    const cursorKey = cursor ? primaryKey(table, cursor) : null;
    if (
      cursorKey !== null &&
      nextRows.some(
        (row) => compareText(primaryKey(table, row), cursorKey) <= 0,
      )
    ) {
      fail("unstable-target-page");
    }
    rows.push(...nextRows);
    if (nextRows.length < pageSize) {
      return rows;
    }
    cursor = nextRows.at(-1) || null;
    page += 1;
  }
  fail("target-page-limit-exceeded");
}

export async function readTargetDataset(
  client: D1Client,
): Promise<CanonicalDataset> {
  const tables = emptyTables();
  for (const table of CANONICAL_TABLES) {
    tables[table] = await readTargetTable(client, table);
  }
  return sortDataset({
    indexValidation: {
      authMethodStale: 0,
      authMethodValid: 0,
      usernameStale: 0,
      usernameValid: 0,
    },
    tables,
  });
}

function parseTargetObject(value: D1Parameter, code: string): JsonRecord {
  if (typeof value !== "string") {
    fail(code);
  }
  try {
    const parsed = record(JSON.parse(value) as unknown);
    if (parsed) {
      return parsed;
    }
  } catch {}
  fail(code);
}

function canonicalFlag(value: D1Parameter): boolean {
  if (value !== 0 && value !== 1) {
    fail("malformed-canonical-flag");
  }
  return value === 1;
}

function canonicalInteger(value: D1Parameter, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(code);
  }
  return value;
}

function canonicalNonnegativeInteger(value: D1Parameter, code: string): number {
  const parsed = canonicalInteger(value, code);
  if (parsed < 0) {
    fail(code);
  }
  return parsed;
}

function canonicalNullableNonnegativeInteger(
  value: D1Parameter,
  code: string,
): number | null {
  return value === null ? null : canonicalNonnegativeInteger(value, code);
}

function canonicalString(
  value: D1Parameter,
  code: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) {
    fail(code);
  }
  return value;
}

function canonicalNullableString(
  value: D1Parameter,
  code: string,
): string | null {
  return value === null ? null : canonicalString(value, code, true);
}

function validateCanonicalRevision(
  row: CanonicalRow,
  exact: number | null = null,
): void {
  const revision = canonicalInteger(
    row.revision,
    "malformed-canonical-revision",
  );
  if (revision < 1 || (exact !== null && revision !== exact)) {
    fail("malformed-canonical-revision");
  }
}

function parseTargetArray(value: D1Parameter, code: string): unknown[] {
  if (typeof value !== "string") {
    fail(code);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  fail(code);
}

function validateGameplayEmoji(value: D1Parameter): string | number {
  if (typeof value !== "string") {
    fail("malformed-canonical-gameplay-emoji");
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "string" ||
      (typeof parsed === "number" && Number.isFinite(parsed))
    ) {
      return parsed;
    }
  } catch {}
  fail("malformed-canonical-gameplay-emoji");
}

function assertUniqueCanonicalKeys(dataset: CanonicalDataset): void {
  for (const table of CANONICAL_TABLES) {
    const keys = new Set<string>();
    for (const row of dataset.tables[table]) {
      const key = primaryKey(table, row);
      if (keys.has(key)) {
        fail("duplicate-canonical-primary-key");
      }
      keys.add(key);
    }
  }
}

function assertCanonicalProfileMaterialization(
  row: CanonicalRow,
  payload: JsonRecord,
): void {
  const mining = record(payload.mining);
  const materials = record(mining?.materials);
  if (!mining || !materials) {
    fail("canonical-profile-materialization-mismatch");
  }
  const materializations: Array<[string, string, unknown, number, boolean]> = [
    ["rating_sort", "rating_sort_present", payload.rating, 1500, true],
    [
      "mana_points_sort",
      "mana_points_sort_present",
      payload.totalManaPoints,
      0,
      false,
    ],
    ["nonce_sort", "nonce_sort_present", payload.nonce, -1, false],
    ...MATERIAL_KEYS.map(
      (material): [string, string, unknown, number, boolean] => [
        `${material}_sort`,
        `${material}_sort_present`,
        materials[material],
        0,
        false,
      ],
    ),
  ];
  for (const [
    valueColumn,
    presenceColumn,
    payloadValue,
    fallback,
    rating,
  ] of materializations) {
    const present = canonicalFlag(row[presenceColumn]);
    const value = row[valueColumn];
    if (
      (value !== null && !finiteNumber(value)) ||
      (!present && value !== null) ||
      payloadValue !==
        (value === null ? fallback : rating && value === 0 ? 1500 : value)
    ) {
      fail("canonical-profile-materialization-mismatch");
    }
  }
  const winPresent = canonicalFlag(row.win_present);
  const emojiPresent = canonicalFlag(row.emoji_present);
  const gameplayEmoji = validateGameplayEmoji(row.gameplay_emoji_json);
  if (
    (!winPresent && payload.win !== true) ||
    (emojiPresent && payload.emoji !== gameplayEmoji) ||
    (!emojiPresent &&
      payload.emoji !== getProfileFallbackEmojiId(String(row.profile_id)))
  ) {
    fail("canonical-profile-materialization-mismatch");
  }
}

const RATING_PROJECTION_FIELDS = [
  ["telegramProjection", "telegram_projection"],
  ["profileGameProjection", "profile_game_projection"],
  ["eventProgress", "event_progress"],
] as const;

function ratingMaterializationFailure(): never {
  fail("canonical-rating-materialization-mismatch");
}

function ratingPayloadInteger(
  payload: JsonRecord,
  key: string,
  fallback: number | null,
  requireExplicit: boolean,
): number | null {
  const value = payload[key];
  if (value === null || value === undefined) {
    if (requireExplicit) ratingMaterializationFailure();
    return fallback;
  }
  if (!nonnegativeSafeInteger(value)) ratingMaterializationFailure();
  return Number(value);
}

function ratingPayloadProjectionState(value: unknown): string | null {
  const state = cleanString(value);
  if (!state) return null;
  if (state !== "pending" && state !== "done" && state !== "dead") {
    ratingMaterializationFailure();
  }
  return state;
}

function assertRatingPayloadConsistency(
  row: CanonicalRow,
  payload: JsonRecord,
): void {
  for (const [column, key] of [
    ["status", "status"],
    ["invite_id", "inviteId"],
    ["match_id", "matchId"],
    ["player_id", "playerId"],
    ["opponent_id", "opponentId"],
    ["owner_uid", "ownerUid"],
    ["owner_token", "ownerToken"],
  ] as const) {
    const value = cleanString(payload[key]);
    if (!value || value !== row[column]) ratingMaterializationFailure();
  }
  for (const [column, key] of [
    ["player_profile_id", "playerProfileId"],
    ["opponent_profile_id", "opponentProfileId"],
  ] as const) {
    if (nullableString(payload[key]) !== row[column]) {
      ratingMaterializationFailure();
    }
  }
  for (const [column, key] of [
    ["started_at_ms", "startedAtMs"],
    ["updated_at_ms", "updatedAtMs"],
    ["lease_expires_at_ms", "leaseExpiresAtMs"],
  ] as const) {
    if (ratingPayloadInteger(payload, key, null, true) !== row[column]) {
      ratingMaterializationFailure();
    }
  }
  if (
    ratingPayloadInteger(payload, "completedAtMs", null, false) !==
    row.completed_at_ms
  ) {
    ratingMaterializationFailure();
  }
  for (const [payloadPrefix, columnPrefix] of RATING_PROJECTION_FIELDS) {
    if (
      ratingPayloadProjectionState(payload[`${payloadPrefix}State`]) !==
        row[`${columnPrefix}_state`] ||
      ratingPayloadInteger(
        payload,
        `${payloadPrefix}UpdatedAtMs`,
        null,
        false,
      ) !== row[`${columnPrefix}_updated_at_ms`] ||
      ratingPayloadInteger(payload, `${payloadPrefix}Version`, null, false) !==
        row[`${columnPrefix}_version`]
    ) {
      ratingMaterializationFailure();
    }
  }
}

export function validateCanonicalTarget(dataset: CanonicalDataset): void {
  assertUniqueCanonicalKeys(dataset);
  const profiles = new Map<string, MergeProfileState>();
  const profileLegacyFields = new Map<string, string>();
  const activeProfileIds = new Set<string>();
  const activeProfilePayloads = new Map<string, JsonRecord>();
  const usernameKeys = new Set<string>();
  for (const row of dataset.tables.profile_records) {
    const profileId = safeDocumentId(row.profile_id);
    const payload = parseTargetObject(
      row.payload_json,
      "malformed-canonical-profile-payload",
    );
    const legacyFields = parseTargetObject(
      row.legacy_fields_json,
      "malformed-canonical-profile-legacy-fields",
    );
    validateGameplayEmoji(row.gameplay_emoji_json);
    validateCanonicalRevision(row);
    const createdAtMs = canonicalNonnegativeInteger(
      row.created_at_ms,
      "malformed-canonical-profile-timestamp",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-profile-timestamp",
    );
    canonicalNullableNonnegativeInteger(
      row.merged_at_ms,
      "malformed-canonical-profile-timestamp",
    );
    if (
      !isPlayerProfile(payload) ||
      payload.id !== profileId ||
      !record(legacyFields) ||
      updatedAtMs < createdAtMs
    ) {
      fail("malformed-canonical-profile-payload");
    }
    assertCanonicalProfileMaterialization(row, payload);
    const state = row.state;
    const mergedIntoProfileId = optionalDocumentId(
      row.merged_into_profile_id,
      "malformed-canonical-profile-state",
    );
    if (
      (state !== "active" && state !== "retiring") ||
      (state === "active" && mergedIntoProfileId !== null) ||
      (state === "retiring" &&
        (!mergedIntoProfileId || mergedIntoProfileId === profileId))
    ) {
      fail("malformed-canonical-profile-state");
    }
    const expectedUsernameKey =
      state === "active" && payload.username
        ? buildUsernameLookupKey(payload.username)
        : null;
    if (row.username_key !== expectedUsernameKey) {
      fail("malformed-canonical-username-key");
    }
    if (
      typeof expectedUsernameKey === "string" &&
      usernameKeys.has(expectedUsernameKey)
    ) {
      fail("duplicate-canonical-username-key");
    }
    if (typeof expectedUsernameKey === "string") {
      usernameKeys.add(expectedUsernameKey);
    }
    profiles.set(profileId, {
      state,
      mergedIntoProfileId,
    });
    profileLegacyFields.set(profileId, String(row.legacy_fields_json));
    if (state === "active") {
      activeProfileIds.add(profileId);
      activeProfilePayloads.set(profileId, payload);
    }
  }
  const mergeTargets = new Map<string, string>();
  for (const row of dataset.tables.profile_merge_targets) {
    const sourceProfileId = safeDocumentId(row.source_profile_id);
    const targetProfileId = safeDocumentId(row.target_profile_id);
    if (mergeTargets.has(sourceProfileId)) {
      fail("duplicate-canonical-merge-target");
    }
    canonicalNonnegativeInteger(
      row.merged_at_ms,
      "malformed-canonical-merge-target",
    );
    canonicalNullableString(row.op_id, "malformed-canonical-merge-target");
    parseTargetObject(
      row.source_legacy_fields_json,
      "malformed-canonical-merge-target-legacy-fields",
    );
    const sourceLegacyFields = profileLegacyFields.get(sourceProfileId);
    if (
      sourceLegacyFields !== undefined &&
      row.source_legacy_fields_json !== sourceLegacyFields
    ) {
      fail("canonical-merge-target-legacy-fields-mismatch");
    }
    mergeTargets.set(sourceProfileId, targetProfileId);
  }
  validateMergeTopology(profiles, mergeTargets);
  const loginOwners = new Map<string, string>();
  for (const row of dataset.tables.profile_login_owners) {
    const loginUid = safeLoginUid(row.login_uid);
    const profileId = safeDocumentId(row.profile_id);
    validateCanonicalRevision(row);
    const createdAtMs = canonicalNonnegativeInteger(
      row.created_at_ms,
      "malformed-canonical-login-owner",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-login-owner",
    );
    if (
      loginOwners.has(loginUid) ||
      !activeProfileIds.has(profileId) ||
      updatedAtMs < createdAtMs
    ) {
      fail("malformed-canonical-login-owner");
    }
    loginOwners.set(loginUid, profileId);
  }
  const profileMethods = new Map<string, CanonicalRow>();
  for (const row of dataset.tables.profile_auth_methods) {
    const method = exactString(row.method) as AuthMethodKey;
    const normalizedValue = exactString(row.normalized_value);
    const profileId = exactString(row.profile_id);
    const rawValue = exactString(row.raw_value);
    const profileMethod = `${profileId}\u0000${method}`;
    validateCanonicalRevision(row);
    canonicalNullableNonnegativeInteger(
      row.linked_at_ms,
      "malformed-canonical-auth-method",
    );
    canonicalNullableNonnegativeInteger(
      row.consent_at_ms,
      "malformed-canonical-auth-method",
    );
    const createdAtMs = canonicalNonnegativeInteger(
      row.created_at_ms,
      "malformed-canonical-auth-method",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-auth-method",
    );
    const appleEmail = canonicalNullableString(
      row.apple_email_masked,
      "malformed-canonical-auth-method",
    );
    const xUsername = canonicalNullableString(
      row.x_username,
      "malformed-canonical-auth-method",
    );
    const consentSource = canonicalNullableString(
      row.consent_source,
      "malformed-canonical-auth-method",
    );
    if (
      !AUTH_METHODS.includes(method) ||
      !normalizedValue ||
      !rawValue ||
      !activeProfileIds.has(profileId) ||
      profileMethods.has(profileMethod) ||
      normalizeMethodValue(method, normalizedValue) !== normalizedValue ||
      normalizeMethodValue(method, rawValue) !== normalizedValue ||
      (method !== "apple" && appleEmail !== null) ||
      (method !== "x" && xUsername !== null) ||
      (consentSource !== null &&
        consentSource !== "signin" &&
        consentSource !== "settings") ||
      updatedAtMs < createdAtMs
    ) {
      fail("malformed-canonical-auth-method");
    }
    profileMethods.set(profileMethod, row);
  }
  for (const [profileId, payload] of activeProfilePayloads) {
    for (const [method, field] of [
      ["eth", "eth"],
      ["sol", "sol"],
    ] as const) {
      const owner = profileMethods.get(`${profileId}\u0000${method}`);
      const value = payload[field];
      if (value === null) {
        if (owner) fail("canonical-profile-auth-method-mismatch");
        continue;
      }
      if (
        !owner ||
        normalizeMethodValue(method, value) !== owner.normalized_value
      ) {
        fail("canonical-profile-auth-method-mismatch");
      }
    }
  }
  for (const row of dataset.tables.profile_february_opponents) {
    const profileId = safeDocumentId(row.profile_id);
    const opponentProfileId = safeDocumentId(row.opponent_profile_id);
    canonicalNonnegativeInteger(
      row.recorded_at_ms,
      "malformed-canonical-february-opponent",
    );
    if (
      !profiles.has(profileId) ||
      !opponentProfileId ||
      profileId === opponentProfileId
    ) {
      fail("malformed-canonical-february-opponent");
    }
  }
  for (const row of dataset.tables.profile_auth_recovery_jobs) {
    const profileId = safeDocumentId(row.profile_id);
    if (!activeProfileIds.has(profileId)) {
      fail("malformed-canonical-auth-recovery");
    }
    const loginUids = parseTargetArray(
      row.login_uids_json,
      "malformed-canonical-auth-recovery",
    );
    const sourceProfileIds = parseTargetArray(
      row.source_profile_ids_json,
      "malformed-canonical-auth-recovery",
    );
    validateCanonicalRevision(row);
    const createdAtMs = canonicalNonnegativeInteger(
      row.created_at_ms,
      "malformed-canonical-auth-recovery",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-auth-recovery",
    );
    canonicalNonnegativeInteger(
      row.phase_started_at_ms,
      "malformed-canonical-auth-recovery",
    );
    canonicalNonnegativeInteger(
      row.last_enqueued_at_ms,
      "malformed-canonical-auth-recovery",
    );
    if (
      !loginUids.every((value) => {
        try {
          return loginOwners.get(safeLoginUid(value)) === profileId;
        } catch {
          return false;
        }
      }) ||
      new Set(loginUids).size !== loginUids.length ||
      new Set(sourceProfileIds).size !== sourceProfileIds.length ||
      !["prizes", "games", "finalize"].includes(
        canonicalString(row.source_phase, "malformed-canonical-auth-recovery"),
      ) ||
      (row.prize_cursor !== null && typeof row.prize_cursor !== "string") ||
      updatedAtMs < createdAtMs
    ) {
      fail("malformed-canonical-auth-recovery");
    }
    for (const sourceValue of sourceProfileIds) {
      let sourceProfileId: string;
      try {
        sourceProfileId = safeDocumentId(sourceValue);
      } catch {
        fail("malformed-canonical-auth-recovery");
      }
      let current = sourceProfileId;
      let followed = 0;
      while (current !== profileId) {
        const next = mergeTargets.get(current);
        if (!next || followed >= MAX_MIGRATABLE_PROFILE_MERGE_HOPS) {
          fail("malformed-canonical-auth-recovery");
        }
        current = next;
        followed += 1;
      }
      if (followed === 0) {
        fail("malformed-canonical-auth-recovery");
      }
    }
  }
  for (const row of dataset.tables.profile_auth_operations) {
    safeDocumentId(row.operation_id);
    const kind = canonicalString(
      row.kind,
      "malformed-canonical-auth-operation",
    );
    const method = canonicalString(
      row.method,
      "malformed-canonical-auth-operation",
    );
    const status = canonicalString(
      row.status,
      "malformed-canonical-auth-operation",
    );
    safeLoginUid(row.login_uid);
    validateCanonicalRevision(row);
    const startedAtMs = canonicalNonnegativeInteger(
      row.started_at_ms,
      "malformed-canonical-auth-operation",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-auth-operation",
    );
    canonicalNullableString(
      row.error_code,
      "malformed-canonical-auth-operation",
    );
    canonicalNullableString(
      row.error_message,
      "malformed-canonical-auth-operation",
    );
    if (
      !["unlink", "verify"].includes(kind) ||
      !AUTH_METHODS.includes(method as AuthMethodKey) ||
      !["started", "failed", "success"].includes(status) ||
      updatedAtMs < startedAtMs
    ) {
      fail("malformed-canonical-auth-operation");
    }
    if (row.meta_json !== null) {
      parseTargetObject(row.meta_json, "malformed-canonical-auth-operation");
    }
    if (row.result_json !== null) {
      parseTargetObject(row.result_json, "malformed-canonical-auth-operation");
    }
  }
  for (const row of dataset.tables.profile_auth_method_revocations) {
    const method = canonicalString(
      row.method,
      "malformed-canonical-auth-method-revocation",
    ) as AuthMethodKey;
    const normalizedValue = canonicalString(
      row.normalized_value,
      "malformed-canonical-auth-method-revocation",
    );
    safeDocumentId(row.profile_id);
    const startedAtMs = canonicalNonnegativeInteger(
      row.started_at_ms,
      "malformed-canonical-auth-method-revocation",
    );
    const retryAtMs = canonicalNonnegativeInteger(
      row.retry_at_ms,
      "malformed-canonical-auth-method-revocation",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-auth-method-revocation",
    );
    const cooldownMs = canonicalInteger(
      row.cooldown_ms,
      "malformed-canonical-auth-method-revocation",
    );
    canonicalString(row.scope, "malformed-canonical-auth-method-revocation");
    safeLoginUid(row.unlinked_by_uid);
    validateCanonicalRevision(row);
    if (
      !AUTH_METHODS.includes(method) ||
      normalizeMethodValue(method, normalizedValue) !== normalizedValue ||
      cooldownMs <= 0 ||
      retryAtMs < startedAtMs ||
      updatedAtMs < startedAtMs
    ) {
      fail("malformed-canonical-auth-method-revocation");
    }
  }
  for (const row of dataset.tables.profile_auth_method_cooldowns) {
    const method = canonicalString(
      row.method,
      "malformed-canonical-auth-method-cooldown",
    ) as AuthMethodKey;
    safeDocumentId(row.profile_id);
    const startedAtMs = canonicalNonnegativeInteger(
      row.started_at_ms,
      "malformed-canonical-auth-method-cooldown",
    );
    const retryAtMs = canonicalNonnegativeInteger(
      row.retry_at_ms,
      "malformed-canonical-auth-method-cooldown",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-auth-method-cooldown",
    );
    const cooldownMs = canonicalInteger(
      row.cooldown_ms,
      "malformed-canonical-auth-method-cooldown",
    );
    canonicalString(row.scope, "malformed-canonical-auth-method-cooldown");
    safeLoginUid(row.unlinked_by_uid);
    validateCanonicalRevision(row);
    if (
      !AUTH_METHODS.includes(method) ||
      cooldownMs <= 0 ||
      retryAtMs < startedAtMs ||
      updatedAtMs < startedAtMs
    ) {
      fail("malformed-canonical-auth-method-cooldown");
    }
  }
  for (const row of dataset.tables.rating_updates) {
    const payload = parseTargetObject(
      row.payload_json,
      "malformed-canonical-rating-update",
    );
    const operationId = safeDocumentId(row.operation_id);
    const status = canonicalString(
      row.status,
      "malformed-canonical-rating-update",
    );
    const inviteId = canonicalString(
      row.invite_id,
      "malformed-canonical-rating-update",
    );
    const matchId = canonicalString(
      row.match_id,
      "malformed-canonical-rating-update",
    );
    for (const column of [
      "player_id",
      "opponent_id",
      "owner_uid",
      "owner_token",
    ]) {
      canonicalString(row[column], "malformed-canonical-rating-update");
    }
    for (const column of ["player_profile_id", "opponent_profile_id"]) {
      if (row[column] !== null) {
        safeDocumentId(row[column]);
      }
    }
    const startedAtMs = canonicalNonnegativeInteger(
      row.started_at_ms,
      "malformed-canonical-rating-update",
    );
    const updatedAtMs = canonicalNonnegativeInteger(
      row.updated_at_ms,
      "malformed-canonical-rating-update",
    );
    const leaseExpiresAtMs = canonicalNonnegativeInteger(
      row.lease_expires_at_ms,
      "malformed-canonical-rating-update",
    );
    const completedAtMs = canonicalNullableNonnegativeInteger(
      row.completed_at_ms,
      "malformed-canonical-rating-update",
    );
    for (const prefix of [
      "telegram_projection",
      "profile_game_projection",
      "event_progress",
    ]) {
      const state = row[`${prefix}_state`];
      if (
        state !== null &&
        !["pending", "done", "dead"].includes(
          canonicalString(state, "malformed-canonical-rating-update"),
        )
      ) {
        fail("malformed-canonical-rating-update");
      }
      canonicalNullableNonnegativeInteger(
        row[`${prefix}_updated_at_ms`],
        "malformed-canonical-rating-update",
      );
      canonicalNullableNonnegativeInteger(
        row[`${prefix}_version`],
        "malformed-canonical-rating-update",
      );
    }
    validateCanonicalRevision(row);
    assertRatingPayloadConsistency(row, payload);
    if (
      !["processing", "done"].includes(status) ||
      operationId !== `${inviteId}__${matchId}` ||
      updatedAtMs < startedAtMs ||
      leaseExpiresAtMs < startedAtMs ||
      (status === "processing" && completedAtMs !== null) ||
      (status === "done" &&
        (completedAtMs === null || completedAtMs < startedAtMs))
    ) {
      fail("malformed-canonical-rating-update");
    }
  }
  for (const row of dataset.tables.wager_settlements) {
    safeDocumentId(row.operation_id);
    canonicalString(row.fingerprint, "malformed-canonical-wager-settlement");
    safeDocumentId(row.winner_profile_id);
    safeDocumentId(row.loser_profile_id);
    if (
      !MATERIAL_KEYS.includes(row.material as never) ||
      canonicalInteger(row.count, "malformed-canonical-wager-settlement") <= 0
    ) {
      fail("malformed-canonical-wager-settlement");
    }
    canonicalNonnegativeInteger(
      row.applied_at_ms,
      "malformed-canonical-wager-settlement",
    );
    validateCanonicalRevision(row, 1);
  }
}

const LEADERBOARD_QUERY_PLANS = [
  ["rating_sort", "rating_sort_present", "idx_profile_records_rating"],
  [
    "mana_points_sort",
    "mana_points_sort_present",
    "idx_profile_records_mana_points",
  ],
  ["dust_sort", "dust_sort_present", "idx_profile_records_dust"],
  ["slime_sort", "slime_sort_present", "idx_profile_records_slime"],
  ["gum_sort", "gum_sort_present", "idx_profile_records_gum"],
  ["metal_sort", "metal_sort_present", "idx_profile_records_metal"],
  ["ice_sort", "ice_sort_present", "idx_profile_records_ice"],
  ["nonce_sort", "nonce_sort_present", "idx_profile_records_nonce"],
] as const;

export function leaderboardQueryPlanStatements(): D1Statement[] {
  return LEADERBOARD_QUERY_PLANS.map(([value, presence]) => ({
    sql: `
      EXPLAIN QUERY PLAN
      SELECT payload_json
      FROM profile_records
      WHERE state = 'active' AND ${presence} = 1
      ORDER BY ${value} DESC, profile_id DESC
      LIMIT 100
    `,
    params: [],
  }));
}

export async function assertLeaderboardQueryPlans(
  client: D1Client,
): Promise<void> {
  const results = await client.query(leaderboardQueryPlanStatements());
  if (results.length !== LEADERBOARD_QUERY_PLANS.length) {
    fail("malformed-leaderboard-query-plan");
  }
  results.forEach((rows, index) => {
    const expectedIndex = LEADERBOARD_QUERY_PLANS[index][2];
    const details = rows.map((row) => cleanString(row.detail));
    if (
      !details.some((detail) => detail.includes(expectedIndex)) ||
      details.some((detail) => /USE TEMP B-TREE FOR ORDER BY/i.test(detail))
    ) {
      fail("leaderboard-query-plan-mismatch");
    }
  });
}

export function verificationSnapshot(
  dataset: CanonicalDataset,
): VerificationSnapshot {
  const hash = createHash("sha256");
  const counts = {} as Record<CanonicalTable, number>;
  for (const table of CANONICAL_TABLES) {
    counts[table] = dataset.tables[table].length;
    hash.update(table);
    hash.update("\n");
    for (const row of dataset.tables[table]) {
      hash.update(jsonText(row));
      hash.update("\n");
    }
  }
  return { counts, fingerprint: hash.digest("hex") };
}

function sameSnapshot(
  left: VerificationSnapshot,
  right: VerificationSnapshot,
): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    CANONICAL_TABLES.every(
      (table) => left.counts[table] === right.counts[table],
    )
  );
}

export async function readStableCanonicalTarget(
  client: D1Client,
): Promise<CanonicalDataset> {
  await assertCanonicalFrozenForVerification(client);
  const first = await readTargetDataset(client);
  validateCanonicalTarget(first);
  await assertCanonicalFrozenForVerification(client);
  const second = await readTargetDataset(client);
  validateCanonicalTarget(second);
  await assertCanonicalFrozenForVerification(client);
  if (
    !sameSnapshot(verificationSnapshot(first), verificationSnapshot(second))
  ) {
    fail("profile-d1-target-not-stable");
  }
  return second;
}

function assertDatasetParity(
  expected: CanonicalDataset,
  target: CanonicalDataset,
): void {
  if (
    !sameSnapshot(verificationSnapshot(expected), verificationSnapshot(target))
  ) {
    fail("profile-d1-verification-mismatch");
  }
}

export function publicSummary(
  mode: MigrationMode,
  dataset: CanonicalDataset,
  verified: boolean,
): JsonRecord {
  const summary: JsonRecord = {
    mode,
    verified,
    counts: Object.fromEntries(
      CANONICAL_TABLES.map((table) => [table, dataset.tables[table].length]),
    ),
  };
  if (mode !== "verify-d1") {
    summary.staleIndexes = {
      authMethod: dataset.indexValidation.authMethodStale,
      username: dataset.indexValidation.usernameStale,
    };
  }
  return summary;
}

export function formatPublicFailure(error: unknown): string {
  const code =
    error instanceof ProfileCanonicalMigrationError
      ? error.message
      : "profile-canonical-migration-failed";
  return `profile canonical migration failed: ${code}`;
}

async function readCanonicalSource(): Promise<CanonicalDataset> {
  return buildCanonicalDataset(await readSourceCollections());
}

export async function execute(
  argv = process.argv.slice(2),
  dependencies: MigrationExecutionDependencies = {},
): Promise<void> {
  const options = parseArgs(argv);
  const createClient = dependencies.createClient || createD1Client;
  const log = dependencies.log || console.log;
  if (options.mode === "verify-d1") {
    const client = createClient();
    const target = await readStableCanonicalTarget(client);
    await assertLeaderboardQueryPlans(client);
    await assertCanonicalFrozenForVerification(client);
    log(JSON.stringify(publicSummary(options.mode, target, true)));
    return;
  }
  assertProductionFirestoreEnvironment();
  const initializeFirebase =
    dependencies.initializeFirebase || adminSupport.initAdmin;
  const cleanupFirebase =
    dependencies.cleanupFirebase || adminSupport.cleanupAdmin;
  const addCredentialHelp =
    dependencies.addCredentialHelp ||
    adminSupport.addApplicationDefaultCredentialHelp;
  const readSource = dependencies.readSource || readCanonicalSource;
  if (!initializeFirebase(["--project", options.project])) {
    fail("firebase-admin-initialization-failed");
  }
  try {
    const initialSource = await readSource();
    const initialPlan = buildCanonicalImportPlan(initialSource);
    if (options.mode === "dry-run") {
      log(JSON.stringify(publicSummary(options.mode, initialSource, false)));
      return;
    }
    const repeatedSource = await readSource();
    const repeatedPlan = buildCanonicalImportPlan(repeatedSource);
    if (initialPlan.digest !== repeatedPlan.digest) {
      fail("profile-source-changed-before-import");
    }
    const client = createClient();
    if (options.mode === "verify") {
      await assertCanonicalFrozenForVerification(client);
      const target = await readStableCanonicalTarget(client);
      assertDatasetParity(repeatedSource, target);
      await assertLeaderboardQueryPlans(client);
      log(JSON.stringify(publicSummary(options.mode, repeatedSource, true)));
      return;
    }
    await assertCanonicalImportPlanCompatible(client, initialPlan.digest);
    await claimCanonicalImportPlan(client, initialPlan.digest);
    await executeCanonicalImportPlan(client, initialPlan);
    const finalSource = await readSource();
    const finalPlan = buildCanonicalImportPlan(finalSource);
    if (finalPlan.digest !== initialPlan.digest) {
      fail("profile-source-changed-after-import");
    }
    const target = await readTargetDataset(client);
    validateCanonicalTarget(target);
    assertDatasetParity(finalSource, target);
    await assertLeaderboardQueryPlans(client);
    await assertCanonicalImporting(client, initialPlan.digest);
    await finalizeCanonicalImport(client, initialPlan.digest);
    log(JSON.stringify(publicSummary(options.mode, finalSource, true)));
  } catch (error) {
    throw addCredentialHelp(error);
  } finally {
    await cleanupFirebase();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  execute().catch((error) => {
    console.error(formatPublicFailure(error));
    process.exitCode = 1;
  });
}
