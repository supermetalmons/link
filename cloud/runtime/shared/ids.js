// Generated from src/shared/ids.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_RECORD_KEY_BYTES =
  exports.INVITE_ID_RANDOM_LENGTH =
  exports.AUTO_INVITE_PREFIX =
  exports.ALPHANUMERIC_CHARACTERS =
    void 0;
exports.buildAutoInviteId = buildAutoInviteId;
exports.computeHash32 = computeHash32;
exports.createSeededRandom = createSeededRandom;
exports.isAutoInviteId = isAutoInviteId;
exports.isSafeRecordKey = isSafeRecordKey;
exports.normalizeRecordKey = normalizeRecordKey;
exports.pickHostColor = pickHostColor;
exports.randomAlphanumeric = randomAlphanumeric;
exports.shuffle = shuffle;
const ALPHANUMERIC_CHARACTERS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
exports.ALPHANUMERIC_CHARACTERS = ALPHANUMERIC_CHARACTERS;
const AUTO_INVITE_PREFIX = "auto_";
exports.AUTO_INVITE_PREFIX = AUTO_INVITE_PREFIX;
const INVITE_ID_RANDOM_LENGTH = 11;
exports.INVITE_ID_RANDOM_LENGTH = INVITE_ID_RANDOM_LENGTH;
const MAX_RECORD_KEY_BYTES = 768;
exports.MAX_RECORD_KEY_BYTES = MAX_RECORD_KEY_BYTES;
const INVALID_RECORD_KEY_CHARACTERS = ".#$[]/";
function normalizeRecordKey(value) {
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
function isSafeRecordKey(value) {
  return normalizeRecordKey(value) !== null;
}
function randomAlphanumeric(length, random = Math.random) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHANUMERIC_CHARACTERS.charAt(
      Math.floor(random() * ALPHANUMERIC_CHARACTERS.length),
    );
  }
  return value;
}
function isAutoInviteId(value) {
  return typeof value === "string" && value.startsWith(AUTO_INVITE_PREFIX);
}
function buildAutoInviteId(random = Math.random) {
  return `${AUTO_INVITE_PREFIX}${randomAlphanumeric(INVITE_ID_RANDOM_LENGTH, random)}`;
}
function pickHostColor(random = Math.random) {
  return random() < 0.5 ? "white" : "black";
}
function computeHash32(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
function createSeededRandom(seedValue) {
  let state = computeHash32(seedValue) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(items, random = Math.random) {
  const next = items.slice();
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}
