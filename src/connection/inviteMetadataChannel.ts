import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_REFRESH_MS,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isInviteMetadataMessage,
  type InviteMetadataSnapshot,
  type ReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import {
  InviteMetadataApiError,
  getInviteMetadataSocketUrl,
} from "../services/inviteMetadataApi";
import {
  SnapshotChannel,
  type SnapshotChannelDependencies,
} from "./snapshotChannel";

type InviteMetadataChannelDependencies = Pick<
  SnapshotChannelDependencies<
    InviteMetadataSnapshot,
    ReadInviteMetadataResponse
  >,
  | "createSocket"
  | "getProtocols"
  | "getTokenRemainingMs"
  | "isActive"
  | "isOnline"
  | "isVisible"
  | "addWakeListener"
  | "onError"
  | "setTimer"
  | "clearTimer"
  | "random"
  | "now"
> & {
  inviteId: string;
  initialSnapshot?: InviteMetadataSnapshot;
  readMetadata: (signal: AbortSignal) => Promise<ReadInviteMetadataResponse>;
  onSnapshot: (
    snapshot: InviteMetadataSnapshot,
    viewer?: ReadInviteMetadataResponse["viewer"],
  ) => void;
};

export class InviteMetadataChannel extends SnapshotChannel<
  InviteMetadataSnapshot,
  ReadInviteMetadataResponse
> {
  constructor(dependencies: InviteMetadataChannelDependencies) {
    let revision = dependencies.initialSnapshot?.revision ?? -1;
    super({
      ...dependencies,
      initialSnapshotAccepted: dependencies.initialSnapshot !== undefined,
      socketUrl: getInviteMetadataSocketUrl(dependencies.inviteId),
      socketProtocol: INVITE_METADATA_SOCKET_PROTOCOL,
      maxMessageBytes: INVITE_METADATA_MAX_MESSAGE_BYTES,
      refreshMs: INVITE_METADATA_REFRESH_MS,
      readSnapshot: dependencies.readMetadata,
      parseMessage: (message) =>
        isInviteMetadataMessage(message) &&
        message.snapshot.inviteId === dependencies.inviteId
          ? message.snapshot
          : null,
      retryAfterMs: (error) =>
        error instanceof InviteMetadataApiError ? (error.retryAfterMs ?? 0) : 0,
      readError: (error) =>
        error instanceof InviteMetadataApiError
          ? error
          : new InviteMetadataApiError("metadata-unavailable"),
      channelError: () =>
        new InviteMetadataApiError("metadata-channel-unavailable"),
      onSnapshot: (snapshot, response) => {
        if (
          snapshot.inviteId !== dependencies.inviteId ||
          snapshot.revision < revision ||
          (snapshot.revision === revision && !response?.viewer)
        )
          return;
        revision = snapshot.revision;
        dependencies.onSnapshot(snapshot, response?.viewer);
      },
    });
  }
}
