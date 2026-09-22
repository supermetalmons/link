import {
  REACTION_PROTOCOL_VERSION,
  REACTION_SOCKET_PROTOCOL,
  REACTION_SOCKET_PROTOCOL_V2,
  isInviteReaction,
  type InviteReaction,
  type InviteReactionEvent,
  type InviteReactionSnapshot,
  type InviteRoomSnapshot,
} from "@mons/shared/reactions";
import type { MatchPresentation } from "@mons/shared/match-presentation";
import type { MatchPresentationStore } from "./matchPresentationStore.ts";
import {
  selectRegisteredPresentations,
  type MatchPresentationRegistration,
} from "./matchPresentationRegistry.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import {
  readSocketSession,
  socketSessionCurrent,
  type SocketSessions,
} from "./socketSession.ts";
import {
  socketCapacityFull,
  type SocketCapacityLimits,
} from "./socketCapacity.ts";
import { acceptRoomSocket, sendSocketSnapshot } from "./socketUpgrade.ts";

type ReactionChannelDependencies = {
  presentations: Pick<
    MatchPresentationStore,
    "readPresentations" | "registeredPresentationSnapshot"
  >;
  pinnedInviteId: () => string;
  readRegistrations: (
    inviteId: string,
    matchId: string,
  ) => Promise<MatchPresentationRegistration[]>;
  scheduleAlarm: (atMs: number) => Promise<void>;
  capacityFull: (role: string) => boolean;
  socketSessions: Pick<SocketSessions, "send">;
  limits: SocketCapacityLimits;
};

type StoredReaction = {
  sender_uid: string;
  reaction_json: string;
};

function socketVersion(socket: WebSocket): 1 | 2 {
  return socket.deserializeAttachment()?.schemaVersion === 2 ? 2 : 1;
}

function isReactionSocket(socket: WebSocket): boolean {
  const channel = socket.deserializeAttachment()?.channel;
  return channel === undefined || channel === "reaction";
}

export type InviteReactionPublishResult =
  "published" | "duplicate" | "conflict" | "participant-limit";

export class ReactionChannel {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly dependencies: ReactionChannelDependencies,
  ) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS latest_reactions (sender_uid TEXT PRIMARY KEY, reaction_json TEXT NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
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
      (!matchId || matchId !== matchId.trim() || !isSafeRecordKey(matchId))
    ) {
      return new Response("Invalid presentation match", { status: 400 });
    }
    let canonicalActors: string[] | null = null;
    if (request.headers.get("X-Mons-Presentation-Canonical") === "1") {
      try {
        const value: unknown = JSON.parse(
          decodeURIComponent(
            request.headers.get("X-Mons-Presentation-Actors") || "",
          ),
        );
        if (
          version !== 2 ||
          !Array.isArray(value) ||
          !value.length ||
          value.length > 2 ||
          value.some((uid) => !isCanonicalLoginUid(uid))
        ) {
          return new Response("Invalid presentation actors", { status: 400 });
        }
        canonicalActors = value;
      } catch {
        return new Response("Invalid presentation actors", { status: 400 });
      }
    }
    if (!["host", "guest", "spectator"].includes(role) || ip.length > 64) {
      return new Response("Invalid reaction admission", { status: 400 });
    }
    const session = readSocketSession(request, role !== "spectator");
    if (!session) return new Response("Session expired", { status: 401 });
    if (session.authenticated)
      await this.dependencies.scheduleAlarm(session.authExpiresAtMs);
    let canonicalRegistrations: MatchPresentationRegistration[] | null = null;
    if (canonicalActors) {
      const inviteId = this.dependencies.pinnedInviteId();
      const actors = canonicalActors;
      const before = this.dependencies.presentations.readPresentations(
        matchId!,
      ).players;
      const read = async () =>
        (await this.dependencies.readRegistrations(inviteId, matchId!)).filter(
          (row) => actors.includes(row.actorUid),
        );
      canonicalRegistrations = await read();
      if (!canonicalRegistrations.length)
        throw new Error("match-presentation-unavailable");
      const registeredActors = new Set(
        canonicalRegistrations.map((row) => row.actorUid),
      );
      const missedUpdates = Object.values(
        this.dependencies.presentations.readPresentations(matchId!).players,
      )
        .filter(
          (value) =>
            actors.includes(value.actorUid) &&
            !registeredActors.has(value.actorUid) &&
            value.revision > (before[value.actorUid]?.revision ?? 0),
        )
        .map((value) => value.actorUid);
      if (missedUpdates.length) {
        canonicalRegistrations = await read();
        const refreshedActors = new Set(
          canonicalRegistrations.map((row) => row.actorUid),
        );
        if (missedUpdates.some((actorUid) => !refreshedActors.has(actorUid)))
          throw new Error("match-presentation-unavailable");
      }
    }
    if (!socketSessionCurrent(session))
      return new Response("Session expired", { status: 401 });
    const allSockets = this.ctx.getWebSockets();
    const reactionSockets = allSockets.filter(isReactionSocket);
    const roleCount = (value: string) =>
      this.ctx.getWebSockets(`role:${value}`).length;
    const spectatorCount =
      reactionSockets.length - roleCount("host") - roleCount("guest");
    const ipCount = this.ctx.getWebSockets(`spectator-ip:${ip}`).length;
    if (
      this.dependencies.capacityFull(role) ||
      socketCapacityFull(
        role,
        {
          sockets: reactionSockets.length,
          spectators: spectatorCount,
          spectatorsPerIp: ipCount,
          socketsForRole: roleCount(role),
        },
        this.dependencies.limits,
      )
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
            presentation: canonicalRegistrations
              ? selectRegisteredPresentations(
                  matchId!,
                  canonicalRegistrations,
                  this.dependencies.presentations.registeredPresentationSnapshot(
                    matchId!,
                  ),
                )
              : this.dependencies.presentations.readPresentations(matchId!),
          }
        : {
            schemaVersion: REACTION_PROTOCOL_VERSION,
            type: "snapshot",
            reactions,
          };
    const pair = acceptRoomSocket(
      this.ctx,
      {
        schemaVersion: version,
        matchId: version === 2 ? matchId : null,
        ...session,
      },
      [`role:${role}`, ...(role === "spectator" ? [`spectator-ip:${ip}`] : [])],
    );
    return sendSocketSnapshot(
      this.dependencies.socketSessions,
      pair,
      snapshot,
      protocol === REACTION_SOCKET_PROTOCOL ||
        protocol === REACTION_SOCKET_PROTOCOL_V2
        ? protocol
        : undefined,
    );
  }

  publish(
    senderUid: string,
    reaction: InviteReaction,
  ): InviteReactionPublishResult {
    if (!isCanonicalLoginUid(senderUid) || !isInviteReaction(reaction)) {
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
      if (isReactionSocket(socket)) {
        this.dependencies.socketSessions.send(
          socket,
          socketVersion(socket) === 2 ? v2Message : message,
        );
      }
    }
    return "published";
  }

  broadcastPresentation(
    matchId: string,
    presentation: MatchPresentation,
  ): void {
    const message = JSON.stringify({
      schemaVersion: 2,
      type: "presentation",
      presentation,
    });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (
        isReactionSocket(socket) &&
        attachment?.schemaVersion === 2 &&
        attachment.matchId === matchId
      )
        this.dependencies.socketSessions.send(socket, message);
    }
  }
}
