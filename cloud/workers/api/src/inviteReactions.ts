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
import type {
  MatchPresentationSnapshot,
  UpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";
import type { InviteMetadataReadResult } from "./inviteMetadata.ts";
import type { InviteWagersReadResult } from "./inviteWagers.ts";
import { InviteChannelsRoom, canReceiveInvite } from "./inviteChannelsRoom.ts";
import {
  MatchPresentationStore,
  type MatchPresentationSeeds,
  type MatchPresentationUpdateResult,
} from "./matchPresentationStore.ts";

import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import { createInviteSourceReader } from "./inviteSource.ts";
import {
  createWagerStateD1Store,
  type WagerStateSnapshot,
} from "./wagerStateD1.ts";
import { MatchSyncRoom } from "./matchSyncRoom.ts";
import type { MatchSyncMetadata, MatchSyncReadResult } from "./matchSync.ts";
import { MatchStateStore } from "./matchStateStore.ts";
import { captureMatchStateRpc, type MatchStateRpc } from "./matchStateRpc.ts";
import type {
  MatchStateClaimTimerRequest,
  MatchStateCreateRequest,
  MatchStateEffect,
  MatchStateEventEffectsRequest,
  MatchStateMoveRequest,
  MatchStatePairRequest,
  MatchStateRecordRequest,
  MatchStateStartTimerRequest,
  MatchStateSurrenderRequest,
} from "./matchStateTypes.ts";
import { createMatchTimerStartStore } from "./gameplayCoordinationD1.ts";
import {
  acquireEventWriteAdmission,
  patchEventOwnedPaths,
  releaseEventWriteAdmission,
} from "./eventD1.ts";
import {
  buildEventProgressPlan,
  ensureEventProgressWorkflow,
} from "./eventProgress.ts";
import { assertProfileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";
import {
  listMatchPresentationRegistrations,
  selectRegisteredPresentations,
  type MatchPresentationRegistration,
  type MatchPresentationSeedRegistration,
  type RegisteredMatchPresentationSnapshot,
} from "./matchPresentationRegistry.ts";
import {
  readSocketSession,
  socketSessionCurrent,
  SocketSessions,
} from "./socketSession.ts";

export type {
  MatchPresentationSeeds,
  MatchPresentationUpdateResult,
} from "./matchPresentationStore.ts";

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

export class InviteReactions
  extends DurableObject<Env>
  implements MatchStateRpc
{
  private readonly matchSync: MatchSyncRoom;
  private readonly matchState: MatchStateStore;
  private readonly socketSessions: SocketSessions;
  private matchEffectsPending: Promise<void> | null = null;
  private inviteReader: (inviteId: string) => Promise<unknown>;
  private wagerReader: (inviteId: string) => Promise<WagerStateSnapshot[]>;
  private inviteAlarmSequence: Promise<void> = Promise.resolve();
  private readonly inviteChannels: InviteChannelsRoom;
  private readonly presentations: MatchPresentationStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.socketSessions = new SocketSessions(ctx);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS latest_reactions (sender_uid TEXT PRIMARY KEY, reaction_json TEXT NOT NULL)",
    );
    this.inviteReader = createInviteSourceReader(env);
    this.wagerReader = createWagerStateD1Store(env.PROFILE_DB).readInvite;
    this.inviteChannels = new InviteChannelsRoom(ctx, {
      readInvite: (inviteId) => this.inviteReader(inviteId),
      readWagerStates: (inviteId) => this.wagerReader(inviteId),
      scheduleAlarm: (atMs) => this.scheduleInviteAlarm(atMs),
      capacityFull: (role) => this.roomCapacityFull(role),
      socketSessions: this.socketSessions,
      limits: {
        sockets: MAX_INVITE_REACTION_SOCKETS,
        spectators: MAX_INVITE_REACTION_SPECTATORS,
        spectatorsPerIp: MAX_INVITE_REACTION_SPECTATORS_PER_IP,
        socketsPerParticipant: MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT,
      },
    });
    this.presentations = new MatchPresentationStore(ctx.storage, {
      pinInvite: (inviteId) => this.inviteChannels.pinInvite(inviteId),
    });
    this.matchState = new MatchStateStore(ctx.storage, {
      timerStarts: createMatchTimerStartStore(env.PROFILE_GAMES_DB),
      scheduleAlarm: (atMs, transaction) =>
        this.scheduleInviteAlarm(atMs, transaction),
    });
    this.matchSync = new MatchSyncRoom(ctx, {
      pinInvite: (inviteId) => {
        this.inviteChannels.pinInvite(inviteId);
      },
      readMetadata: (inviteId) =>
        this.inviteChannels.readMetadata(inviteId, true),
      inviteGeneration: () => this.inviteChannels.invalidationGeneration(),
      sourceEpoch: () => this.matchState.readSource().epoch,
      readPair: (metadata, matchId) => this.readMatchPair(metadata, matchId),
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
      return this.inviteChannels.fetch(request, "metadata");
    if (pathname === "/wagers/socket")
      return this.inviteChannels.fetch(request, "wagers");
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
      await this.scheduleInviteAlarm(session.authExpiresAtMs);
    let canonicalRegistrations: MatchPresentationRegistration[] | null = null;
    if (canonicalActors) {
      const inviteId = this.inviteChannels.pinnedInviteId();
      const actors = canonicalActors;
      const before = this.presentations.readPresentations(matchId!).players;
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
        this.presentations.readPresentations(matchId!).players,
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
                  this.presentations.registeredPresentationSnapshot(matchId!),
                )
              : this.presentations.readPresentations(matchId!),
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

  private scheduleInviteAlarm(
    atMs: number,
    transaction?: Pick<DurableObjectTransaction, "getAlarm" | "setAlarm">,
  ): Promise<void> {
    const schedule = async (
      storage: Pick<DurableObjectTransaction, "getAlarm" | "setAlarm">,
    ) => {
      const current = await storage.getAlarm();
      if (current === null || current > atMs) {
        await storage.setAlarm(atMs);
      }
    };
    if (transaction) return schedule(transaction);
    const pending = this.inviteAlarmSequence.then(() =>
      this.ctx.storage.transaction(schedule),
    );
    this.inviteAlarmSequence = pending.catch(() => undefined);
    return pending;
  }

  async readMetadata(inviteId: string): Promise<InviteMetadataReadResult> {
    return this.inviteChannels.readMetadata(inviteId);
  }

  async readWagers(inviteId: string): Promise<InviteWagersReadResult> {
    return this.inviteChannels.readWagers(inviteId);
  }

  async readMatches(
    inviteId: string,
    matchId: string,
  ): Promise<MatchSyncReadResult> {
    return this.matchSync.read(inviteId, matchId);
  }

  private async readMatchPair(
    metadata: MatchSyncMetadata,
    matchId: string,
  ): Promise<[unknown, unknown]> {
    const local = () => {
      const source = this.matchState.readSource();
      const pair = this.matchState.readPair({
        inviteId: metadata.snapshot.inviteId,
        epoch: source.epoch,
        matchId,
        playerId: metadata.snapshot.hostId,
        opponentId: metadata.snapshot.guestId,
      });
      return [pair.playerMatch, pair.opponentMatch] as [unknown, unknown];
    };
    return local();
  }

  async readCanonicalMatchRecord(input: MatchStateRecordRequest) {
    return captureMatchStateRpc(() => {
      this.inviteChannels.pinInvite(input.inviteId);
      return this.matchState.readRecord(input);
    });
  }

  async readCanonicalMatchPair(input: MatchStatePairRequest) {
    return captureMatchStateRpc(() => {
      this.inviteChannels.pinInvite(input.inviteId);
      return this.matchState.readPair(input);
    });
  }

  async createCanonicalMatch(input: MatchStateCreateRequest) {
    return captureMatchStateRpc(async () => {
      this.inviteChannels.pinInvite(input.inviteId);
      const result = this.matchState.createRecords(input);
      await this.notifyCanonicalMatches(input.inviteId, result.changedMatchIds);
      return result;
    });
  }

  async submitCanonicalMove(input: MatchStateMoveRequest) {
    return captureMatchStateRpc(async () => {
      this.inviteChannels.pinInvite(input.inviteId);
      const result = this.matchState.move(input);
      await this.notifyCanonicalMatches(input.inviteId, [input.matchId]);
      return result;
    });
  }

  async surrenderCanonicalMatch(input: MatchStateSurrenderRequest) {
    return captureMatchStateRpc(async () => {
      this.inviteChannels.pinInvite(input.inviteId);
      const result = this.matchState.surrender(input);
      await this.notifyCanonicalMatches(input.inviteId, [input.matchId]);
      return result;
    });
  }

  async startCanonicalMatchTimer(input: MatchStateStartTimerRequest) {
    return captureMatchStateRpc(async () => {
      this.inviteChannels.pinInvite(input.inviteId);
      const result = await this.matchState.startTimer(input);
      await this.notifyCanonicalMatches(input.inviteId, [input.matchId]);
      return result;
    });
  }

  async claimCanonicalMatchTimer(input: MatchStateClaimTimerRequest) {
    return captureMatchStateRpc(async () => {
      this.inviteChannels.pinInvite(input.inviteId);
      const result = await this.matchState.claimTimer(input);
      await this.notifyCanonicalMatches(input.inviteId, [input.matchId]);
      await this.dispatchMatchEffects();
      return result;
    });
  }

  async applyCanonicalMatchEventEffects(input: MatchStateEventEffectsRequest) {
    return captureMatchStateRpc(async () => {
      this.inviteChannels.pinInvite(input.inviteId);
      const result = await this.matchState.applyEventEffects(input);
      await this.notifyCanonicalMatches(input.inviteId, result.changedMatchIds);
      return result;
    });
  }

  private async notifyCanonicalMatches(
    inviteId: string,
    matchIds?: string[],
  ): Promise<void> {
    try {
      await this.matchSync.notify(inviteId, matchIds);
    } catch (error) {
      console.error({
        event: "canonical_match_notification_failed",
        inviteId,
        kind: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private async deliverMatchEffect(effect: MatchStateEffect): Promise<void> {
    await assertProfileBackgroundMutationsEnabled(this.env);
    await createMatchTimerStartStore(this.env.PROFILE_GAMES_DB).deletePair(
      effect.playerId,
      effect.opponentId,
      effect.matchId,
    );
    if (!effect.eventId) return;
    const plan = await buildEventProgressPlan(
      {
        eventId: effect.eventId,
        sourceKey: effect.sourceKey,
        reason: effect.reason,
      },
      effect.claimedAtMs,
    );
    const admission = await acquireEventWriteAdmission(this.env.EVENT_DB);
    let released = false;
    try {
      await patchEventOwnedPaths(
        this.env.EVENT_DB,
        { [`eventProgressOutbox/${plan.outboxId}`]: plan.outbox },
        { admission },
      );
    } finally {
      released = await releaseEventWriteAdmission(this.env.EVENT_DB, admission);
    }
    if (!released) throw new Error("match-event-admission-release-unconfirmed");
    await ensureEventProgressWorkflow(this.env, plan);
  }

  private dispatchMatchEffects(): Promise<void> {
    if (this.matchEffectsPending) return this.matchEffectsPending;
    const pending = this.flushMatchEffects();
    this.matchEffectsPending = pending;
    void pending
      .finally(() => {
        if (this.matchEffectsPending === pending)
          this.matchEffectsPending = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private async flushMatchEffects(): Promise<void> {
    for (const effect of this.matchState.listDueEffects(Date.now(), 20)) {
      try {
        await this.deliverMatchEffect(effect);
        this.matchState.completeEffect(effect.effectId);
      } catch (error) {
        await this.matchState.retryEffect(effect.effectId, Date.now() + 60_000);
        console.error({
          event: "canonical_match_effect_retry",
          inviteId: effect.inviteId,
          matchId: effect.matchId,
          kind: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    const next = this.matchState.nextEffectAt();
    if (next !== null) await this.scheduleInviteAlarm(next);
  }

  async notifyMatchesChanged(
    inviteId: string,
    matchIds?: string[],
  ): Promise<void> {
    await this.matchSync.notify(inviteId, matchIds);
  }

  async notifyMetadataChanged(inviteId: string): Promise<void> {
    this.inviteChannels.invalidate();
    await this.matchSync.notify(inviteId);
    await this.inviteChannels.refreshIfSubscribed(inviteId);
  }

  async notifyWagersChanged(inviteId: string): Promise<void> {
    this.inviteChannels.invalidate();
    await this.inviteChannels.refreshIfSubscribed(inviteId, "wagers");
  }

  async alarm(): Promise<void> {
    this.socketSessions.nextExpiry();
    await this.dispatchMatchEffects();
    await this.inviteChannels.alarm();
    await this.matchSync.alarm();
    const due = [
      this.inviteChannels.nextAlarm(),
      this.matchSync.nextAlarm(),
      this.matchState.nextEffectAt(),
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

  async publish(
    senderUid: string,
    reaction: InviteReaction,
  ): Promise<InviteReactionPublishResult> {
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
        this.socketSessions.send(
          socket,
          socketVersion(socket) === 2 ? v2Message : message,
        );
      }
    }
    return "published";
  }

  async ensurePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): Promise<MatchPresentationSnapshot> {
    return this.presentations.ensurePresentations(matchId, seeds);
  }

  async getPresentationSnapshot(
    matchId: string,
  ): Promise<MatchPresentationSnapshot> {
    return this.presentations.getPresentationSnapshot(matchId);
  }

  async registerPresentationSeeds(
    inviteId: string,
    seeds: MatchPresentationSeedRegistration[],
  ): Promise<MatchPresentationRegistration[]> {
    return this.presentations.registerPresentationSeeds(inviteId, seeds);
  }

  async getRegisteredPresentationSnapshot(
    matchId: string,
  ): Promise<RegisteredMatchPresentationSnapshot> {
    return this.presentations.getRegisteredPresentationSnapshot(matchId);
  }

  async getFrozenPresentationSnapshot(
    matchId: string,
  ): Promise<MatchPresentationSnapshot> {
    return this.presentations.getFrozenPresentationSnapshot(matchId);
  }

  async freezeRegisteredPresentations(
    matchId: string,
    actorUids: string[],
  ): Promise<MatchPresentationSnapshot> {
    return this.presentations.freezeRegisteredPresentations(matchId, actorUids);
  }

  async freezePresentations(
    matchId: string,
    seeds: MatchPresentationSeeds,
  ): Promise<MatchPresentationSnapshot> {
    return this.presentations.freezePresentations(matchId, seeds);
  }

  async updatePresentation(
    actorUid: string,
    matchId: string,
    request: UpdateMatchPresentationRequest,
  ): Promise<MatchPresentationUpdateResult> {
    const result = this.presentations.updatePresentation(
      actorUid,
      matchId,
      request,
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
