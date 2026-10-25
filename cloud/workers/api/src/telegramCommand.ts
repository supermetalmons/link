import type {
  ApiRequest,
  ApiJsonBody,
  ApiJsonStatus,
  TelegramRecoveryAction as RecoveryAction,
  TelegramSendCommand as SendCommand,
  TelegramRecoveryCommand as RecoveryCommand,
  TelegramRecoveryStatusCommand as RecoveryStatusCommand,
} from "@mons/shared/api-contracts";
import { replaceTelegramDesired } from "../../../runtime/telegram/messageProjectionRecords.js";
import {
  previewTelegramRecovery,
  requestTelegramRecovery,
  persistedTelegramRecovery,
  readTelegramRecoveryStatus,
} from "./telegramCommandRecords.ts";
import {
  buildTelegramSendDesired,
  validateTelegramMessageKey,
} from "../../../runtime/telegram/desiredStateCore.js";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import { refreshSundayMonsReminder } from "./eventReminderProjection.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
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

type TelegramCommand = ApiRequest<"POST /internal/telegram/command">;
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
  if (kind === "event-reminder-refresh") {
    if (!exactKeys(value, ["kind", "eventId"])) {
      throw new TypeError("invalid-command");
    }
    const eventId = value.eventId;
    if (
      typeof eventId !== "string" ||
      eventId !== eventId.trim() ||
      !isSafeRecordKey(eventId)
    ) {
      throw new TypeError("invalid-event-id");
    }
    return { kind, eventId };
  }
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
    const command: unknown = {
      kind,
      messageKey: validateTelegramMessageKey(nonEmptyString(value.messageKey)),
      action,
      ...(parseMessageId(action, value.messageId) === undefined
        ? {}
        : { messageId: Number(value.messageId) }),
      ...(kind === "recovery-request" ? { requestId } : {}),
    };
    return command as RecoveryCommand;
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
  throw new TypeError("invalid-command");
}

function commandResponse<
  Status extends ApiJsonStatus<"POST /internal/telegram/command">,
>(
  status: Status,
  body: ApiJsonBody<"POST /internal/telegram/command", NoInfer<Status>>,
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
    value: replaceTelegramDesired(current, desired),
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
  const eligible = previewTelegramRecovery(
    await repository.getMessage(command.messageKey),
    command,
  );
  if (!eligible.eligible) {
    return commandResponse(409, { ok: false, error: "recovery-not-required" });
  }
  const { pendingRequestId, processedRequestId } = eligible;
  if (eligible.conflict) {
    return commandResponse(409, { ok: false, error: "recovery-conflict" });
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
    (current) =>
      requestTelegramRecovery(
        current,
        command,
        (reason) => {
          conflict = reason;
        },
        () => conflict,
      ),
  );
  if (conflict) {
    return commandResponse(409, { ok: false, error: conflict });
  }
  const persisted = persistedTelegramRecovery(transaction.value, command);
  const requestId = persisted.requestId;
  if (!persisted.matches) {
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
  const status = readTelegramRecoveryStatus(
    await repository.getMessage(command.messageKey),
    command.requestId,
  );
  if (status) {
    return commandResponse(200, {
      ok: true,
      messageKey: command.messageKey,
      requestId: command.requestId,
      ...status,
    });
  }

  return commandResponse(404, { ok: false, error: "recovery-not-found" });
}

export async function handleTelegramCommand(
  request: Request,
  env: Env,
  {
    now = Date.now,
    readStorageMode = readTelegramStorageMode,
    refreshReminder = refreshSundayMonsReminder,
    repository: repositoryOverride,
  }: {
    now?: () => number;
    readStorageMode?: typeof readTelegramStorageMode;
    refreshReminder?: typeof refreshSundayMonsReminder;
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
    if (command.kind === "event-reminder-refresh") {
      const result = await refreshReminder(env, command.eventId);
      if (result.status === "skipped") {
        return commandResponse(409, {
          ok: false,
          error: result.reason || "reminder-not-eligible",
        });
      }
      return commandResponse(202, {
        ok: true,
        eventId: command.eventId,
        status: result.status,
        messageKey: result.messageKey,
        requestId: result.requestId,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
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
