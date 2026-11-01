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
  parseVerifyOperationMetadata,
  parseAuthOperationReceipt,
  parseCanonicalRatingPayload,
  type VerifyOperationMetadata,
  type AuthOperationReceipt,
  type CanonicalRatingPayload,
  createStoredPlayerProfile,
  parseStoredPlayerProfile,
  type StoredPlayerProfile,
} from "../src/profileCanonical/contracts.ts";
import { createDefaultProfileAppearance } from "@mons/shared/appearance";
import { materializeCanonicalProfile } from "../src/profileCanonical/profiles.ts";
import { commitProfileGameProjectionWrites } from "../src/profileGamesD1.ts";
import type {
  CanonicalAuthOperationValue,
  CanonicalAuthOperationStartWrite,
  CanonicalAuthOperationUpdateWrite,
} from "../src/profileCanonical/types.ts";

export function profileFixture(
  input: Partial<StoredPlayerProfile> & Pick<StoredPlayerProfile, "id">,
): StoredPlayerProfile {
  return parseStoredPlayerProfile({
    ...createStoredPlayerProfile(
      input.id,
      createDefaultProfileAppearance(input.emoji ?? 1),
    ),
    ...input,
  });
}

export function materializeProfileFixture(
  input: Omit<Parameters<typeof materializeCanonicalProfile>[0], "profile"> & {
    profile: Partial<StoredPlayerProfile> & Pick<StoredPlayerProfile, "id">;
  },
): ReturnType<typeof materializeCanonicalProfile> {
  return materializeCanonicalProfile({
    ...input,
    profile: profileFixture(input.profile),
  });
}
export { materializeProfileFixture as materializeProfileCompatibility };

export function projectionDocumentFixture<Value>(
  value: Value,
): ProfileGameProjectionDocument & Value {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid-projection-fixture");
  const fields = Object.fromEntries(Object.entries(value));
  const status = fields.status ?? "waiting";
  const sortBucket =
    status === "pending"
      ? 20
      : status === "waiting"
        ? 30
        : status === "active"
          ? 40
          : 50;
  const timestamp = fields.listSortAt ?? 1;
  const canonical =
    fields.entityType === "event"
      ? {
          source: "event-projector",
          entityType: "event",
          id: `event_${fields.eventId ?? "event"}`,
          eventId: "event",
          status,
          sortBucket,
          listSortAt: timestamp,
          ownerProfileId: "profile-1",
          startAt: null,
          updatedAt: timestamp,
          endedAt: null,
          participantCount: 0,
          participantPreview: [],
          winnerDisplayName: null,
          ...fields,
          schemaVersion: 2,
        }
      : {
          source: "game-projector",
          entityType: "game",
          inviteId: "invite",
          kind: "direct",
          hostLoginId: null,
          guestLoginId: null,
          hostProfileId: null,
          guestProfileId: null,
          status,
          sortBucket,
          isPendingAutomatch: status === "pending",
          automatchStateHint: null,
          automatchCanceledAt: null,
          latestMatchId: fields.inviteId ?? "invite",
          ownerProfileId: "profile-1",
          ownerRole: "host",
          ownerLoginId: null,
          opponentProfileId: null,
          opponentLoginId: null,
          opponentName: null,
          opponentEmoji: status === "active" || status === "ended" ? 1 : null,
          listSortAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
          endedAt: null,
          lastEventFingerprint: "fixture",
          lastEventType: null,
          lastEventReason: null,
          lastEventAt: timestamp,
          ...fields,
          schemaVersion: 3,
          projectorVersion: 3,
        };
  return retainProfileGameProjection(
    canonical,
  ) as ProfileGameProjectionDocument & Value;
}
export function projectionProfileFixture<Value>(
  value: Value,
): ProjectionProfileDocument & Value {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid-projection-profile-fixture");
  return retainProjectionProfile({
    eth: "",
    sol: "",
    username: "",
    emoji: 0,
    ...value,
  }) as ProjectionProfileDocument & Value;
}
export function profileLegacyFixture<Value>(value: Value): Value {
  return value;
}
export function authMetadataFixture<Value>(
  value: Value,
): VerifyOperationMetadata {
  return parseVerifyOperationMetadata(value);
}
export function authResultFixture<Value>(value: Value): AuthOperationReceipt {
  return parseAuthOperationReceipt(value);
}
export function ratingPayloadFixture<Value>(
  value: Value,
): CanonicalRatingPayload {
  return parseCanonicalRatingPayload(value);
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
  if (value.status !== "started")
    throw new Error("expected-started-auth-fixture");
  return value;
}
export function legacyAuthUpdateFixture(
  value: CanonicalAuthOperationValue,
): CanonicalAuthOperationUpdateWrite {
  if (value.status !== "success" && value.status !== "failed")
    throw new Error("expected-finished-auth-fixture");
  return value;
}
