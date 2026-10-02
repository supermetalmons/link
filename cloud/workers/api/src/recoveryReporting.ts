import { summarizeError } from "./errorSummary.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";

export type RecoveryFailureContext = {
  event: string;
  scope: "auth" | "profile-game" | "telegram";
  phase:
    | "inspect"
    | "repair"
    | "claim"
    | "enqueue"
    | "quarantine"
    | "cleanup"
    | "sweep";
  source?: "automatch" | "event" | "profile-link" | "rating";
  itemIndex?: number;
  profileId?: string;
  inviteId?: string;
  eventId?: string;
  operationId?: string;
  loginUid?: string;
  lockScope?: "cleanup";
};

export type RecoveryFailureReporter<T> = (
  item: T,
  error: unknown,
  index: number,
) => void;

export function logRecoveryEvent<Level extends "error" | "info">(
  logger: Pick<Console, Level>,
  level: Level,
  entry: object,
): void {
  try {
    logger[level](JSON.stringify(entry));
  } catch {}
}

export function reportRecoveryFailure(
  logger: Pick<Console, "error">,
  context: RecoveryFailureContext,
  error: unknown,
): void {
  try {
    const summary = summarizeError(error);
    const entry: Record<string, unknown> = {
      event: context.event,
      scope: context.scope,
      phase: context.phase,
      code: summary.message ?? "unknown",
      error: summary,
    };
    if (context.source) entry.source = context.source;
    if (context.lockScope) entry.lockScope = context.lockScope;
    if (
      typeof context.itemIndex === "number" &&
      Number.isSafeInteger(context.itemIndex) &&
      context.itemIndex >= 0
    ) {
      entry.itemIndex = context.itemIndex;
    }
    for (const key of [
      "profileId",
      "inviteId",
      "eventId",
      "operationId",
    ] as const) {
      const value = context[key];
      if (
        isSafeRecordKey(value) &&
        value === value.trim() &&
        value.isWellFormed()
      )
        entry[key] = value;
    }
    if (isCanonicalLoginUid(context.loginUid))
      entry.loginUid = context.loginUid;
    logRecoveryEvent(logger, "error", entry);
  } catch {}
}

export function reportRecoveryItemFailure<T>(
  reporter: RecoveryFailureReporter<T> | undefined,
  item: T,
  error: unknown,
  index: number,
): void {
  try {
    reporter?.(item, error, index);
  } catch {}
}
