"use strict";

const asCurrentValue = (value) => (value === undefined ? null : value);

const validateDecisionOutput = (output) => {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("RTDB transaction decision must return an object");
  }
  const hasValue = Object.hasOwn(output, "value");
  if (output.commit === false) {
    if (hasValue) {
      throw new TypeError("RTDB logical abort must not include value");
    }
    return { commit: false, decision: output.decision };
  }
  if (Object.hasOwn(output, "commit")) {
    throw new TypeError("RTDB write decision must omit commit");
  }
  if (!hasValue || output.value === undefined) {
    throw new TypeError("RTDB write decision requires a defined value");
  }
  return {
    commit: true,
    value: output.value,
    decision: output.decision,
  };
};

const runRtdbDecisionTransaction = async (reference, decide) => {
  if (!reference || typeof reference.transaction !== "function") {
    throw new TypeError("reference.transaction is required");
  }
  if (typeof decide !== "function") {
    throw new TypeError("transaction decision callback is required");
  }

  let finalOutput;
  const result = await reference.transaction(
    (current) => {
      const normalizedCurrent = asCurrentValue(current);
      finalOutput = validateDecisionOutput(decide(normalizedCurrent));
      return finalOutput.commit === false
        ? normalizedCurrent
        : finalOutput.value;
    },
    undefined,
    false,
  );
  const sdkCommitted = result?.committed === true;
  const committed = sdkCommitted && finalOutput?.commit === true;
  const snapshot = result?.snapshot;
  return {
    committed,
    sdkCommitted,
    decision: finalOutput?.decision,
    value:
      snapshot && typeof snapshot.exists === "function" && snapshot.exists()
        ? snapshot.val()
        : null,
  };
};

module.exports = {
  runRtdbDecisionTransaction,
};
