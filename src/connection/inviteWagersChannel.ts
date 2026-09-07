import {
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  INVITE_WAGERS_REFRESH_MS,
  INVITE_WAGERS_SOCKET_PROTOCOL,
  isInviteWagersMessage,
  type InviteWagersSnapshot,
  type ReadInviteWagersResponse,
} from "@mons/shared/invite-wagers";
import {
  InviteWagersApiError,
  getInviteWagersSocketUrl,
} from "../services/inviteWagersApi";
import {
  SnapshotChannel,
  type SnapshotChannelDependencies,
  type SnapshotDelivery,
} from "./snapshotChannel";

export type InviteWagersDelivery = SnapshotDelivery;

export {
  SNAPSHOT_RECONNECT_DELAYS_MS as INVITE_WAGERS_RECONNECT_DELAYS_MS,
  SNAPSHOT_HEARTBEAT_INTERVAL_MS as INVITE_WAGERS_HEARTBEAT_INTERVAL_MS,
  SNAPSHOT_HEARTBEAT_TIMEOUT_MS as INVITE_WAGERS_HEARTBEAT_TIMEOUT_MS,
} from "./snapshotChannel";

type InviteWagersChannelDependencies = Pick<
  SnapshotChannelDependencies<InviteWagersSnapshot, ReadInviteWagersResponse>,
  | "createSocket"
  | "getProtocols"
  | "isActive"
  | "isOnline"
  | "isVisible"
  | "addWakeListener"
  | "onError"
  | "setTimer"
  | "clearTimer"
  | "random"
  | "now"
  | "captureGeneration"
  | "needsHttpRefresh"
> & {
  inviteId: string;
  readWagers: (signal: AbortSignal) => Promise<ReadInviteWagersResponse>;
  onSnapshot: (
    snapshot: InviteWagersSnapshot,
    delivery: InviteWagersDelivery,
  ) => void;
};

export class InviteWagersChannel extends SnapshotChannel<
  InviteWagersSnapshot,
  ReadInviteWagersResponse
> {
  constructor(dependencies: InviteWagersChannelDependencies) {
    let revision = -1;
    super({
      ...dependencies,
      socketUrl: getInviteWagersSocketUrl(dependencies.inviteId),
      socketProtocol: INVITE_WAGERS_SOCKET_PROTOCOL,
      maxMessageBytes: INVITE_WAGERS_MAX_MESSAGE_BYTES,
      refreshMs: INVITE_WAGERS_REFRESH_MS,
      readSnapshot: dependencies.readWagers,
      parseMessage: (message) =>
        isInviteWagersMessage(message) &&
        message.snapshot.inviteId === dependencies.inviteId
          ? message.snapshot
          : null,
      retryAfterMs: (error) =>
        error instanceof InviteWagersApiError ? (error.retryAfterMs ?? 0) : 0,
      readError: (error) =>
        error instanceof InviteWagersApiError
          ? error
          : new InviteWagersApiError("wagers-unavailable"),
      channelError: () =>
        new InviteWagersApiError("wagers-channel-unavailable"),
      onSnapshot: (snapshot, response, delivery) => {
        if (
          snapshot.inviteId !== dependencies.inviteId ||
          snapshot.revision < revision ||
          (snapshot.revision === revision && !response)
        )
          return;
        revision = snapshot.revision;
        dependencies.onSnapshot(snapshot, delivery);
      },
    });
  }
}
