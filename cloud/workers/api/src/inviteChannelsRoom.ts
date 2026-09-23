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
import { isSafeRecordKey } from "./recordKeys.ts";
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
  socketSessionCurrent,
  type SocketSession,
  type SocketSessions,
} from "./socketSession.ts";
import { readSocketAdmission } from "./socketAdmission.ts";
import { acceptRoomSocket, sendSocketSnapshot } from "./socketUpgrade.ts";
import {
  socketCapacityFull,
  type SocketCapacityLimits,
} from "./socketCapacity.ts";
import type { InviteAlarmWork } from "./inviteAlarmCoordinator.ts";

type InviteChannel = "metadata" | "wagers";

type MetadataRead = {
  metadata: InviteMetadataReadResult;
  value: unknown;
  generation: number;
  version: number;
  invalidationGeneration: number;
};

type WagerRead = {
  metadata: MetadataRead;
  wagers: InviteWagersReadResult;
  generation: number;
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
  limits: SocketCapacityLimits;
};

export class InviteChannelsRoom {
  private metadataSequence: Promise<void> = Promise.resolve();
  private wagerSequence: Promise<void> = Promise.resolve();
  private pendingAdmissions = 0;
  private queuedMetadataRead: Promise<MetadataRead> | null = null;
  private activeMetadataRead: Promise<MetadataRead> | null = null;
  private queuedWagerRead: Promise<WagerRead> | null = null;
  private metadataRefreshGeneration = 0;
  private metadataVersion = 0;
  private wagerRefreshGeneration = 0;
  private inviteInvalidationGeneration = 0;
  private metadataResult: MetadataRead | null = null;
  private wagerResult: WagerRead | null = null;
  private metadataCheckedAt = 0;

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

  private serializeMetadata<T>(work: () => T | Promise<T>): Promise<T> {
    const pending = this.metadataSequence.then(work);
    this.metadataSequence = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private serializeWagers<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.wagerSequence.then(work);
    this.wagerSequence = pending.then(
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

  private metadataCurrent(result: MetadataRead): boolean {
    return (
      this.metadataResult === result &&
      result.generation === this.metadataRefreshGeneration &&
      result.invalidationGeneration === this.inviteInvalidationGeneration
    );
  }

  private wagersCurrent(result: WagerRead): boolean {
    return (
      this.wagerResult === result &&
      result.generation === this.wagerRefreshGeneration &&
      this.metadataResult !== null &&
      this.metadataCurrent(this.metadataResult) &&
      result.metadata.version === this.metadataResult.version &&
      result.metadata.invalidationGeneration ===
        this.inviteInvalidationGeneration
    );
  }

  private async refreshMetadata(inviteId: string): Promise<MetadataRead> {
    const previous = this.metadataResult;
    this.metadataResult = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = ++this.metadataRefreshGeneration;
      const invalidationGeneration = this.inviteInvalidationGeneration;
      const value = await this.dependencies.readInvite(inviteId);
      const source = normalizeInviteMetadata(inviteId, value);
      if (invalidationGeneration !== this.inviteInvalidationGeneration)
        continue;
      const metadata = this.applyMetadata(inviteId, source);
      this.revalidateWagerAccess(metadata);
      const version =
        previous &&
        JSON.stringify(previous.metadata) === JSON.stringify(metadata)
          ? previous.version
          : ++this.metadataVersion;
      const result = {
        metadata,
        value,
        generation,
        version,
        invalidationGeneration,
      };
      this.metadataResult = result;
      this.metadataCheckedAt = Date.now();
      return result;
    }
    throw new Error("invite-source-kept-changing");
  }

  private readMetadataSnapshot(inviteId: string): Promise<MetadataRead> {
    this.pinInvite(inviteId);
    if (!this.queuedMetadataRead) {
      this.queuedMetadataRead = this.serializeMetadata(() => {
        this.queuedMetadataRead = null;
        const pending = this.refreshMetadata(inviteId);
        this.activeMetadataRead = pending;
        return pending.finally(() => {
          if (this.activeMetadataRead === pending)
            this.activeMetadataRead = null;
        });
      });
    }
    return this.queuedMetadataRead;
  }

  private async refreshWagers(inviteId: string): Promise<WagerRead> {
    this.wagerResult = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = ++this.wagerRefreshGeneration;
      const invalidationGeneration = this.inviteInvalidationGeneration;
      let wagerStates: WagerStateSnapshot[] | undefined;
      try {
        wagerStates = await this.dependencies.readWagerStates(inviteId);
      } catch (error) {
        logWagersRefreshFailure(inviteId, error);
      }
      const metadata = await this.readMetadataSnapshot(inviteId);
      if (invalidationGeneration !== this.inviteInvalidationGeneration)
        continue;
      let source: InviteWagersSourceResult;
      try {
        source =
          wagerStates === undefined
            ? {
                status:
                  metadata.metadata.status === "missing"
                    ? "missing"
                    : "invalid",
              }
            : await normalizeInviteWagers(
                inviteId,
                composeInviteWagerSource(metadata.value, wagerStates),
                metadata.metadata,
              );
      } catch (error) {
        logWagersRefreshFailure(inviteId, error);
        source = { status: "invalid" };
      }
      const result = await this.serializeMetadata(async () => {
        const latest = this.metadataResult;
        if (
          !latest ||
          !this.metadataCurrent(latest) ||
          latest.version !== metadata.version ||
          invalidationGeneration !== this.inviteInvalidationGeneration
        )
          return null;
        let wagers: InviteWagersReadResult;
        try {
          wagers = this.applyWagers(source, latest.metadata);
        } catch (error) {
          logWagersRefreshFailure(inviteId, error);
          wagers = { status: "invalid" };
        }
        const result = { metadata: latest, wagers, generation };
        this.wagerResult = result;
        return result;
      });
      if (result) return result;
    }
    throw new Error("invite-source-kept-changing");
  }

