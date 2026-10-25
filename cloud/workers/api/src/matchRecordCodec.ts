import type {
  SubmitMoveRequest,
  GameSessionMatch,
} from "@mons/shared/game-sessions";
import type { FreshMatchRecord } from "@mons/shared/match-protocol";
import { canonicalJson } from "./canonicalJson.ts";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";

declare const matchDocument: unique symbol;
declare const matchArrayDocument: unique symbol;

export type MatchDocument = { readonly [matchDocument]: true };
export type MatchArrayDocument = { readonly [matchArrayDocument]: true };
export type RetainedMatchValue =
  null | boolean | number | string | MatchDocument | MatchArrayDocument;

export type MatchWireValue =
  undefined | null | boolean | number | string | object;

type NormalizedMatchJson =
  | null
  | boolean
  | number
  | string
  | NormalizedMatchJson[]
  | { [key: string]: NormalizedMatchJson };

export type MatchStorageRead =
  | { kind: "missing" }
  | {
      kind: "stored";
      source: "durable" | "legacy";
      value: RetainedMatchValue;
    };

type SourceRecord = Record<string, unknown>;
const fields = (value: MatchDocument): SourceRecord =>
  value as object as SourceRecord;

export function readMatchDocument(value: unknown): MatchDocument | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as MatchDocument)
    : null;
}

export function readRetainedMatchValue(value: unknown): RetainedMatchValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value as object as MatchArrayDocument;
  const document = readMatchDocument(value);
  if (document) return document;
  throw new TypeError("match-state-invalid-json");
}

export function readStoredMatchJson(
  row: { value_json: string } | null | undefined,
  source: "durable" | "legacy",
): MatchStorageRead {
  if (!row) return { kind: "missing" };
  const value: unknown = JSON.parse(row.value_json);
  return { kind: "stored", source, value: readRetainedMatchValue(value) };
}

export function storedMatchValue(read: MatchStorageRead): RetainedMatchValue {
  return read.kind === "stored" ? read.value : null;
}

export function matchWireValue(value: RetainedMatchValue): MatchWireValue {
  return value;
}

export function canonicalMatchDocumentJson(value: unknown): string {
  return canonicalJson(value, () => {
    throw new TypeError("match-state-invalid-json");
  });
}

export type MoveMatchRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | {
      kind: "playable";
      document: MatchDocument;
      fen: string;
      flatMovesString: string;
    };

export function readMoveMatch(value: unknown): MoveMatchRead {
  if (value === null || value === undefined) return { kind: "missing" };
  const document = readMatchDocument(value);
  if (!document) return { kind: "invalid" };
  const record = fields(document);
  if (
    typeof record.fen !== "string" ||
    !record.fen ||
    (record.flatMovesString !== undefined &&
      typeof record.flatMovesString !== "string")
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "playable",
    document,
    fen: record.fen,
    flatMovesString: record.flatMovesString ?? "",
  };
}

export function writeMovedMatch(
  current: MatchDocument,
  request: Pick<SubmitMoveRequest, "gameVariant" | "fen" | "flatMovesString">,
): MatchDocument {
  const record = fields(current);
  const gameVariant =
    record.gameVariant === undefined || record.gameVariant === ""
      ? request.gameVariant
      : undefined;
  return readMatchDocument({
    ...record,
    ...(gameVariant ? { gameVariant } : {}),
    fen: request.fen,
    flatMovesString: request.flatMovesString,
  })!;
}

export function supersededMatchPosition(current: MatchDocument) {
  const record = fields(current);
  return {
    fen: String(record.fen),
    flatMovesString: String(record.flatMovesString),
  };
}

export function matchSurrenderState(value: RetainedMatchValue) {
  const record = value ? (Object(value) as SourceRecord) : {};
  return {
    exists: Boolean(value),
    surrendered: record.status === "surrendered",
  };
}

export function matchSurrenderHasFen(value: RetainedMatchValue): boolean {
  const record = value ? (Object(value) as SourceRecord) : {};
  return typeof record.fen === "string" && record.fen !== "";
}

export function writeSurrenderedMatch(
  value: RetainedMatchValue,
): MatchDocument {
  return readMatchDocument({ ...Object(value), status: "surrendered" })!;
}

export function matchesCreationMarker(
  value: RetainedMatchValue,
  marker: string,
): boolean {
  return (
    value !== null && Reflect.get(Object(value), "sessionCreation") === marker
  );
}

export function withMatchCreationMarker(
  value: MatchDocument,
  marker: string,
): MatchDocument {
  return readMatchDocument({ ...fields(value), sessionCreation: marker })!;
}

export function normalizeNewMatchDocument(value: MatchDocument): MatchDocument {
  const normalize = (entry: unknown): NormalizedMatchJson => {
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "object") {
      canonicalMatchDocumentJson(entry);
      if (
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        typeof entry === "string"
      )
        return entry;
      throw new TypeError("match-state-invalid-json");
    }
    const children = Object.entries(entry).flatMap(([key, child]) => {
      const normalized = normalize(child);
      return normalized === null ? [] : [[key, normalized] as const];
    });
    if (children.length === 0) return null;
    const maximum = children.reduce(
      (current, [key]) => Math.max(current, Number(key)),
      0,
    );
    if (
      children.every(([key]) => /^(0|[1-9]\d*)$/.test(key)) &&
      maximum < children.length * 2
    ) {
      const array: NormalizedMatchJson[] = Array(maximum + 1).fill(null);
      for (const [key, child] of children) array[Number(key)] = child;
      return array;
    }
    return Object.fromEntries(children);
  };
  const normalized = readMatchDocument(normalize(value));
  if (!normalized) throw new TypeError("match-state-invalid-creation");
  return normalized;
}

export function writeMatchTimer(
  value: MatchDocument,
  timer: string,
): MatchDocument {
  return readMatchDocument({ ...fields(value), timer })!;
}

export function writeRetainedMatchTerminalTimer(
  value: RetainedMatchValue,
): MatchDocument {
  return readMatchDocument({ ...Object(value), timer: MATCH_TIMER_TERMINAL })!;
}

export function matchTimerEquals(
  value: RetainedMatchValue,
  timer: string,
): boolean {
  return value !== null && Reflect.get(Object(value), "timer") === timer;
}

export type MatchCreationWrite = FreshMatchRecord<
  number | string,
  string | null,
  string,
  "white" | "black"
>;

export type MatchCreationInput =
  | { kind: "record"; document: MatchDocument }
  | { kind: "missing" }
  | { kind: "retained-invalid"; value: RetainedMatchValue };

export function createMatchCreationInput(
  value: MatchCreationWrite,
): MatchCreationInput {
  return { kind: "record", document: readMatchDocument(value)! };
}

export function createRestoredMatchCreationInput(
  value: GameSessionMatch,
): MatchCreationInput {
  return { kind: "record", document: readMatchDocument(value)! };
}

export function readMatchCreationInput(value: unknown): MatchCreationInput {
  if (value === undefined) return { kind: "missing" };
  const document = readMatchDocument(value);
  return document
    ? { kind: "record", document }
    : { kind: "retained-invalid", value: readRetainedMatchValue(value) };
}

export function matchCreationWireValue(value: MatchCreationInput): unknown {
  return value.kind === "missing"
    ? undefined
    : value.kind === "record"
      ? value.document
      : value.value;
}
