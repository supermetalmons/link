import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
import { isSafeRecordKey } from "@mons/shared/ids";
import { parseInviteMatchIndex } from "@mons/shared/rematches";

export type RematchEndScope = { loginUid: string; inviteId: string };
export type PendingRematchEnd = RematchEndScope & {
  matchId: string;
  actorUid: string;
  operationId: string;
};

type StoredRematchEnd = { version: 1; record: PendingRematchEnd };
type RematchEndFields = { [Key in keyof PendingRematchEnd]?: unknown };
type StoredRematchEndFields = { version?: unknown; record?: unknown };

type Timer = ReturnType<typeof setTimeout> | number;
type Dependencies = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  isAuthorized: () => boolean;
  isOnline: () => boolean;
  submit: (record: PendingRematchEnd) => Promise<void>;
  onError: (error: Error) => void;
  onConfirmed: (record: PendingRematchEnd) => void;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

export const REMATCH_END_STORAGE_PREFIX = "mons:pending-rematch-ends:v1:";

export function rematchEndDeliveryStorageKey(scope: RematchEndScope): string {
  return `${REMATCH_END_STORAGE_PREFIX}${JSON.stringify([
    scope.loginUid,
    scope.inviteId,
  ])}`;
}

function hasRematchEndIdentifiers(
  record: RematchEndFields,
): record is RematchEndFields &
  Pick<PendingRematchEnd, "loginUid" | "inviteId" | "matchId" | "actorUid"> {
  return [
    record.loginUid,
    record.inviteId,
    record.matchId,
    record.actorUid,
  ].every(
    (id) => typeof id === "string" && id === id.trim() && isSafeRecordKey(id),
  );
}

function isPendingRematchEnd(value: unknown): value is PendingRematchEnd {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as RematchEndFields;
  return (
    hasRematchEndIdentifiers(record) &&
    parseInviteMatchIndex(record.inviteId, record.matchId) !== null &&
    typeof record.operationId === "string" &&
    GAME_SESSION_OPERATION_ID_PATTERN.test(record.operationId)
  );
}

function storedRematchEndOperationId(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return (
    parsed as { record?: { operationId?: unknown } | null } | null | undefined
  )?.record?.operationId;
}

export function readPendingRematchEnd(
  scope: RematchEndScope,
  persistence: Pick<Storage, "getItem"> | null,
): PendingRematchEnd | null {
  const key = rematchEndDeliveryStorageKey(scope);
  const text = persistence?.getItem(key);
  if (!text) return null;
  const parsed: unknown = JSON.parse(text);
  const stored = parsed as StoredRematchEndFields | null | undefined;
  if (
    stored?.version !== 1 ||
    !isPendingRematchEnd(stored.record) ||
    rematchEndDeliveryStorageKey(stored.record) !== key
  ) {
    throw new Error("invalid-stored-rematch-end");
  }
  return { ...stored.record };
}

function codeOf(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unavailable";
  switch (code) {
    case "http-401":
      return "unauthenticated";
    case "http-403":
      return "permission-denied";
    case "http-404":
      return "not-found";
    case "http-429":
      return "resource-exhausted";
    default:
      return code;
  }
}

function retryDelay(error: unknown, fallbackMs: number): number {
  const requested =
    error && typeof error === "object" && "retryAfterMs" in error
      ? error.retryAfterMs
      : undefined;
  return typeof requested === "number" &&
    Number.isFinite(requested) &&
    requested >= 0
    ? Math.min(2_147_483_647, Math.max(fallbackMs, requested))
    : fallbackMs;
}

function shouldPause(error: unknown): boolean {
  return [
    "unauthenticated",
    "permission-denied",
    "invalid-argument",
    "not-found",
    "failed-precondition",
    "move-authentication-changed",
    "move-delivery-conflict",
    "move-delivery-baseline-conflict",
  ].includes(codeOf(error));
}

export class RematchEndDelivery {
  readonly scope: RematchEndScope;
  private readonly dependencies: Dependencies;
  private readonly key: string;
  private record: PendingRematchEnd | null = null;
  private inFlight: PendingRematchEnd | null = null;
  private timer: Timer | null = null;
  private failures = 0;
  private paused = false;

  constructor(scope: RematchEndScope, dependencies: Dependencies) {
    this.scope = { ...scope };
    this.dependencies = dependencies;
    this.key = rematchEndDeliveryStorageKey(scope);
    try {
      this.record = readPendingRematchEnd(scope, dependencies.storage);
    } catch (error) {
      this.report(error);
    }
  }

  get pending(): PendingRematchEnd | null {
    return this.record ? { ...this.record } : null;
  }

  accept(record: PendingRematchEnd): boolean {
    if (
      !isPendingRematchEnd(record) ||
      rematchEndDeliveryStorageKey(record) !== this.key ||
      !this.dependencies.isAuthorized()
    ) {
      return false;
    }
    if (this.record) {
      this.refresh();
      return true;
    }
    try {
      if (!this.dependencies.storage) {
        throw new Error("rematch-end-storage-unavailable");
      }
      this.dependencies.storage.setItem(
        this.key,
        JSON.stringify({ version: 1, record } satisfies StoredRematchEnd),
      );
    } catch (error) {
      this.report(error);
    }
    this.record = { ...record };
    this.failures = 0;
    this.refresh();
    return true;
  }

  refresh(): void {
    this.paused = false;
    this.pump();
  }

  pause(): void {
    this.paused = true;
    this.clearRetryTimer();
  }

  confirm(): void {
    const record = this.record;
    if (!record) return;
    this.record = null;
    this.clearRetryTimer();
    this.failures = 0;
    try {
      const text = this.dependencies.storage?.getItem(this.key);
      if (text && storedRematchEndOperationId(text) === record.operationId) {
        this.dependencies.storage?.removeItem(this.key);
      }
    } catch (error) {
      this.report(error);
    }
    this.dependencies.onConfirmed({ ...record });
  }

  private pump(): void {
    const record = this.record;
    if (
      !record ||
      this.inFlight ||
      this.timer !== null ||
      this.paused ||
      !this.dependencies.isAuthorized() ||
      !this.dependencies.isOnline()
    ) {
      return;
    }
    this.inFlight = record;
    void this.send(record);
  }

  private async send(record: PendingRematchEnd): Promise<void> {
    try {
      await this.dependencies.submit({ ...record });
      if (
        this.record === record &&
        !this.paused &&
        this.dependencies.isAuthorized()
      ) {
        this.confirm();
      }
    } catch (error) {
      if (this.record !== record || this.paused) return;
      this.report(error);
      if (!this.dependencies.isAuthorized() || shouldPause(error)) {
        this.paused = true;
        return;
      }
      const delayMs = retryDelay(
        error,
        codeOf(error) === "resource-exhausted"
          ? 60_000
          : Math.min(60_000, 1_000 * 2 ** Math.min(this.failures, 6)),
      );
      this.failures += 1;
      this.timer = (this.dependencies.setTimer || setTimeout)(() => {
        this.timer = null;
        this.pump();
      }, delayMs);
    } finally {
      this.inFlight = null;
      this.pump();
    }
  }

  private clearRetryTimer(): void {
    if (this.timer === null) return;
    (this.dependencies.clearTimer || clearTimeout)(this.timer);
    this.timer = null;
  }

  private report(error: unknown): void {
    this.dependencies.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
