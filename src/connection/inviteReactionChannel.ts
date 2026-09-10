import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_MAX_MESSAGE_BYTES,
  REACTION_SOCKET_PROTOCOL_V2,
  isInviteReactionForInvite,
  isInviteRoomMessage,
  type InviteReaction,
} from "@mons/shared/reactions";
import {
  PRESENTATION_MAX_MESSAGE_BYTES,
  type MatchPresentation,
  type MatchPresentationSnapshot,
} from "@mons/shared/match-presentation";
import { getInviteReactionSocketUrl } from "../services/inviteReactionsApi";
import { socketSessionRefreshDelay } from "./socketSession";

export const REACTION_RECONNECT_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000,
] as const;
export const REACTION_HEARTBEAT_INTERVAL_MS = 30_000;
export const REACTION_HEARTBEAT_TIMEOUT_MS = 10_000;

type Timer = ReturnType<typeof setTimeout>;
type ReactionSocket = Pick<
  WebSocket,
  | "readyState"
  | "onopen"
  | "onmessage"
  | "onclose"
  | "onerror"
  | "send"
  | "close"
>;

type InviteReactionChannelDependencies = {
  inviteId: string;
  matchId?: string;
  createSocket: (url: string, protocols?: string[]) => ReactionSocket;
  getProtocols?: (forceRefresh: boolean) => Promise<string[]>;
  getTokenRemainingMs?: (token: string) => number;
  isActive: () => boolean;
  isOnline: () => boolean;
  canConnect: () => boolean;
  addWakeListener: (listener: () => void) => () => void;
  onInitialSnapshot: (reactions: Record<string, InviteReaction>) => void;
  onReaction: (reaction: InviteReaction, senderUid: string) => void;
  onPresentationSnapshot?: (snapshot: MatchPresentationSnapshot) => void;
  onPresentation?: (presentation: MatchPresentation) => void;
  onError: (error: unknown) => void;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  random: () => number;
  now?: () => number;
};

export class InviteReactionChannel {
  private readonly dependencies: InviteReactionChannelDependencies;
  private readonly controller = new AbortController();
  private readonly removeWakeListener: () => void;
  private socket: ReactionSocket | null = null;
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private responseTimer: Timer | null = null;
  private authTimer: Timer | null = null;
  private authRefreshAt: number | null = null;
  private failures = 0;
  private initialized = false;
  private receivedSnapshot = false;
  private connecting = false;
  private connectionGeneration = 0;
  private connectionAttempts = 0;

  constructor(dependencies: InviteReactionChannelDependencies) {
    this.dependencies = dependencies;
    this.removeWakeListener = dependencies.addWakeListener(() =>
      this.refresh(),
    );
    this.scheduleReconnect(0);
  }

