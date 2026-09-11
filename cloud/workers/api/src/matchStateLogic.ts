import {
  countMoveHistory,
  isMoveHistoryPrefix,
  type SubmitMoveRequest,
} from "@mons/shared/game-sessions";
import {
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} from "@mons/shared/match-protocol";
import {
  MATCH_TIMER_TERMINAL,
  parseStrictMatchTimer,
} from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import { isCanonicalLoginUid } from "./recordKeys.ts";
import type { MatchStateJson, MatchStateRecord } from "./matchStateTypes.ts";

export function matchStateRecord(value: unknown): MatchStateRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MatchStateRecord)
    : null;
}

export function normalizeCreatedMatchState(
  value: MatchStateRecord,
): MatchStateRecord {
  const normalize = (entry: unknown): MatchStateJson => {
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "object") {
      canonicalMatchStateJson(entry);
      return entry as MatchStateJson;
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
      const array: MatchStateJson[] = Array(maximum + 1).fill(null);
      for (const [key, child] of children) array[Number(key)] = child;
      return array;
    }
    return Object.fromEntries(children);
  };
  const normalized = matchStateRecord(normalize(value));
  if (!normalized) throw new TypeError("match-state-invalid-creation");
  return normalized;
}

export function decideMatchStateMove(
  value: unknown,
  request: SubmitMoveRequest,
): {
  outcome: "applied" | "already-applied" | "superseded";
  value: MatchStateRecord;
} {
  if (value === null || value === undefined) {
    throw new AuthApiFailure(404, "not-found", "match-not-found");
  }
  const match = matchStateRecord(value);
  if (
    !match ||
    typeof match.fen !== "string" ||
    !match.fen ||
    (match.flatMovesString !== undefined &&
      typeof match.flatMovesString !== "string")
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
  }
  const history = (match.flatMovesString ?? "") as string;
  if (
    request.previousStates &&
    (!isMatchFenWithinLimit(match.fen) || !isMatchHistoryWithinLimits(history))
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
  }
  if (history === request.flatMovesString && match.fen === request.fen) {
    return { outcome: "already-applied", value: match };
  }
  if (
    request.previousStates &&
    history !== request.flatMovesString &&
    isMoveHistoryPrefix(request.flatMovesString, history)
  ) {
    return { outcome: "superseded", value: match };
  }
  const previousState =
    request.previousStates?.[
      countMoveHistory(history) -
        countMoveHistory(request.previousFlatMovesString)
    ];
  const matchesPreviousState = request.previousStates
    ? isMoveHistoryPrefix(request.previousFlatMovesString, history) &&
      isMoveHistoryPrefix(history, request.flatMovesString) &&
      previousState?.fen === match.fen
    : history === request.previousFlatMovesString;
  if (!matchesPreviousState) {
    throw new AuthApiFailure(409, "aborted", "move-chain-conflict");
  }
  const gameVariant =
    match.gameVariant === undefined || match.gameVariant === ""
      ? request.gameVariant
      : undefined;
  return {
    outcome: "applied",
    value: {
      ...match,
      ...(gameVariant ? { gameVariant } : {}),
      fen: request.fen,
      flatMovesString: request.flatMovesString,
    },
  };
}

export function isCommittedMatchStateClaim(
  claim: MatchStateRecord,
  inviteId: string,
): boolean {
  const timer = parseStrictMatchTimer(claim.timer);
  return (
    claim.status === "claimed" &&
    claim.inviteId === inviteId &&
    isCanonicalLoginUid(claim.playerId) &&
    isCanonicalLoginUid(claim.opponentId) &&
    claim.playerId !== claim.opponentId &&
    Number.isSafeInteger(claim.turnNumber) &&
    (claim.turnNumber as number) >= 0 &&
    (claim.timer === MATCH_TIMER_TERMINAL ||
      timer?.turnNumber === claim.turnNumber) &&
    Number.isSafeInteger(claim.claimedAtMs) &&
    (claim.claimedAtMs as number) >= 0 &&
    claim.expiresAtMs == null
  );
}

export function canonicalMatchStateJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMatchStateJson).join(",")}]`;
  }
  const record = matchStateRecord(value);
  if (!record) throw new TypeError("match-state-invalid-json");
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalMatchStateJson(record[key])}`,
    )
    .join(",")}}`;
}

export async function digestMatchState(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalMatchStateJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
