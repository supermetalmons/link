import { readProperty } from "./values.js";
import type { TelegramRepository } from "./deliveryEngine.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import { validateTelegramMessageKey } from "./desiredStateCore.js";
import { normalizeTimestamp } from "./deliveryPolicy.js";
export type TelegramStoredRecord = Record<string, unknown>;
export type TelegramTransactionResult = TransactionResult<TelegramStoredRecord>;
export type TelegramStorage = {
  readMessage(messageKey: string): Promise<TelegramStoredRecord | null>;
  transactMessage(
    messageKey: string,
    updater: (
      current: TelegramStoredRecord | null,
    ) => TransactionDecision<TelegramStoredRecord>,
  ): Promise<TelegramTransactionResult>;
  readControl(): Promise<TelegramStoredRecord | null>;
  transactControl(
    updater: (
      current: TelegramStoredRecord | null,
    ) => TransactionDecision<TelegramStoredRecord>,
  ): Promise<TelegramTransactionResult>;
};

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const omitKeys = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  const output = { ...asObject(value) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
};

const createTelegramRepository: (
  input: TelegramStorage,
) => TelegramRepository = ({
  readMessage,
  transactMessage,
  readControl,
  transactControl,
}) => {
  if (
    [readMessage, transactMessage, readControl, transactControl].some(
      (method) => typeof method !== "function",
    )
  ) {
    throw new TypeError("Telegram message and control operations are required");
  }
  return {
    async getMessage(messageKey) {
      return readMessage(validateTelegramMessageKey(messageKey));
    },
    async transactMessage(messageKey, updater) {
      return transactMessage(validateTelegramMessageKey(messageKey), updater);
    },
    async getRetryNotBeforeMs() {
      const value = Number((await readControl())?.retryNotBeforeMs);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    },
    async extendRetryNotBeforeMs(candidateMs) {
      const normalizedCandidate = Number(candidateMs);
      if (!Number.isFinite(normalizedCandidate) || normalizedCandidate <= 0) {
        throw new TypeError("retryNotBeforeMs must be a positive number");
      }
      const result = await transactControl((current) => {
        const control = asObject(current);
        const previous = Number(control.retryNotBeforeMs);
        return {
          value: {
            ...control,
            retryNotBeforeMs: Math.max(
              Number.isFinite(previous) && previous > 0
                ? Math.floor(previous)
                : 0,
              Math.floor(normalizedCandidate),
            ),
          },
          decision: "retry-barrier-extended",
        };
      });
      if (!result.committed) {
        const error = Object.assign(new Error("retry-barrier-not-persisted"), {
          code: "retry-barrier-not-persisted",
        });
        throw error;
      }
      const persistedMs = Number(result.value?.retryNotBeforeMs);
      if (!Number.isFinite(persistedMs) || persistedMs < normalizedCandidate) {
        const error = Object.assign(new Error("retry-barrier-invalid-result"), {
          code: "retry-barrier-invalid-result",
        });
        throw error;
      }
      return Math.floor(persistedMs);
    },
    async acquireApiGate(input) {
      const owner = normalizeString(input?.owner);
      const messageKey = validateTelegramMessageKey(input?.messageKey);
      const revision = normalizeString(input?.revision);
      const operation = normalizeString(input?.operation);
      const acquiredAtMs = normalizeTimestamp(input?.acquiredAtMs);
      const reclaimOwner = normalizeString(input?.reclaimOwner);
      if (!owner || !revision || !operation || !acquiredAtMs) {
        throw new TypeError("complete API gate identity is required");
      }
      let decision = "blocked";
      const result = await transactControl((current) => {
        const control = asObject(current);
        const retryNotBeforeMs = normalizeTimestamp(control.retryNotBeforeMs);
        if (retryNotBeforeMs > acquiredAtMs) {
          decision = "retry-after";
          return { commit: false, decision };
        }
        const currentGateOwner = normalizeString(
          readProperty(control.apiGate, "owner"),
        );
        if (
          currentGateOwner &&
          (currentGateOwner !== owner || reclaimOwner !== owner)
        ) {
          decision = "gate-held";
          return { commit: false, decision };
        }
        if (currentGateOwner === owner) {
          decision = "acquired";
          return { value: control, decision: "api-gate-reclaimed" };
        }
        decision = "acquired";
        return {
          value: {
            ...control,
            apiGate: {
              owner,
              messageKey,
              revision,
              operation,
              acquiredAtMs,
              ...(normalizeString(input?.taskGeneration)
                ? { taskGeneration: normalizeString(input.taskGeneration) }
                : {}),
              ...(normalizeString(input?.attemptId)
                ? { attemptId: normalizeString(input.attemptId) }
                : {}),
              ...(normalizeString(input?.pendingDeleteId)
                ? { pendingDeleteId: normalizeString(input.pendingDeleteId) }
                : {}),
            },
          },
          decision,
        };
      });
      const control = asObject(result.value);
      return {
        acquired: result.committed && decision === "acquired",
        reason: decision,
        retryNotBeforeMs: normalizeTimestamp(control.retryNotBeforeMs),
        gate: asObject(control.apiGate),
      };
    },
    async releaseApiGate(ownerInput) {
      const owner = normalizeString(ownerInput);
      if (!owner) {
        throw new TypeError("API gate owner is required");
      }
      let released = false;
      const result = await transactControl((current) => {
        const control = asObject(current);
        if (normalizeString(readProperty(control.apiGate, "owner")) !== owner) {
          return { commit: false, decision: "stale-api-gate-release" };
        }
        released = true;
        return {
          value: omitKeys(control, ["apiGate"]),
          decision: "api-gate-released",
        };
      });
      return result.committed && released;
    },
    async extendRetryBarrierAndReleaseApiGate({
      owner: ownerInput,
      retryNotBeforeMs: candidateInput,
    }) {
      const owner = normalizeString(ownerInput);
      const candidateMs = normalizeTimestamp(candidateInput);
      if (!owner || !candidateMs) {
        throw new TypeError("barrier proof owner and deadline are required");
      }
      let applied = false;
      const result = await transactControl((current) => {
        const control = asObject(current);
        const gateOwner = normalizeString(
          readProperty(control.apiGate, "owner"),
        );
        const currentMs = normalizeTimestamp(control.retryNotBeforeMs);
        if (gateOwner && gateOwner !== owner) {
          return { commit: false, decision: "stale-barrier-proof" };
        }
        if (!gateOwner && currentMs < candidateMs) {
          return { commit: false, decision: "missing-barrier-proof-gate" };
        }
        applied = true;
        return {
          value: {
            ...omitKeys(control, ["apiGate"]),
            retryNotBeforeMs: Math.max(currentMs, candidateMs),
          },
          decision: "barrier-proof-applied",
        };
      });
      const control = asObject(result.value);
      return {
        applied: result.committed && applied,
        retryNotBeforeMs: normalizeTimestamp(control.retryNotBeforeMs),
        gate: asObject(control.apiGate),
      };
    },
  };
};

export { createTelegramRepository };
