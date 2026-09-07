import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_REFRESH_MS,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isInviteMetadataMessage,
  type InviteMetadataSnapshot,
  type ReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import {
  InviteMetadataApiError,
  getInviteMetadataSocketUrl,
} from "../services/inviteMetadataApi";

export const INVITE_METADATA_RECONNECT_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000,
] as const;
export const INVITE_METADATA_HEARTBEAT_INTERVAL_MS = 30_000;
export const INVITE_METADATA_HEARTBEAT_TIMEOUT_MS = 10_000;
const HTTP_ERROR_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

type Timer = ReturnType<typeof setTimeout>;
type MetadataSocket = Pick<
  WebSocket,
  | "readyState"
  | "onopen"
  | "onmessage"
  | "onclose"
  | "onerror"
  | "send"
  | "close"
>;

type InviteMetadataChannelDependencies = {
  inviteId: string;
  createSocket: (url: string, protocols?: string[]) => MetadataSocket;
  getProtocols?: (forceRefresh: boolean) => Promise<string[]>;
  readMetadata: (signal: AbortSignal) => Promise<ReadInviteMetadataResponse>;
  isActive: () => boolean;
  isOnline: () => boolean;
  isVisible: () => boolean;
  addWakeListener: (listener: () => void) => () => void;
  onSnapshot: (
    snapshot: InviteMetadataSnapshot,
    viewer?: ReadInviteMetadataResponse["viewer"],
  ) => void;
  onError: (error: unknown) => void;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  random: () => number;
  now?: () => number;
};

export class InviteMetadataChannel {
  private readonly dependencies: InviteMetadataChannelDependencies;
  private readonly controller = new AbortController();
  private readonly removeWakeListener: () => void;
  private socket: MetadataSocket | null = null;
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private responseTimer: Timer | null = null;
  private httpTimer: Timer | null = null;
  private connecting = false;
  private healthy = false;
  private connectionGeneration = 0;
  private snapshotDeadline = 0;
  private connectionAttempts = 0;
  private socketFailures = 0;
  private httpFailures = 0;
  private nextHttpAt = 0;
  private reading = false;
  private refreshAgain = false;
  private revision = -1;

