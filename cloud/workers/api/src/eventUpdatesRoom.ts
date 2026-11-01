import {
  EVENT_UPDATES_SOCKET_PROTOCOL,
  isEventUpdateMessage,
  type EventUpdateMessage,
} from "@mons/shared/events";
import { requireEventBookmarkEpoch } from "./eventBookmarks.ts";
import { sha256Hex } from "./canonicalJson.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import {
  readSocketSession,
  socketSessionCurrent,
  SocketSessions,
} from "./socketSession.ts";
import { acceptRoomSocket, sendSocketSnapshot } from "./socketUpgrade.ts";

const MAX_EVENT_UPDATE_SOCKETS = 512;
export const MAX_EVENT_UPDATE_SOCKETS_PER_USER = 4;
const MAX_EVENT_UPDATE_SOCKETS_PER_IP = 32;

type EventUpdatesDependencies = {
  storage: DurableObjectStorage;
  epoch: string;
  readRevision(eventId: string): Promise<number>;
};

export class EventUpdatesRoom {
  readonly sessions: SocketSessions;
  private readonly epoch: string;
  private alarmTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly dependencies: EventUpdatesDependencies,
  ) {
    this.epoch = requireEventBookmarkEpoch(dependencies.epoch);
    this.sessions = new SocketSessions(ctx);
    dependencies.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS event_update_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      event_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT`);
  }

  private state(): EventUpdateMessage {
    const row = this.dependencies.storage.sql
      .exec<{ event_id: string; epoch: string; revision: number }>(
        "SELECT event_id, epoch, revision FROM event_update_state WHERE singleton = 1",
      )
      .one();
    const message = {
      schemaVersion: 1 as const,
      type: "event-changed" as const,
      eventId: row.event_id,
      epoch: row.epoch,
      revision: row.revision,
    };
    if (!isEventUpdateMessage(message))
      throw new Error("event-updates-state-invalid");
    return message;
  }

  private pin(eventId: string): void {
    if (!isSafeRecordKey(eventId) || eventId !== eventId.trim())
      throw new TypeError("event-updates-target-invalid");
    this.dependencies.storage.sql.exec(
      "INSERT OR IGNORE INTO event_update_state VALUES (1, ?, ?, 0)",
      eventId,
      this.epoch,
    );
    if (this.state().eventId !== eventId)
      throw new Error("event-updates-target-conflict");
  }

  private publish(eventId: string, revision: number): void {
    const message = {
      schemaVersion: 1 as const,
      type: "event-changed" as const,
      eventId,
      epoch: this.epoch,
      revision,
    };
    if (!isEventUpdateMessage(message))
      throw new TypeError("event-updates-revision-invalid");
    const previous = this.state();
    if (previous.epoch === this.epoch && previous.revision >= revision) return;
    this.dependencies.storage.sql.exec(
      "UPDATE event_update_state SET epoch = ?, revision = ? WHERE singleton = 1",
      this.epoch,
      revision,
    );
    const serialized = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets())
      this.sessions.send(socket, serialized);
  }

  notifyEventChanged(eventId: string, epoch: string, revision: number): void {
    if (
      !isEventUpdateMessage({
        schemaVersion: 1,
        type: "event-changed",
        eventId,
        epoch,
        revision,
      })
    )
      throw new TypeError("event-updates-notification-invalid");
    if (epoch !== this.epoch) return;
    this.pin(eventId);
    this.publish(eventId, revision);
  }

  private scheduleExpiry(atMs: number): Promise<void> {
    const pending = this.alarmTail.then(() =>
      this.dependencies.storage.transaction(async (transaction) => {
        const current = await transaction.getAlarm();
        if (current === null || current > atMs)
          await transaction.setAlarm(atMs);
      }),
    );
    this.alarmTail = pending.catch(() => undefined);
    return pending;
  }

  private full(userTag: string, ip: string): boolean {
    const active = (tag?: string) =>
      this.ctx
        .getWebSockets(tag)
        .filter((socket) => this.sessions.active(socket)).length;
    return (
      active() >= MAX_EVENT_UPDATE_SOCKETS ||
      active(userTag) >= MAX_EVENT_UPDATE_SOCKETS_PER_USER ||
      active(`event-ip:${ip}`) >= MAX_EVENT_UPDATE_SOCKETS_PER_IP
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      new URL(request.url).pathname !== "/events/socket" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("Sec-WebSocket-Protocol") !==
        EVENT_UPDATES_SOCKET_PROTOCOL
    )
      return new Response("WebSocket upgrade required", { status: 426 });
    let eventId = "";
    let uid = "";
    try {
      eventId = decodeURIComponent(
        request.headers.get("X-Mons-Event-Id") || "",
      );
      uid = decodeURIComponent(request.headers.get("X-Mons-Event-User") || "");
    } catch {}
    const ip = request.headers.get("X-Mons-Event-IP") || "";
    if (
      !isSafeRecordKey(eventId) ||
      eventId !== eventId.trim() ||
      !isCanonicalLoginUid(uid) ||
      !ip ||
      ip.length > 128
    )
      return new Response("Invalid event target", { status: 400 });
    const session = readSocketSession(request, true);
    if (!session?.authenticated)
      return new Response("Session expired", { status: 401 });
    const userTag = `event-user:${await sha256Hex(uid)}`;
    this.pin(eventId);
    if (this.full(userTag, ip))
      return new Response("Event room is full", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    const revision = await this.dependencies.readRevision(eventId);
    this.publish(eventId, revision);
    await this.scheduleExpiry(session.authExpiresAtMs);
    if (!socketSessionCurrent(session))
      return new Response("Session expired", { status: 401 });
    if (this.full(userTag, ip))
      return new Response("Event room is full", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    const pair = acceptRoomSocket(
      this.ctx,
      { channel: "events", schemaVersion: 1, eventId, uid, ...session },
      [userTag, `event-ip:${ip}`],
    );
    return sendSocketSnapshot(
      this.sessions,
      pair,
      this.state(),
      EVENT_UPDATES_SOCKET_PROTOCOL,
    );
  }

  async alarm(): Promise<void> {
    const next = this.sessions.nextExpiry();
    if (next !== null) await this.scheduleExpiry(next);
  }
}
