import { AuthApiFailure } from "./authErrors.ts";
import { readBoundedBody } from "./http.ts";
import { hasValidTelegramBridgeSignature } from "./telegramBridgeAuth.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  assertD1MigrationIdentity,
  D1_MIGRATION_BINDINGS,
  isD1MigrationBinding,
  type D1MigrationBinding,
  type D1MigrationEnvironment,
} from "./d1MigrationControl.ts";
import {
  fenceD1MigrationSource,
  readD1MigrationStatus,
  verifyD1MigrationDatabase,
} from "./d1MigrationDatabase.ts";

export const D1_MIGRATION_PATH = "/internal/d1-migration";

type Command = {
  schemaVersion: 1;
  kind: "d1-migration";
  runId: string;
  operation: "status" | "fence" | "barrier" | "verify";
  expectedVersionId?: string;
  binding?: D1MigrationBinding;
  schemaDigest?: string;
  objectId?: string;
  inviteId?: string;
  bookmark?: string;
};

function invalid(): never {
  throw new AuthApiFailure(
    400,
    "invalid-argument",
    "invalid-d1-migration-command",
  );
}

function parseCommand(body: string): Command {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    input.kind !== "d1-migration" ||
    typeof input.runId !== "string" ||
    (input.operation !== "status" &&
      input.operation !== "fence" &&
      input.operation !== "barrier" &&
      input.operation !== "verify")
  )
    invalid();
  const allowed = [
    "schemaVersion",
    "kind",
    "runId",
    "operation",
    "expectedVersionId",
  ];
  if (input.operation === "barrier") allowed.push("objectId", "inviteId");
  else allowed.push("binding");
  if (input.operation === "fence") allowed.push("schemaDigest");
  if (input.operation === "verify") allowed.push("bookmark");
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid();
  if (
    input.expectedVersionId !== undefined &&
    typeof input.expectedVersionId !== "string"
  )
    invalid();
  if (
    input.operation !== "status" &&
    typeof input.expectedVersionId !== "string"
  )
    invalid();
  if (input.binding !== undefined && !isD1MigrationBinding(input.binding))
    invalid();
  if (
    input.bookmark !== undefined &&
    (typeof input.bookmark !== "string" ||
      input.bookmark.length === 0 ||
      input.bookmark.length > 4096)
  )
    invalid();
  if (
    input.operation === "fence" &&
    (!isD1MigrationBinding(input.binding) ||
      typeof input.schemaDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.schemaDigest))
  )
    invalid();
  if (input.operation === "barrier") {
    const objectTarget = Object.hasOwn(input, "objectId");
    const inviteTarget = Object.hasOwn(input, "inviteId");
    if (objectTarget === inviteTarget) invalid();
    if (
      objectTarget &&
      (typeof input.objectId !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.objectId))
    )
      invalid();
    if (
      inviteTarget &&
      (typeof input.inviteId !== "string" ||
        input.inviteId !== input.inviteId.trim() ||
        !isSafeRecordKey(input.inviteId))
    )
      invalid();
  }
  const command: Command = {
    schemaVersion: 1,
    kind: "d1-migration",
    runId: input.runId,
    operation: input.operation,
  };
  if (typeof input.expectedVersionId === "string")
    command.expectedVersionId = input.expectedVersionId;
  if (isD1MigrationBinding(input.binding)) command.binding = input.binding;
  if (typeof input.schemaDigest === "string")
    command.schemaDigest = input.schemaDigest;
  if (typeof input.objectId === "string") command.objectId = input.objectId;
  if (typeof input.inviteId === "string") command.inviteId = input.inviteId;
  if (typeof input.bookmark === "string") command.bookmark = input.bookmark;
  return command;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleD1MigrationRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    if (request.method !== "POST")
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    const configuration = env as D1MigrationEnvironment;
    if (configuration.API_MAINTENANCE !== "true")
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "d1-migration-not-enabled",
      );
    const body = await readBoundedBody(request, 8192);
    const secret = env.TELEGRAM_QUEUE_BRIDGE_SECRET?.trim();
    if (
      !secret ||
      !(await hasValidTelegramBridgeSignature(
        body,
        secret,
        request.headers.get("X-Mons-Telegram-Timestamp") || "",
        request.headers.get("X-Mons-Telegram-Signature") || "",
        Date.now(),
      ))
    )
      throw new AuthApiFailure(401, "unauthenticated", "unauthenticated");
    const command = parseCommand(body);
    const identity = assertD1MigrationIdentity(
      configuration,
      command.runId,
      command.expectedVersionId,
    );
    const common = {
      ok: true,
      schemaVersion: 1,
      ...identity,
      maintenance: true,
    };
    if (command.operation === "barrier") {
      const id = command.objectId
        ? env.INVITE_REACTIONS.idFromString(command.objectId)
        : env.INVITE_REACTIONS.idFromName(command.inviteId!);
      const objectId = id.toString();
      const stub = env.INVITE_REACTIONS.get(id);
      const barrier = await stub.maintenanceBarrier({
        runId: identity.runId,
        expectedVersionId: identity.versionId,
      });
      if (
        barrier.versionId !== identity.versionId ||
        barrier.runId !== identity.runId ||
        barrier.objectId !== objectId
      )
        throw new Error("d1-migration-object-barrier-unconfirmed");
      return response({ ...common, ...barrier });
    }
    const bindings = command.binding
      ? [command.binding]
      : D1_MIGRATION_BINDINGS;
    const databases = await Promise.all(
      bindings.map(async (binding) => {
        const database = env[binding];
        if (command.operation === "fence")
          return fenceD1MigrationSource(
            database,
            binding,
            identity.runId,
            command.schemaDigest!,
          );
        const status = await readD1MigrationStatus(
          database,
          binding,
          identity.runId,
        );
        return command.operation === "verify"
          ? {
              ...status,
              ...(await verifyD1MigrationDatabase(
                database,
                binding,
                command.bookmark,
              )),
            }
          : status;
      }),
    );
    return response({ ...common, databases });
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(
            503,
            "unavailable",
            "d1-migration-operation-unavailable",
          );
    if (!(error instanceof AuthApiFailure))
      console.error({
        event: "d1_migration_operation_failed",
        kind: error instanceof Error ? error.name : "unknown",
      });
    return response(
      { ok: false, error: failure.code, message: failure.message },
      failure.status,
    );
  }
}