  refresh(): void {
    if (!this.isActive()) return;
    if (
      this.socket &&
      (this.socket.readyState >= 2 ||
        (this.authRefreshAt !== null && this.now() >= this.authRefreshAt))
    )
      this.disconnect();
    if (!this.socket && !this.connecting) this.scheduleReconnect(0);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  stop(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    this.clearTimer("reconnectTimer");
    this.disconnect();
    this.removeWakeListener();
  }

  private isActive(): boolean {
    return !this.signal.aborted && this.dependencies.isActive();
  }

  private now(): number {
    return this.dependencies.now?.() ?? performance.now();
  }

  private isCurrent(socket: ReactionSocket): boolean {
    return this.isActive() && this.socket === socket;
  }

  private clearTimer(
    key: "reconnectTimer" | "heartbeatTimer" | "responseTimer" | "authTimer",
  ): void {
    const timer = this[key];
    if (timer !== null) this.dependencies.clearTimer(timer);
    this[key] = null;
  }

  private disconnect(): void {
    this.connectionGeneration += 1;
    this.connecting = false;
    const socket = this.socket;
    this.socket = null;
    this.receivedSnapshot = false;
    this.clearTimer("heartbeatTimer");
    this.clearTimer("responseTimer");
    this.clearTimer("authTimer");
    this.authRefreshAt = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {}
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearTimer("reconnectTimer");
    if (
      !this.isActive() ||
      !this.dependencies.isOnline() ||
      !this.dependencies.canConnect()
    )
      return;
    this.reconnectTimer = this.dependencies.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private fail(socket: ReactionSocket | null, error: unknown): void {
    if (!this.isActive() || this.socket !== socket) return;
    this.disconnect();
    this.dependencies.onError(new Error("reaction-channel-unavailable"));
    const baseDelay =
      REACTION_RECONNECT_DELAYS_MS[
        Math.min(this.failures++, REACTION_RECONNECT_DELAYS_MS.length - 1)
      ];
    const delay = Math.round(
      baseDelay * (0.8 + this.dependencies.random() * 0.2),
    );
    this.scheduleReconnect(delay);
  }

  private connect(): void {
    if (
      !this.isActive() ||
      this.socket ||
      this.connecting ||
      !this.dependencies.isOnline() ||
      !this.dependencies.canConnect()
    )
      return;
    this.connecting = true;
    const generation = ++this.connectionGeneration;
    const forceRefresh = this.connectionAttempts++ > 0;
    const deadline = this.now() + REACTION_HEARTBEAT_TIMEOUT_MS;
    const isPreparing = () =>
      this.isActive() &&
      this.connecting &&
      this.connectionGeneration === generation;
    this.responseTimer = this.dependencies.setTimer(() => {
      if (isPreparing()) {
        this.fail(this.socket, new Error("reaction-snapshot-timeout"));
      }
    }, REACTION_HEARTBEAT_TIMEOUT_MS);
    const open = (protocols?: string[]) => {
      if (!isPreparing()) return;
      if (this.now() >= deadline) {
        this.fail(null, new Error("reaction-snapshot-timeout"));
        return;
      }
      if (!this.dependencies.isOnline() || !this.dependencies.canConnect()) {
        this.disconnect();
        return;
      }
      try {
        const url = new URL(
          getInviteReactionSocketUrl(this.dependencies.inviteId),
        );
        if (this.dependencies.matchId) {
          url.searchParams.set("matchId", this.dependencies.matchId);
          protocols = [
            REACTION_SOCKET_PROTOCOL_V2,
            ...(protocols?.slice(1) ?? []),
          ];
        }
        const socket = this.dependencies.createSocket(
          url.toString(),
          protocols,
        );
        if (!isPreparing()) {
          socket.close();
          return;
        }
        this.socket = socket;
        const authDelay = socketSessionRefreshDelay(
          protocols,
          this.dependencies.getTokenRemainingMs,
        );
        this.authRefreshAt = authDelay === null ? null : this.now() + authDelay;
        if (this.authRefreshAt !== null) {
          this.authTimer = this.dependencies.setTimer(
            () => {
              this.authTimer = null;
              if (!this.isCurrent(socket)) return;
              this.disconnect();
              this.scheduleReconnect(0);
            },
            Math.max(0, this.authRefreshAt - this.now()),
          );
        }
        socket.onmessage = (event) => this.receive(socket, event.data);
        socket.onclose = () =>
          this.fail(socket, new Error("reaction-socket-closed"));
        socket.onerror = () =>
          this.fail(socket, new Error("reaction-socket-error"));
      } catch {
        if (isPreparing())
          this.fail(this.socket, new Error("reaction-socket-error"));
      }
    };
    if (!this.dependencies.getProtocols) {
      open();
      return;
    }
    try {
      void this.dependencies.getProtocols(forceRefresh).then(open, () => {
        if (isPreparing())
          this.fail(null, new Error("reaction-auth-unavailable"));
      });
    } catch {
      if (isPreparing())
        this.fail(null, new Error("reaction-auth-unavailable"));
    }
  }

  private scheduleHeartbeat(socket: ReactionSocket): void {
    this.clearTimer("heartbeatTimer");
    this.heartbeatTimer = this.dependencies.setTimer(() => {
      this.heartbeatTimer = null;
      if (!this.isCurrent(socket)) return;
      this.responseTimer = this.dependencies.setTimer(() => {
        this.fail(socket, new Error("reaction-heartbeat-timeout"));
      }, REACTION_HEARTBEAT_TIMEOUT_MS);
      try {
        socket.send(REACTION_HEARTBEAT_REQUEST);
      } catch (error) {
        this.fail(socket, error);
      }
    }, REACTION_HEARTBEAT_INTERVAL_MS);
  }

  private receive(socket: ReactionSocket, data: unknown): void {
    if (!this.isCurrent(socket)) return;
    if (data === REACTION_HEARTBEAT_RESPONSE && this.receivedSnapshot) {
      this.clearTimer("responseTimer");
      this.scheduleHeartbeat(socket);
      return;
    }
    try {
      if (
        typeof data !== "string" ||
        new TextEncoder().encode(data).byteLength >
          (this.dependencies.matchId
            ? PRESENTATION_MAX_MESSAGE_BYTES
            : REACTION_MAX_MESSAGE_BYTES)
      ) {
        throw new Error("invalid-reaction-message");
      }
      const message: unknown = JSON.parse(data);
      if (!isInviteRoomMessage(message))
        throw new Error("invalid-reaction-message");
      if (this.dependencies.matchId && message.schemaVersion !== 2) {
        throw new Error("invalid-room-version");
      }
      if (message.type === "snapshot") {
        if (
          this.receivedSnapshot ||
          !Object.values(message.reactions).every((reaction) =>
            isInviteReactionForInvite(this.dependencies.inviteId, reaction),
          )
        ) {
          throw new Error("invalid-reaction-snapshot");
        }
        this.receivedSnapshot = true;
        this.connecting = false;
        this.failures = 0;
        this.clearTimer("responseTimer");
        if (message.schemaVersion === 2) {
          if (message.presentation.matchId !== this.dependencies.matchId) {
            throw new Error("invalid-presentation-match");
          }
          this.dependencies.onPresentationSnapshot?.(message.presentation);
          if (!this.isCurrent(socket)) return;
        }
        if (!this.initialized) {
          this.initialized = true;
          this.dependencies.onInitialSnapshot(message.reactions);
        } else {
          for (const [senderUid, reaction] of Object.entries(
            message.reactions,
          )) {
            if (!this.isCurrent(socket)) return;
            this.dependencies.onReaction(reaction, senderUid);
          }
        }
        if (this.isCurrent(socket)) this.scheduleHeartbeat(socket);
      } else if (message.type === "presentation") {
        if (
          !this.receivedSnapshot ||
          message.presentation.matchId !== this.dependencies.matchId
        ) {
          throw new Error("invalid-presentation-event");
        }
        this.dependencies.onPresentation?.(message.presentation);
      } else {
        if (
          !this.receivedSnapshot ||
          !isInviteReactionForInvite(
            this.dependencies.inviteId,
            message.reaction,
          )
        ) {
          throw new Error("invalid-reaction-event");
        }
        this.dependencies.onReaction(message.reaction, message.senderUid);
      }
    } catch (error) {
      this.fail(socket, error);
    }
  }
}
