import { DurableObject } from "cloudflare:workers";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_PROTOCOL_VERSION,
  REACTION_SOCKET_PROTOCOL,
  isInviteReaction,
  type InviteReaction,
  type InviteReactionEvent,
  type InviteReactionSnapshot,
} from "@mons/shared/reactions";
import { isCanonicalFirebaseUid } from "./firebaseKeys.ts";

export const MAX_INVITE_REACTION_SOCKETS = 256;
export const MAX_INVITE_REACTION_SPECTATORS = 248;
export const MAX_INVITE_REACTION_SPECTATORS_PER_IP = 8;
export const MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT = 4;

type StoredReaction = {
  sender_uid: string;
  reaction_json: string;
};

export type InviteReactionPublishResult =
  "published" | "duplicate" | "conflict" | "participant-limit";

export class InviteReactions extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS latest_reactions (sender_uid TEXT PRIMARY KEY, reaction_json TEXT NOT NULL)",
    );
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        REACTION_HEARTBEAT_REQUEST,
        REACTION_HEARTBEAT_RESPONSE,
      ),
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const role = request.headers.get("X-Mons-Reaction-Role") || "spectator";
    const ip = request.headers.get("X-Mons-Reaction-IP") || "unknown";
    if (!["host", "guest", "spectator"].includes(role) || ip.length > 64) {
      return new Response("Invalid reaction admission", { status: 400 });
    }
    const allSockets = this.ctx.getWebSockets();
    const roleCount = (value: string) =>
      this.ctx.getWebSockets(`role:${value}`).length;
    const spectatorCount =
      allSockets.length - roleCount("host") - roleCount("guest");
    const ipCount = this.ctx.getWebSockets(`spectator-ip:${ip}`).length;
    if (
      allSockets.length >= MAX_INVITE_REACTION_SOCKETS ||
      (role === "spectator"
        ? spectatorCount >= MAX_INVITE_REACTION_SPECTATORS ||
          ipCount >= MAX_INVITE_REACTION_SPECTATORS_PER_IP
        : roleCount(role) >= MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT)
    ) {
      return new Response("Reaction room is full", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
    const reactions = Object.fromEntries(
      this.ctx.storage.sql
        .exec<StoredReaction>(
          "SELECT sender_uid, reaction_json FROM latest_reactions ORDER BY sender_uid",
        )
        .toArray()
        .map((row) => [row.sender_uid, JSON.parse(row.reaction_json)]),
    );
    const snapshot: InviteReactionSnapshot = {
      schemaVersion: REACTION_PROTOCOL_VERSION,
      type: "snapshot",
      reactions,
    };
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [
      `role:${role}`,
      ...(role === "spectator" ? [`spectator-ip:${ip}`] : []),
    ]);
    pair[1].send(JSON.stringify(snapshot));
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers:
        request.headers.get("Sec-WebSocket-Protocol") ===
        REACTION_SOCKET_PROTOCOL
          ? { "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL }
          : {},
    });
  }

  async publish(
    senderUid: string,
    reaction: InviteReaction,
  ): Promise<InviteReactionPublishResult> {
    if (!isCanonicalFirebaseUid(senderUid) || !isInviteReaction(reaction)) {
      throw new TypeError("invalid-reaction");
    }
    const normalized: InviteReaction = {
      uuid: reaction.uuid,
      kind: reaction.kind,
      variation: reaction.variation,
      matchId: reaction.matchId,
    };
    const serialized = JSON.stringify(normalized);
    const [stored] = this.ctx.storage.sql
      .exec<StoredReaction>(
        "SELECT sender_uid, reaction_json FROM latest_reactions WHERE sender_uid = ?",
        senderUid,
      )
      .toArray();
    if (stored) {
      const previous: InviteReaction = JSON.parse(stored.reaction_json);
      if (previous.uuid === normalized.uuid) {
        return stored.reaction_json === serialized ? "duplicate" : "conflict";
      }
    } else if (
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM latest_reactions",
        )
        .one().count >= 2
    ) {
      return "participant-limit";
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO latest_reactions (sender_uid, reaction_json) VALUES (?, ?) ON CONFLICT(sender_uid) DO UPDATE SET reaction_json = excluded.reaction_json",
      senderUid,
      serialized,
    );
    const event: InviteReactionEvent = {
      schemaVersion: REACTION_PROTOCOL_VERSION,
      type: "reaction",
      senderUid,
      reaction: normalized,
    };
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        try {
          socket.close(1011, "Reaction delivery failed");
        } catch {}
      }
    }
    return "published";
  }

  webSocketMessage(socket: WebSocket): void {
    socket.close(1008, "Reaction sockets are receive-only");
  }

  webSocketClose(socket: WebSocket): void {
    socket.close();
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Reaction connection failed");
  }
}
