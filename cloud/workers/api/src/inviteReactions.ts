import { DurableObject } from "cloudflare:workers";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_PROTOCOL_VERSION,
  REACTION_SOCKET_PROTOCOL,
  REACTION_SOCKET_PROTOCOL_V2,
  isInviteReaction,
  type InviteReaction,
  type InviteReactionEvent,
  type InviteReactionSnapshot,
  type InviteRoomSnapshot,
} from "@mons/shared/reactions";
import {
  isMatchPresentationSnapshot,
  isUpdateMatchPresentationRequest,
  type MatchPresentation,
  type MatchPresentationSnapshot,
  type UpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";

export const MAX_INVITE_REACTION_SOCKETS = 256;
export const MAX_INVITE_REACTION_SPECTATORS = 248;
export const MAX_INVITE_REACTION_SPECTATORS_PER_IP = 8;
export const MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT = 4;

type StoredReaction = {
  sender_uid: string;
  reaction_json: string;
};

type StoredPresentation = {
  match_id: string;
  actor_uid: string;
  emoji_id: number;
  aura: string;
  revision: number;
  operation_id: string | null;
  operation_json: string | null;
};

export type MatchPresentationSeeds = Record<
  string,
  { emojiId: number; aura: string }
>;
export type MatchPresentationUpdateResult = {
  status: "updated" | "duplicate" | "conflict";
  presentation: MatchPresentation;
};

function presentationFromRow(row: StoredPresentation): MatchPresentation {
  return {
    matchId: row.match_id,
    actorUid: row.actor_uid,
    emojiId: row.emoji_id,
    aura: row.aura,
    revision: row.revision,
  };
}

function socketVersion(socket: WebSocket): 1 | 2 {
  return socket.deserializeAttachment()?.schemaVersion === 2 ? 2 : 1;
}

function send(socket: WebSocket, message: string): void {
  try {
    socket.send(message);
  } catch {
    try {
      socket.close(1011, "Reaction delivery failed");
    } catch {}
  }
}

export type InviteReactionPublishResult =
  "published" | "duplicate" | "conflict" | "participant-limit";

export class InviteReactions extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS latest_reactions (sender_uid TEXT PRIMARY KEY, reaction_json TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_presentations (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT, operation_json TEXT, PRIMARY KEY(match_id, actor_uid))",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS frozen_match_presentations (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(match_id, actor_uid))",
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
    const protocol = request.headers.get("Sec-WebSocket-Protocol");
    const version = protocol === REACTION_SOCKET_PROTOCOL_V2 ? 2 : 1;
    let matchId: string | null = null;
    try {
      const encodedMatchId = request.headers.get("X-Mons-Presentation-Match");
      if (encodedMatchId !== null) matchId = decodeURIComponent(encodedMatchId);
    } catch {
      return new Response("Invalid presentation match", { status: 400 });
    }
    if (
      version === 2 &&
      (!matchId || matchId !== matchId.trim() || !isSafeFirebaseKey(matchId))
    ) {
      return new Response("Invalid presentation match", { status: 400 });
    }
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
    const snapshot: InviteReactionSnapshot | InviteRoomSnapshot =
      version === 2
        ? {
            schemaVersion: 2,
            type: "snapshot",
            reactions,
            presentation: this.readPresentations(matchId!),
          }
        : {
            schemaVersion: REACTION_PROTOCOL_VERSION,
            type: "snapshot",
            reactions,
          };
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({
      schemaVersion: version,
      matchId: version === 2 ? matchId : null,
    });
    this.ctx.acceptWebSocket(pair[1], [
      `role:${role}`,
      ...(role === "spectator" ? [`spectator-ip:${ip}`] : []),
    ]);
    pair[1].send(JSON.stringify(snapshot));
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers:
        protocol === REACTION_SOCKET_PROTOCOL ||
        protocol === REACTION_SOCKET_PROTOCOL_V2
          ? { "Sec-WebSocket-Protocol": protocol }
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
    const v2Message = JSON.stringify({ ...event, schemaVersion: 2 });
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, socketVersion(socket) === 2 ? v2Message : message);
    }
    return "published";
  }

  private readPresentations(
    matchId: string,
    frozen = false,
  ): MatchPresentationSnapshot {
    const rows = this.ctx.storage.sql
      .exec<StoredPresentation>(
        frozen
          ? "SELECT match_id, actor_uid, emoji_id, aura, revision FROM frozen_match_presentations WHERE match_id = ? ORDER BY actor_uid"
          : "SELECT * FROM match_presentations WHERE match_id = ? ORDER BY actor_uid",
        matchId,
      )
      .toArray();
    return {
      matchId,
      players: Object.fromEntries(
        rows.map((row) => [row.actor_uid, presentationFromRow(row)]),
      ),
    };
  }

  private initializePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): MatchPresentationSnapshot {
    const normalized: MatchPresentationSnapshot = {
      matchId,
      players: Object.fromEntries(
        Object.entries(seeds).map(([actorUid, seed]) => [
          actorUid,
          {
            matchId,
            actorUid,
            emojiId: seed.emojiId,
            aura: seed.aura,
            revision: 0,
          },
        ]),
      ),
    };
    if (
      !isMatchPresentationSnapshot(normalized) ||
      Object.keys(seeds).some((uid) => !isCanonicalFirebaseUid(uid))
    ) {
      throw new TypeError("invalid-presentation-seeds");
    }
    const current = this.readPresentations(matchId);
    if (
      new Set([...Object.keys(current.players), ...Object.keys(seeds)]).size > 2
    ) {
      throw new TypeError("presentation-participant-limit");
    }
    for (const [actorUid, seed] of Object.entries(seeds)) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO match_presentations (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, 0)",
        matchId,
        actorUid,
        seed.emojiId,
        seed.aura,
      );
    }
    return this.readPresentations(matchId);
  }

  async ensurePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): Promise<MatchPresentationSnapshot> {
    return this.ctx.storage.transactionSync(() =>
      this.initializePresentations(matchId, seeds),
    );
  }

  async getPresentationSnapshot(
    matchId: string,
  ): Promise<MatchPresentationSnapshot> {
    return this.readPresentations(matchId);
  }

  async freezePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): Promise<MatchPresentationSnapshot> {
    return this.ctx.storage.transactionSync(() => {
      const current = this.initializePresentations(matchId, seeds);
      for (const actorUid of Object.keys(seeds)) {
        const presentation = current.players[actorUid];
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO frozen_match_presentations (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, ?)",
          matchId,
          actorUid,
          presentation.emojiId,
          presentation.aura,
          presentation.revision,
        );
      }
      return this.readPresentations(matchId, true);
    });
  }

  async updatePresentation(
    actorUid: string,
    matchId: string,
    request: UpdateMatchPresentationRequest,
  ): Promise<MatchPresentationUpdateResult> {
    if (
      !isCanonicalFirebaseUid(actorUid) ||
      !isUpdateMatchPresentationRequest(request)
    ) {
      throw new TypeError("invalid-presentation-update");
    }
    const operationJson = JSON.stringify({
      operationId: request.operationId,
      expectedRevision: request.expectedRevision,
      emojiId: request.emojiId,
      aura: request.aura,
    });
    const result = this.ctx.storage.transactionSync(
      (): MatchPresentationUpdateResult => {
        const [row] = this.ctx.storage.sql
          .exec<StoredPresentation>(
            "SELECT * FROM match_presentations WHERE match_id = ? AND actor_uid = ?",
            matchId,
            actorUid,
          )
          .toArray();
        if (!row) throw new TypeError("presentation-not-initialized");
        const current = presentationFromRow(row);
        if (row.operation_id === request.operationId) {
          return {
            status:
              row.operation_json === operationJson ? "duplicate" : "conflict",
            presentation: current,
          };
        }
        if (
          row.revision !== request.expectedRevision ||
          row.revision === Number.MAX_SAFE_INTEGER
        ) {
          return { status: "conflict", presentation: current };
        }
        const presentation = {
          ...current,
          emojiId: request.emojiId,
          aura: request.aura,
          revision: current.revision + 1,
        };
        this.ctx.storage.sql.exec(
          "UPDATE match_presentations SET emoji_id = ?, aura = ?, revision = ?, operation_id = ?, operation_json = ? WHERE match_id = ? AND actor_uid = ?",
          presentation.emojiId,
          presentation.aura,
          presentation.revision,
          request.operationId,
          operationJson,
          matchId,
          actorUid,
        );
        return { status: "updated", presentation };
      },
    );
    if (result.status === "updated") {
      const message = JSON.stringify({
        schemaVersion: 2,
        type: "presentation",
        presentation: result.presentation,
      });
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment();
        if (attachment?.schemaVersion === 2 && attachment.matchId === matchId)
          send(socket, message);
      }
    }
    return result;
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
