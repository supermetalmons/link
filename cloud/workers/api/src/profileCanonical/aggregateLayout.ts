import { CanonicalProfileCorruption } from "./types.ts";
export const CANONICAL_PROFILE_AGGREGATE_PARTS = [
  "profile",
  "loginOwners",
  "authMethods",
  "februaryOpponentProfileIds",
  "mergeTarget",
  "recovery",
] as const;

export type CanonicalProfileAggregatePart =
  (typeof CANONICAL_PROFILE_AGGREGATE_PARTS)[number];

export type CanonicalProfileAggregateParts<T> = Record<
  CanonicalProfileAggregatePart,
  T
>;

export function canonicalProfileAggregateValues<T>(
  parts: CanonicalProfileAggregateParts<T>,
): T[] {
  return CANONICAL_PROFILE_AGGREGATE_PARTS.map((part) => parts[part]);
}

export function canonicalProfileAggregatePart<T>(
  values: readonly T[],
  part: CanonicalProfileAggregatePart,
): T {
  const index = CANONICAL_PROFILE_AGGREGATE_PARTS.indexOf(part);
  if (index < 0 || index >= values.length)
    throw new CanonicalProfileCorruption();
  return values[index]!;
}
