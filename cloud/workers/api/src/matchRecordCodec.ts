import {
  isGameSessionMatch,
  type SubmitMoveRequest,
  type GameSessionMatch,
} from "@mons/shared/game-sessions";
import type { FreshMatchRecord } from "@mons/shared/match-protocol";
import type { Aura, EmojiId } from "@mons/shared/appearance";
import { isReaction, type Reaction } from "@mons/shared/reactions";
import { canonicalJson } from "./canonicalJson.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  MATCH_TIMER_TERMINAL,
  isMatchTimer,
  matchTimersEqual,
  type MatchTimer,
} from "@mons/shared/timers";

export type MatchDocument = GameSessionMatch & {
  sessionCreation: string | null;
  reaction: Reaction | null;
};
export type RetainedMatchValue = MatchDocument | null;
export type MatchWireValue = RetainedMatchValue;
export type MatchStorageRead =
  | { kind: "missing" }
  | { kind: "stored"; source: "durable" | "archive"; value: MatchDocument };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function marker(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    isSafeRecordKey(value)
  );
}

export function readMatchDocument(value: unknown): MatchDocument | null {
  if (
    !record(value) ||
    !Object.hasOwn(value, "sessionCreation") ||
    !Object.hasOwn(value, "reaction")
  )
    return null;
  const { sessionCreation, reaction, ...match } = value;
  if (
    !(sessionCreation === null || marker(sessionCreation)) ||
    !(reaction === null || isReaction(reaction)) ||
    !isGameSessionMatch(match)
  )
    return null;
  return { ...match, sessionCreation, reaction };
}

export function readRetainedMatchValue(value: unknown): RetainedMatchValue {
  if (value === null) return null;
  const match = readMatchDocument(value);
  if (!match) throw new TypeError("match-state-invalid-record");
  return match;
}

export function readStoredMatchJson(
  row: { value_json: string } | null | undefined,
  source: "durable" | "archive",
): MatchStorageRead {
  if (!row) return { kind: "missing" };
  const value: unknown = JSON.parse(row.value_json);
  const match = readMatchDocument(value);
  if (!match) throw new TypeError("match-state-invalid-record");
  return { kind: "stored", source, value: match };
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
  return document
    ? {
        kind: "playable",
        document,
        fen: document.fen,
        flatMovesString: document.flatMovesString,
      }
    : { kind: "invalid" };
}

export function writeMovedMatch(
  current: MatchDocument,
  request: Pick<SubmitMoveRequest, "gameVariant" | "fen" | "flatMovesString">,
): MatchDocument {
  if (
    request.gameVariant !== undefined &&
    current.gameVariant !== request.gameVariant
  )
    throw new TypeError("match-state-game-variant-conflict");
  return requireMatchDocument({
    ...current,
    fen: request.fen,
    flatMovesString: request.flatMovesString,
  });
}

export function supersededMatchPosition(current: MatchDocument) {
  return { fen: current.fen, flatMovesString: current.flatMovesString };
}

export function matchSurrenderState(value: RetainedMatchValue) {
  return {
    exists: value !== null,
    surrendered: value?.status === "surrendered",
  };
}

export function matchSurrenderHasFen(value: RetainedMatchValue): boolean {
  return value !== null && value.fen !== "";
}

export function writeSurrenderedMatch(
  value: RetainedMatchValue,
): MatchDocument {
  if (!value) throw new TypeError("match-state-record-missing");
  return { ...value, status: "surrendered" };
}

export function matchesCreationMarker(
  value: RetainedMatchValue,
  creationMarker: string,
): boolean {
  return value?.sessionCreation === creationMarker;
}

export function withMatchCreationMarker(
  value: MatchDocument,
  creationMarker: string,
): MatchDocument {
  if (!marker(creationMarker))
    throw new TypeError("match-state-invalid-marker");
  return { ...value, sessionCreation: creationMarker };
}

function requireMatchDocument(value: unknown): MatchDocument {
  const match = readMatchDocument(value);
  if (!match) throw new TypeError("match-state-invalid-record");
  return match;
}

export function normalizeNewMatchDocument(value: MatchDocument): MatchDocument {
  return structuredClone(requireMatchDocument(value));
}

export function writeMatchTimer(
  value: MatchDocument,
  timer: MatchTimer,
): MatchDocument {
  if (!isMatchTimer(timer)) throw new TypeError("match-state-invalid-timer");
  return { ...value, timer: structuredClone(timer) };
}

export function writeRetainedMatchTerminalTimer(
  value: RetainedMatchValue,
): MatchDocument {
  if (!value) throw new TypeError("match-state-record-missing");
  return writeMatchTimer(value, MATCH_TIMER_TERMINAL);
}

export function matchTimerEquals(
  value: RetainedMatchValue,
  timer: MatchTimer,
): boolean {
  return value !== null && matchTimersEqual(value.timer, timer);
}

export type MatchCreationWrite = FreshMatchRecord<
  EmojiId,
  Aura,
  string,
  "white" | "black"
>;
export type MatchCreationInput = { kind: "record"; document: MatchDocument };

export function createMatchCreationInput(
  value: MatchCreationWrite,
): MatchCreationInput {
  return readMatchCreationInput(value);
}

export function createRestoredMatchCreationInput(
  value: GameSessionMatch,
): MatchCreationInput {
  return readMatchCreationInput(value);
}

export function readMatchCreationInput(value: unknown): MatchCreationInput {
  const document =
    readMatchDocument(value) ??
    (isGameSessionMatch(value)
      ? { ...value, sessionCreation: null, reaction: null }
      : null);
  if (!document) throw new TypeError("match-state-invalid-creation");
  return { kind: "record", document };
}

export function matchCreationWireValue(
  value: MatchCreationInput,
): MatchDocument {
  return value.document;
}
