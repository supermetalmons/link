import type { InviteDocument } from "@mons/shared/invite-records";
import { matchWireValue } from "./matchRecordCodec.ts";
import {
  matchPairWire,
  matchCreateWireResult,
  type MatchStateCreateWireRequest,
  type MatchStateEventEffectsWireRequest,
} from "./matchStateWire.ts";
import type {
  MatchPresentationSnapshot,
  UpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  type InviteReaction,
} from "@mons/shared/reactions";
import { DurableObject } from "cloudflare:workers";
import { canReceiveInvite, InviteChannelsRoom } from "./inviteChannelsRoom.ts";
import type { InviteMetadataReadResult } from "./inviteMetadata.ts";
import { ensureInviteRoomSchema } from "./inviteRoomSchema.ts";
import type { InviteWagersReadResult } from "./inviteWagers.ts";
import {
  MatchPresentationStore,
  type MatchPresentationUpdateResult,
} from "./matchPresentationStore.ts";

import { createMatchTimerStartStore } from "./gameplayCoordinationD1.ts";
import { InviteAlarmCoordinator } from "./inviteAlarmCoordinator.ts";
import { createInviteSourceReader } from "./inviteSource.ts";
import { parseNewMatchTimerStorage } from "./localMatchTimerStore.ts";
import {
  createMatchEffectDelivery,
  MatchEffectsDispatcher,
} from "./matchEffectsDispatcher.ts";
import {
  listMatchPresentationRegistrations,
  type MatchPresentationRegistration,
  type MatchPresentationSeedRegistration,
  type RegisteredMatchPresentationSnapshot,
} from "./matchPresentationRegistry.ts";
import { captureMatchStateRpc } from "./matchStateRpc.ts";
import { MatchStateStore } from "./matchStateStore.ts";
import type {
  MatchStateClaimTimerRequest,
  MatchStateMoveRequest,
  MatchStatePairRequest,
  MatchStateRecordRequest,
  MatchStateRecordsRequest,
  MatchStateStartTimerRequest,
  MatchStateSurrenderRequest,
} from "./matchStateTypes.ts";
import { MAX_MATCH_STATE_RECORD_READS } from "./matchStateTypes.ts";
import type { MatchSyncReadResult } from "./matchSync.ts";
import { MatchSyncRoom } from "./matchSyncRoom.ts";
import {
  ReactionChannel,
  type InviteReactionPublishResult,
} from "./reactionChannel.ts";
import { socketCapacityFull } from "./socketCapacity.ts";
import { SocketSessions } from "./socketSession.ts";
import {
  PARTICIPANT_SOCKET_TAGS,
  channelSocketTag,
  roleSocketTag,
  spectatorIpSocketTag,
  type SocketRole,
} from "./socketTags.ts";
import {
  createWagerStateD1Store,
  type WagerStateSnapshot,
} from "./wagerStateD1.ts";

export type { InviteReactionPublishResult } from "./reactionChannel.ts";

export type { MatchPresentationUpdateResult } from "./matchPresentationStore.ts";

export const MAX_INVITE_REACTION_SOCKETS = 256;
export const MAX_INVITE_REACTION_SPECTATORS = 248;
export const MAX_INVITE_REACTION_SPECTATORS_PER_IP = 8;
export const MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT = 4;
export const MAX_INVITE_ROOM_SOCKETS = 512;
const INVITE_CHANNEL_SOCKET_LIMITS = {
  sockets: MAX_INVITE_REACTION_SOCKETS,
  spectators: MAX_INVITE_REACTION_SPECTATORS,
  spectatorsPerIp: MAX_INVITE_REACTION_SPECTATORS_PER_IP,
  socketsPerParticipant: MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT,
};
const MAX_INVITE_ROOM_SPECTATOR_SOCKETS =
  MAX_INVITE_ROOM_SOCKETS -
  PARTICIPANT_SOCKET_TAGS.length * MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT;

