"use strict";

const asCurrentValue = (value) => (value === undefined ? null : value);

const validateDecisionOutput = (output) => {
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

const runStateDecisionTransaction = async (reference, decide) => {
  if (!reference || typeof reference.transaction !== "function") {
    throw new TypeError("reference.transaction is required");
  }
  if (typeof decide !== "function") {
    throw new TypeError("transaction decision callback is required");
  }

  let finalOutput;
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

module.exports = {
  runStateDecisionTransaction,
};
