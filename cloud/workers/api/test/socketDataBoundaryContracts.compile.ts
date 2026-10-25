import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import type { InviteRoomSnapshot } from "@mons/shared/reactions";
import { canReceiveInvite } from "../src/inviteChannelsRoom.ts";
import type { InviteMetadataReadResult } from "../src/inviteMetadata.ts";
import type {
  InviteSocketAccess,
  RetainedInviteKey,
  RetainedMatchKey,
  RetainedSocketAttachment,
  RoomSocketAttachment,
} from "../src/socketAttachmentRecords.ts";
import type {
  StoredReactionDocument,
  StoredReactionSnapshot,
} from "../src/reactionRecords.ts";
import type {
  acceptRoomSocket,
  sendSocketSnapshot,
} from "../src/socketUpgrade.ts";

type Assert<Value extends true> = Value;
type Accepts<Value, Contract> = Value extends Contract ? true : false;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type AuthenticatedReaction = {
  channel: "reaction";
  schemaVersion: 2;
  matchId: string;
  authenticated: true;
  sid: string;
  authExpiresAtMs: number;
};
type AnonymousReaction = {
  channel: "reaction";
  schemaVersion: 2;
  matchId: string;
  authenticated: false;
};
type MatchAttachment = {
  channel: "matches";
  schemaVersion: 1;
  inviteId: string;
  matchId: string;
  role: "host";
  actorUid: string;
  authenticated: true;
  sid: string;
  authExpiresAtMs: number;
};
type InviteAttachment = {
  channel: "metadata" | "wagers";
  schemaVersion: 1;
  inviteId: string;
  role: "spectator";
  actorUid: null;
  authenticated: false;
};
type SnapshotInput = Parameters<typeof sendSocketSnapshot>[2];

export type SocketBoundaryContracts = [
  Assert<Accepts<AuthenticatedReaction, RoomSocketAttachment>>,
  Assert<Accepts<AnonymousReaction, RoomSocketAttachment>>,
  Assert<Accepts<MatchAttachment, RoomSocketAttachment>>,
  Assert<Accepts<InviteAttachment, RoomSocketAttachment>>,
  Assert<Rejects<Record<string, unknown>, RoomSocketAttachment>>,
  Assert<Rejects<RetainedSocketAttachment, RoomSocketAttachment>>,
  Assert<Rejects<Record<string, unknown>, RetainedSocketAttachment>>,
  Assert<Rejects<AuthenticatedReaction, RetainedSocketAttachment>>,
  Assert<Rejects<RetainedMatchKey, string>>,
  Assert<Rejects<RetainedInviteKey, RetainedMatchKey>>,
  Assert<Rejects<RetainedMatchKey, RetainedInviteKey>>,
  Assert<Rejects<Omit<AuthenticatedReaction, "sid">, RoomSocketAttachment>>,
  Assert<
    Rejects<
      Omit<AuthenticatedReaction, "authExpiresAtMs">,
      RoomSocketAttachment
    >
  >,
  Assert<
    Rejects<
      Omit<AuthenticatedReaction, "authExpiresAtMs"> & {
        authExpiresAtMs: string;
      },
      RoomSocketAttachment
    >
  >,
  Assert<
    Rejects<
      Omit<AnonymousReaction, "schemaVersion"> & { schemaVersion: 1 },
      RoomSocketAttachment
    >
  >,
  Assert<Rejects<Omit<AnonymousReaction, "channel">, RoomSocketAttachment>>,
  Assert<Rejects<Omit<MatchAttachment, "matchId">, RoomSocketAttachment>>,
  Assert<
    Rejects<
      Omit<MatchAttachment, "role"> & { role: "observer" },
      RoomSocketAttachment
    >
  >,
  Assert<
    Rejects<
      Omit<InviteAttachment, "schemaVersion"> & { schemaVersion: 2 },
      RoomSocketAttachment
    >
  >,
  Assert<
    Rejects<Record<string, unknown>, Parameters<typeof acceptRoomSocket>[1]>
  >,
  Assert<Accepts<InviteRoomSnapshot, SnapshotInput>>,
  Assert<Accepts<StoredReactionSnapshot, SnapshotInput>>,
  Assert<
    Accepts<
      { schemaVersion: 1; type: "snapshot"; snapshot: InviteMetadataSnapshot },
      SnapshotInput
    >
  >,
  Assert<Rejects<Record<string, unknown>, SnapshotInput>>,
  Assert<Rejects<unknown, SnapshotInput>>,
  Assert<
    Rejects<
      Omit<InviteRoomSnapshot, "reactions"> & {
        reactions: Record<string, unknown>;
      },
      SnapshotInput
    >
  >,
  Assert<Rejects<Record<string, unknown>, StoredReactionDocument>>,
];

export function freshAccessResult(
  attachment: InviteSocketAccess,
  source: Extract<InviteMetadataReadResult, { status: "ok" }>,
): boolean {
  return canReceiveInvite(attachment, source);
}

export function retainedAccessResult(
  attachment: RetainedSocketAttachment,
  source: Extract<InviteMetadataReadResult, { status: "ok" }>,
): boolean {
  // @ts-expect-error retained access preserves raw falsy values
  return canReceiveInvite(attachment, source);
}
