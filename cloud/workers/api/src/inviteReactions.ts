import { MatchTimerMutationQueue } from "./matchTimerMutationQueue.ts";
import { MatchWriterStore } from "./matchWriterStore.ts";
import type { MatchWriterMutation } from "./matchWriterRecords.ts";
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
import { ApplicationDataUnavailable } from "./applicationDataControl.ts";
import type {
  ApplicationAdmission,
  ApplicationAdmissionKind,
} from "./applicationAdmissions.ts";
import {
  applicationWaitUntil,
  currentApplicationAdmission,
  runApplicationOperation,
  scopedApplicationEnv,
} from "./applicationExecution.ts";
import {
  assertApplicationObjectAdmission,
  fenceApplicationObjectStorage,
  initializeApplicationObjectControl,
} from "./applicationObjectStorage.ts";
import {
  readApplicationAdmissionHeader,
  readApplicationRpcAdmission,
} from "./applicationRoomRpc.ts";
import { canReceiveInvite, InviteChannelsRoom } from "./inviteChannelsRoom.ts";
import type { InviteMetadataReadResult } from "./inviteMetadata.ts";
import { ensureInviteRoomSchema } from "./inviteRoomSchema.ts";
import type { InviteWagersReadResult } from "./inviteWagers.ts";
import {
  MatchPresentationStore,
  type MatchPresentationUpdateResult,
} from "./matchPresentationStore.ts";

