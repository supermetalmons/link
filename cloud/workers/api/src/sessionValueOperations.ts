import type {
  SessionCounter,
  SessionIncrementOperation,
  SessionTimestamp,
  SessionTimestampOperation,
} from "../../../runtime/automatchRecords.js";

export const SESSION_TIMESTAMP: SessionTimestampOperation = Object.freeze({
  kind: "timestamp",
});

export function sessionIncrement(delta: number): SessionIncrementOperation {
  if (!Number.isFinite(delta))
    throw new TypeError("State increment must be finite");
  return { kind: "increment", delta };
}

function operation(
  value: unknown,
  kind: string,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    "kind" in value &&
    value.kind === kind
  );
}

export function resolveSessionTimestamp(
  value: SessionTimestamp,
  nowMs: number,
): number {
  if (typeof value === "number") return value;
  if (!operation(value, "timestamp", ["kind"]))
    throw new TypeError("invalid-automatch-server-value");
  return nowMs;
}

export function resolveSessionCounter(
  value: SessionCounter,
  current: unknown,
): number {
  if (typeof value === "number") return value;
  if (
    !operation(value, "increment", ["kind", "delta"]) ||
    typeof value.delta !== "number" ||
    !Number.isFinite(value.delta)
  )
    throw new TypeError("invalid-automatch-server-value");
  const next =
    (typeof current === "number" && Number.isFinite(current) ? current : 0) +
    value.delta;
  if (!Number.isFinite(next))
    throw new TypeError("invalid-automatch-increment");
  return next;
}
