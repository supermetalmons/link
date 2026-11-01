"use strict";
/**
 * @template Value
 * @typedef {{transaction(update: (current: Value | null | undefined) => Value | null | undefined): Promise<{committed?: boolean, value?: Value | null}>}} LegacyReference
 */
/**
 * @template Value, Decision
 * @typedef {{committed: boolean, storageCommitted: boolean, decision: Decision | undefined, value: Value | null}} LegacyTransactionResult
 */
/** @param {unknown} value */
const asCurrentValue = (value) => (value === undefined ? null : value);
/** @param {unknown} input */
const validateDecisionOutput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("State transaction decision must return an object");
  }
  const output = /** @type {Record<string, unknown>} */ (input);
  const hasValue = Object.hasOwn(output, "value");
  if (output.commit === false) {
    if (hasValue) {
      throw new TypeError("State logical abort must not include value");
    }
    return { commit: /** @type {const} */ (false), decision: output.decision };
  }
  if (Object.hasOwn(output, "commit")) {
    throw new TypeError("State write decision must omit commit");
  }
  if (!hasValue || output.value === undefined) {
    throw new TypeError("State write decision requires a defined value");
  }
  return {
    commit: /** @type {const} */ (true),
    value: output.value,
    decision: output.decision,
  };
};
/**
 * @template Value
 * @overload
 * @param {LegacyReference<Value>} reference
 * @param {(current: Value | null) => import("../runtime/transactions").TransactionDecision<Value>} decide
 * @returns {Promise<LegacyTransactionResult<Value, string>>}
 */
/**
 * @overload
 * @param {LegacyReference<unknown>} reference
 * @param {(current: unknown) => unknown} decide
 * @returns {Promise<LegacyTransactionResult<unknown, unknown>>}
 */
/**
 * @param {LegacyReference<unknown>} reference
 * @param {(current: unknown) => unknown} decide
 */
const runStateDecisionTransaction = async (reference, decide) => {
  if (!reference || typeof reference.transaction !== "function") {
    throw new TypeError("reference.transaction is required");
  }
  if (typeof decide !== "function") {
    throw new TypeError("transaction decision callback is required");
  }
  /** @type {{finalOutput?: ReturnType<typeof validateDecisionOutput>}} */
  const state = {};
  const result = await reference.transaction((current) => {
    const normalizedCurrent = asCurrentValue(current);
    const finalOutput = validateDecisionOutput(decide(normalizedCurrent));
    state.finalOutput = finalOutput;
    return finalOutput.commit === false ? normalizedCurrent : finalOutput.value;
  });
  const storageCommitted = result?.committed === true;
  const committed = storageCommitted && state.finalOutput?.commit === true;
  return {
    committed,
    storageCommitted,
    decision: state.finalOutput?.decision,
    value: result?.value ?? null,
  };
};
module.exports = { runStateDecisionTransaction, EVENT_LOCK_ROOT: "eventLocks" };
