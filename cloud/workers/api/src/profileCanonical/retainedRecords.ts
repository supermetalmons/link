declare const canonicalDocument: unique symbol;
type CanonicalDocument<Kind extends string> = {
  readonly [canonicalDocument]: Kind;
};
export type CanonicalProfileLegacyDocument =
  CanonicalDocument<"profile-legacy">;
export type CanonicalAuthMetadataDocument = CanonicalDocument<"auth-metadata">;
export type CanonicalAuthResultDocument = CanonicalDocument<"auth-result">;
export type CanonicalRatingPayloadDocument =
  CanonicalDocument<"rating-payload">;

export function retainCanonicalProfileLegacy(
  value: unknown,
): CanonicalProfileLegacyDocument {
  return value as CanonicalProfileLegacyDocument;
}

export function emptyCanonicalProfileLegacy(): CanonicalProfileLegacyDocument {
  return retainCanonicalProfileLegacy({});
}

export function sameCanonicalProfileLegacy(
  left: CanonicalProfileLegacyDocument,
  right: CanonicalProfileLegacyDocument,
): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function retainCanonicalAuthMetadata(
  value: unknown,
): CanonicalAuthMetadataDocument {
  return value as CanonicalAuthMetadataDocument;
}

export function retainCanonicalAuthResult(
  value: unknown,
): CanonicalAuthResultDocument {
  return value as CanonicalAuthResultDocument;
}

export function retainCanonicalRatingPayload(
  value: unknown,
): CanonicalRatingPayloadDocument {
  return value as CanonicalRatingPayloadDocument;
}
