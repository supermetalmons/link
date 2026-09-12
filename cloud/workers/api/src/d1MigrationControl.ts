import { AuthApiFailure } from "./authErrors.ts";

export type D1MigrationEnvironment = {
  API_MAINTENANCE?: string;
  D1_MIGRATION_RUN_ID?: string;
  CF_VERSION_METADATA?: { id: string };
};

export const D1_MIGRATION_BINDINGS = [
  "PROFILE_GAMES_DB",
  "AUTH_STATE_DB",
  "TELEGRAM_DB",
  "EVENT_PRIZE_WITHDRAWALS_DB",
  "PROFILE_DB",
  "EVENT_DB",
] as const;

export type D1MigrationBinding = (typeof D1_MIGRATION_BINDINGS)[number];

export type D1MigrationBarrierRequest = {
  runId: string;
  expectedVersionId: string;
};

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const VERSION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function apiMaintenanceEnabled(env: D1MigrationEnvironment): boolean {
  return (
    env.API_MAINTENANCE !== undefined &&
    env.API_MAINTENANCE !== "" &&
    env.API_MAINTENANCE !== "false"
  );
}

export function assertApiAvailable(env: D1MigrationEnvironment): void {
  if (apiMaintenanceEnabled(env))
    throw new AuthApiFailure(503, "unavailable", "api-maintenance");
}

export function apiMaintenanceResponse(env: D1MigrationEnvironment): Response {
  return Response.json(
    {
      ok: false,
      error: "unavailable",
      message: "api-maintenance",
      runId: env.D1_MIGRATION_RUN_ID || null,
      versionId: env.CF_VERSION_METADATA?.id || null,
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "60",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function assertD1MigrationIdentity(
  env: D1MigrationEnvironment,
  runId: unknown,
  expectedVersionId?: unknown,
): { runId: string; versionId: string } {
  if (env.API_MAINTENANCE !== "true")
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "d1-migration-not-enabled",
    );
  if (
    typeof runId !== "string" ||
    !RUN_ID.test(runId) ||
    runId !== env.D1_MIGRATION_RUN_ID
  )
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "d1-migration-run-conflict",
    );
  const versionId = env.CF_VERSION_METADATA?.id;
  if (typeof versionId !== "string" || !VERSION_ID.test(versionId))
    throw new AuthApiFailure(
      503,
      "unavailable",
      "d1-migration-version-unavailable",
    );
  if (
    expectedVersionId !== undefined &&
    (typeof expectedVersionId !== "string" ||
      !VERSION_ID.test(expectedVersionId) ||
      expectedVersionId !== versionId)
  )
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "d1-migration-version-conflict",
    );
  return { runId, versionId };
}

export function isD1MigrationBinding(
  value: unknown,
): value is D1MigrationBinding {
  return (
    typeof value === "string" &&
    (D1_MIGRATION_BINDINGS as readonly string[]).includes(value)
  );
}

export async function d1MigrationDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
