export type TelegramTransactionDecision =
  | { commit: false; decision?: string }
  | { commit: true; value: unknown; decision?: string };

export function validateTelegramTransactionDecision(
  output: unknown,
): TelegramTransactionDecision {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("Telegram transaction decision must be an object");
  }
  const candidate = output as {
    commit?: unknown;
    decision?: unknown;
    value?: unknown;
  };
  const hasValue = Object.hasOwn(output, "value");
  const decision =
    typeof candidate.decision === "string" ? candidate.decision : undefined;
  if (candidate.commit === false) {
    if (hasValue) {
      throw new TypeError("Telegram logical abort must not include value");
    }
    return { commit: false, decision };
  }
  if (Object.hasOwn(output, "commit")) {
    throw new TypeError("Telegram write decision must omit commit");
  }
  if (!hasValue || candidate.value === undefined) {
    throw new TypeError("Telegram write decision requires a defined value");
  }
  return { commit: true, value: candidate.value, decision };
}
