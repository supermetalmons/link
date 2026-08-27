import {
  buildTelegramDeleteDesired,
  buildTelegramSendDesired,
  validateTelegramMessageKey,
} from "../../../functions/telegram/desiredStateCore.js";
import type { TelegramRepository } from "../../../functions/telegram/deliveryEngine.js";
import { readBoundedBody } from "./http.ts";
import {
  hasValidTelegramBridgeSignature,
  MAX_TIMESTAMP_SKEW_SECONDS,
} from "./telegramBridgeAuth.ts";
import {
  buildInitialTelegramDeliveryTask,
  enqueueInitialTelegramDelivery,
  enqueueTelegramDeliveryTask,
} from "./telegramDeliveryTasks.ts";
import {
  createD1TelegramRepository,
  readTelegramStorageMode,
} from "./telegramD1.ts";

export const TELEGRAM_COMMAND_PATH = "/internal/telegram/command";
export const MAX_TELEGRAM_COMMAND_BODY_BYTES = 32 * 1024;

const RECOVERY_ACTIONS = new Set([
  "abandon",
  "confirm-send-absent",
  "confirm-send-applied",
]);
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_MESSAGE_PREFIX = "admin:";

type RecoveryAction =
  "abandon" | "confirm-send-absent" | "confirm-send-applied";

type SendCommand = {
  destination: string;
  generation: string;
  instanceKey: string;
  kind: "send";
  messageKey: string;
  parseMode?: string | null;
  silent?: boolean;
  sourceRevision: string | number;
  text: string;
};

type RecoveryCommand = {
  action: RecoveryAction;
  kind: "recovery-preview" | "recovery-request";
  messageId?: number;
  messageKey: string;
  requestId?: string;
};

type RecoveryStatusCommand = {
  kind: "recovery-status";
  messageKey: string;
  requestId: string;
};

type SmokeCommand = {
  kind: "smoke";
  requestId: string;
};

type TelegramCommand =
  RecoveryCommand | RecoveryStatusCommand | SendCommand | SmokeCommand;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseRecoveryAction(value: unknown): RecoveryAction {
  const action = nonEmptyString(value) as RecoveryAction;
  if (!RECOVERY_ACTIONS.has(action)) throw new TypeError("invalid-action");
  return action;
}

function parseMessageId(
  action: RecoveryAction,
  value: unknown,
): number | undefined {
  if (action === "confirm-send-applied") {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
      throw new TypeError("invalid-message-id");
    }
    return Number(value);
  }
  if (value !== undefined) throw new TypeError("invalid-message-id");
  return undefined;
}

function parseCommand(body: string): TelegramCommand {
  const value = record(JSON.parse(body) as unknown);
  const kind = nonEmptyString(value?.kind);
  if (!value || !kind) throw new TypeError("invalid-command");
  if (kind === "send") {
    if (
      !exactKeys(
        value,
        [
          "kind",
          "messageKey",
          "generation",
          "destination",
          "instanceKey",
          "text",
          "sourceRevision",
        ],
        ["parseMode", "silent"],
      )
    ) {
      throw new TypeError("invalid-command");
    }
    const messageKey = validateTelegramMessageKey(
      nonEmptyString(value.messageKey),
    );
    const generation = nonEmptyString(value.generation);
    const destination = nonEmptyString(value.destination);
    const instanceKey = nonEmptyString(value.instanceKey);
    const text = typeof value.text === "string" ? value.text : "";
    const sourceRevision =
      typeof value.sourceRevision === "number"
        ? value.sourceRevision
        : nonEmptyString(value.sourceRevision);
    const parseMode = value.parseMode;
    if (
      !messageKey.startsWith(ADMIN_MESSAGE_PREFIX) ||
      !generation ||
      !destination ||
      !instanceKey ||
      !text ||
      sourceRevision === "" ||
      (parseMode !== undefined && parseMode !== null && parseMode !== "HTML") ||
      (value.silent !== undefined && typeof value.silent !== "boolean")
    ) {
      throw new TypeError("invalid-command");
    }
    return {
      kind,
      messageKey,
      generation,
      destination,
      instanceKey,
      text,
      sourceRevision,
      ...(parseMode === undefined ? {} : { parseMode }),
      ...(value.silent === undefined ? {} : { silent: value.silent }),
    };
  }
  if (kind === "recovery-preview" || kind === "recovery-request") {
    const required =
      kind === "recovery-request"
        ? ["kind", "messageKey", "action", "requestId"]
        : ["kind", "messageKey", "action"];
    if (!exactKeys(value, required, ["messageId"])) {
      throw new TypeError("invalid-command");
    }
    const action = parseRecoveryAction(value.action);
    const requestId = nonEmptyString(value.requestId);
    if (kind === "recovery-request" && !REQUEST_ID_PATTERN.test(requestId)) {
      throw new TypeError("invalid-request-id");
    }
    return {
      kind,
      messageKey: validateTelegramMessageKey(nonEmptyString(value.messageKey)),
      action,
      ...(parseMessageId(action, value.messageId) === undefined
        ? {}
        : { messageId: Number(value.messageId) }),
      ...(kind === "recovery-request" ? { requestId } : {}),
    };
  }
  if (kind === "recovery-status") {
    if (!exactKeys(value, ["kind", "messageKey", "requestId"])) {
      throw new TypeError("invalid-command");
    }
    const requestId = nonEmptyString(value.requestId);
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new TypeError("invalid-request-id");
    }
    return {
      kind,
      messageKey: validateTelegramMessageKey(nonEmptyString(value.messageKey)),
      requestId,
    };
  }
  if (kind === "smoke") {
    if (!exactKeys(value, ["kind", "requestId"])) {
      throw new TypeError("invalid-command");
    }
    const requestId = nonEmptyString(value.requestId);
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new TypeError("invalid-request-id");
    }
    return { kind, requestId };
  }
  throw new TypeError("invalid-command");
}

