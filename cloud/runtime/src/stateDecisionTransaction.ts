import type { TransactionDecision } from "./transactions.js";

const asCurrentValue = <T>(value: T | undefined) =>
  value === undefined ? null : value;

type DecisionOutput<T> =
  | { commit: false; decision?: string }
  | { commit: true; value: T | null; decision?: string };

const validateDecisionOutput = <T>(
  input: TransactionDecision<T>,
): DecisionOutput<T> => {
  const output = input as {
    commit?: unknown;
    value?: T | null;
    decision?: string;
  };
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("State transaction decision must return an object");
  }
  const hasValue = Object.hasOwn(output, "value");
  if (output.commit === false) {
    if (hasValue) {
      throw new TypeError("State logical abort must not include value");
    }
    return { commit: false, decision: output.decision };
  }
  if (Object.hasOwn(output, "commit")) {
    throw new TypeError("State write decision must omit commit");
  }
  if (!hasValue || output.value === undefined) {
    throw new TypeError("State write decision requires a defined value");
  }
  return {
    commit: true,
    value: output.value,
    decision: output.decision,
  };
};

export type StateTransactionReference<T> = {
  transaction(
    update: (current: T | null | undefined) => T | null,
  ): Promise<{ committed?: boolean; value?: T | null } | null | undefined>;
};

export const runStateDecisionTransaction = async <T>(
  reference: StateTransactionReference<T>,
  decide: (current: T | null) => TransactionDecision<T>,
) => {
  if (!reference || typeof reference.transaction !== "function") {
    throw new TypeError("reference.transaction is required");
  }
  if (typeof decide !== "function") {
    throw new TypeError("transaction decision callback is required");
  }

  let finalOutput: DecisionOutput<T> | undefined;
  const result = await reference.transaction((current) => {
    const normalizedCurrent = asCurrentValue(current);
    finalOutput = validateDecisionOutput(decide(normalizedCurrent));
    return finalOutput.commit === false ? normalizedCurrent : finalOutput.value;
  });
  const storageCommitted = result?.committed === true;
  const committed = storageCommitted && finalOutput?.commit === true;
  return {
    committed,
    storageCommitted,
    decision: finalOutput?.decision,
    value: result?.value ?? null,
  };
};
