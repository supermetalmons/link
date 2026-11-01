import {
  isPlayerProfile,
  type CompletePlayerProfile,
} from "@mons/shared/profiles";
import {
  isEmojiId,
  type EmojiId,
  type ProfileAppearance,
} from "@mons/shared/appearance";
import { MATERIAL_KEYS, type MiningSnapshot } from "@mons/shared/mining";
import {
  isHistoricalMatchPair,
  type HistoricalMatchPair,
} from "@mons/shared/game-sessions";
import type { AuthErrorCode } from "../authErrors.ts";
import { CanonicalProfileCorruption } from "./types.ts";

export type StoredPlayerProfile = CompletePlayerProfile & {
  completedProblemIds: string[];
  feb2026UniqueOpponentsCount: number;
  isTutorialCompleted: boolean;
};

const PROFILE_KEYS = [
  "id",
  "nonce",
  "rating",
  "totalManaPoints",
  "win",
  "emoji",
  "aura",
  "cardBackgroundId",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
  "cardStickers",
  "username",
  "eth",
  "sol",
  "feb2026UniqueOpponentsCount",
  "completedProblemIds",
  "isTutorialCompleted",
  "mining",
] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CanonicalProfileCorruption();
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const row = object(value);
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  )
    throw new CanonicalProfileCorruption();
  return row;
}

function string(value: unknown, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.length) ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new CanonicalProfileCorruption();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new CanonicalProfileCorruption();
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new CanonicalProfileCorruption();
  return value;
}
function nullableFinite(value: unknown): number | null {
  return value === null ? null : finite(value);
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new CanonicalProfileCorruption();
  return value;
}
function nullableBoolean(value: unknown): boolean | null {
  return value === null ? null : boolean(value);
}