  private readWagerSnapshot(inviteId: string): Promise<WagerRead> {
    this.pinInvite(inviteId);
    if (!this.queuedWagerRead) {
      this.queuedWagerRead = this.serializeWagers(() => {
        this.queuedWagerRead = null;
        return this.refreshWagers(inviteId);
      });
    }
    return this.queuedWagerRead;
  }

  async readMetadata(
    inviteId: string,
    allowCached = false,
  ): Promise<InviteMetadataReadResult> {
    this.pinInvite(inviteId);
    if (allowCached) {
      const pending = this.queuedMetadataRead || this.activeMetadataRead;
      if (pending) return (await pending).metadata;
      if (
        this.metadataResult &&
        this.metadataCurrent(this.metadataResult) &&
        Date.now() - this.metadataCheckedAt < INVITE_METADATA_REFRESH_MS
      )
        return this.metadataResult.metadata;
    }
    return (await this.readMetadataSnapshot(inviteId)).metadata;
  }

  async refreshCommittedMetadata(
    inviteId: string,
    matchesSubscribed: boolean,
  ): Promise<void> {
    this.pinInvite(inviteId);
    const wagersSubscribed = this.inviteSockets("wagers", true).length > 0;
    const channelsSubscribed =
      wagersSubscribed || this.inviteSockets("metadata", true).length > 0;
    if (channelsSubscribed) {
      await this.scheduleInviteRefresh(
        Date.now() + (wagersSubscribed ? 0 : INVITE_METADATA_REFRESH_MS),
      );
    }
    if (!channelsSubscribed && !matchesSubscribed) return;
    await this.readMetadataSnapshot(inviteId);
  }

  async readWagers(inviteId: string): Promise<InviteWagersReadResult> {
    return (await this.readWagerSnapshot(inviteId)).wagers;
  }

  async refreshIfSubscribed(
    inviteId: string,
    channel?: InviteChannel,
  ): Promise<void> {
    if (this.inviteSockets(channel, true).length === 0) return;
    this.pinInvite(inviteId);
    await this.scheduleInviteRefresh(Date.now());
  }

