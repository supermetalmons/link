import type * as Projection from "../../../runtime/profileGameProjectionRecords.js";
import type {
  ProjectionRecord,
  ProjectionWrite as PortableProjectionWrite,
  ProjectionOwnershipSnapshot,
} from "../../../runtime/profileGamesProjectionCore.js";
import type { EventProjectionWrite } from "../../../runtime/eventProfileGameProjectionCore.js";
import type { ProjectionWrite } from "../src/profileGamesD1.ts";
import type * as Outbox from "../../../runtime/eventProjectionOutboxRecords.js";
import type { EventMutation } from "../../../runtime/eventCommands.js";
import type { EventStore } from "../src/eventStoreContracts.ts";
import type { ProjectionOutboxSnapshot } from "../src/eventD1/reads.ts";
import type { EventProjectionRecoveryWriter } from "../src/eventProjectionRecoveryD1.ts";
import type * as Canonical from "../src/profileCanonical/types.ts";
import type * as Documents from "../src/profileCanonical/retainedRecords.ts";
import type * as Operations from "../src/authIdentityCanonical/operationRecords.ts";
import type { createCanonicalAuthOperations } from "../src/authIdentityCanonical/operations.ts";
import type { VerifyOperationMeta } from "../src/authOperationReplay.ts";
import type * as Rating from "../src/ratingCanonical/codec.ts";
import type { RatingCompletionPatch } from "../src/ratingContracts.ts";
type Assert<Value extends true> = Value;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type Accepts<Value, Contract> = Value extends Contract ? true : false;
type HasIndex<Value> = string extends keyof Value ? true : false;
export type DocumentsBoundaryContracts = [
  Assert<
    Rejects<Record<string, unknown>, Projection.ProfileGameProjectionDocument>
  >,
  Assert<
    HasIndex<Projection.ProfileGameProjectionDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<Record<string, unknown>, Projection.ProjectionProfileDocument>
  >,
  Assert<
    HasIndex<Projection.ProjectionProfileDocument> extends false ? true : false
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Outbox.EventProjectionOutboxDocument<"profile-game">
    >
  >,
  Assert<
    HasIndex<Outbox.EventProjectionOutboxDocument<"profile-game">> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Outbox.EventProjectionOutboxDocument<"telegram">
    >
  >,
  Assert<
    HasIndex<Outbox.EventProjectionOutboxDocument<"telegram">> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<Record<string, unknown>, Documents.CanonicalProfileLegacyDocument>
  >,
  Assert<
    HasIndex<Documents.CanonicalProfileLegacyDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<Record<string, unknown>, Documents.CanonicalAuthMetadataDocument>
  >,
  Assert<
    HasIndex<Documents.CanonicalAuthMetadataDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<Record<string, unknown>, Documents.CanonicalAuthResultDocument>
  >,
  Assert<
    HasIndex<Documents.CanonicalAuthResultDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Record<string, unknown>, Documents.CanonicalRatingPayloadDocument>
  >,
  Assert<
    HasIndex<Documents.CanonicalRatingPayloadDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Projection.ProfileGameProjectionDocument,
      Projection.ProjectionProfileDocument
    >
  >,
  Assert<
    Rejects<
      Projection.ProjectionProfileDocument,
      Projection.ProfileGameProjectionDocument
    >
  >,
  Assert<
    Rejects<
      Outbox.EventProjectionOutboxDocument<"profile-game">,
      Outbox.EventProjectionOutboxDocument<"telegram">
    >
  >,
  Assert<
    Rejects<
      Outbox.EventProjectionOutboxDocument<"telegram">,
      Outbox.EventProjectionOutboxDocument<"profile-game">
    >
  >,
  Assert<
    Rejects<
      Documents.CanonicalProfileLegacyDocument,
      Documents.CanonicalAuthMetadataDocument
    >
  >,
  Assert<
    Rejects<
      Documents.CanonicalAuthMetadataDocument,
      Documents.CanonicalProfileLegacyDocument
    >
  >,
  Assert<
    Rejects<
      Documents.CanonicalAuthMetadataDocument,
      Documents.CanonicalAuthResultDocument
    >
  >,
  Assert<
    Rejects<
      Documents.CanonicalAuthResultDocument,
      Documents.CanonicalAuthMetadataDocument
    >
  >,
  Assert<
    Rejects<
      Documents.CanonicalAuthResultDocument,
      Documents.CanonicalRatingPayloadDocument
    >
  >,
  Assert<
    Rejects<
      Projection.ProfileGameProjectionDocument,
      Documents.CanonicalRatingPayloadDocument
    >
  >,
  Assert<Rejects<Record<string, unknown>, ProjectionRecord["data"]>>,
  Assert<
    Rejects<
      Map<string, Record<string, unknown>>,
      ProjectionOwnershipSnapshot["profileDataById"]
    >
  >,
];

