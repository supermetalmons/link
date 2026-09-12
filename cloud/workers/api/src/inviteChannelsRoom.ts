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
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import {
  normalizeInviteMetadata,
  type InviteMetadataReadResult,
} from "./inviteMetadata.ts";
import {
  normalizeInviteWagers,
  type InviteWagersReadResult,
  type InviteWagersSourceResult,
} from "./inviteWagers.ts";
import { composeInviteWagerSource } from "./inviteWagerSource.ts";
import type { WagerStateSnapshot } from "./wagerStateD1.ts";
import {
  readSocketSession,
  socketSessionCurrent,
  type SocketSession,
  type SocketSessions,
} from "./socketSession.ts";

type InviteChannel = "metadata" | "wagers";

type InviteReadResult = {
  metadata: InviteMetadataReadResult;
  wagers?: InviteWagersReadResult;
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

export function canReceiveInvite(
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

type InviteChannelsDependencies = {
  readInvite: (inviteId: string) => Promise<unknown>;
  readWagerStates: (inviteId: string) => Promise<WagerStateSnapshot[]>;
  scheduleAlarm: (atMs: number) => Promise<void>;
  capacityFull: (role: string) => boolean;
  socketSessions: SocketSessions;
  limits: {
    sockets: number;
    spectators: number;
    spectatorsPerIp: number;
    socketsPerParticipant: number;
  };
};

export class InviteChannelsRoom {
  private inviteSequence: Promise<void> = Promise.resolve();
  private queuedInviteRead: Promise<InviteReadResult> | null = null;
  private queuedInviteNeedsWagers = false;
  private pendingWagerAdmissions = 0;
  private inviteRefreshGeneration = 0;
  private inviteResultGeneration = 0;
  private inviteInvalidationGeneration = 0;
  private inviteResultInvalidationGeneration = 0;
  private inviteResult: InviteReadResult | null = null;
  private inviteCheckedAt = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly dependencies: InviteChannelsDependencies,
  ) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), invite_id TEXT NOT NULL, snapshot_json TEXT, revision INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_wagers (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), invite_id TEXT NOT NULL, snapshot_json TEXT, revision INTEGER NOT NULL, source_fingerprint TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_refresh_schedule (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), next_at_ms INTEGER NOT NULL)",
    );
  }

  pinInvite(inviteId: string): void {
    this.pinInviteRow(inviteId);
  }

  pinnedInviteId(): string {
    return this.ctx.storage.sql
      .exec<Pick<StoredMetadata, "invite_id">>(
        "SELECT invite_id FROM invite_metadata WHERE singleton = 1",
      )
      .one().invite_id;
  }

  invalidationGeneration(): number {
    return this.inviteInvalidationGeneration;
  }

  invalidate(): void {
    this.inviteInvalidationGeneration++;
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
          this.dependencies.socketSessions.active(socket) &&
          (!activeOnly || socket.readyState === WebSocket.OPEN)
        );
      });
  }

  private pinInviteRow(inviteId: string): StoredMetadata {
    if (
      inviteId !== inviteId.trim() ||
      !isSafeRecordKey(inviteId) ||
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

  private async scheduleInviteRefresh(atMs: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO invite_refresh_schedule (singleton, next_at_ms) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET next_at_ms = MIN(next_at_ms, excluded.next_at_ms)",
      atMs,
    );
    await this.dependencies.scheduleAlarm(atMs);
  }

  private applyMetadata(
    inviteId: string,
    result: InviteMetadataReadResult,
  ): InviteMetadataReadResult {
    const stored = this.pinInviteRow(inviteId);
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
        this.dependencies.socketSessions.send(socket, serialized);
      }
    }
    return source;
  }

  private revalidateWagerAccess(metadata: InviteMetadataReadResult): void {
    for (const socket of this.inviteSockets("wagers", true)) {
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
  }

  private applyWagers(
    result: InviteWagersSourceResult,
    metadata: InviteMetadataReadResult,
  ): InviteWagersReadResult {
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
      for (const socket of this.inviteSockets("wagers", true)) {
        if (
          canReceiveInvite(
            socket.deserializeAttachment() as InviteSocketAttachment,
            metadata,
          )
        ) {
          this.dependencies.socketSessions.send(socket, serialized);
        }
      }
    }
    return { status: "ok", snapshot, metadata };
  }

  private async refreshInvite(
    inviteId: string,
    needsWagers = false,
  ): Promise<InviteReadResult> {
    this.pinInvite(inviteId);
    needsWagers ||= this.pendingWagerAdmissions > 0;
    const generation = ++this.inviteRefreshGeneration;
    this.inviteResult = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const invalidationGeneration = this.inviteInvalidationGeneration;
      let wagerStates: WagerStateSnapshot[] | undefined;
      if (needsWagers) {
        try {
          wagerStates = await this.dependencies.readWagerStates(inviteId);
        } catch (error) {
          logWagersRefreshFailure(inviteId, error);
        }
      }
      const value = await this.dependencies.readInvite(inviteId);
      const metadataSource = normalizeInviteMetadata(inviteId, value);
      let wagerSource: InviteWagersSourceResult | undefined;
      if (needsWagers) {
        try {
          wagerSource =
            wagerStates === undefined
              ? {
                  status:
                    metadataSource.status === "missing" ? "missing" : "invalid",
                }
              : await normalizeInviteWagers(
                  inviteId,
                  composeInviteWagerSource(value, wagerStates),
                  metadataSource,
                );
        } catch (error) {
          logWagersRefreshFailure(inviteId, error);
          wagerSource = { status: "invalid" };
        }
      }
      if (invalidationGeneration !== this.inviteInvalidationGeneration)
        continue;
      const metadata = this.applyMetadata(inviteId, metadataSource);
      this.revalidateWagerAccess(metadata);
      const result: InviteReadResult = { metadata };
      if (wagerSource) {
        try {
          result.wagers = this.applyWagers(wagerSource, metadata);
        } catch (error) {
          logWagersRefreshFailure(inviteId, error);
          result.wagers = { status: "invalid" };
        }
      }
      this.inviteResult = result;
      this.inviteCheckedAt = Date.now();
      this.inviteResultGeneration = generation;
      this.inviteResultInvalidationGeneration = invalidationGeneration;
      return result;
    }
    throw new Error("invite-source-kept-changing");
  }

  private readInvite(
    inviteId: string,
    needsWagers = false,
  ): Promise<InviteReadResult> {
    this.pinInvite(inviteId);
    this.queuedInviteNeedsWagers ||= needsWagers;
    if (!this.queuedInviteRead) {
      this.queuedInviteRead = this.serializeInvite(() => {
        const needsWagers = this.queuedInviteNeedsWagers;
        this.queuedInviteRead = null;
        this.queuedInviteNeedsWagers = false;
        return this.refreshInvite(inviteId, needsWagers);
      });
    }
    return this.queuedInviteRead;
  }

  async readMetadata(
    inviteId: string,
    allowCached = false,
  ): Promise<InviteMetadataReadResult> {
    if (
      allowCached &&
      this.inviteResult &&
      this.inviteResultInvalidationGeneration ===
        this.inviteInvalidationGeneration &&
      Date.now() - this.inviteCheckedAt < INVITE_METADATA_REFRESH_MS
    )
      return this.inviteResult.metadata;
    return (await this.readInvite(inviteId)).metadata;
  }

  async readWagers(inviteId: string): Promise<InviteWagersReadResult> {
    const result = await this.readInvite(inviteId, true);
    if (!result.wagers) throw new Error("invite-wagers-refresh-missing");
    return result.wagers;
  }

  async refreshIfSubscribed(
    inviteId: string,
    channel?: InviteChannel,
  ): Promise<void> {
    if (this.inviteSockets(channel, true).length === 0) return;
    this.pinInvite(inviteId);
    await this.scheduleInviteRefresh(Date.now());
  }

  async alarm(): Promise<void> {
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
        await this.refreshInvite(
          attachment.inviteId,
          this.inviteSockets("wagers", true).length > 0,
        );
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
  }

  nextAlarm(): number | null {
    const [scheduled] = this.ctx.storage.sql
      .exec<{ next_at_ms: number }>(
        "SELECT next_at_ms FROM invite_refresh_schedule WHERE singleton = 1",
      )
      .toArray();
    return scheduled?.next_at_ms ?? null;
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
      this.dependencies.capacityFull(role) ||
      sockets.length >= this.dependencies.limits.sockets ||
      (role === "spectator"
        ? roleCount("spectator") >= this.dependencies.limits.spectators ||
          this.ctx.getWebSockets(`${channel}-ip:${ip}`).length >=
            this.dependencies.limits.spectatorsPerIp
        : roleCount(role) >= this.dependencies.limits.socketsPerParticipant)
    );
  }

  async fetch(request: Request, channel: InviteChannel): Promise<Response> {
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
        : !isCanonicalLoginUid(actorUid))
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
    if (channel === "wagers") this.pendingWagerAdmissions++;
    return this.serializeInvite(async () => {
      if (this.inviteRoomFull(channel, role, ip)) {
        return new Response(`${name} room is full`, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      if (session.authenticated)
        await this.dependencies.scheduleAlarm(session.authExpiresAtMs);
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
          this.inviteInvalidationGeneration &&
        (channel === "metadata" || this.inviteResult.wagers !== undefined)
          ? this.inviteResult
          : await this.refreshInvite(inviteId, channel === "wagers");
      const source = latest[channel];
      if (!source) throw new Error("invite-wagers-refresh-missing");
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
      this.dependencies.socketSessions.send(pair[1], JSON.stringify(message));
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": protocol },
      });
    }).finally(() => {
      if (channel === "wagers") this.pendingWagerAdmissions--;
    });
  }
}
