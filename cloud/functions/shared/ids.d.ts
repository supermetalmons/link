export const ALPHANUMERIC_CHARACTERS: string;
export const AUTO_INVITE_PREFIX: "auto_";
export const INVITE_ID_RANDOM_LENGTH: 11;
export const MAX_FIREBASE_KEY_BYTES: 768;

export type RandomSource = () => number;
export type PlayerColor = "white" | "black";
export type AutoInviteId = `${typeof AUTO_INVITE_PREFIX}${string}`;

export function randomAlphanumeric(
  length: number,
  random?: RandomSource,
): string;
export function buildAutoInviteId(random?: RandomSource): AutoInviteId;
export function isAutoInviteId(value: unknown): value is AutoInviteId;
export function isSafeFirebaseKey(value: unknown): value is string;
export function normalizeFirebaseKey(value: unknown): string | null;
export function pickHostColor(random?: RandomSource): PlayerColor;
export function computeHash32(value: string): number;
export function createSeededRandom(seedValue: string): RandomSource;
export function shuffle<T>(items: readonly T[], random?: RandomSource): T[];
