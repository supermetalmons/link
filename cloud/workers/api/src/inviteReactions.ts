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
import {
  INVITE_METADATA_REFRESH_MS,
  INVITE_METADATA_SOCKET_PROTOCOL,
  type InviteMetadataMessage,
  type InviteMetadataSnapshot,
} from "@mons/shared/invite-metadata";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  createInviteMetadataReader,
  type InviteMetadataReadResult,
} from "./inviteMetadata.ts";

export const MAX_INVITE_REACTION_SOCKETS = 256;
export const MAX_INVITE_REACTION_SPECTATORS = 248;
export const MAX_INVITE_REACTION_SPECTATORS_PER_IP = 8;
export const MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT = 4;
export const MAX_INVITE_ROOM_SOCKETS = 512;

const METADATA_SOCKET_TAG = "channel:metadata";

type StoredMetadata = {
  invite_id: string;
  snapshot_json: string | null;
  revision: number;
};

type MetadataSocketAttachment = {
  channel: "metadata";
  schemaVersion: 1;
  inviteId: string;
  role: "host" | "guest" | "spectator";
  actorUid: string | null;
  authenticated: boolean;
};

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

function isMetadataSocket(socket: WebSocket): boolean {
  return socket.deserializeAttachment()?.channel === "metadata";
}

