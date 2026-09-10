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
import {
  INVITE_WAGERS_REFRESH_MS,
  INVITE_WAGERS_SOCKET_PROTOCOL,
  type InviteWagersMessage,
  type InviteWagersSnapshot,
} from "@mons/shared/invite-wagers";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  normalizeInviteMetadata,
  type InviteMetadataReadResult,
} from "./inviteMetadata.ts";
import { createInviteSourceReader } from "./inviteSource.ts";
import {
  normalizeInviteWagers,
  type InviteWagersReadResult,
  type InviteWagersSourceResult,
} from "./inviteWagers.ts";
import { MatchSyncRoom } from "./matchSyncRoom.ts";
import type { MatchSyncReadResult } from "./matchSync.ts";
import {
  assertMatchPresentationRegistration,
  listMatchPresentationRegistrations,
  matchPresentationSeedDigest,
  selectRegisteredPresentations,
  type MatchPresentationRegistration,
  type MatchPresentationSeedRegistration,
  type RegisteredMatchPresentationSnapshot,
} from "./matchPresentationRegistry.ts";
import {
  readSocketSession,
  socketSessionCurrent,
  SocketSessions,
  type SocketSession,
} from "./socketSession.ts";

export const MAX_INVITE_REACTION_SOCKETS = 256;
export const MAX_INVITE_REACTION_SPECTATORS = 248;
export const MAX_INVITE_REACTION_SPECTATORS_PER_IP = 8;
export const MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT = 4;
export const MAX_INVITE_ROOM_SOCKETS = 512;
const PARTICIPANT_SOCKET_TAGS = [
  "role:host",
  "role:guest",
  "metadata-role:host",
  "metadata-role:guest",
  "wagers-role:host",
  "wagers-role:guest",
  "match-role:host",
  "match-role:guest",
];
const MAX_INVITE_ROOM_SPECTATOR_SOCKETS =
  MAX_INVITE_ROOM_SOCKETS -
  PARTICIPANT_SOCKET_TAGS.length * MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT;

type InviteChannel = "metadata" | "wagers";

type InviteReadResult = {
  metadata: InviteMetadataReadResult;
  wagers: InviteWagersReadResult;
};

type StoredMetadata = {
  invite_id: string;
  snapshot_json: string | null;
  revision: number;
};

type StoredWagers = StoredMetadata & {
  source_fingerprint: string | null;
};

type InviteSocketAttachment = {
  channel: InviteChannel;
  schemaVersion: 1;
  inviteId: string;
  role: "host" | "guest" | "spectator";
  actorUid: string | null;
} & SocketSession;

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

