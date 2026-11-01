import {
  isAutomatchReceiptRecord,
  isGameSessionMutationReceiptRecord,
  type AutomatchReceiptView,
  type GameSessionMutationReceiptView,
} from "../../../runtime/automatchRecords.js";

export type ReceiptRead<T> =
  { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; value: T };
export function parseAutomatchReceipt(
  value: unknown,
): AutomatchReceiptView | null {
  return isAutomatchReceiptRecord(value) ? value : null;
}
export function parseGameSessionMutationReceipt(
  value: unknown,
): GameSessionMutationReceiptView | null {
  return isGameSessionMutationReceiptRecord(value) ? value : null;
}
function decodeReceipt<T>(
  value: unknown,
  parse: (input: unknown) => T | null,
): ReceiptRead<T> {
  if (value === null) return { kind: "missing" };
  const parsed = parse(value);
  return parsed === null
    ? { kind: "invalid" }
    : { kind: "valid", value: parsed };
}
export function decodeAutomatchReceipt(
  value: unknown,
): ReceiptRead<AutomatchReceiptView> {
  return decodeReceipt(value, parseAutomatchReceipt);
}
export function decodeGameSessionMutationReceipt(
  value: unknown,
): ReceiptRead<GameSessionMutationReceiptView> {
  return decodeReceipt(value, parseGameSessionMutationReceipt);
}
