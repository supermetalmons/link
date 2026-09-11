import { isSafeFirebaseKey } from "@mons/shared/ids";
import type {
  MatchStateImportRequest,
  MatchStateImportSnapshot,
} from "./matchStateTypes.ts";

export const MATCH_STATE_MIGRATION_PATH = "/internal/match-state/migration";
export const MATCH_STATE_MIGRATION_MAX_BYTES = 16 * 1024 * 1024;
export const MATCH_STATE_MIGRATION_MAX_RECORDS = 1000;

export type MatchStateMigrationRequest = {
  schemaVersion: 1;
  operation: "import" | "readback" | "activate";
  sourceDigest: string;
  ownerToken: string;
  bundle: MatchStateImportSnapshot;
};

export function matchStateCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(matchStateCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${matchStateCanonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("invalid-match-state-json");
}

export async function matchStateDigest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(matchStateCanonicalJson(value)),
    ),
  );
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function sortedMatchStateImport(
  value: MatchStateImportRequest,
): MatchStateImportRequest {
  const compare = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  return {
    inviteId: value.inviteId,
    epoch: value.epoch,
    importId: value.importId,
    records: [...value.records].sort(
      (left, right) =>
        compare(left.matchId, right.matchId) ||
        compare(left.playerId, right.playerId),
    ),
    claims: [...value.claims].sort((left, right) =>
      compare(left.matchId, right.matchId),
    ),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, names: string[]): boolean {
  return (
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

function key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    isSafeFirebaseKey(value)
  );
}

export async function parseMatchStateMigrationRequest(
  body: string,
): Promise<MatchStateMigrationRequest> {
  const raw: unknown = JSON.parse(body);
  if (
    !record(raw) ||
    !fields(raw, [
      "schemaVersion",
      "operation",
      "sourceDigest",
      "ownerToken",
      "bundle",
    ]) ||
    raw.schemaVersion !== 1 ||
    !["import", "readback", "activate"].includes(String(raw.operation)) ||
    typeof raw.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.sourceDigest) ||
    typeof raw.ownerToken !== "string" ||
    !/^[a-f0-9-]{36}$/.test(raw.ownerToken) ||
    !record(raw.bundle)
  )
    throw new TypeError("invalid-match-state-migration-request");
  const bundle = raw.bundle;
  if (
    !fields(bundle, [
      "inviteId",
      "epoch",
      "importId",
      "records",
      "claims",
      "digest",
      "recordCount",
      "claimCount",
    ]) ||
    !key(bundle.inviteId) ||
    !key(bundle.importId) ||
    !Number.isSafeInteger(bundle.epoch) ||
    Number(bundle.epoch) < 1 ||
    !Array.isArray(bundle.records) ||
    !Array.isArray(bundle.claims) ||
    bundle.records.length + bundle.claims.length >
      MATCH_STATE_MIGRATION_MAX_RECORDS ||
    bundle.recordCount !== bundle.records.length ||
    bundle.claimCount !== bundle.claims.length ||
    typeof bundle.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(bundle.digest)
  )
    throw new TypeError("invalid-match-state-migration-bundle");
  const seen = new Set<string>();
  for (const row of bundle.records) {
    if (
      !record(row) ||
      !fields(row, ["matchId", "playerId", "value"]) ||
      !key(row.matchId) ||
      !key(row.playerId) ||
      !record(row.value)
    )
      throw new TypeError("invalid-match-state-migration-record");
    const id = JSON.stringify([row.matchId, row.playerId]);
    if (seen.has(id))
      throw new TypeError("duplicate-match-state-migration-record");
    seen.add(id);
  }
  const claims = new Set<string>();
  for (const row of bundle.claims) {
    if (
      !record(row) ||
      !fields(row, ["matchId", "value"]) ||
      !key(row.matchId) ||
      !record(row.value) ||
      claims.has(row.matchId)
    )
      throw new TypeError("invalid-match-state-migration-claim");
    claims.add(row.matchId);
  }
  const normalized = sortedMatchStateImport(bundle as MatchStateImportSnapshot);
  if ((await matchStateDigest(normalized)) !== bundle.digest)
    throw new TypeError("match-state-migration-digest-conflict");
  return {
    schemaVersion: 1,
    operation: raw.operation as MatchStateMigrationRequest["operation"],
    sourceDigest: raw.sourceDigest,
    ownerToken: raw.ownerToken,
    bundle: {
      ...normalized,
      digest: bundle.digest,
      recordCount: normalized.records.length,
      claimCount: normalized.claims.length,
    },
  };
}
