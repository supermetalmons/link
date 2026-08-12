"use strict";

const admin = require("../firebaseAdmin");
const { runRtdbDecisionTransaction } = require("../rtdbDecisionTransaction");
const {
  TELEGRAM_MESSAGE_ROOT,
  validateTelegramMessageKey,
} = require("./desiredState");
const { normalizeTimestamp } = require("./deliveryPolicy");

const TELEGRAM_DELIVERY_CONTROL_ROOT = "telegramDeliveryControl";

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const omitKeys = (value, keys) => {
  const output = { ...asObject(value) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
};

const createFirebaseTelegramRepository = (database = admin.database()) => ({
  async getMessage(messageKey) {
    const snapshot = await database
      .ref(`${TELEGRAM_MESSAGE_ROOT}/${validateTelegramMessageKey(messageKey)}`)
      .once("value");
    return snapshot.exists() ? snapshot.val() : null;
  },
  async transactMessage(messageKey, updater) {
    return runRtdbDecisionTransaction(
      database.ref(
        `${TELEGRAM_MESSAGE_ROOT}/${validateTelegramMessageKey(messageKey)}`,
      ),
      updater,
    );
  },
  async getRetryNotBeforeMs() {
    const snapshot = await database
      .ref(`${TELEGRAM_DELIVERY_CONTROL_ROOT}/retryNotBeforeMs`)
      .once("value");
    const value = Number(snapshot.val());
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  },
  async extendRetryNotBeforeMs(candidateMs) {
    const normalizedCandidate = Number(candidateMs);
    if (!Number.isFinite(normalizedCandidate) || normalizedCandidate <= 0) {
      throw new TypeError("retryNotBeforeMs must be a positive number");
    }
    const result = await database
      .ref(`${TELEGRAM_DELIVERY_CONTROL_ROOT}/retryNotBeforeMs`)
      .transaction(
        (current) => {
          const currentMs = Number(current);
          return Math.max(
            Number.isFinite(currentMs) && currentMs > 0
              ? Math.floor(currentMs)
              : 0,
            Math.floor(normalizedCandidate),
          );
        },
        undefined,
        false,
      );
    if (!result.committed) {
      const error = new Error("retry-barrier-not-persisted");
      error.code = "retry-barrier-not-persisted";
      throw error;
    }
    const persistedMs = Number(result.snapshot.val());
    if (!Number.isFinite(persistedMs) || persistedMs < normalizedCandidate) {
      const error = new Error("retry-barrier-invalid-result");
      error.code = "retry-barrier-invalid-result";
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
    const result = await runRtdbDecisionTransaction(
      database.ref(TELEGRAM_DELIVERY_CONTROL_ROOT),
      (current) => {
        const control = asObject(current);
        const retryNotBeforeMs = normalizeTimestamp(control.retryNotBeforeMs);
        if (retryNotBeforeMs > acquiredAtMs) {
          decision = "retry-after";
          return { commit: false, decision };
        }
        const currentGateOwner = normalizeString(control.apiGate?.owner);
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
                ? {
                    pendingDeleteId: normalizeString(input.pendingDeleteId),
                  }
                : {}),
            },
          },
          decision,
        };
      },
    );
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
    const result = await runRtdbDecisionTransaction(
      database.ref(TELEGRAM_DELIVERY_CONTROL_ROOT),
      (current) => {
        const control = asObject(current);
        if (normalizeString(control.apiGate?.owner) !== owner) {
          return { commit: false, decision: "stale-api-gate-release" };
        }
        released = true;
        return {
          value: omitKeys(control, ["apiGate"]),
          decision: "api-gate-released",
        };
      },
    );
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
    const result = await runRtdbDecisionTransaction(
      database.ref(TELEGRAM_DELIVERY_CONTROL_ROOT),
      (current) => {
        const control = asObject(current);
        const gateOwner = normalizeString(control.apiGate?.owner);
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
      },
    );
    const control = asObject(result.value);
    return {
      applied: result.committed && applied,
      retryNotBeforeMs: normalizeTimestamp(control.retryNotBeforeMs),
      gate: asObject(control.apiGate),
    };
  },
});

module.exports = {
  TELEGRAM_DELIVERY_CONTROL_ROOT,
  createFirebaseTelegramRepository,
};
