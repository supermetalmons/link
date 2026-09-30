// Generated from src/shared/ids.ts. Run npm run generate:runtime.
export type RandomSource = () => number;
export type PlayerColor = "white" | "black";
export type AutoInviteId = `${typeof AUTO_INVITE_PREFIX}${string}`;
declare const ALPHANUMERIC_CHARACTERS: string;
declare const AUTO_INVITE_PREFIX = "auto_";
declare const INVITE_ID_RANDOM_LENGTH = 11;
declare const MAX_RECORD_KEY_BYTES = 768;
declare function normalizeRecordKey(value: unknown): string | null;
declare function isSafeRecordKey(value: unknown): value is string;
declare function randomAlphanumeric(
  length: number,
  random?: RandomSource,
): string;
declare function isAutoInviteId(value: unknown): value is AutoInviteId;
declare function buildAutoInviteId(random?: RandomSource): AutoInviteId;
declare function pickHostColor(random?: RandomSource): PlayerColor;
declare function computeHash32(value: string): number;
declare function createSeededRandom(seedValue: string): RandomSource;
declare function shuffle<T>(items: readonly T[], random?: RandomSource): T[];
export {
  ALPHANUMERIC_CHARACTERS,
  AUTO_INVITE_PREFIX,
  INVITE_ID_RANDOM_LENGTH,
  MAX_RECORD_KEY_BYTES,
  buildAutoInviteId,
  computeHash32,
  createSeededRandom,
  isAutoInviteId,
  isSafeRecordKey,
  normalizeRecordKey,
  pickHostColor,
  randomAlphanumeric,
  shuffle,
};