export function parseStoredMining(value: unknown): MiningSnapshot {
  const row = exact(value, ["lastRockDate", "materials"]);
  const lastRockDate = nullableString(row.lastRockDate);
  if (lastRockDate !== null) {
    const date = new Date(`${lastRockDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(lastRockDate) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== lastRockDate
    )
      throw new CanonicalProfileCorruption();
  }
  const materials = exact(row.materials, MATERIAL_KEYS);
  return {
    lastRockDate,
    materials: {
      dust: integer(materials.dust),
      slime: integer(materials.slime),
      gum: integer(materials.gum),
      metal: integer(materials.metal),
      ice: integer(materials.ice),
    },
  };
}

export function parseStoredPlayerProfile(value: unknown): StoredPlayerProfile {
  const row = exact(value, PROFILE_KEYS);
  if (!isPlayerProfile(value)) throw new CanonicalProfileCorruption();
  string(value.id);
  if (value.id.includes("/")) throw new CanonicalProfileCorruption();
  integer(value.nonce, -1);
  if (finite(value.rating) < 0) throw new CanonicalProfileCorruption();
  integer(value.totalManaPoints);
  nullableString(value.username);
  nullableString(value.eth);
  nullableString(value.sol);
  const completed = row.completedProblemIds;
  if (
    !Array.isArray(completed) ||
    completed.some((entry) => typeof entry !== "string") ||
    new Set(completed).size !== completed.length
  )
    throw new CanonicalProfileCorruption();
  const completedProblemIds = completed.map((entry: unknown) => string(entry));
  return {
    ...value,
    completedProblemIds,
    feb2026UniqueOpponentsCount: integer(row.feb2026UniqueOpponentsCount),
    isTutorialCompleted: boolean(row.isTutorialCompleted),
    mining: parseStoredMining(row.mining),
  };
}

export function createStoredPlayerProfile(
  profileId: string,
  appearance: ProfileAppearance,
  fields: Partial<
    Omit<StoredPlayerProfile, "id" | keyof ProfileAppearance>
  > = {},
): StoredPlayerProfile {
  return parseStoredPlayerProfile({
    id: profileId,
    ...appearance,
    nonce: -1,
    rating: 1500,
    totalManaPoints: 0,
    win: true,
    username: null,
    eth: null,
    sol: null,
    feb2026UniqueOpponentsCount: 0,
    completedProblemIds: [],
    isTutorialCompleted: false,
    mining: {
      lastRockDate: null,
      materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
    },
    ...fields,
  });
}

export function parseStoredGameplayEmoji(value: unknown): EmojiId {
  if (!isEmojiId(value)) throw new CanonicalProfileCorruption();
  return value;
}

export type VerifyOperationMetadata = {
  methodValue: string;
  methodValueHash: string;
  intentId: string | null;
};
export function parseVerifyOperationMetadata(
  value: unknown,
): VerifyOperationMetadata {
  const row = exact(value, ["methodValue", "methodValueHash", "intentId"]);
  const methodValueHash = string(row.methodValueHash);
  if (!/^[a-f0-9]{64}$/.test(methodValueHash))
    throw new CanonicalProfileCorruption();
  return {
    methodValue: string(row.methodValue),
    methodValueHash,
    intentId: nullableString(row.intentId),
  };
}

export type VerifyOperationReceipt = {
  schemaVersion: 1;
  kind: "verify";
  profileId: string;
  uid: string;
  opId: string;
};
export type UnlinkOperationReceipt = {
  schemaVersion: 1;
  kind: "unlink";
  profileId: string | null;
};
export type AuthOperationReceipt =
  VerifyOperationReceipt | UnlinkOperationReceipt;

export function parseAuthOperationReceipt(
  value: unknown,
): AuthOperationReceipt {
  const row = object(value);
  if (row.schemaVersion !== 1) throw new CanonicalProfileCorruption();
  if (row.kind === "verify") {
    exact(row, ["schemaVersion", "kind", "profileId", "uid", "opId"]);
    return {
      schemaVersion: 1,
      kind: "verify",
      profileId: string(row.profileId),
      uid: string(row.uid),
      opId: string(row.opId),
    };
  }
  if (row.kind === "unlink") {
    exact(row, ["schemaVersion", "kind", "profileId"]);
    return {
      schemaVersion: 1,
      kind: "unlink",
      profileId: nullableString(row.profileId),
    };
  }
  throw new CanonicalProfileCorruption();
}

const AUTH_ERRORS: Record<AuthErrorCode, true> = {
  aborted: true,
  "deadline-exceeded": true,
  "failed-precondition": true,
  internal: true,
  "invalid-argument": true,
  "method-not-allowed": true,
  "not-found": true,
  "permission-denied": true,
  "resource-exhausted": true,
  unauthenticated: true,
  unavailable: true,
};
export function parseStoredAuthErrorCode(value: unknown): AuthErrorCode {
  if (typeof value !== "string" || !Object.hasOwn(AUTH_ERRORS, value))
    throw new CanonicalProfileCorruption();
  return value as AuthErrorCode;
}

export type CanonicalRatingPayload = {
  schemaVersion: 1;
  eventId: string | null;
  eventOwned: boolean;
  isEventMatch: boolean;
  result: "gg" | "win" | null;
  canUpdateRatings: boolean | null;
  didApplyRatingDelta: boolean | null;
  winnerDisplayName: string | null;
  loserDisplayName: string | null;
  winnerNewRating: number | null;
  loserNewRating: number | null;
  playerManaPoints: number | null;
  opponentManaPoints: number | null;
  shouldUpdateFebruaryChallenge: boolean;
  updateRatingMessage: string | null;
  telegramDeliveryVersion: 2 | null;
  historicalMatchPair: HistoricalMatchPair | null;
  profileGameProjectionReason: string | null;
  telegramProjectionReason: string | null;
  eventProgressReason: string | null;
};

const RATING_PAYLOAD_KEYS = [
  "schemaVersion",
  "eventId",
  "eventOwned",
  "isEventMatch",
  "result",
  "canUpdateRatings",
  "didApplyRatingDelta",
  "winnerDisplayName",
  "loserDisplayName",
  "winnerNewRating",
  "loserNewRating",
  "playerManaPoints",
  "opponentManaPoints",
  "shouldUpdateFebruaryChallenge",
  "updateRatingMessage",
  "telegramDeliveryVersion",
  "historicalMatchPair",
  "profileGameProjectionReason",
  "telegramProjectionReason",
  "eventProgressReason",
] as const;

export function parseCanonicalRatingPayload(
  value: unknown,
): CanonicalRatingPayload {
  const row = exact(value, RATING_PAYLOAD_KEYS);
  if (
    row.schemaVersion !== 1 ||
    (row.result !== null && row.result !== "gg" && row.result !== "win") ||
    (row.telegramDeliveryVersion !== null &&
      row.telegramDeliveryVersion !== 2) ||
    (row.historicalMatchPair !== null &&
      !isHistoricalMatchPair(row.historicalMatchPair))
  )
    throw new CanonicalProfileCorruption();
  const eventId = nullableString(row.eventId),
    eventOwned = boolean(row.eventOwned),
    isEventMatch = boolean(row.isEventMatch);
  if (
    (eventOwned && (!isEventMatch || eventId === null)) ||
    (!isEventMatch && eventId !== null)
  )
    throw new CanonicalProfileCorruption();
  return {
    schemaVersion: 1,
    eventId,
    eventOwned,
    isEventMatch,
    result: row.result,
    canUpdateRatings: nullableBoolean(row.canUpdateRatings),
    didApplyRatingDelta: nullableBoolean(row.didApplyRatingDelta),
    winnerDisplayName: nullableString(row.winnerDisplayName),
    loserDisplayName: nullableString(row.loserDisplayName),
    winnerNewRating: nullableFinite(row.winnerNewRating),
    loserNewRating: nullableFinite(row.loserNewRating),
    playerManaPoints: nullableInteger(row.playerManaPoints),
    opponentManaPoints: nullableInteger(row.opponentManaPoints),
    shouldUpdateFebruaryChallenge: boolean(row.shouldUpdateFebruaryChallenge),
    updateRatingMessage: nullableString(row.updateRatingMessage),
    telegramDeliveryVersion: row.telegramDeliveryVersion,
    historicalMatchPair: row.historicalMatchPair,
    profileGameProjectionReason: nullableString(
      row.profileGameProjectionReason,
    ),
    telegramProjectionReason: nullableString(row.telegramProjectionReason),
    eventProgressReason: nullableString(row.eventProgressReason),
  };
}

export function createEmptyRatingPayload(): CanonicalRatingPayload {
  return {
    schemaVersion: 1,
    eventId: null,
    eventOwned: false,
    isEventMatch: false,
    result: null,
    canUpdateRatings: null,
    didApplyRatingDelta: null,
    winnerDisplayName: null,
    loserDisplayName: null,
    winnerNewRating: null,
    loserNewRating: null,
    playerManaPoints: null,
    opponentManaPoints: null,
    shouldUpdateFebruaryChallenge: false,
    updateRatingMessage: null,
    telegramDeliveryVersion: null,
    historicalMatchPair: null,
    profileGameProjectionReason: null,
    telegramProjectionReason: null,
    eventProgressReason: null,
  };
}