export type ProjectionWritesBoundaryContracts = [
  Assert<
    Rejects<
      { type: "create"; profileId: string; projectionId: string },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      { type: "update"; profileId: string; projectionId: string },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      { type: "merge"; profileId: string; projectionId: string },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "delete";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "create";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
        expectedVersion: number;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "merge";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
        expectedVersion: number;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      { type: "create"; profileId: string; inviteId: string },
      PortableProjectionWrite
    >
  >,
  Assert<
    Rejects<
      { type: "update"; profileId: string; inviteId: string },
      PortableProjectionWrite
    >
  >,
  Assert<
    Rejects<
      { type: "merge"; profileId: string; inviteId: string },
      PortableProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "delete";
        profileId: string;
        inviteId: string;
        data: Projection.ProfileGameProjectionDocument;
      },
      PortableProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "create";
        profileId: string;
        inviteId: string;
        data: Projection.ProfileGameProjectionDocument;
        expectedVersion: number;
      },
      PortableProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "merge";
        profileId: string;
        inviteId: string;
        data: Projection.ProfileGameProjectionDocument;
        expectedVersion: number;
      },
      PortableProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "update";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
        requireAbsent: true;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "merge";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
        requireAbsent: true;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "delete";
        profileId: string;
        projectionId: string;
        requireAbsent: true;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Rejects<
      { type: "merge"; profileId: string; eventId: string },
      EventProjectionWrite
    >
  >,
  Assert<
    Rejects<
      {
        type: "delete";
        profileId: string;
        eventId: string;
        data: Projection.ProfileGameProjectionDocument;
      },
      EventProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "schemaVersion"> & {
        schemaVersion: 1;
      },
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "ownerRole"> & {
        ownerRole: "other";
      },
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "opponentEmoji"> & {
        opponentEmoji: string;
      },
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "listSortAt"> & {
        listSortAt: string;
      },
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "source"> & { source: string },
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "listSortAt">,
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "ownerProfileId">,
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.GameProjectionWrite, "lastEventFingerprint">,
      Projection.GameProjectionWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.EventProjectionPayloadWrite, "status"> & {
        status: "pending";
      },
      Projection.EventProjectionPayloadWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Projection.EventProjectionPayloadWrite, "participantPreview"> & {
        participantPreview: unknown[];
      },
      Projection.EventProjectionPayloadWrite
    >
  >,
];

export type EventOutboxesBoundaryContracts = [
  Assert<
    Rejects<
      {
        kind: "profile-game-outbox";
        eventId: string;
        value: Outbox.EventProjectionOutboxDocument<"telegram">;
      },
      EventMutation
    >
  >,
  Assert<
    Rejects<
      {
        kind: "profile-game-outbox-field";
        eventId: string;
        field: "status";
        value: "dead";
      },
      EventMutation
    >
  >,
  Assert<
    Rejects<
      {
        kind: "profile-game";
        eventId: string;
        record: Outbox.EventProjectionOutboxDocument<"telegram">;
        recordJson: string;
      },
      ProjectionOutboxSnapshot
    >
  >,
  Assert<
    Rejects<
      {
        kind: "telegram";
        eventId: string;
        record: Outbox.EventProjectionOutboxDocument<"profile-game">;
        recordJson: string;
      },
      ProjectionOutboxSnapshot
    >
  >,
  Assert<
    "transactEventProfileGameProjectionOutbox" extends keyof EventStore
      ? false
      : true
  >,
  Assert<
    "transactEventTelegramProjectionOutbox" extends keyof EventStore
      ? false
      : true
  >,
  Assert<
    "transact" extends keyof EventProjectionRecoveryWriter<"profile-game">
      ? false
      : true
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<
        Extract<EventMutation, { kind: "profile-game-outbox" }>["value"]
      >
    >
  >,
  Assert<
    "transact" extends keyof EventProjectionRecoveryWriter<"telegram">
      ? false
      : true
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<Extract<EventMutation, { kind: "telegram-outbox" }>["value"]>
    >
  >,
  Assert<
    "markInvalid" extends keyof EventProjectionRecoveryWriter<"profile-game">
      ? false
      : true
  >,
  Assert<
    "repairInvalid" extends keyof EventProjectionRecoveryWriter<"telegram">
      ? false
      : true
  >,
  Assert<
    Rejects<
      Omit<Outbox.EventProfileGameProjectionRequest, "status"> & {
        status: "dead";
      },
      Outbox.EventProfileGameProjectionRequest
    >
  >,
  Assert<
    Rejects<
      Omit<Outbox.EventProfileGameProjectionRequest, "schemaVersion"> & {
        schemaVersion: number;
      },
      Outbox.EventProfileGameProjectionRequest
    >
  >,
  Assert<
    Rejects<
      Omit<
        Outbox.EventProfileGameProjectionRequest,
        "cleanupOwnerProfileIds"
      > & { cleanupOwnerProfileIds: Record<string, boolean> },
      Outbox.EventProfileGameProjectionRequest
    >
  >,
  Assert<
    Rejects<
      Omit<Outbox.EventTelegramProjectionRequest, "firstQueuedAtMs"> & {
        firstQueuedAtMs: string;
      },
      Outbox.EventTelegramProjectionRequest
    >
  >,
  Assert<
    Rejects<
      Omit<Outbox.EventTelegramProjectionRequest, "status"> & {
        status: "dead";
      },
      Outbox.EventTelegramProjectionRequest
    >
  >,
];

