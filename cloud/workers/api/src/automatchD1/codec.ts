import {
  evaluateStateValueMarker,
  STATE_VALUE_FIELD,
} from "../stateCompatibility.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import { classifyD1Failure } from "../d1Failure.ts";
import { validateStoredJson } from "../jsonValidation.ts";
import {
  AUTOMATCH_RECORD_TABLES,
  AutomatchD1Failure,
  type AutomatchRoot,
  type AutomatchRecordSnapshot,
  type RecordRow,
  type AutomatchRecordValue,
  type AutomatchRecordMutation,
} from "./types.ts";

export function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("invalid-automatch-timestamp");
  }
  return value;
}

export function requireRoot(root: AutomatchRoot) {
  if (!Object.hasOwn(AUTOMATCH_RECORD_TABLES, root)) {
    throw new TypeError("invalid-automatch-root");
  }
  return AUTOMATCH_RECORD_TABLES[root];
}

export function requireKey(key: string): void {
  if (!isSafeRecordKey(key)) {
    throw new TypeError("invalid-automatch-key");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateAutomatchJson(value: unknown): void {
  validateStoredJson(value, "invalid-automatch-json");
}

export function encodeValue(value: unknown): string | null {
  validateAutomatchJson(value);
  return value === null ? null : JSON.stringify(value);
}

export function decodeSnapshot<Root extends AutomatchRoot>(
  root: Root,
  row: RecordRow,
): AutomatchRecordSnapshot<Root> {
  requireKey(row.record_key);
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new AutomatchD1Failure("automatch-record-corrupt");
  }
  return {
    root,
    key: row.record_key,
    value: retainAutomatchValue(
      root,
      row.payload_json === null ? null : JSON.parse(row.payload_json),
    ),
    revision: row.revision,
  } as AutomatchRecordSnapshot<Root>;
}

export function retainAutomatchValue<Root extends AutomatchRoot>(
  _root: Root,
  value: unknown,
): AutomatchRecordValue<Root> {
  return value as AutomatchRecordValue<Root>;
}

export function retainAutomatchMutation(
  current: AutomatchRecordSnapshot,
  value: unknown,
): AutomatchRecordMutation {
  return { current, value } as AutomatchRecordMutation;
}

export function isAutomatchRevisionConflict(error: unknown): boolean {
  return classifyD1Failure(error) === "automatch-conflict";
}

export function nestedValue(value: unknown, parts: readonly string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    ) {
      return null;
    }
    current = Reflect.get(current, part);
  }
  return structuredClone(current);
}

export function setNested(
  value: unknown,
  parts: readonly string[],
  next: unknown,
): unknown {
  if (!parts.length) return next;
  const entries =
    value !== null && typeof value === "object" ? Object.entries(value) : [];
  const result = Object.fromEntries(entries);
  const [key, ...rest] = parts;
  const child = setNested(
    Object.hasOwn(result, key) ? result[key] : null,
    rest,
    next,
  );
  if (child === null) delete result[key];
  else
    Object.defineProperty(result, key, {
      value: child,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  if (!Object.keys(result).length) return null;
  return result;
}

export function resolveAutomatchServerValues(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  timestamp(nowMs);
  if (record(value) && Object.hasOwn(value, STATE_VALUE_FIELD)) {
    if (Object.keys(value).length !== 1)
      throw new TypeError("invalid-automatch-server-value");
    const result = evaluateStateValueMarker(
      value[STATE_VALUE_FIELD],
      current,
      nowMs,
    );
    if (result.ok) return result.value;
    if (result.reason === "increment-overflow")
      throw new TypeError("invalid-automatch-increment");
    throw new TypeError("invalid-automatch-server-value");
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      resolveAutomatchServerValues(
        entry,
        nestedValue(current, [String(index)]),
        nowMs,
      ),
    );
  }
  if (record(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        requireKey(key);
        return [
          key,
          resolveAutomatchServerValues(
            entry,
            nestedValue(current, [key]),
            nowMs,
          ),
        ];
      }),
    );
  }
  encodeValue(value);
  return value;
}
