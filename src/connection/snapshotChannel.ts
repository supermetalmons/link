import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import { socketSessionRefreshDelay } from "./socketSession";

export type SnapshotDelivery = {
  source: "http" | "socket";
  requestGeneration: number;
};

export const SNAPSHOT_RECONNECT_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000,
] as const;
export const SNAPSHOT_HEARTBEAT_INTERVAL_MS = 30_000;
export const SNAPSHOT_HEARTBEAT_TIMEOUT_MS = 10_000;
const HTTP_ERROR_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

type Timer = ReturnType<typeof setTimeout>;
type SnapshotSocket = Pick<
  WebSocket,
  | "readyState"
  | "onopen"
  | "onmessage"
  | "onclose"
  | "onerror"
  | "send"
  | "close"
>;

export type SnapshotChannelDependencies<
  TSnapshot,
  TResponse extends { snapshot: TSnapshot },
> = {
  socketUrl: string;
  socketProtocol: string;
  maxMessageBytes: number;
  refreshMs: number;
  createSocket: (url: string, protocols?: string[]) => SnapshotSocket;
  getProtocols?: (forceRefresh: boolean) => Promise<string[]>;
  getTokenRemainingMs?: (token: string) => number;
  readSnapshot: (signal: AbortSignal) => Promise<TResponse>;
  parseMessage: (value: unknown) => TSnapshot | null;
  captureGeneration?: () => number;
  needsHttpRefresh?: () => boolean;
  retryAfterMs: (error: unknown) => number;
  readError: (error: unknown) => unknown;
  channelError: () => unknown;
  isActive: () => boolean;
  isOnline: () => boolean;
  isVisible: () => boolean;
  addWakeListener: (listener: () => void) => () => void;
  onSnapshot: (
    snapshot: TSnapshot,
    response: TResponse | undefined,
    delivery: SnapshotDelivery,
  ) => void;
  onError: (error: unknown) => void;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  random: () => number;
  now?: () => number;
};

export class SnapshotChannel<
  TSnapshot,
  TResponse extends { snapshot: TSnapshot },
> {
  private readonly dependencies: SnapshotChannelDependencies<
    TSnapshot,
    TResponse
  >;
  private readonly controller = new AbortController();
  private readonly removeWakeListener: () => void;
  private socket: SnapshotSocket | null = null;
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private responseTimer: Timer | null = null;
  private httpTimer: Timer | null = null;
  private authTimer: Timer | null = null;
  private authRefreshAt: number | null = null;
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

  constructor(dependencies: SnapshotChannelDependencies<TSnapshot, TResponse>) {
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
    if (
      this.socket &&
      (this.socket.readyState >= 2 ||
        (this.authRefreshAt !== null && this.now() >= this.authRefreshAt))
    )
      this.disconnect();
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
    return this.dependencies.now?.() ?? performance.now();
  }

  private isCurrent(socket: SnapshotSocket): boolean {
    return this.isActive() && this.socket === socket;
  }

  private clearTimer(
    key:
      | "reconnectTimer"
      | "heartbeatTimer"
      | "responseTimer"
      | "httpTimer"
      | "authTimer",
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
      const requestGeneration = this.dependencies.captureGeneration?.() ?? 0;
      const response = await this.dependencies.readSnapshot(this.signal);
      if (!this.isActive()) return;
      this.httpFailures = 0;
      this.nextHttpAt = 0;
      this.dependencies.onSnapshot(response.snapshot, response, {
        source: "http",
        requestGeneration,
      });
    } catch (error) {
      if (!this.isActive()) return;
      const retryDelay =
        HTTP_ERROR_DELAYS_MS[
          Math.min(this.httpFailures++, HTTP_ERROR_DELAYS_MS.length - 1)
        ];
      const retryAfter = this.dependencies.retryAfterMs(error);
      this.nextHttpAt = this.now() + Math.max(retryDelay, retryAfter);
      this.dependencies.onError(this.dependencies.readError(error));
    } finally {
      this.reading = false;
      if (this.isActive()) {
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.requestRefresh();
        } else if (!this.healthy || this.dependencies.needsHttpRefresh?.()) {
          this.scheduleHttp(
            Math.max(this.dependencies.refreshMs, this.nextHttpAt - this.now()),
          );
        }
      }
    }
  }

  private disconnect(): void {
    this.connectionGeneration += 1;
    this.connecting = false;
    this.healthy = false;
    this.clearTimer("heartbeatTimer");
    this.clearTimer("responseTimer");
    this.clearTimer("authTimer");
    this.authRefreshAt = null;
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

  private fail(socket: SnapshotSocket | null): void {
    if (!this.isActive() || this.socket !== socket) return;
    this.disconnect();
    this.dependencies.onError(this.dependencies.channelError());
    if (!this.isActive()) return;
    const baseDelay =
      SNAPSHOT_RECONNECT_DELAYS_MS[
        Math.min(this.socketFailures++, SNAPSHOT_RECONNECT_DELAYS_MS.length - 1)
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
    const deadline = this.now() + SNAPSHOT_HEARTBEAT_TIMEOUT_MS;
    this.snapshotDeadline = deadline;
    const isPreparing = () =>
      this.isActive() &&
      this.connecting &&
      this.connectionGeneration === generation;
    this.responseTimer = this.dependencies.setTimer(() => {
      if (isPreparing()) this.fail(this.socket);
    }, SNAPSHOT_HEARTBEAT_TIMEOUT_MS);
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
          this.dependencies.socketUrl,
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
              this.requestRefresh();
            },
            Math.max(0, this.authRefreshAt - this.now()),
          );
        }
        socket.onmessage = (event) => this.receive(socket, event.data);
        socket.onclose = () => this.fail(socket);
        socket.onerror = () => this.fail(socket);
      } catch {
        if (isPreparing()) this.fail(this.socket);
      }
    };
    if (!this.dependencies.getProtocols) {
      open([this.dependencies.socketProtocol]);
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

  private scheduleHeartbeat(socket: SnapshotSocket): void {
    this.clearTimer("heartbeatTimer");
    this.heartbeatTimer = this.dependencies.setTimer(() => {
      this.heartbeatTimer = null;
      if (!this.isCurrent(socket)) return;
      this.responseTimer = this.dependencies.setTimer(
        () => this.fail(socket),
        SNAPSHOT_HEARTBEAT_TIMEOUT_MS,
      );
      try {
        socket.send(REACTION_HEARTBEAT_REQUEST);
      } catch {
        this.fail(socket);
      }
    }, SNAPSHOT_HEARTBEAT_INTERVAL_MS);
  }

  private receive(socket: SnapshotSocket, data: unknown): void {
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
        data.length > this.dependencies.maxMessageBytes ||
        new TextEncoder().encode(data).byteLength >
          this.dependencies.maxMessageBytes
      ) {
        throw new Error("invalid-snapshot-message");
      }
      const message: unknown = JSON.parse(data);
      const snapshot = this.dependencies.parseMessage(message);
      if (!snapshot) {
        throw new Error("invalid-snapshot-message");
      }
      if (!this.healthy) {
        this.healthy = true;
        this.connecting = false;
        this.socketFailures = 0;
        this.clearTimer("responseTimer");
        this.scheduleHeartbeat(socket);
      }
      this.clearTimer("httpTimer");
      this.dependencies.onSnapshot(snapshot, undefined, {
        source: "socket",
        requestGeneration: this.dependencies.captureGeneration?.() ?? 0,
      });
      if (this.dependencies.needsHttpRefresh?.()) this.requestRefresh();
    } catch {
      this.fail(socket);
    }
  }
}