export type AuthOperationsBoundaryContracts = [
  Assert<
    Rejects<
      Record<string, unknown>,
      Canonical.CanonicalProfileValue["legacyFields"]
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<Canonical.CanonicalAuthOperationSnapshot["meta"]>
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<Canonical.CanonicalAuthOperationSnapshot["result"]>
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Canonical.CanonicalMergeTargetValue["sourceLegacyFields"]
    >
  >,
  Assert<
    Rejects<
      Omit<
        Extract<Canonical.CanonicalAuthOperationStartWrite, { kind: "verify" }>,
        "status"
      > & { status: "success" },
      Canonical.CanonicalAuthOperationStartWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        Extract<Canonical.CanonicalAuthOperationStartWrite, { kind: "verify" }>,
        "result"
      > & { result: Documents.CanonicalAuthResultDocument },
      Canonical.CanonicalAuthOperationStartWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        Extract<Canonical.CanonicalAuthOperationStartWrite, { kind: "unlink" }>,
        "meta"
      > & { meta: Documents.CanonicalAuthMetadataDocument },
      Canonical.CanonicalAuthOperationStartWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        Extract<Canonical.CanonicalAuthOperationStartWrite, { kind: "verify" }>,
        "meta"
      > & { meta: null },
      Canonical.CanonicalAuthOperationStartWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        Extract<
          Canonical.CanonicalAuthOperationUpdateWrite,
          { status: "success" }
        >,
        "result"
      > & { result: null },
      Canonical.CanonicalAuthOperationUpdateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        Extract<
          Canonical.CanonicalAuthOperationUpdateWrite,
          { status: "failed" }
        >,
        "result"
      > & { result: Documents.CanonicalAuthResultDocument },
      Canonical.CanonicalAuthOperationUpdateWrite
    >
  >,
  Assert<
    Rejects<
      {
        result: Parameters<typeof Operations.authOperationResult>[0];
        error: Error;
      },
      Operations.AuthOperationOutcome
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Parameters<typeof Operations.authOperationResult>[0]
    >
  >,
  Assert<
    Rejects<
      Omit<
        Extract<Operations.AuthOperationStartInput, { kind: "unlink" }>,
        "meta"
      > & { meta: VerifyOperationMeta },
      Operations.AuthOperationStartInput
    >
  >,
];

export type RatingsBoundaryContracts = [
  Assert<
    Rejects<
      Record<string, unknown>,
      Canonical.CanonicalRatingUpdateValue["payload"]
    >
  >,
  Assert<
    Rejects<Record<string, unknown>, Parameters<typeof Rating.ratingValue>[1]>
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Parameters<typeof Rating.mergedRatingValue>[1]
    >
  >,
  Assert<
    Rejects<
      Omit<RatingCompletionPatch, "status"> & { status: "processing" },
      RatingCompletionPatch
    >
  >,
  Assert<
    Rejects<
      Omit<RatingCompletionPatch, "historicalMatchArchiveVersion"> & {
        historicalMatchArchiveVersion: 2;
      },
      RatingCompletionPatch
    >
  >,
  Assert<
    Rejects<
      Omit<RatingCompletionPatch, "telegramDeliveryVersion"> & {
        telegramDeliveryVersion: 1;
      },
      RatingCompletionPatch
    >
  >,
  Assert<
    Rejects<
      Omit<RatingCompletionPatch, "profileGameProjectionVersion"> & {
        profileGameProjectionVersion: 2;
      },
      RatingCompletionPatch
    >
  >,
  Assert<
    Rejects<
      Omit<RatingCompletionPatch, "eventProgressVersion"> & {
        eventProgressVersion: 2;
      },
      RatingCompletionPatch
    >
  >,
  Assert<
    Rejects<
      Omit<RatingCompletionPatch, "telegramProjectionState"> & {
        telegramProjectionState: "done";
      },
      RatingCompletionPatch
    >
  >,
  Assert<
    Rejects<
      Omit<RatingCompletionPatch, "playerManaPoints"> & {
        playerManaPoints: string;
      },
      RatingCompletionPatch
    >
  >,
  Assert<
    Rejects<
      Omit<Rating.RatingLeasePayloadWrite, "status"> & { status: "done" },
      Rating.RatingLeasePayloadWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Rating.RatingLeasePayloadWrite, "ownerToken">,
      Rating.RatingLeasePayloadWrite
    >
  >,
];