  prepareAlarm(): InviteAlarmWork | null {
    const sockets = this.inviteSockets(undefined, true);
    if (sockets.length === 0 && this.pendingAdmissions === 0) {
      this.ctx.storage.sql.exec("DELETE FROM invite_refresh_schedule");
      return null;
    }
    const [scheduled] = this.ctx.storage.sql
      .exec<{ next_at_ms: number }>(
        "SELECT next_at_ms FROM invite_refresh_schedule WHERE singleton = 1",
      )
      .toArray();
    if (scheduled && scheduled.next_at_ms > Date.now()) return null;
    const nextAtMs =
      Date.now() +
      Math.min(INVITE_METADATA_REFRESH_MS, INVITE_WAGERS_REFRESH_MS);
    this.ctx.storage.sql.exec(
      "INSERT INTO invite_refresh_schedule (singleton, next_at_ms) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET next_at_ms = excluded.next_at_ms",
      nextAtMs,
    );
    const inviteId = this.pinnedInviteId();
    const refresh = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "invite_source_refresh_failed",
            inviteId,
            kind: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    };
    return {
      schedule: () => this.dependencies.scheduleAlarm(nextAtMs),
      metadata: async () => {
        if (this.inviteSockets(undefined, true).length > 0)
          await refresh(() => this.readMetadataSnapshot(inviteId));
      },
      wagers: async () => {
        if (this.inviteSockets("wagers", true).length > 0)
          await refresh(() => this.readWagerSnapshot(inviteId));
      },
    };
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
      socketCapacityFull(
        role,
        {
          sockets: sockets.length,
          spectators: roleCount("spectator"),
          spectatorsPerIp: this.ctx.getWebSockets(`${channel}-ip:${ip}`).length,
          socketsForRole: roleCount(role),
        },
        this.dependencies.limits,
      )
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
    const parsed = readSocketAdmission(request, {
      headerPrefix: name,
      protocol,
      actorUid,
    });
    if (parsed.status === "invalid") {
      return new Response(`Invalid ${channel} admission`, { status: 400 });
    }
    if (parsed.status === "expired")
      return new Response("Session expired", { status: 401 });
    const { role, ip, revision, passwordProtected, session } = parsed.admission;
    const attachment: InviteSocketAttachment = {
      channel,
      schemaVersion: 1,
      inviteId,
      role,
      actorUid,
      ...session,
    };
    const observedGeneration =
      channel === "metadata"
        ? this.metadataRefreshGeneration
        : this.wagerRefreshGeneration;
    const admit = async (): Promise<Response> => {
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
      const accept = (
        source: InviteMetadataReadResult | InviteWagersReadResult,
        metadata: InviteMetadataReadResult,
      ): Response => {
        if (source.status !== "ok" || metadata.status !== "ok") {
          return new Response(`Invite ${channel} unavailable`, {
            status: source.status === "missing" ? 404 : 409,
          });
        }
        if (
          source.snapshot.revision !== revision ||
          metadata.passwordProtected !== passwordProtected
        ) {
          return new Response(`Invite ${channel} changed`, { status: 409 });
        }
        if (!canReceiveInvite(attachment, metadata)) {
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
        const pair = acceptRoomSocket(this.ctx, attachment, [
          `channel:${channel}`,
          `${channel}-role:${role}`,
          ...(role === "spectator" ? [`${channel}-ip:${ip}`] : []),
        ]);
        const message = {
          schemaVersion: 1,
          type: "snapshot",
          snapshot: source.snapshot,
        };
        return sendSocketSnapshot(
          this.dependencies.socketSessions,
          pair,
          message,
          protocol,
        );
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        if (channel === "metadata") {
          const latest =
            this.metadataResult &&
            this.metadataResult.generation > observedGeneration &&
            this.metadataCurrent(this.metadataResult)
              ? this.metadataResult
              : await this.refreshMetadata(inviteId);
          if (!this.metadataCurrent(latest)) continue;
          return accept(latest.metadata, latest.metadata);
        }
        const latest =
          this.wagerResult &&
          this.wagerResult.generation > observedGeneration &&
          this.wagersCurrent(this.wagerResult)
            ? this.wagerResult
            : await this.refreshWagers(inviteId);
        const response = await this.serializeMetadata(() => {
          if (!this.wagersCurrent(latest)) return null;
          return accept(latest.wagers, latest.metadata.metadata);
        });
        if (response) return response;
      }
      throw new Error("invite-source-kept-changing");
    };
    this.pendingAdmissions++;
    return (
      channel === "metadata"
        ? this.serializeMetadata(admit)
        : this.serializeWagers(admit)
    ).finally(() => {
      this.pendingAdmissions--;
    });
  }
}