function commandResponse(
  status: number,
  body: Record<string, unknown>,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function sameRecovery(
  request: Record<string, unknown>,
  command: RecoveryCommand,
): boolean {
  return (
    nonEmptyString(request.action) === command.action &&
    (command.messageId === undefined
      ? request.messageId === undefined
      : Number(request.messageId) === command.messageId)
  );
}

function recoveryEligibility(recordValue: unknown): {
  attemptId: string;
  record: Record<string, unknown>;
} | null {
  const message = record(recordValue) || {};
  const delivery = record(message.delivery) || {};
  const sendInFlight = record(delivery.sendInFlight) || {};
  const attemptId = nonEmptyString(sendInFlight.attemptId);
  return delivery.status === "uncertain" && attemptId
    ? { attemptId, record: message }
    : null;
}

async function handleSend(
  command: SendCommand,
  repository: TelegramRepository,
  env: Env,
): Promise<Response> {
  const desired = buildTelegramSendDesired(command);
  buildInitialTelegramDeliveryTask({
    messageKey: command.messageKey,
    revision: desired.revision,
    generation: command.generation,
    producer: "admin-command",
  });
  await repository.transactMessage(command.messageKey, (current) => ({
    value: { ...(record(current) || {}), desired },
    decision: "admin-desired-persisted",
  }));
  await enqueueInitialTelegramDelivery(env, {
    messageKey: command.messageKey,
    revision: desired.revision,
    generation: command.generation,
    producer: "admin-command",
  });
  return commandResponse(202, {
    ok: true,
    messageKey: command.messageKey,
    revision: desired.revision,
  });
}

async function handleRecoveryPreview(
  command: RecoveryCommand,
  repository: TelegramRepository,
): Promise<Response> {
  const eligible = recoveryEligibility(
    await repository.getMessage(command.messageKey),
  );
  if (!eligible) {
    return commandResponse(409, {
      ok: false,
      error: "recovery-not-required",
    });
  }
  const pending = record(eligible.record.manualRecovery) || {};
  const delivery = record(eligible.record.delivery) || {};
  const pendingRequestId = nonEmptyString(pending.requestId);
  const processedRequestId = nonEmptyString(delivery.lastRecoveryRequestId);
  if (
    pendingRequestId &&
    pendingRequestId !== processedRequestId &&
    !sameRecovery(pending, command)
  ) {
    return commandResponse(409, {
      ok: false,
      error: "recovery-conflict",
    });
  }
  return commandResponse(200, {
    ok: true,
    dryRun: true,
    messageKey: command.messageKey,
    action: command.action,
    ...(command.messageId ? { messageId: command.messageId } : {}),
    ...(pendingRequestId && pendingRequestId !== processedRequestId
      ? { pendingRequestId }
      : {}),
  });
}

async function handleRecoveryRequest(
  command: RecoveryCommand & { requestId: string },
  repository: TelegramRepository,
  env: Env,
): Promise<Response> {
  let conflict = "";
  const transaction = await repository.transactMessage(
    command.messageKey,
    (current) => {
      const eligible = recoveryEligibility(current);
      if (!eligible) {
        conflict = "recovery-not-required";
        return { commit: false, decision: conflict };
      }
      const message = eligible.record;
      const delivery = record(message.delivery) || {};
      const pending = record(message.manualRecovery) || {};
      const pendingRequestId = nonEmptyString(pending.requestId);
      const processedRequestId = nonEmptyString(delivery.lastRecoveryRequestId);
      if (pendingRequestId && pendingRequestId !== processedRequestId) {
        if (!sameRecovery(pending, command)) {
          conflict = "recovery-conflict";
        }
        return { commit: false, decision: conflict || "recovery-resumed" };
      }
      return {
        value: {
          ...message,
          manualRecovery: {
            requestId: command.requestId,
            action: command.action,
            ...(command.messageId === undefined
              ? {}
              : { messageId: command.messageId }),
          },
        },
        decision: "recovery-requested",
      };
    },
  );
  if (conflict) {
    return commandResponse(409, { ok: false, error: conflict });
  }
  const persisted = record(transaction.value) || {};
  const request = record(persisted.manualRecovery) || {};
  const requestId = nonEmptyString(request.requestId);
  if (!requestId || !sameRecovery(request, command)) {
    return commandResponse(409, {
      ok: false,
      error: "recovery-conflict",
    });
  }
  await enqueueTelegramDeliveryTask(env, {
    messageKey: command.messageKey,
    revision: "manual-recovery",
    taskKind: "manual-recovery",
    retrySequence: 0,
    generation: `${requestId}:operator`,
  });
  return commandResponse(202, {
    ok: true,
    messageKey: command.messageKey,
    requestId,
    action: command.action,
  });
}

async function handleRecoveryStatus(
  command: RecoveryStatusCommand,
  repository: TelegramRepository,
): Promise<Response> {
  const message = record(await repository.getMessage(command.messageKey)) || {};
  const delivery = record(message.delivery) || {};
  const result = record(message.manualRecoveryResult) || {};
  if (nonEmptyString(result.requestId) === command.requestId) {
    return commandResponse(200, {
      ok: true,
      messageKey: command.messageKey,
      requestId: command.requestId,
      status: nonEmptyString(result.status) || "rejected",
      action: nonEmptyString(result.action),
      deliveryStatus: nonEmptyString(delivery.status) || null,
      ...(nonEmptyString(result.code)
        ? { code: nonEmptyString(result.code) }
        : {}),
    });
  }
  const pending = record(message.manualRecovery) || {};
  if (nonEmptyString(pending.requestId) === command.requestId) {
    return commandResponse(200, {
      ok: true,
      messageKey: command.messageKey,
      requestId: command.requestId,
      status: "pending",
      deliveryStatus: nonEmptyString(delivery.status) || null,
    });
  }
  return commandResponse(404, { ok: false, error: "recovery-not-found" });
}

async function handleSmoke(
  command: SmokeCommand,
  repository: TelegramRepository,
  env: Env,
): Promise<Response> {
  const messageKey = `migration-smoke:${command.requestId}`;
  const desired = buildTelegramDeleteDesired({
    destination: "community",
    sourceRevision: command.requestId,
  });
  await repository.transactMessage(messageKey, (current) => ({
    value: { ...(record(current) || {}), desired },
    decision: "migration-smoke-persisted",
  }));
  await enqueueInitialTelegramDelivery(env, {
    messageKey,
    revision: desired.revision,
    generation: `migration-smoke:${command.requestId}`,
    producer: "migration-smoke",
  });
  return commandResponse(202, {
    ok: true,
    messageKey,
    revision: desired.revision,
  });
}

export async function handleTelegramCommand(
  request: Request,
  env: Env,
  {
    now = Date.now,
    readStorageMode = readTelegramStorageMode,
    repository: repositoryOverride,
  }: {
    now?: () => number;
    readStorageMode?: typeof readTelegramStorageMode;
    repository?: TelegramRepository;
  } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return commandResponse(405, { ok: false, error: "method-not-allowed" });
  }
  let body: string;
  try {
    body = await readBoundedBody(request, MAX_TELEGRAM_COMMAND_BODY_BYTES);
  } catch {
    return commandResponse(400, { ok: false, error: "invalid-request" });
  }
  const timestamp =
    request.headers.get("X-Mons-Telegram-Timestamp")?.trim() || "";
  const signature =
    request.headers.get("X-Mons-Telegram-Signature")?.trim() || "";
  const secret = env.TELEGRAM_QUEUE_BRIDGE_SECRET.trim();
  if (
    !secret ||
    !(await hasValidTelegramBridgeSignature(
      body,
      secret,
      timestamp,
      signature,
      now(),
    ))
  ) {
    return commandResponse(401, { ok: false, error: "unauthenticated" });
  }
  let command: TelegramCommand;
  try {
    command = parseCommand(body);
  } catch {
    return commandResponse(400, { ok: false, error: "invalid-request" });
  }
  const storageMode = await readStorageMode(env.TELEGRAM_DB);
  if (storageMode === "frozen") {
    return commandResponse(
      503,
      { ok: false, error: "telegram-frozen" },
      { "Retry-After": "60" },
    );
  }
  const repository =
    repositoryOverride || createD1TelegramRepository(env.TELEGRAM_DB, { now });
  try {
    if (command.kind === "send") {
      return await handleSend(command, repository, env);
    }
    if (command.kind === "recovery-preview") {
      return await handleRecoveryPreview(command, repository);
    }
    if (command.kind === "recovery-request") {
      return await handleRecoveryRequest(
        command as RecoveryCommand & { requestId: string },
        repository,
        env,
      );
    }
    if (command.kind === "recovery-status") {
      return await handleRecoveryStatus(command, repository);
    }
    if (command.kind === "smoke") {
      return await handleSmoke(command, repository, env);
    }
    return commandResponse(400, { ok: false, error: "invalid-request" });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_command_failed",
        kind: command.kind,
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
    return commandResponse(503, { ok: false, error: "unavailable" });
  }
}

export { MAX_TIMESTAMP_SKEW_SECONDS, parseCommand };