type StoredPresentationSeed = {
  invite_id: string;
  match_id: string;
  actor_uid: string;
  seed_digest: string;
  emoji_id: number;
  aura: string;
  provenance: "creation" | "backfill";
  source_id: string;
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

function isReactionSocket(socket: WebSocket): boolean {
  const channel = socket.deserializeAttachment()?.channel;
  return channel === undefined || channel === "reaction";
}

function canReceiveInvite(
  attachment: Pick<
    InviteSocketAttachment,
    "role" | "actorUid" | "authenticated"
  >,
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

function logWagersRefreshFailure(inviteId: string, error: unknown): void {
  console.error({
    event: "invite_wagers_refresh_failed",
    inviteId,
    kind: error instanceof Error ? error.name : "unknown",
  });
}

export type InviteReactionPublishResult =
  "published" | "duplicate" | "conflict" | "participant-limit";

export class InviteReactions extends DurableObject<Env> {
  private readonly matchSync: MatchSyncRoom;
  private readonly socketSessions: SocketSessions;
  private inviteReader: (inviteId: string) => Promise<unknown>;
  private inviteSequence: Promise<void> = Promise.resolve();
  private inviteAlarmSequence: Promise<void> = Promise.resolve();
  private queuedInviteRead: Promise<InviteReadResult> | null = null;
  private inviteRefreshGeneration = 0;
  private inviteResultGeneration = 0;
  private inviteInvalidationGeneration = 0;
  private inviteResultInvalidationGeneration = 0;
  private inviteResult: InviteReadResult | null = null;
  private inviteCheckedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.socketSessions = new SocketSessions(ctx);
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
      "CREATE TABLE IF NOT EXISTS match_presentation_seeds (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, invite_id TEXT NOT NULL, seed_digest TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, provenance TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(match_id, actor_uid))",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), invite_id TEXT NOT NULL, snapshot_json TEXT, revision INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_wagers (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), invite_id TEXT NOT NULL, snapshot_json TEXT, revision INTEGER NOT NULL, source_fingerprint TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_refresh_schedule (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), next_at_ms INTEGER NOT NULL)",
    );
    this.inviteReader = createInviteSourceReader(env);
    this.matchSync = new MatchSyncRoom(ctx, env, {
      pinInvite: (inviteId) => {
        this.pinInvite(inviteId);
      },
      readMetadata: async (inviteId) => {
        if (
          this.inviteResult &&
          this.inviteResultInvalidationGeneration ===
            this.inviteInvalidationGeneration &&
          Date.now() - this.inviteCheckedAt < INVITE_METADATA_REFRESH_MS
        )
          return this.inviteResult.metadata;
        return this.readMetadata(inviteId);
      },
      inviteGeneration: () => this.inviteInvalidationGeneration,
      scheduleAlarm: (atMs) => this.scheduleInviteAlarm(atMs),
      capacityFull: (role, ip) => this.matchRoomFull(role, ip),
      canReceive: canReceiveInvite,
      socketSessions: this.socketSessions,
    });
    this.ctx.setWebSocketAutoResponse();
    this.socketSessions.nextExpiry();
  }

  async fetch(request: Request): Promise<Response> {
    this.socketSessions.nextExpiry();
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/matches/socket") return this.matchSync.fetch(request);
    if (pathname === "/metadata/socket")
      return this.fetchInviteSocket(request, "metadata");
    if (pathname === "/wagers/socket")
      return this.fetchInviteSocket(request, "wagers");
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
          value.some((uid) => !isCanonicalFirebaseUid(uid))
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
      await this.scheduleInviteAlarm(session.authExpiresAtMs);
    let canonicalRegistrations: MatchPresentationRegistration[] | null = null;
    if (canonicalActors) {
      const { invite_id: inviteId } = this.ctx.storage.sql
        .exec<Pick<StoredMetadata, "invite_id">>(
          "SELECT invite_id FROM invite_metadata WHERE singleton = 1",
        )
        .one();
      const actors = canonicalActors;
      const before = this.readPresentations(matchId!).players;
      const read = async () =>
        (
          await listMatchPresentationRegistrations(
            this.env.PROFILE_GAMES_DB,
            inviteId,
            matchId!,
          )
        ).filter((row) => actors.includes(row.actorUid));
      canonicalRegistrations = await read();
      if (!canonicalRegistrations.length)
        throw new Error("match-presentation-unavailable");
      const registeredActors = new Set(
        canonicalRegistrations.map((row) => row.actorUid),
      );
      const missedUpdates = Object.values(
        this.readPresentations(matchId!).players,
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
      this.roomCapacityFull(role) ||
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
            presentation: canonicalRegistrations
              ? selectRegisteredPresentations(
                  matchId!,
                  canonicalRegistrations,
                  this.registeredPresentationSnapshot(matchId!),
                )
              : this.readPresentations(matchId!),
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
      ...session,
    });
    this.ctx.acceptWebSocket(pair[1], [
      `role:${role}`,
      ...(role === "spectator" ? [`spectator-ip:${ip}`] : []),
    ]);
    this.socketSessions.send(pair[1], JSON.stringify(snapshot));
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

  private inviteSockets(
    channel?: InviteChannel,
    activeOnly = false,
  ): WebSocket[] {
    return this.ctx
      .getWebSockets(channel ? `channel:${channel}` : undefined)
      .filter((socket) => {
        const attachment = socket.deserializeAttachment();
        return (
          (attachment?.channel === "metadata" ||
            attachment?.channel === "wagers") &&
          this.socketSessions.active(socket) &&
          (!activeOnly || socket.readyState === WebSocket.OPEN)
        );
      });
  }

  private pinInvite(inviteId: string): StoredMetadata {
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
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO invite_wagers (singleton, invite_id, snapshot_json, revision, source_fingerprint) VALUES (1, ?, NULL, 0, NULL)",
      inviteId,
    );
    return stored;
  }

  private serializeInvite<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.inviteSequence.then(work);
    this.inviteSequence = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private scheduleInviteAlarm(atMs: number): Promise<void> {
    const pending = this.inviteAlarmSequence.then(async () => {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > atMs) {
        await this.ctx.storage.setAlarm(atMs);
      }
    });
    this.inviteAlarmSequence = pending.catch(() => undefined);
    return pending;
  }

  private async scheduleInviteRefresh(atMs: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO invite_refresh_schedule (singleton, next_at_ms) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET next_at_ms = MIN(next_at_ms, excluded.next_at_ms)",
      atMs,
    );
    await this.scheduleInviteAlarm(atMs);
  }

  private applyMetadata(
    inviteId: string,
    result: InviteMetadataReadResult,
  ): InviteMetadataReadResult {
    const stored = this.pinInvite(inviteId);
    const sockets = this.inviteSockets("metadata", true);
    if (result.status !== "ok") {
      for (const socket of sockets) {
        socket.close(1008, "Invite metadata unavailable");
      }
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
        !canReceiveInvite(
          socket.deserializeAttachment() as InviteSocketAttachment,
          source,
        )
      ) {
        socket.close(1008, "Invite access changed");
      } else if (serialized) {
        this.socketSessions.send(socket, serialized);
      }
    }
    return source;
  }

  private applyWagers(
    result: InviteWagersSourceResult,
    metadata: InviteMetadataReadResult,
  ): InviteWagersReadResult {
    const sockets = this.inviteSockets("wagers", true);
    for (const socket of sockets) {
      if (
        metadata.status === "missing" ||
        (metadata.status === "ok" &&
          !canReceiveInvite(
            socket.deserializeAttachment() as InviteSocketAttachment,
            metadata,
          ))
      ) {
        socket.close(1008, "Invite access changed");
      }
    }
    if (result.status !== "ok" || metadata.status !== "ok") {
      return { status: result.status === "missing" ? "missing" : "invalid" };
    }
    const stored = this.ctx.storage.sql
      .exec<StoredWagers>("SELECT * FROM invite_wagers WHERE singleton = 1")
      .one();
    const changed = result.fingerprint !== stored.source_fingerprint;
    if (changed && stored.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("wagers-revision-exhausted");
    }
    const snapshot: InviteWagersSnapshot = {
      ...result.snapshot,
      revision: changed ? stored.revision + 1 : stored.revision,
    };
    if (changed) {
      this.ctx.storage.sql.exec(
        "UPDATE invite_wagers SET snapshot_json = ?, revision = ?, source_fingerprint = ? WHERE singleton = 1",
        JSON.stringify(snapshot),
        snapshot.revision,
        result.fingerprint,
      );
      const message: InviteWagersMessage = {
        schemaVersion: 1,
        type: "snapshot",
        snapshot,
      };
      const serialized = JSON.stringify(message);
      for (const socket of sockets) {
        if (
          canReceiveInvite(
            socket.deserializeAttachment() as InviteSocketAttachment,
            metadata,
          )
        ) {
          this.socketSessions.send(socket, serialized);
        }
      }
    }
    return { status: "ok", snapshot, metadata };
  }

  private async refreshInvite(inviteId: string): Promise<InviteReadResult> {
    this.pinInvite(inviteId);
    const generation = ++this.inviteRefreshGeneration;
    this.inviteResult = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const invalidationGeneration = this.inviteInvalidationGeneration;
      const value = await this.inviteReader(inviteId);
      const metadataSource = normalizeInviteMetadata(inviteId, value);
      let wagerSource: InviteWagersSourceResult;
      try {
        wagerSource = await normalizeInviteWagers(
          inviteId,
          value,
          metadataSource,
        );
      } catch (error) {
        logWagersRefreshFailure(inviteId, error);
        wagerSource = { status: "invalid" };
      }
      if (invalidationGeneration !== this.inviteInvalidationGeneration)
        continue;
      const metadata = this.applyMetadata(inviteId, metadataSource);
      let wagers: InviteWagersReadResult;
      try {
        wagers = this.applyWagers(wagerSource, metadata);
      } catch (error) {
        logWagersRefreshFailure(inviteId, error);
        wagers = { status: "invalid" };
      }
      const result = { metadata, wagers };
      this.inviteResult = result;
      this.inviteCheckedAt = Date.now();
      this.inviteResultGeneration = generation;
      this.inviteResultInvalidationGeneration = invalidationGeneration;
      return result;
    }
    throw new Error("invite-source-kept-changing");
  }

  private readInvite(inviteId: string): Promise<InviteReadResult> {
    this.pinInvite(inviteId);
    if (!this.queuedInviteRead) {
      this.queuedInviteRead = this.serializeInvite(() => {
        this.queuedInviteRead = null;
        return this.refreshInvite(inviteId);
      });
    }
    return this.queuedInviteRead;
  }

  async readMetadata(inviteId: string): Promise<InviteMetadataReadResult> {
    return (await this.readInvite(inviteId)).metadata;
  }

  async readWagers(inviteId: string): Promise<InviteWagersReadResult> {
    return (await this.readInvite(inviteId)).wagers;
  }

  async readMatches(
    inviteId: string,
    matchId: string,
  ): Promise<MatchSyncReadResult> {
    return this.matchSync.read(inviteId, matchId);
  }

  async notifyMatchesChanged(
    inviteId: string,
    matchIds?: string[],
  ): Promise<void> {
    await this.matchSync.notify(inviteId, matchIds);
  }

  async notifyMetadataChanged(inviteId: string): Promise<void> {
    this.inviteInvalidationGeneration++;
    await this.matchSync.notify(inviteId);
    if (this.inviteSockets(undefined, true).length === 0) return;
    this.pinInvite(inviteId);
    await this.scheduleInviteRefresh(Date.now());
  }

  async notifyWagersChanged(inviteId: string): Promise<void> {
    this.inviteInvalidationGeneration++;
    if (this.inviteSockets("wagers", true).length === 0) return;
    this.pinInvite(inviteId);
    await this.scheduleInviteRefresh(Date.now());
  }

  async alarm(): Promise<void> {
    this.socketSessions.nextExpiry();
    await this.serializeInvite(async () => {
      const sockets = this.inviteSockets(undefined, true);
      if (sockets.length === 0) {
        this.ctx.storage.sql.exec("DELETE FROM invite_refresh_schedule");
        return;
      }
      const [scheduled] = this.ctx.storage.sql
        .exec<{ next_at_ms: number }>(
          "SELECT next_at_ms FROM invite_refresh_schedule WHERE singleton = 1",
        )
        .toArray();
      if (scheduled && scheduled.next_at_ms > Date.now()) return;
      this.ctx.storage.sql.exec("DELETE FROM invite_refresh_schedule");
      await this.scheduleInviteRefresh(
        Date.now() +
          Math.min(INVITE_METADATA_REFRESH_MS, INVITE_WAGERS_REFRESH_MS),
      );
      const attachment =
        sockets[0].deserializeAttachment() as InviteSocketAttachment;
      try {
        await this.refreshInvite(attachment.inviteId);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "invite_source_refresh_failed",
            inviteId: attachment.inviteId,
            kind: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    });
    await this.matchSync.alarm();
    const [scheduled] = this.ctx.storage.sql
      .exec<{ next_at_ms: number }>(
        "SELECT next_at_ms FROM invite_refresh_schedule WHERE singleton = 1",
      )
      .toArray();
    const nextMatch = this.matchSync.nextAlarm();
    const due = [
      scheduled?.next_at_ms,
      nextMatch,
      this.socketSessions.nextExpiry(),
    ].filter((value): value is number => typeof value === "number");
    if (due.length) await this.scheduleInviteAlarm(Math.min(...due));
  }

  private matchRoomFull(role: string, ip: string): boolean {
    return (
      this.roomCapacityFull(role) ||
      this.ctx.getWebSockets("channel:matches").length >=
        MAX_INVITE_REACTION_SOCKETS ||
      (role === "spectator"
        ? this.ctx.getWebSockets("match-role:spectator").length >=
            MAX_INVITE_REACTION_SPECTATORS ||
          this.ctx.getWebSockets(`match-ip:${ip}`).length >=
            MAX_INVITE_REACTION_SPECTATORS_PER_IP
        : this.ctx.getWebSockets(`match-role:${role}`).length >=
          MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT)
    );
  }

  private roomCapacityFull(role: string): boolean {
    const total = this.ctx.getWebSockets().length;
    if (total >= MAX_INVITE_ROOM_SOCKETS) return true;
    if (role !== "spectator") return false;
    const participants = PARTICIPANT_SOCKET_TAGS.reduce(
      (count, tag) => count + this.ctx.getWebSockets(tag).length,
      0,
    );
    return total - participants >= MAX_INVITE_ROOM_SPECTATOR_SOCKETS;
  }

  private inviteRoomFull(
    channel: InviteChannel,
    role: string,
    ip: string,
  ): boolean {
    const sockets = this.inviteSockets(channel);
    const roleCount = (value: string) =>
      this.ctx.getWebSockets(`${channel}-role:${value}`).length;
    return (
      this.roomCapacityFull(role) ||
      sockets.length >= MAX_INVITE_REACTION_SOCKETS ||
      (role === "spectator"
        ? roleCount("spectator") >= MAX_INVITE_REACTION_SPECTATORS ||
          this.ctx.getWebSockets(`${channel}-ip:${ip}`).length >=
            MAX_INVITE_REACTION_SPECTATORS_PER_IP
        : roleCount(role) >= MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT)
    );
  }

  private async fetchInviteSocket(
    request: Request,
    channel: InviteChannel,
  ): Promise<Response> {
    const name = channel === "metadata" ? "Metadata" : "Wagers";
    const protocol =
      channel === "metadata"
        ? INVITE_METADATA_SOCKET_PROTOCOL
        : INVITE_WAGERS_SOCKET_PROTOCOL;
    const header = (field: string) =>
      request.headers.get(`X-Mons-${name}-${field}`);
    let inviteId: string;
    let actorUid: string | null;
    try {
      inviteId = decodeURIComponent(header("Invite") || "");
      const actor = header("Actor");
      actorUid = actor ? decodeURIComponent(actor) : null;
      this.pinInvite(inviteId);
    } catch {
      return new Response(`Invalid ${channel} invite`, { status: 400 });
    }
    const role = header("Role");
    const ip = header("IP") || "unknown";
    const expectedRevision = header("Revision");
    const protectedHeader = header("Protected");
    const authenticated = header("Authenticated");
    if (
      request.headers.get("Sec-WebSocket-Protocol") !== protocol ||
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
      return new Response(`Invalid ${channel} admission`, { status: 400 });
    }
    const session = readSocketSession(request, authenticated === "1");
    if (!session) return new Response("Session expired", { status: 401 });
    const attachment: InviteSocketAttachment = {
      channel,
      schemaVersion: 1,
      inviteId,
      role,
      actorUid,
      ...session,
    };
    const observedGeneration = this.inviteRefreshGeneration;
    return this.serializeInvite(async () => {
      if (this.inviteRoomFull(channel, role, ip)) {
        return new Response(`${name} room is full`, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      if (session.authenticated)
        await this.scheduleInviteAlarm(session.authExpiresAtMs);
      await this.scheduleInviteRefresh(
        Date.now() +
          (channel === "metadata"
            ? INVITE_METADATA_REFRESH_MS
            : INVITE_WAGERS_REFRESH_MS),
      );
      const latest =
        this.inviteResult &&
        this.inviteResultGeneration > observedGeneration &&
        this.inviteResultInvalidationGeneration ===
          this.inviteInvalidationGeneration
          ? this.inviteResult
          : await this.refreshInvite(inviteId);
      const source = latest[channel];
      if (source.status !== "ok" || latest.metadata.status !== "ok") {
        return new Response(`Invite ${channel} unavailable`, {
          status: source.status === "missing" ? 404 : 409,
        });
      }
      if (
        source.snapshot.revision !== Number(expectedRevision) ||
        latest.metadata.passwordProtected !== (protectedHeader === "1")
      ) {
        return new Response(`Invite ${channel} changed`, { status: 409 });
      }
      if (!canReceiveInvite(attachment, latest.metadata)) {
        return new Response("Invite access denied", { status: 403 });
      }
      if (!socketSessionCurrent(session))
        return new Response("Session expired", { status: 401 });
      if (this.inviteRoomFull(channel, role, ip)) {
        return new Response(`${name} room is full`, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      const pair = new WebSocketPair();
      pair[1].serializeAttachment(attachment);
      this.ctx.acceptWebSocket(pair[1], [
        `channel:${channel}`,
        `${channel}-role:${role}`,
        ...(role === "spectator" ? [`${channel}-ip:${ip}`] : []),
      ]);
      const message = {
        schemaVersion: 1,
        type: "snapshot",
        snapshot: source.snapshot,
      };
      this.socketSessions.send(pair[1], JSON.stringify(message));
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": protocol },
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
      if (isReactionSocket(socket)) {
        this.socketSessions.send(
          socket,
          socketVersion(socket) === 2 ? v2Message : message,
        );
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
      if (
        !Object.hasOwn(current.players, actorUid) &&
        this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM match_presentation_seeds WHERE match_id = ? AND actor_uid = ?",
            matchId,
            actorUid,
          )
          .toArray().length
      ) {
        throw new Error("match-presentation-unavailable");
      }
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

  private readCanonicalPresentationPlayers(
    matchId: string,
    actorUids: readonly string[],
  ): MatchPresentationSnapshot {
    const snapshot = this.registeredPresentationSnapshot(matchId);
    const players = Object.fromEntries(
      actorUids.map((actorUid) => {
        if (!Object.hasOwn(snapshot.players, actorUid))
          throw new Error("match-presentation-unavailable");
        return [actorUid, snapshot.players[actorUid]];
      }),
    );
    return { matchId, players };
  }

  private registeredPresentationSnapshot(
    matchId: string,
  ): RegisteredMatchPresentationSnapshot {
    if (!isSafeFirebaseKey(matchId))
      throw new TypeError("invalid-presentation-match");
    const seeds = this.ctx.storage.sql
      .exec<StoredPresentationSeed>(
        "SELECT * FROM match_presentation_seeds WHERE match_id = ? ORDER BY actor_uid",
        matchId,
      )
      .toArray();
    const current = this.readPresentations(matchId);
    const players = Object.fromEntries(
      seeds.map((seed) => {
        if (!Object.hasOwn(current.players, seed.actor_uid))
          throw new Error("match-presentation-unavailable");
        return [seed.actor_uid, current.players[seed.actor_uid]];
      }),
    );
    const seedDigests = Object.fromEntries(
      seeds.map((seed) => [seed.actor_uid, seed.seed_digest]),
    );
    const snapshot = { matchId, players, seedDigests };
    if (!isMatchPresentationSnapshot({ matchId, players }))
      throw new Error("match-presentation-unavailable");
    return snapshot;
  }

  async registerPresentationSeeds(
    inviteId: string,
    seeds: MatchPresentationSeedRegistration[],
  ): Promise<MatchPresentationRegistration[]> {
    if (!seeds.length || seeds.length > 100)
      throw new TypeError("invalid-presentation-seed-batch");
    for (const seed of seeds) {
      assertMatchPresentationRegistration(seed);
      if (
        seed.inviteId !== inviteId ||
        (await matchPresentationSeedDigest(seed)) !== seed.seedDigest
      )
        throw new TypeError("invalid-presentation-seed-digest");
    }
    return this.ctx.storage.transactionSync(() => {
      this.pinInvite(inviteId);
      return seeds.map((seed) => {
        const existing = this.ctx.storage.sql
          .exec<StoredPresentationSeed>(
            "SELECT * FROM match_presentation_seeds WHERE match_id = ? AND actor_uid = ?",
            seed.matchId,
            seed.actorUid,
          )
          .toArray()[0];
        if (
          existing &&
          (existing.invite_id !== inviteId ||
            existing.seed_digest !== seed.seedDigest ||
            existing.emoji_id !== seed.emojiId ||
            existing.aura !== seed.aura)
        ) {
          throw new Error("match-presentation-seed-conflict");
        }
        if (
          existing &&
          !Object.hasOwn(
            this.readPresentations(seed.matchId).players,
            seed.actorUid,
          )
        ) {
          throw new Error("match-presentation-unavailable");
        }
        this.initializePresentations(seed.matchId, {
          [seed.actorUid]: { emojiId: seed.emojiId, aura: seed.aura },
        });
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO match_presentation_seeds (match_id, actor_uid, invite_id, seed_digest, emoji_id, aura, provenance, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          seed.matchId,
          seed.actorUid,
          inviteId,
          seed.seedDigest,
          seed.emojiId,
          seed.aura,
          seed.provenance,
          seed.sourceId,
        );
        const snapshot = this.registeredPresentationSnapshot(seed.matchId);
        if (snapshot.seedDigests[seed.actorUid] !== seed.seedDigest)
          throw new Error("match-presentation-seed-unacknowledged");
        return {
          inviteId,
          matchId: seed.matchId,
          actorUid: seed.actorUid,
          seedDigest: seed.seedDigest,
          provenance: existing?.provenance || seed.provenance,
          sourceId: existing?.source_id || seed.sourceId,
        };
      });
    });
  }

  async getRegisteredPresentationSnapshot(
    matchId: string,
  ): Promise<RegisteredMatchPresentationSnapshot> {
    return this.registeredPresentationSnapshot(matchId);
  }

  async getFrozenPresentationSnapshot(
    matchId: string,
  ): Promise<MatchPresentationSnapshot> {
    if (!isSafeFirebaseKey(matchId))
      throw new TypeError("invalid-presentation-match");
    return this.readPresentations(matchId, true);
  }

  async freezeRegisteredPresentations(
    matchId: string,
    actorUids: string[],
  ): Promise<MatchPresentationSnapshot> {
    if (
      !actorUids.length ||
      actorUids.length > 2 ||
      actorUids.some((uid) => !isCanonicalFirebaseUid(uid))
    )
      throw new TypeError("invalid-presentation-actors");
    return this.ctx.storage.transactionSync(() => {
      const frozen = this.readPresentations(matchId, true);
      const missing = actorUids.filter(
        (uid) => !Object.hasOwn(frozen.players, uid),
      );
      if (missing.length) {
        const snapshot = this.readCanonicalPresentationPlayers(
          matchId,
          missing,
        );
        for (const actorUid of missing) {
          const value = snapshot.players[actorUid];
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO frozen_match_presentations (match_id, actor_uid, emoji_id, aura, revision) VALUES (?, ?, ?, ?, ?)",
            matchId,
            actorUid,
            value.emojiId,
            value.aura,
            value.revision,
          );
        }
      }
      return this.readPresentations(matchId, true);
    });
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
        if (
          isReactionSocket(socket) &&
          attachment?.schemaVersion === 2 &&
          attachment.matchId === matchId
        )
          this.socketSessions.send(socket, message);
      }
    }
    return result;
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (!this.socketSessions.active(socket)) {
      this.matchSync.closed(socket);
      return;
    }
    if (message === REACTION_HEARTBEAT_REQUEST) {
      this.socketSessions.send(socket, REACTION_HEARTBEAT_RESPONSE);
      return;
    }
    socket.close(1008, "Reaction sockets are receive-only");
    this.matchSync.closed(socket);
  }

  webSocketClose(socket: WebSocket): void {
    socket.close();
    this.matchSync.closed(socket);
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Reaction connection failed");
    this.matchSync.closed(socket);
  }
}
