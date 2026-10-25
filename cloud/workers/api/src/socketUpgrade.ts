import type {
  ApiSocketMessage,
  ApiSocketEndpoint,
  ApiTransportStatus,
} from "@mons/shared/api-contracts";
import type { StoredReactionSnapshot } from "./reactionRecords.ts";
import type { RoomSocketAttachment } from "./socketAttachmentRecords.ts";
import type { SocketSessions } from "./socketSession.ts";
type InviteMetadataMessage =
  ApiSocketMessage<"GET /invites/:inviteId/metadata/socket">;
type InviteWagersMessage =
  ApiSocketMessage<"GET /invites/:inviteId/wagers/socket">;
type MatchSyncMessage =
  ApiSocketMessage<"GET /invites/:inviteId/matches/:matchId/socket">;
type InviteRoomSnapshot = Extract<
  ApiSocketMessage<"GET /invites/:inviteId/reactions/socket">,
  { type: "snapshot" }
>;

type SocketPair = InstanceType<typeof WebSocketPair>;
export type InviteChannelSnapshotMessage = {
  schemaVersion: 1;
  type: "snapshot";
  snapshot: InviteMetadataMessage["snapshot"] | InviteWagersMessage["snapshot"];
};
type SocketSnapshot =
  | InviteChannelSnapshotMessage
  | MatchSyncMessage
  | InviteRoomSnapshot
  | StoredReactionSnapshot;

export function acceptRoomSocket(
  ctx: DurableObjectState,
  attachment: RoomSocketAttachment,
  tags: string[],
): SocketPair {
  const pair = new WebSocketPair();
  pair[1].serializeAttachment(attachment);
  ctx.acceptWebSocket(pair[1], tags);
  return pair;
}

export function sendSocketSnapshot(
  sessions: Pick<SocketSessions, "send">,
  pair: SocketPair,
  message: SocketSnapshot,
  protocol?: string,
): Response {
  sessions.send(pair[1], JSON.stringify(message));
  return new Response(null, {
    status: 101 satisfies ApiTransportStatus<ApiSocketEndpoint, "websocket">,
    webSocket: pair[0],
    headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {},
  });
}
