import {
  parseAutomatchRecord,
  type AutomatchRecordMap,
} from "../../../../runtime/automatchRecords.js";
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
  if (!isSafeRecordKey(key) || key.trim() !== key) {
    throw new TypeError("invalid-automatch-key");
  }
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
    value: parseAutomatchValue(
      root,
      row.payload_json === null ? null : JSON.parse(row.payload_json),
    ),
    revision: row.revision,
  } as AutomatchRecordSnapshot<Root>;
}

export function parseAutomatchValue<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordValue<Root> {
  return parseAutomatchRecord(root, value);
}

export function createAutomatchMutation(
  current: {
    root: AutomatchRoot;
    key: string;
    revision: number;
    value: AutomatchRecordMap[AutomatchRoot] | null;
  },
  value: unknown,
): AutomatchRecordMutation {
  return {
    current: {
      ...current,
      value: parseAutomatchRecord(current.root, current.value),
    },
    value: parseAutomatchRecord(current.root, value),
  } as AutomatchRecordMutation;
}

export function isAutomatchRevisionConflict(error: unknown): boolean {
  return classifyD1Failure(error) === "automatch-conflict";
}
