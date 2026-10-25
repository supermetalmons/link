const trimmed = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

export function readWithdrawalRequest(value: unknown) {
  const fields =
    value && typeof value === "object"
      ? (value as {
          eventId?: unknown;
          prizeId?: unknown;
          solanaAddress?: unknown;
        })
      : {};
  return {
    eventId: trimmed(fields.eventId),
    prizeId: trimmed(fields.prizeId),
    solanaAddress: trimmed(fields.solanaAddress),
  };
}