function canReceiveMetadata(
  attachment: MetadataSocketAttachment,
  source: Extract<InviteMetadataReadResult, { status: "ok" }>,
): boolean {
  if (attachment.role === "host") {
    return (
      attachment.authenticated && attachment.actorUid === source.snapshot.hostId
    );
  }
  if (attachment.role === "guest") {
    return (
      attachment.authenticated &&
      source.snapshot.guestId !== null &&
      attachment.actorUid === source.snapshot.guestId
    );
  }
  return (
    source.snapshot.guestId !== null ||
    (attachment.authenticated && !source.passwordProtected)
  );
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
  private metadataReader: (
    inviteId: string,
  ) => Promise<InviteMetadataReadResult>;
  private metadataSequence: Promise<void> = Promise.resolve();
  private metadataAlarmSequence: Promise<void> = Promise.resolve();
  private metadataRead: Promise<InviteMetadataReadResult> | null = null;
  private metadataRefreshGeneration = 0;
  private metadataResultGeneration = 0;
  private metadataResult: InviteMetadataReadResult | null = null;

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
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), invite_id TEXT NOT NULL, snapshot_json TEXT, revision INTEGER NOT NULL)",
    );
    this.metadataReader = createInviteMetadataReader(env);
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
    if (new URL(request.url).pathname === "/metadata/socket") {
      return this.fetchMetadataSocket(request);
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
    const reactionSockets = allSockets.filter(
      (socket) => !isMetadataSocket(socket),
    );
    const roleCount = (value: string) =>
      this.ctx.getWebSockets(`role:${value}`).length;
    const spectatorCount =
      reactionSockets.length - roleCount("host") - roleCount("guest");
    const ipCount = this.ctx.getWebSockets(`spectator-ip:${ip}`).length;
    if (
      allSockets.length >= MAX_INVITE_ROOM_SOCKETS ||
      reactionSockets.length >= MAX_INVITE_REACTION_SOCKETS ||
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

  private metadataSockets(activeOnly = false): WebSocket[] {
    return this.ctx
      .getWebSockets(METADATA_SOCKET_TAG)
      .filter((socket) => !activeOnly || socket.readyState === WebSocket.OPEN);
  }

  private pinMetadataInvite(inviteId: string): StoredMetadata {
    if (
      inviteId !== inviteId.trim() ||
      !isSafeFirebaseKey(inviteId) ||
      (this.ctx.id.name && this.ctx.id.name !== inviteId)
    ) {
      throw new TypeError("invalid-metadata-invite");
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO invite_metadata (singleton, invite_id, snapshot_json, revision) VALUES (1, ?, NULL, 0)",
      inviteId,
    );
    const stored = this.ctx.storage.sql
      .exec<StoredMetadata>("SELECT * FROM invite_metadata WHERE singleton = 1")
      .one();
    if (stored.invite_id !== inviteId) {
      throw new TypeError("metadata-invite-conflict");
    }
    return stored;
  }

  private serializeMetadata<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.metadataSequence.then(work);
    this.metadataSequence = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private scheduleMetadataAlarm(atMs: number): Promise<void> {
    const pending = this.metadataAlarmSequence.then(async () => {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > atMs) {
        await this.ctx.storage.setAlarm(atMs);
      }
    });
    this.metadataAlarmSequence = pending.catch(() => undefined);
    return pending;
  }

  private async refreshMetadata(
    inviteId: string,
  ): Promise<InviteMetadataReadResult> {
    const stored = this.pinMetadataInvite(inviteId);
    const generation = ++this.metadataRefreshGeneration;
    this.metadataResult = null;
    const result = await this.metadataReader(inviteId);
    const sockets = this.metadataSockets(true);
    if (result.status !== "ok") {
      for (const socket of sockets) {
        socket.close(1008, "Invite metadata unavailable");
      }
      this.metadataResult = result;
      this.metadataResultGeneration = generation;
      return result;
    }
    const comparison = { ...result.snapshot, revision: stored.revision };
    const changed = JSON.stringify(comparison) !== stored.snapshot_json;
    if (changed && stored.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("metadata-revision-exhausted");
    }
    const snapshot: InviteMetadataSnapshot = {
      ...comparison,
      revision: changed ? stored.revision + 1 : stored.revision,
    };
    if (changed) {
      this.ctx.storage.sql.exec(
        "UPDATE invite_metadata SET snapshot_json = ?, revision = ? WHERE singleton = 1",
        JSON.stringify(snapshot),
        snapshot.revision,
      );
    }
    const source = { ...result, snapshot };
    const message: InviteMetadataMessage = {
      schemaVersion: 1,
      type: "snapshot",
      snapshot,
    };
    const serialized = changed ? JSON.stringify(message) : null;
    for (const socket of sockets) {
      if (
        !canReceiveMetadata(
          socket.deserializeAttachment() as MetadataSocketAttachment,
          source,
        )
      ) {
        socket.close(1008, "Invite access changed");
      } else if (serialized) {
        send(socket, serialized);
      }
    }
    this.metadataResult = source;
    this.metadataResultGeneration = generation;
    return source;
  }

  async readMetadata(inviteId: string): Promise<InviteMetadataReadResult> {
    this.pinMetadataInvite(inviteId);
    if (!this.metadataRead) {
      const pending = this.serializeMetadata(() =>
        this.refreshMetadata(inviteId),
      );
      this.metadataRead = pending;
      void pending.then(
        () => {
          if (this.metadataRead === pending) this.metadataRead = null;
        },
        () => {
          if (this.metadataRead === pending) this.metadataRead = null;
        },
      );
    }
    return this.metadataRead;
  }

  async notifyMetadataChanged(inviteId: string): Promise<void> {
    if (this.metadataSockets(true).length === 0) return;
    this.pinMetadataInvite(inviteId);
    await this.scheduleMetadataAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    await this.serializeMetadata(async () => {
      const sockets = this.metadataSockets(true);
      if (sockets.length === 0) return;
      await this.scheduleMetadataAlarm(Date.now() + INVITE_METADATA_REFRESH_MS);
      const attachment =
        sockets[0].deserializeAttachment() as MetadataSocketAttachment;
      try {
        await this.refreshMetadata(attachment.inviteId);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "invite_metadata_refresh_failed",
            inviteId: attachment.inviteId,
            kind: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    });
  }

  private metadataRoomFull(role: string, ip: string): boolean {
    const sockets = this.metadataSockets();
    const roleCount = (value: string) =>
      this.ctx.getWebSockets(`metadata-role:${value}`).length;
    return (
      this.ctx.getWebSockets().length >= MAX_INVITE_ROOM_SOCKETS ||
      sockets.length >= MAX_INVITE_REACTION_SOCKETS ||
      (role === "spectator"
        ? roleCount("spectator") >= MAX_INVITE_REACTION_SPECTATORS ||
          this.ctx.getWebSockets(`metadata-ip:${ip}`).length >=
            MAX_INVITE_REACTION_SPECTATORS_PER_IP
        : roleCount(role) >= MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT)
    );
  }

  private async fetchMetadataSocket(request: Request): Promise<Response> {
    let inviteId: string;
    let actorUid: string | null;
    try {
      inviteId = decodeURIComponent(
        request.headers.get("X-Mons-Metadata-Invite") || "",
      );
      const actor = request.headers.get("X-Mons-Metadata-Actor");
      actorUid = actor ? decodeURIComponent(actor) : null;
      this.pinMetadataInvite(inviteId);
    } catch {
      return new Response("Invalid metadata invite", { status: 400 });
    }
    const role = request.headers.get("X-Mons-Metadata-Role");
    const ip = request.headers.get("X-Mons-Metadata-IP") || "unknown";
    const expectedRevision = request.headers.get("X-Mons-Metadata-Revision");
    const protectedHeader = request.headers.get("X-Mons-Metadata-Protected");
    const authenticated = request.headers.get("X-Mons-Metadata-Authenticated");
    if (
      request.headers.get("Sec-WebSocket-Protocol") !==
        INVITE_METADATA_SOCKET_PROTOCOL ||
      (role !== "host" && role !== "guest" && role !== "spectator") ||
      ip.length > 64 ||
      !expectedRevision ||
      !/^[1-9]\d*$/.test(expectedRevision) ||
      !Number.isSafeInteger(Number(expectedRevision)) ||
      (protectedHeader !== "0" && protectedHeader !== "1") ||
      (authenticated !== "0" && authenticated !== "1") ||
      (role === "spectator"
        ? actorUid !== null
        : !isCanonicalFirebaseUid(actorUid))
    ) {
      return new Response("Invalid metadata admission", { status: 400 });
    }
    const attachment: MetadataSocketAttachment = {
      channel: "metadata",
      schemaVersion: 1,
      inviteId,
      role,
      actorUid,
      authenticated: authenticated === "1",
    };
    const observedGeneration = this.metadataRefreshGeneration;
    return this.serializeMetadata(async () => {
      if (this.metadataRoomFull(role, ip)) {
        return new Response("Metadata room is full", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      await this.scheduleMetadataAlarm(Date.now() + INVITE_METADATA_REFRESH_MS);
      const source =
        this.metadataResult &&
        this.metadataResultGeneration > observedGeneration
          ? this.metadataResult
          : await this.refreshMetadata(inviteId);
      if (source.status !== "ok") {
        return new Response("Invite metadata unavailable", {
          status: source.status === "missing" ? 404 : 409,
        });
      }
      if (
        source.snapshot.revision !== Number(expectedRevision) ||
        source.passwordProtected !== (protectedHeader === "1")
      ) {
        return new Response("Invite metadata changed", { status: 409 });
      }
      if (!canReceiveMetadata(attachment, source)) {
        return new Response("Invite access denied", { status: 403 });
      }
      if (this.metadataRoomFull(role, ip)) {
        return new Response("Metadata room is full", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      const pair = new WebSocketPair();
      pair[1].serializeAttachment(attachment);
      this.ctx.acceptWebSocket(pair[1], [
        METADATA_SOCKET_TAG,
        `metadata-role:${role}`,
        ...(role === "spectator" ? [`metadata-ip:${ip}`] : []),
      ]);
      const message: InviteMetadataMessage = {
        schemaVersion: 1,
        type: "snapshot",
        snapshot: source.snapshot,
      };
      pair[1].send(JSON.stringify(message));
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": INVITE_METADATA_SOCKET_PROTOCOL },
      });
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
      if (!isMetadataSocket(socket)) {
        send(socket, socketVersion(socket) === 2 ? v2Message : message);
      }
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
