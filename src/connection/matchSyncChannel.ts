import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_REFRESH_MS,
  MATCH_SYNC_SOCKET_PROTOCOL,
  isMatchSyncMessage,
  type MatchSyncSnapshot,
  type ReadMatchSyncResponse,
} from "@mons/shared/match-sync";
import {
  MatchSyncApiError,
  getMatchSyncSocketUrl,
} from "../services/matchSyncApi";
import {
  SnapshotChannel,
  type SnapshotChannelDependencies,
} from "./snapshotChannel";

type MatchSyncChannelDependencies = Pick<
  SnapshotChannelDependencies<MatchSyncSnapshot, ReadMatchSyncResponse>,
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
  matchId: string;
  requiredPlayerIds: () => Iterable<string>;
  readMatches: (signal: AbortSignal) => Promise<ReadMatchSyncResponse>;
  onSnapshot: (snapshot: MatchSyncSnapshot) => void;
};

export class MatchSyncChannel extends SnapshotChannel<
  MatchSyncSnapshot,
  ReadMatchSyncResponse
> {
  constructor(dependencies: MatchSyncChannelDependencies) {
    let latest: MatchSyncSnapshot | null = null;
    super({
      ...dependencies,
      socketUrl: getMatchSyncSocketUrl(
        dependencies.inviteId,
        dependencies.matchId,
      ),
      socketProtocol: MATCH_SYNC_SOCKET_PROTOCOL,
      maxMessageBytes: MATCH_SYNC_MAX_MESSAGE_BYTES,
      refreshMs: MATCH_SYNC_REFRESH_MS,
      readSnapshot: dependencies.readMatches,
      parseMessage: (message) =>
        isMatchSyncMessage(message) &&
        message.snapshot.inviteId === dependencies.inviteId &&
        message.snapshot.matchId === dependencies.matchId
          ? message.snapshot
          : null,
      needsHttpRefresh: () => {
        const snapshot = latest;
        if (!snapshot) return true;
        return Array.from(dependencies.requiredPlayerIds()).some((playerId) => {
          const match =
            playerId === snapshot.hostPlayerId
              ? snapshot.hostMatch
              : playerId === snapshot.guestPlayerId
                ? snapshot.guestMatch
                : null;
          return match === null;
        });
      },
      retryAfterMs: (error) =>
        error instanceof MatchSyncApiError ? (error.retryAfterMs ?? 0) : 0,
      readError: (error) =>
        error instanceof MatchSyncApiError
          ? error
          : new MatchSyncApiError("match-sync-unavailable"),
      channelError: () =>
        new MatchSyncApiError("match-sync-channel-unavailable"),
      onSnapshot: (snapshot, response) => {
        if (
          snapshot.inviteId !== dependencies.inviteId ||
          snapshot.matchId !== dependencies.matchId ||
          (latest && snapshot.revision < latest.revision) ||
          (latest && snapshot.revision === latest.revision && !response)
        )
          return;
        latest = snapshot;
        dependencies.onSnapshot(snapshot);
      },
    });
  }
}
