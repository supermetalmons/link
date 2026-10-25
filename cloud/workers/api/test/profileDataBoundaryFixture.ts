import {
  retainProfileGameProjection,
  retainProjectionProfile,
  type ProfileGameProjectionDocument,
  type ProjectionProfileDocument,
} from "../../../runtime/profileGameProjectionRecords.js";
import {
  retainEventProjectionOutbox,
  type EventProjectionOutboxDocument,
  type EventProjectionOutboxKind,
} from "../../../runtime/eventProjectionOutboxRecords.js";
import {
  retainCanonicalProfileLegacy,
  retainCanonicalAuthMetadata,
  retainCanonicalAuthResult,
  retainCanonicalRatingPayload,
  type CanonicalProfileLegacyDocument,
  type CanonicalAuthMetadataDocument,
  type CanonicalAuthResultDocument,
  type CanonicalRatingPayloadDocument,
} from "../src/profileCanonical/retainedRecords.ts";
import { materializeCanonicalProfile } from "../src/profileCanonical/profiles.ts";
import { commitProfileGameProjectionWrites } from "../src/profileGamesD1.ts";
import type {
  CanonicalAuthOperationValue,
  CanonicalAuthOperationStartWrite,
  CanonicalAuthOperationUpdateWrite,
} from "../src/profileCanonical/types.ts";

export function materializeProfileCompatibility(
  input: Omit<
    Parameters<typeof materializeCanonicalProfile>[0],
    "legacyFields"
  > & { legacyFields?: unknown },
): ReturnType<typeof materializeCanonicalProfile> {
  return Reflect.apply(materializeCanonicalProfile, undefined, [input]);
}

export function projectionDocumentFixture<Value>(
  value: Value,
): ProfileGameProjectionDocument & Value {
  return retainProfileGameProjection(value) as ProfileGameProjectionDocument &
    Value;
}
export function projectionProfileFixture<Value>(
  value: Value,
): ProjectionProfileDocument & Value {
  return retainProjectionProfile(value) as ProjectionProfileDocument & Value;
}
export function profileLegacyFixture<Value>(
  value: Value,
): CanonicalProfileLegacyDocument & Value {
  return retainCanonicalProfileLegacy(value) as CanonicalProfileLegacyDocument &
    Value;
}
export function authMetadataFixture<Value>(
  value: Value,
): CanonicalAuthMetadataDocument & Value {
  return retainCanonicalAuthMetadata(value) as CanonicalAuthMetadataDocument &
    Value;
}
export function authResultFixture<Value>(
  value: Value,
): CanonicalAuthResultDocument & Value {
  return retainCanonicalAuthResult(value) as CanonicalAuthResultDocument &
    Value;
}
export function ratingPayloadFixture<Value>(
  value: Value,
): CanonicalRatingPayloadDocument & Value {
  return retainCanonicalRatingPayload(value) as CanonicalRatingPayloadDocument &
    Value;
}
export function eventProjectionOutboxFixture<
  Kind extends EventProjectionOutboxKind,
  Value,
>(kind: Kind, value: Value): EventProjectionOutboxDocument<Kind> & Value {
  return retainEventProjectionOutbox(
    kind,
    value,
  ) as EventProjectionOutboxDocument<Kind> & Value;
}
export function projectionFixtureFields(
  value: ProfileGameProjectionDocument,
): Record<string, unknown>;
export function projectionFixtureFields(
  value: ProfileGameProjectionDocument | null | undefined,
): Record<string, unknown> | null | undefined;
export function projectionFixtureFields(
  value: ProfileGameProjectionDocument | null | undefined,
): Record<string, unknown> | null | undefined {
  const retained: unknown = value;
  return retained as Record<string, unknown> | null | undefined;
}
export function retainedFixtureFields(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
export function commitProjectionCompatibility(
  db: D1Database,
  writes: unknown,
  options?: Parameters<typeof commitProfileGameProjectionWrites>[2],
): Promise<void> {
  return Reflect.apply(commitProfileGameProjectionWrites, undefined, [
    db,
    writes,
    options,
  ]);
}
export function legacyAuthStartFixture(
  value: CanonicalAuthOperationValue,
): CanonicalAuthOperationStartWrite {
  return value as CanonicalAuthOperationStartWrite;
}
export function legacyAuthUpdateFixture(
  value: CanonicalAuthOperationValue,
): CanonicalAuthOperationUpdateWrite {
  return value as CanonicalAuthOperationUpdateWrite;
}