  constructor(dependencies: InviteMetadataChannelDependencies) {
    this.dependencies = dependencies;
    this.removeWakeListener = dependencies.addWakeListener(() =>
      this.refresh(),
    );
    this.scheduleReconnect(0);
    this.requestRefresh();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  stop(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    this.clearTimer("httpTimer");
    this.clearTimer("reconnectTimer");
    this.disconnect();
    this.removeWakeListener();
  }

  refresh(): void {
    if (!this.isActive()) return;
    if (!this.dependencies.isOnline()) {
      this.clearTimer("reconnectTimer");
      this.clearTimer("httpTimer");
      this.disconnect();
      return;
    }
    if (!this.dependencies.isVisible()) {
      this.clearTimer("httpTimer");
      return;
    }
    if (this.socket && this.socket.readyState >= 2) this.disconnect();
    if (!this.socket && !this.connecting) this.scheduleReconnect(0);
    this.requestRefresh();
  }

  requestRefresh(): void {
    if (!this.isActive() || !this.dependencies.isOnline()) return;
    if (this.reading) {
      this.refreshAgain = true;
      return;
    }
    this.clearTimer("httpTimer");
    const delay = this.nextHttpAt - this.now();
    if (delay > 0) {
      this.scheduleHttp(delay);
      return;
    }
    this.reading = true;
    this.refreshAgain = false;
    void Promise.resolve().then(() => {
      if (this.isActive()) return this.read();
    });
  }

  private isActive(): boolean {
    return !this.signal.aborted && this.dependencies.isActive();
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private isCurrent(socket: MetadataSocket): boolean {
    return this.isActive() && this.socket === socket;
  }

  private clearTimer(
    key: "reconnectTimer" | "heartbeatTimer" | "responseTimer" | "httpTimer",
  ): void {
    const timer = this[key];
    if (timer !== null) this.dependencies.clearTimer(timer);
    this[key] = null;
  }

  private scheduleHttp(delayMs: number): void {
    this.clearTimer("httpTimer");
    if (
      !this.isActive() ||
      !this.dependencies.isOnline() ||
      !this.dependencies.isVisible()
    )
      return;
    this.httpTimer = this.dependencies.setTimer(
      () => {
        this.httpTimer = null;
        this.requestRefresh();
      },
      Math.min(delayMs, 2_147_483_647),
    );
  }

  private async read(): Promise<void> {
    try {
      const response = await this.dependencies.readMetadata(this.signal);
      if (!this.isActive()) return;
      this.httpFailures = 0;
      this.nextHttpAt = 0;
      this.apply(response.snapshot, response.viewer);
    } catch (error) {
      if (!this.isActive()) return;
      const retryDelay =
        HTTP_ERROR_DELAYS_MS[
          Math.min(this.httpFailures++, HTTP_ERROR_DELAYS_MS.length - 1)
        ];
      const retryAfter =
        error instanceof InviteMetadataApiError ? (error.retryAfterMs ?? 0) : 0;
      this.nextHttpAt = this.now() + Math.max(retryDelay, retryAfter);
      this.dependencies.onError(
        error instanceof InviteMetadataApiError
          ? error
          : new InviteMetadataApiError("metadata-unavailable"),
      );
    } finally {
      this.reading = false;
      if (this.isActive()) {
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.requestRefresh();
        } else if (!this.healthy) {
          this.scheduleHttp(
            Math.max(INVITE_METADATA_REFRESH_MS, this.nextHttpAt - this.now()),
          );
        }
      }
    }
  }

  private apply(
    snapshot: InviteMetadataSnapshot,
    viewer?: ReadInviteMetadataResponse["viewer"],
  ): void {
    if (
      !this.isActive() ||
      snapshot.inviteId !== this.dependencies.inviteId ||
      snapshot.revision < this.revision
    )
      return;
    if (snapshot.revision === this.revision && !viewer) return;
    this.revision = snapshot.revision;
    this.dependencies.onSnapshot(snapshot, viewer);
  }

  private disconnect(): void {
    this.connectionGeneration += 1;
    this.connecting = false;
    this.healthy = false;
    this.clearTimer("heartbeatTimer");
    this.clearTimer("responseTimer");
    const socket = this.socket;
    this.socket = null;
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
    if (!this.isActive() || !this.dependencies.isOnline()) return;
    this.reconnectTimer = this.dependencies.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private fail(socket: MetadataSocket | null): void {
    if (!this.isActive() || this.socket !== socket) return;
    this.disconnect();
    this.dependencies.onError(
      new InviteMetadataApiError("metadata-channel-unavailable"),
    );
    if (!this.isActive()) return;
    const baseDelay =
      INVITE_METADATA_RECONNECT_DELAYS_MS[
        Math.min(
          this.socketFailures++,
          INVITE_METADATA_RECONNECT_DELAYS_MS.length - 1,
        )
      ];
    this.scheduleReconnect(
      Math.round(baseDelay * (0.8 + this.dependencies.random() * 0.2)),
    );
    if (this.dependencies.isVisible()) this.requestRefresh();
  }

  private connect(): void {
    if (
      !this.isActive() ||
      this.socket ||
      this.connecting ||
      !this.dependencies.isOnline()
    )
      return;
    this.connecting = true;
    const generation = ++this.connectionGeneration;
    const forceRefresh = this.connectionAttempts++ > 0;
    const deadline = this.now() + INVITE_METADATA_HEARTBEAT_TIMEOUT_MS;
    this.snapshotDeadline = deadline;
    const isPreparing = () =>
      this.isActive() &&
      this.connecting &&
      this.connectionGeneration === generation;
    this.responseTimer = this.dependencies.setTimer(() => {
      if (isPreparing()) this.fail(this.socket);
    }, INVITE_METADATA_HEARTBEAT_TIMEOUT_MS);
    const open = (protocols: string[]) => {
      if (!isPreparing()) return;
      if (this.now() >= deadline) {
        this.fail(null);
        return;
      }
      if (!this.dependencies.isOnline()) {
        this.disconnect();
        return;
      }
      try {
        const socket = this.dependencies.createSocket(
          getInviteMetadataSocketUrl(this.dependencies.inviteId),
          protocols,
        );
        if (!isPreparing()) {
          socket.close();
          return;
        }
        this.socket = socket;
        socket.onmessage = (event) => this.receive(socket, event.data);
        socket.onclose = () => this.fail(socket);
        socket.onerror = () => this.fail(socket);
      } catch {
        if (isPreparing()) this.fail(this.socket);
      }
    };
    if (!this.dependencies.getProtocols) {
      open([INVITE_METADATA_SOCKET_PROTOCOL]);
      return;
    }
    try {
      void this.dependencies.getProtocols(forceRefresh).then(open, () => {
        if (isPreparing()) this.fail(null);
      });
    } catch {
      if (isPreparing()) this.fail(null);
    }
  }

  private scheduleHeartbeat(socket: MetadataSocket): void {
    this.clearTimer("heartbeatTimer");
    this.heartbeatTimer = this.dependencies.setTimer(() => {
      this.heartbeatTimer = null;
      if (!this.isCurrent(socket)) return;
      this.responseTimer = this.dependencies.setTimer(
        () => this.fail(socket),
        INVITE_METADATA_HEARTBEAT_TIMEOUT_MS,
      );
      try {
        socket.send(REACTION_HEARTBEAT_REQUEST);
      } catch {
        this.fail(socket);
      }
    }, INVITE_METADATA_HEARTBEAT_INTERVAL_MS);
  }

  private receive(socket: MetadataSocket, data: unknown): void {
    if (!this.isCurrent(socket)) return;
    if (!this.healthy && this.now() >= this.snapshotDeadline) {
      this.fail(socket);
      return;
    }
    if (data === REACTION_HEARTBEAT_RESPONSE && this.healthy) {
      this.clearTimer("responseTimer");
      this.scheduleHeartbeat(socket);
      return;
    }
    try {
      if (
        typeof data !== "string" ||
        data.length > INVITE_METADATA_MAX_MESSAGE_BYTES ||
        new TextEncoder().encode(data).byteLength >
          INVITE_METADATA_MAX_MESSAGE_BYTES
      ) {
        throw new Error("invalid-metadata-message");
      }
      const message: unknown = JSON.parse(data);
      if (
        !isInviteMetadataMessage(message) ||
        message.snapshot.inviteId !== this.dependencies.inviteId
      ) {
        throw new Error("invalid-metadata-message");
      }
      if (!this.healthy) {
        this.healthy = true;
        this.connecting = false;
        this.socketFailures = 0;
        this.clearTimer("responseTimer");
        this.scheduleHeartbeat(socket);
      }
      this.clearTimer("httpTimer");
      this.apply(message.snapshot);
    } catch {
      this.fail(socket);
    }
  }
}