export class InviteReactions extends DurableObject<Env> {
  private readonly matchSync: MatchSyncRoom;
  private readonly matchState: MatchStateStore;
  private readonly socketSessions: SocketSessions;
  private readonly matchEffects: MatchEffectsDispatcher;
  private inviteReader: (inviteId: string) => Promise<InviteDocument | null>;
  private wagerReader: (inviteId: string) => Promise<WagerStateSnapshot[]>;
  private readonly alarmCoordinator: InviteAlarmCoordinator;
  private readonly reactions: ReactionChannel;
  private readonly inviteChannels: InviteChannelsRoom;
  private readonly presentations: MatchPresentationStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureInviteRoomSchema(ctx.storage);
    this.socketSessions = new SocketSessions(ctx);
    this.alarmCoordinator = new InviteAlarmCoordinator(ctx.storage, {
      expireSessions: () => this.socketSessions.nextExpiry(),
      prepareInviteChannels: () => this.inviteChannels.prepareAlarm(),
      refreshMatches: () => this.matchSync.alarm(),
      dispatchEffects: () => this.matchEffects.dispatch(),
      inviteDeadline: () => this.inviteChannels.nextAlarm(),
      matchDeadline: () => this.matchSync.nextAlarm(),
      effectDeadline: () => this.matchState.effects.nextEffectAt(),
    });
    this.inviteReader = createInviteSourceReader(env);
    this.wagerReader = createWagerStateD1Store(env.PROFILE_DB).readInvite;
    this.inviteChannels = new InviteChannelsRoom(ctx, {
      readInvite: (inviteId) => this.inviteReader(inviteId),
      readWagerStates: (inviteId) => this.wagerReader(inviteId),
      scheduleAlarm: (atMs) => this.alarmCoordinator.schedule(atMs),
      capacityFull: (role) => this.roomCapacityFull(role),
      socketSessions: this.socketSessions,
      limits: INVITE_CHANNEL_SOCKET_LIMITS,
    });
    this.presentations = new MatchPresentationStore(ctx.storage, {
      pinInvite: (inviteId) =>
        this.inviteChannels.pinInvite(inviteId, { cache: false }),
    });
    this.reactions = new ReactionChannel(ctx, {
      presentations: this.presentations,
      pinnedInviteId: () => this.inviteChannels.pinnedInviteId(),
      readRegistrations: (inviteId, matchId) =>
        listMatchPresentationRegistrations(
          env.PROFILE_GAMES_DB,
          inviteId,
          matchId,
        ),
      scheduleAlarm: (atMs) => this.alarmCoordinator.schedule(atMs),
      capacityFull: (role) => this.roomCapacityFull(role),
      socketSessions: this.socketSessions,
      limits: INVITE_CHANNEL_SOCKET_LIMITS,
    });
    this.matchState = new MatchStateStore(ctx.storage, {
      timerStarts: createMatchTimerStartStore(env.PROFILE_GAMES_DB),
      newMatchTimerStorage: parseNewMatchTimerStorage(
        env.NEW_MATCH_TIMER_STORAGE,
      ),
      scheduleAlarm: (atMs, transaction) =>
        this.alarmCoordinator.schedule(atMs, transaction),
    });
    this.matchEffects = new MatchEffectsDispatcher(this.matchState.effects, {
      deliver: createMatchEffectDelivery(env, (effect) =>
        this.matchState.cleanupRetainedTimerStarts(effect),
      ),
      scheduleAlarm: (atMs) => this.alarmCoordinator.schedule(atMs),
    });
    this.matchSync = new MatchSyncRoom(ctx, {
      pinInvite: (inviteId) => {
        this.inviteChannels.pinInvite(inviteId);
      },
      readMetadata: (inviteId) =>
        this.inviteChannels.readMetadata(inviteId, true),
      inviteGeneration: () => this.inviteChannels.invalidationGeneration(),
      sourceEpoch: () => this.matchState.readSource().epoch,
      readSyncState: (input) => this.matchState.readSyncState(input),
      scheduleAlarm: (atMs) => this.alarmCoordinator.schedule(atMs),
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
    return this.reactions.fetch(request);
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
    options: { fresh?: boolean } = {},
  ): Promise<MatchSyncReadResult> {
    if (options.fresh) {
      await this.inviteChannels.readMetadata(inviteId);
      await this.matchSync.notify(inviteId, [matchId]);
    }
    return this.matchSync.read(inviteId, matchId, options.fresh);
  }

  async readCanonicalMatchRecord(input: MatchStateRecordRequest) {
    return captureMatchStateRpc(() => {
      this.inviteChannels.pinInvite(input.inviteId);
      return matchWireValue(this.matchState.readRecord(input));
    });
  }

  async readCanonicalMatchRecords(input: MatchStateRecordsRequest) {
    return captureMatchStateRpc(() => {
      if (
        !Array.isArray(input.requests) ||
        input.requests.length === 0 ||
        input.requests.length > MAX_MATCH_STATE_RECORD_READS
      ) {
        throw new TypeError("match-state-invalid-read-batch");
      }
      this.inviteChannels.pinInvite(input.inviteId);
      return this.matchState.readRecords(input).map(matchWireValue);
    });
  }

  async readCanonicalMatchPair(input: MatchStatePairRequest) {
    return captureMatchStateRpc(() => {
      this.inviteChannels.pinInvite(input.inviteId);
      return matchPairWire(this.matchState.readPair(input));
    });
  }

  async createCanonicalMatch(input: MatchStateCreateWireRequest) {
    return this.mutateCanonicalMatch(
      input,
      () => matchCreateWireResult(this.matchState.createRecords(input)),
      (result) => result.changedMatchIds,
    );
  }

  async submitCanonicalMove(input: MatchStateMoveRequest) {
    return this.mutateCanonicalMatch(
      input,
      () => this.matchState.move(input),
      () => [input.matchId],
    );
  }

  async surrenderCanonicalMatch(input: MatchStateSurrenderRequest) {
    return this.mutateCanonicalMatch(
      input,
      () => this.matchState.surrender(input),
      () => [input.matchId],
    );
  }

  async startCanonicalMatchTimer(input: MatchStateStartTimerRequest) {
    return this.mutateCanonicalMatch(
      input,
      () => this.matchState.startTimer(input),
      () => [input.matchId],
    );
  }

  async claimCanonicalMatchTimer(input: MatchStateClaimTimerRequest) {
    return this.mutateCanonicalMatch(
      input,
      () => this.matchState.claimTimer(input),
      () => [input.matchId],
    );
  }

  async applyCanonicalMatchEventEffects(
    input: MatchStateEventEffectsWireRequest,
    options: { deferNotifications?: boolean } = {},
  ) {
    return this.mutateCanonicalMatch(
      input,
      () =>
        Promise.resolve(
          matchCreateWireResult(this.matchState.applyEventEffects(input)),
        ),
      (result) => (options.deferNotifications ? null : result.changedMatchIds),
    );
  }

  private mutateCanonicalMatch<T>(
    input: { inviteId: string },
    mutate: () => T | Promise<T>,
    changedMatchIds: (result: T) => string[] | null,
  ) {
    return captureMatchStateRpc(async () => {
      const inviteId = input.inviteId;
      this.inviteChannels.pinInvite(inviteId);
      const mutation = mutate();
      const result = mutation instanceof Promise ? await mutation : mutation;
      const matchIds = changedMatchIds(result);
      if (matchIds !== null)
        await this.notifyCanonicalMatches(inviteId, matchIds);
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

  async notifySessionCommitted(inviteId: string): Promise<void> {
    this.inviteChannels.pinInvite(inviteId);
    this.inviteChannels.invalidate();
    await this.matchSync.notify(inviteId);
    await this.inviteChannels.refreshCommittedMetadata(
      inviteId,
      this.matchSync.hasSubscribers(),
    );
    await this.matchSync.refreshSubscribed(inviteId);
  }

  async notifyWagersChanged(inviteId: string): Promise<void> {
    this.inviteChannels.invalidateWagers();
    await this.inviteChannels.refreshIfSubscribed(inviteId, "wagers");
  }

  async alarm(): Promise<void> {
    return this.alarmCoordinator.run();
  }

  private matchRoomFull(role: SocketRole, ip: string): boolean {
    return (
      this.roomCapacityFull(role) ||
      socketCapacityFull(
        role,
        {
          sockets: this.ctx.getWebSockets(channelSocketTag("matches")).length,
          spectators: this.ctx.getWebSockets(
            roleSocketTag("matches", "spectator"),
          ).length,
          spectatorsPerIp: this.ctx.getWebSockets(
            spectatorIpSocketTag("matches", ip),
          ).length,
          socketsForRole: this.ctx.getWebSockets(roleSocketTag("matches", role))
            .length,
        },
        INVITE_CHANNEL_SOCKET_LIMITS,
      )
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
    return this.reactions.publish(senderUid, reaction);
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
      this.reactions.broadcastPresentation(matchId, result.presentation);
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
