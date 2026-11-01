import {
  SESSION_TIMESTAMP,
  resolveSessionCounter,
  resolveSessionTimestamp,
  sessionIncrement,
} from "../src/sessionValueOperations.ts";
import {
  encodeValue,
  requireKey,
  timestamp,
} from "../src/automatchD1/codec.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sessionValueOperationFixture(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sessionValueOperationFixture);
  if (!record(value)) return value;
  if (Object.keys(value).length === 1 && value[".sv"] === "timestamp")
    return SESSION_TIMESTAMP;
  const marker = value[".sv"];
  if (
    Object.keys(value).length === 1 &&
    record(marker) &&
    Object.keys(marker).length === 1 &&
    typeof marker.increment === "number"
  )
    return sessionIncrement(marker.increment);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sessionValueOperationFixture(child),
    ]),
  );
}

export function resolveHistoricalSessionValueFixture(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  timestamp(nowMs);
  const input = sessionValueOperationFixture(value);
  if (record(input) && input.kind === "timestamp")
    return resolveSessionTimestamp(SESSION_TIMESTAMP, nowMs);
  if (record(input) && input.kind === "increment")
    return resolveSessionCounter(
      sessionIncrement(Number(input.delta)),
      current,
    );
  if (Array.isArray(input))
    return input.map((child, index) =>
      resolveHistoricalSessionValueFixture(
        child,
        Array.isArray(current) ? current[index] : null,
        nowMs,
      ),
    );
  if (record(input))
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => {
        requireKey(key);
        return [
          key,
          resolveHistoricalSessionValueFixture(
            child,
            record(current) && Object.hasOwn(current, key)
              ? current[key]
              : null,
            nowMs,
          ),
        ];
      }),
    );
  encodeValue(input);
  return input;
}