import { InviteAlarmCoordinator } from "./inviteAlarmCoordinator.ts";
import { createInviteSourceReader } from "./inviteSource.ts";
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
  private readonly timerMutations = new MatchTimerMutationQueue();
  private matchWriterStore: MatchWriterStore | null = null;
  private initialization: Promise<void> | null = null;
  private matchSync!: MatchSyncRoom;
  private matchState!: MatchStateStore;
  private socketSessions!: SocketSessions;
  private matchEffects!: MatchEffectsDispatcher;
  private inviteReader!: (inviteId: string) => Promise<InviteDocument | null>;
  private wagerReader!: (inviteId: string) => Promise<WagerStateSnapshot[]>;
  private alarmCoordinator!: InviteAlarmCoordinator;
  private reactions!: ReactionChannel;
  private inviteChannels!: InviteChannelsRoom;
  private presentations!: MatchPresentationStore;

  private get matchWriter(): MatchWriterStore {
    if (!this.matchWriterStore) throw new ApplicationDataUnavailable();
    return this.matchWriterStore;
  }

  private async ensureRuntime(): Promise<void> {
    const getAdmission = () => {
      const admission = currentApplicationAdmission();
      if (!admission) throw new ApplicationDataUnavailable();
      return admission;
    };
    if (!this.initialization) {
      this.initialization = (async () => {
        const pristine =
          this.ctx.storage.sql
            .exec(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' LIMIT 1",
            )
            .toArray().length === 0 &&
          Array.from(this.ctx.storage.kv.list({ limit: 1 })).length === 0 &&
          (await this.ctx.storage.getAlarm()) === null;
        const initialize = async () => {
          await initializeApplicationObjectControl(
            this.ctx.storage,
            getAdmission(),
          );
          assertApplicationObjectAdmission(this.ctx.storage, getAdmission());
          const storage = fenceApplicationObjectStorage(
            this.ctx.storage,
            getAdmission,
          );
          const context = new Proxy(this.ctx, {
            get(target, property) {
              if (property === "storage") return storage;
              if (property === "waitUntil") return applicationWaitUntil;
              const method: unknown = Reflect.get(target, property, target);
              if (typeof method !== "function") return method;
              return (...args: unknown[]): unknown => {
                const result: unknown = Reflect.apply(method, target, args);
                return result;
              };
            },
          });
          this.initializeRuntime(
            context,
            scopedApplicationEnv(this.env),
            pristine,
          );
        };
        if (pristine) await this.ctx.storage.transaction(initialize);
        else await initialize();
      })().catch((error: unknown) => {
        this.initialization = null;
        this.matchWriterStore = null;
        throw error;
      });
    }
    await this.initialization;
    assertApplicationObjectAdmission(this.ctx.storage, getAdmission());
  }

  private withApplicationOperation<T>(
    kind: ApplicationAdmissionKind,
    work: () => Promise<T>,
    parent?: ApplicationAdmission,
  ): Promise<T> {
    return runApplicationOperation(
      this.env,
      kind,
      1,
      async () => {
        await this.ensureRuntime();
        return work();
      },
      this.ctx,
      parent,
    );
  }
  private initializeRuntime(
    ctx: DurableObjectState,
    env: Env,
    fresh: boolean,
  ): void {
    ensureInviteRoomSchema(ctx.storage, { fresh });
    this.matchWriterStore = new MatchWriterStore(this.ctx.storage, ctx.storage);
    this.matchWriter.initialize({ fresh });
    if (fresh) this.matchWriter.initializeFreshLocalLayout();
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
    this.matchState = new MatchStateStore(this.matchWriter.guardStorage(), {
      assertTimerWriter: () => this.matchWriter.assertWriter(),
      recordTimerWriterOutcome: (result) =>
        this.matchWriter.recordCommittedOutcome(result),
      scheduleAlarm: (atMs, transaction) =>
        this.alarmCoordinator.schedule(atMs, transaction),
    });
    this.matchEffects = new MatchEffectsDispatcher(this.matchState.effects, {
      deliver: createMatchEffectDelivery(env),
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
    return this.withApplicationOperation(
      "rpc",
      async () => {
        this.socketSessions.nextExpiry();
        if (
          request.method !== "GET" ||
          request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
        ) {
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        const pathname = new URL(request.url).pathname;
        if (pathname === "/matches/socket")
          return this.matchSync.fetch(request);
        if (pathname === "/metadata/socket")
          return this.inviteChannels.fetch(request, "metadata");
        if (pathname === "/wagers/socket")
          return this.inviteChannels.fetch(request, "wagers");
        return this.reactions.fetch(request);
      },
      readApplicationAdmissionHeader(request),
    );
  }

  async readMetadata(
    inviteId: string,
    parent?: ApplicationAdmission,
  ): Promise<InviteMetadataReadResult> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.inviteChannels.readMetadata(inviteId);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async readWagers(
    inviteId: string,
    parent?: ApplicationAdmission,
  ): Promise<InviteWagersReadResult> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.inviteChannels.readWagers(inviteId);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async readMatches(
    inviteId: string,
    matchId: string,
    options: { fresh?: boolean } = {},
    parent?: ApplicationAdmission,
  ): Promise<MatchSyncReadResult> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        if (options.fresh) {
          await this.inviteChannels.readMetadata(inviteId);
          await this.matchSync.notify(inviteId, [matchId]);
        }
        return this.matchSync.read(inviteId, matchId, options.fresh);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async readCanonicalMatchRecord(
    input: MatchStateRecordRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return captureMatchStateRpc(() => {
          this.inviteChannels.pinInvite(input.inviteId);
          return matchWireValue(this.matchState.readRecord(input));
        });
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async readCanonicalMatchRecords(
    input: MatchStateRecordsRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
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
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async readCanonicalMatchPair(
    input: MatchStatePairRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return captureMatchStateRpc(() => {
          this.inviteChannels.pinInvite(input.inviteId);
          return matchPairWire(this.matchState.readPair(input));
        });
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async createCanonicalMatch(
    input: MatchStateCreateWireRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.mutateCanonicalMatch(
          { kind: "create", request: input },
          () => matchCreateWireResult(this.matchState.createRecords(input)),
          (result) => result.changedMatchIds,
        );
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async submitCanonicalMove(
    input: MatchStateMoveRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.mutateCanonicalMatch(
          { kind: "move", request: input },
          () => this.matchState.move(input),
          () => [input.matchId],
        );
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async surrenderCanonicalMatch(
    input: MatchStateSurrenderRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.mutateCanonicalMatch(
          { kind: "surrender", request: input },
          () => this.matchState.surrender(input),
          () => [input.matchId],
        );
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async startCanonicalMatchTimer(
    input: MatchStateStartTimerRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.mutateCanonicalMatch(
          { kind: "start-timer", request: input },
          () =>
            this.timerMutations.run(input.matchId, () =>
              this.matchState.startTimer(input),
            ),
          () => [input.matchId],
        );
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async claimCanonicalMatchTimer(
    input: MatchStateClaimTimerRequest,
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.mutateCanonicalMatch(
          { kind: "claim-timer", request: input },
          () => this.matchState.claimTimer(input),
          () => [input.matchId],
        );
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async applyCanonicalMatchEventEffects(
    input: MatchStateEventEffectsWireRequest,
    options: { deferNotifications?: boolean } = {},
    parent?: ApplicationAdmission,
  ) {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.mutateCanonicalMatch(
          { kind: "event-effects", request: input },
          async () =>
            matchCreateWireResult(
              await this.matchState.applyEventEffects(input),
            ),
          (result) =>
            options.deferNotifications ? null : result.changedMatchIds,
        );
      },
      readApplicationRpcAdmission(parent),
    );
  }

  private mutateCanonicalMatch<T>(
    mutation: Exclude<MatchWriterMutation, { kind: "alarm" }>,
    mutate: () => T | Promise<T>,
    changedMatchIds: (result: T) => string[] | null,
  ) {
    return captureMatchStateRpc(async () => {
      const inviteId = mutation.request.inviteId;
      this.inviteChannels.pinInvite(inviteId);
      const result = await this.matchWriter.runWriter(mutation, mutate);
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
    parent?: ApplicationAdmission,
  ): Promise<void> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        await this.matchSync.notify(inviteId, matchIds);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async notifyMetadataChanged(
    inviteId: string,
    parent?: ApplicationAdmission,
  ): Promise<void> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        this.inviteChannels.invalidate();
        await this.matchSync.notify(inviteId);
        await this.inviteChannels.refreshIfSubscribed(inviteId);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async notifySessionCommitted(
    inviteId: string,
    parent?: ApplicationAdmission,
  ): Promise<void> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        this.inviteChannels.pinInvite(inviteId);
        this.inviteChannels.invalidate();
        await this.matchSync.notify(inviteId);
        await this.inviteChannels.refreshCommittedMetadata(
          inviteId,
          this.matchSync.hasSubscribers(),
        );
        await this.matchSync.refreshSubscribed(inviteId);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async notifyWagersChanged(
    inviteId: string,
    parent?: ApplicationAdmission,
  ): Promise<void> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        this.inviteChannels.invalidateWagers();
        await this.inviteChannels.refreshIfSubscribed(inviteId, "wagers");
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async alarm(): Promise<void> {
    return this.withApplicationOperation(
      "alarm",
      async () => {
        return this.matchWriter.runWriter(
          { kind: "alarm", request: { objectId: this.ctx.id.toString() } },
          () => this.alarmCoordinator.run(),
        );
      },
      undefined,
    );
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
    parent?: ApplicationAdmission,
  ): Promise<InviteReactionPublishResult> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.reactions.publish(senderUid, reaction);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async registerPresentationSeeds(
    inviteId: string,
    seeds: MatchPresentationSeedRegistration[],
    parent?: ApplicationAdmission,
  ): Promise<MatchPresentationRegistration[]> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.presentations.registerPresentationSeeds(inviteId, seeds);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async getRegisteredPresentationSnapshot(
    matchId: string,
    parent?: ApplicationAdmission,
  ): Promise<RegisteredMatchPresentationSnapshot> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.presentations.getRegisteredPresentationSnapshot(matchId);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async getFrozenPresentationSnapshot(
    matchId: string,
    parent?: ApplicationAdmission,
  ): Promise<MatchPresentationSnapshot> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.presentations.getFrozenPresentationSnapshot(matchId);
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async freezeRegisteredPresentations(
    matchId: string,
    actorUids: string[],
    parent?: ApplicationAdmission,
  ): Promise<MatchPresentationSnapshot> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        return this.presentations.freezeRegisteredPresentations(
          matchId,
          actorUids,
        );
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async updatePresentation(
    actorUid: string,
    matchId: string,
    request: UpdateMatchPresentationRequest,
    parent?: ApplicationAdmission,
  ): Promise<MatchPresentationUpdateResult> {
    return this.withApplicationOperation(
      "rpc",
      async () => {
        const result = this.presentations.updatePresentation(
          actorUid,
          matchId,
          request,
        );
        if (result.status === "updated") {
          this.reactions.broadcastPresentation(matchId, result.presentation);
        }
        return result;
      },
      readApplicationRpcAdmission(parent),
    );
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      await this.withApplicationOperation(
        "socket",
        async () => {
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
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof ApplicationDataUnavailable) {
        socket.close(1012, "Service maintenance");
        return;
      }
      throw error;
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    try {
      await this.withApplicationOperation(
        "socket",
        async () => {
          socket.close();
          this.matchSync.closed(socket);
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof ApplicationDataUnavailable) {
        socket.close(1012, "Service maintenance");
        return;
      }
      throw error;
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try {
      await this.withApplicationOperation(
        "socket",
        async () => {
          socket.close(1011, "Reaction connection failed");
          this.matchSync.closed(socket);
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof ApplicationDataUnavailable) {
        socket.close(1012, "Service maintenance");
        return;
      }
      throw error;
    }
  }
}
