export type RandomSource = () => number;

export type PlayerColor = "white" | "black";

export type AutoInviteId = `${typeof AUTO_INVITE_PREFIX}${string}`;

const ALPHANUMERIC_CHARACTERS: string =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const AUTO_INVITE_PREFIX = "auto_";
const INVITE_ID_RANDOM_LENGTH = 11;
const MAX_RECORD_KEY_BYTES = 768;
const INVALID_RECORD_KEY_CHARACTERS = ".#$[]/";

function normalizeRecordKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  const hasInvalidCharacter = Array.from(normalized).some((character) => {
    const code = character.codePointAt(0) || 0;
    return (
      code <= 0x1f ||
      code === 0x7f ||
      INVALID_RECORD_KEY_CHARACTERS.includes(character)
    );
  });
  if (
    !normalized ||
    new TextEncoder().encode(normalized).byteLength > MAX_RECORD_KEY_BYTES ||
    hasInvalidCharacter
  ) {
    return null;
  }
  return normalized;
}

function isSafeRecordKey(value: unknown): value is string {
  return normalizeRecordKey(value) !== null;
}

function randomAlphanumeric(
  length: number,
  random: RandomSource = Math.random,
): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHANUMERIC_CHARACTERS.charAt(
      Math.floor(random() * ALPHANUMERIC_CHARACTERS.length),
    );
  }
  return value;
}

function isAutoInviteId(value: unknown): value is AutoInviteId {
  return typeof value === "string" && value.startsWith(AUTO_INVITE_PREFIX);
}

function buildAutoInviteId(random: RandomSource = Math.random): AutoInviteId {
  return `${AUTO_INVITE_PREFIX}${randomAlphanumeric(
    INVITE_ID_RANDOM_LENGTH,
    random,
  )}`;
}

function pickHostColor(random: RandomSource = Math.random): PlayerColor {
  return random() < 0.5 ? "white" : "black";
}

function computeHash32(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function createSeededRandom(seedValue: string): RandomSource {
  let state = computeHash32(seedValue) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(
  items: readonly T[],
  random: RandomSource = Math.random,
): T[] {
  const next = items.slice();
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

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