export type PositiveBoundaryContracts = [
  Assert<
    Accepts<
      ReturnType<typeof Projection.createGameProjection>,
      ProjectionRecord["data"]
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Projection.createEventProjection>,
      ProjectionRecord["data"]
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Projection.createProjectionProfile>,
      Projection.ProjectionProfileDocument
    >
  >,
  Assert<
    Accepts<
      {
        type: "create";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Accepts<
      {
        type: "merge";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Accepts<
      {
        type: "update";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Accepts<
      {
        type: "delete";
        profileId: string;
        projectionId: string;
        expectedVersion: number;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Accepts<
      {
        type: "create";
        profileId: string;
        projectionId: string;
        data: Projection.ProfileGameProjectionDocument;
        requireAbsent: true;
      },
      ProjectionWrite
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Outbox.createEventProfileGameProjectionRequest>,
      Outbox.EventProjectionOutboxDocument<"profile-game">
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Outbox.createEventTelegramProjectionRequest>,
      Outbox.EventProjectionOutboxDocument<"telegram">
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Operations.startedAuthOperation>,
      Canonical.CanonicalAuthOperationStartWrite
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Operations.finishedAuthOperation>,
      Canonical.CanonicalAuthOperationUpdateWrite
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Operations.successfulAuthOperation>,
      Canonical.CanonicalAuthOperationUpdateWrite
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Rating.ratingLeasePayload>,
      Parameters<typeof Rating.ratingValue>[1]
    >
  >,
  Assert<
    Accepts<
      RatingCompletionPatch,
      Parameters<typeof Rating.mergedRatingValue>[1]
    >
  >,
  Assert<
    Accepts<
      {
        operationId: string;
        kind: "verify";
        method: "eth";
        loginUid: string;
        status: "started";
        meta: Documents.CanonicalAuthMetadataDocument;
        result: null;
        errorCode: null;
        errorMessage: null;
        startedAtMs: number;
        updatedAtMs: number;
      },
      Canonical.CanonicalAuthOperationStartWrite
    >
  >,
  Assert<
    Accepts<
      {
        operationId: string;
        kind: "unlink";
        method: "eth";
        loginUid: string;
        status: "started";
        meta: null;
        result: null;
        errorCode: null;
        errorMessage: null;
        startedAtMs: number;
        updatedAtMs: number;
      },
      Canonical.CanonicalAuthOperationStartWrite
    >
  >,
  Assert<
    Accepts<
      {
        operationId: string;
        kind: "verify";
        method: "eth";
        loginUid: string;
        status: "success";
        meta: Documents.CanonicalAuthMetadataDocument;
        result: Documents.CanonicalAuthResultDocument;
        errorCode: null;
        errorMessage: null;
        startedAtMs: number;
        updatedAtMs: number;
      },
      Canonical.CanonicalAuthOperationUpdateWrite
    >
  >,
  Assert<
    Accepts<
      {
        operationId: string;
        kind: "verify";
        method: "eth";
        loginUid: string;
        status: "failed";
        meta: Documents.CanonicalAuthMetadataDocument;
        result: null;
        errorCode: string;
        errorMessage: string;
        startedAtMs: number;
        updatedAtMs: number;
      },
      Canonical.CanonicalAuthOperationUpdateWrite
    >
  >,
];
export function acceptAuthOperationKinds(
  operations: ReturnType<typeof createCanonicalAuthOperations>,
  meta: VerifyOperationMeta,
) {
  void operations.beginOperation("operation", "verify", "eth", "login", meta);
  void operations.beginOperation("operation", "unlink", "eth", "login", null);
  // @ts-expect-error verify operations require verified metadata
  void operations.beginOperation("operation", "verify", "eth", "login", null);
  // @ts-expect-error unlink operations do not write verification metadata
  void operations.beginOperation("operation", "unlink", "eth", "login", meta);
}
