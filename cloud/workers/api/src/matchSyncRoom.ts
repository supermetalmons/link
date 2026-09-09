import {
  MATCH_SYNC_REFRESH_MS,
  MATCH_SYNC_SOCKET_PROTOCOL,
  type MatchSyncSnapshot,
} from "@mons/shared/match-sync";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import { readPublicFirebaseMatch } from "./firebaseRtdb.ts";
import type { InviteMetadataReadResult } from "./inviteMetadata.ts";
import {
  assertMatchSyncEnvelope,
  createMatchSyncSnapshot,
  isRegisteredSyncMatch,
  type MatchSyncMetadata,
  type MatchSyncReadResult,
} from "./matchSync.ts";

type MatchSocketAttachment = {
  channel: "matches";
  schemaVersion: 1;
  inviteId: string;
  matchId: string;
  role: "host" | "guest" | "spectator";
  actorUid: string | null;
  authenticated: boolean;
};

type StoredMatch = {
  match_id: string;
  snapshot_json: string;
  revision: number;
  next_at_ms: number | null;
};

type MatchReadState = {
  generation: number;
  pending?: Promise<MatchSyncReadResult>;
  checkedAt: number;
  inviteGeneration: number;
  result?: Extract<MatchSyncReadResult, { status: "ok" }>;
};

type MatchRoomDependencies = {
  pinInvite: (inviteId: string) => void;
  readMetadata: (inviteId: string) => Promise<InviteMetadataReadResult>;
  inviteGeneration: () => number;
  scheduleAlarm: (atMs: number) => Promise<void>;
  capacityFull: (role: string, ip: string) => boolean;
  canReceive: (
    attachment: MatchSocketAttachment,
    metadata: MatchSyncMetadata,
  ) => boolean;
};

export class MatchSyncRoom {
  private readonly states = new Map<string, MatchReadState>();
  private readonly admissions = new Map<string, number>();
  private readMatch: (playerId: string, matchId: string) => Promise<unknown>;

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
    private readonly dependencies: MatchRoomDependencies,
  ) {
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_sync_snapshots (match_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, revision INTEGER NOT NULL, next_at_ms INTEGER)",
    );
    this.readMatch = (playerId, matchId) =>
      readPublicFirebaseMatch(env, { playerId, matchId });
  }

  private sockets(matchId?: string): WebSocket[] {
    return this.ctx.getWebSockets("channel:matches").filter((socket) => {
      const attachment =
        socket.deserializeAttachment() as MatchSocketAttachment;
      return (
        socket.readyState === WebSocket.OPEN &&
        attachment?.channel === "matches" &&
        (matchId === undefined || attachment.matchId === matchId)
      );
    });
  }

  private state(matchId: string): MatchReadState {
    let state = this.states.get(matchId);
    if (!state) {
      state = { generation: 0, checkedAt: 0, inviteGeneration: -1 };
      this.states.set(matchId, state);
    }
    return state;
  }

  private close(matchId: string, code: number, reason: string): void {
    for (const socket of this.sockets(matchId)) socket.close(code, reason);
    this.ctx.storage.sql.exec(
      "UPDATE match_sync_snapshots SET next_at_ms = NULL WHERE match_id = ?",
      matchId,
    );
  }

  private apply(
    snapshot: MatchSyncSnapshot,
    metadata: MatchSyncMetadata,
  ): MatchSyncSnapshot {
    const [stored] = this.ctx.storage.sql
      .exec<StoredMatch>(
        "SELECT * FROM match_sync_snapshots WHERE match_id = ?",
        snapshot.matchId,
      )
      .toArray();
    const previousRevision = stored?.revision ?? 0;
    const comparison = { ...snapshot, revision: previousRevision };
    const changed = JSON.stringify(comparison) !== stored?.snapshot_json;
    if (changed && previousRevision >= Number.MAX_SAFE_INTEGER)
      throw new Error("match-sync-revision-exhausted");
    const next = {
      ...comparison,
      revision: changed ? previousRevision + 1 : previousRevision,
    };
    assertMatchSyncEnvelope(next);
    if (changed) {
      this.ctx.storage.sql.exec(
        "INSERT INTO match_sync_snapshots (match_id, snapshot_json, revision) VALUES (?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, revision = excluded.revision",
        next.matchId,
        JSON.stringify(next),
        next.revision,
      );
    }
    const message = changed
      ? JSON.stringify({ schemaVersion: 1, type: "snapshot", snapshot: next })
      : null;
    for (const socket of this.sockets(next.matchId)) {
      const attachment =
        socket.deserializeAttachment() as MatchSocketAttachment;
      if (!this.dependencies.canReceive(attachment, metadata)) {
        socket.close(1008, "Invite access changed");
      } else if (message) {
        try {
          socket.send(message);
        } catch {
          socket.close(1011, "Match delivery failed");
        }
      }
    }
    return next;
  }

  private async scheduleMatch(
    matchId: string,
    atMs: number,
    preserveEarlier = false,
    admitting = false,
  ): Promise<void> {
    if (
      !admitting &&
      !this.admissions.get(matchId) &&
      this.sockets(matchId).length === 0
    ) {
      this.ctx.storage.sql.exec(
        "UPDATE match_sync_snapshots SET next_at_ms = NULL WHERE match_id = ?",
        matchId,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE match_sync_snapshots SET next_at_ms = CASE WHEN ? AND next_at_ms IS NOT NULL THEN MIN(next_at_ms, ?) ELSE ? END WHERE match_id = ?",
      preserveEarlier ? 1 : 0,
      atMs,
      atMs,
      matchId,
    );
    await this.dependencies.scheduleAlarm(atMs);
  }

  private async refresh(
    inviteId: string,
    matchId: string,
    state: MatchReadState,
  ): Promise<MatchSyncReadResult> {
    state.result = undefined;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = state.generation;
        const inviteGeneration = this.dependencies.inviteGeneration();
        const metadata = await this.dependencies.readMetadata(inviteId);
        if (
          generation !== state.generation ||
          inviteGeneration !== this.dependencies.inviteGeneration()
        )
          continue;
        if (metadata.status !== "ok") {
          this.close(matchId, 1008, "Invite unavailable");
          return metadata;
        }
        if (!isRegisteredSyncMatch(metadata, matchId)) {
          this.close(matchId, 1008, "Match unavailable");
          return { status: "missing" };
        }
        const [hostValue, guestValue] = await Promise.all([
          this.readMatch(metadata.snapshot.hostId, matchId),
          metadata.snapshot.guestId === null
            ? null
            : this.readMatch(metadata.snapshot.guestId, matchId),
        ]);
        if (
          generation !== state.generation ||
          inviteGeneration !== this.dependencies.inviteGeneration()
        )
          continue;
        const snapshot = this.apply(
          createMatchSyncSnapshot(metadata, matchId, hostValue, guestValue),
          metadata,
        );
        const result = { status: "ok" as const, snapshot, metadata };
        state.result = result;
        state.checkedAt = Date.now();
        state.inviteGeneration = inviteGeneration;
        await this.scheduleMatch(
          matchId,
          state.checkedAt + MATCH_SYNC_REFRESH_MS,
        );
        if (
          generation !== state.generation ||
          inviteGeneration !== this.dependencies.inviteGeneration()
        )
          continue;
        return result;
      }
      throw new Error("match-sync-source-kept-changing");
    } catch (error) {
      state.result = undefined;
      this.close(matchId, 1011, "Match source unavailable");
      throw error;
    }
  }

  read(
    inviteId: string,
    matchId: string,
    force = false,
  ): Promise<MatchSyncReadResult> {
    this.dependencies.pinInvite(inviteId);
    if (matchId !== matchId.trim() || !isSafeFirebaseKey(matchId))
      throw new TypeError("invalid-match-sync-target");
    const state = this.state(matchId);
    if (state.pending) return state.pending;
    if (
      !force &&
      state.result &&
      state.inviteGeneration === this.dependencies.inviteGeneration() &&
      Date.now() - state.checkedAt < MATCH_SYNC_REFRESH_MS
    )
      return Promise.resolve(state.result);
    const pending = this.refresh(inviteId, matchId, state);
    state.pending = pending;
    void pending
      .finally(() => {
        if (state.pending === pending) state.pending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  async notify(inviteId: string, matchIds?: string[]): Promise<void> {
    this.dependencies.pinInvite(inviteId);
    const ids =
      matchIds === undefined
        ? [
            ...this.states.keys(),
            ...this.sockets().map(
              (socket) =>
                (socket.deserializeAttachment() as MatchSocketAttachment)
                  .matchId,
            ),
          ]
        : matchIds;
    let subscribed = false;
    const now = Date.now();
    for (const matchId of new Set(ids)) {
      if (matchId !== matchId.trim() || !isSafeFirebaseKey(matchId))
        throw new TypeError("invalid-match-sync-target");
      const state = this.states.get(matchId);
      if (state) {
        state.generation++;
        state.result = undefined;
      }
      if (this.sockets(matchId).length === 0) continue;
      this.ctx.storage.sql.exec(
        "UPDATE match_sync_snapshots SET next_at_ms = ? WHERE match_id = ?",
        now,
        matchId,
      );
      subscribed = true;
    }
    if (subscribed) await this.dependencies.scheduleAlarm(now);
  }

  async fetch(request: Request): Promise<Response> {
    const header = (name: string) =>
      request.headers.get(`X-Mons-Match-${name}`);
    let inviteId: string;
    let matchId: string;
    let actorUid: string | null;
    try {
      inviteId = decodeURIComponent(header("Invite") || "");
      matchId = decodeURIComponent(header("Match") || "");
      actorUid = header("Actor") ? decodeURIComponent(header("Actor")!) : null;
      this.dependencies.pinInvite(inviteId);
      if (matchId !== matchId.trim() || !isSafeFirebaseKey(matchId))
        throw new TypeError();
    } catch {
      return new Response("Invalid match target", { status: 400 });
    }
    const role = header("Role");
    const ip = header("IP") || "unknown";
    const revision = header("Revision");
    const protectedHeader = header("Protected");
    const authenticated = header("Authenticated");
    if (
      request.headers.get("Sec-WebSocket-Protocol") !==
        MATCH_SYNC_SOCKET_PROTOCOL ||
      (role !== "host" && role !== "guest" && role !== "spectator") ||
      ip.length > 64 ||
      !revision ||
      !/^[1-9]\d*$/.test(revision) ||
      !Number.isSafeInteger(Number(revision)) ||
      (protectedHeader !== "0" && protectedHeader !== "1") ||
      (authenticated !== "0" && authenticated !== "1") ||
      (role === "spectator"
        ? actorUid !== null
        : !isCanonicalFirebaseUid(actorUid))
    )
      return new Response("Invalid match admission", { status: 400 });
    if (this.dependencies.capacityFull(role, ip))
      return new Response("Match room is full", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    let acceptedSocket: WebSocket | null = null;
    this.admissions.set(matchId, (this.admissions.get(matchId) ?? 0) + 1);
    try {
      const initial = await this.read(inviteId, matchId);
      if (initial.status !== "ok")
        return new Response("Match unavailable", {
          status: initial.status === "missing" ? 404 : 409,
        });
      await this.scheduleMatch(
        matchId,
        Date.now() + MATCH_SYNC_REFRESH_MS,
        true,
        true,
      );
      const latest = await this.read(inviteId, matchId);
      if (latest.status !== "ok")
        return new Response("Match unavailable", {
          status: latest.status === "missing" ? 404 : 409,
        });
      if (
        latest.snapshot.revision !== Number(revision) ||
        latest.metadata.passwordProtected !== (protectedHeader === "1")
      )
        return new Response("Match admission changed", { status: 409 });
      const attachment: MatchSocketAttachment = {
        channel: "matches",
        schemaVersion: 1,
        inviteId,
        matchId,
        role,
        actorUid,
        authenticated: authenticated === "1",
      };
      if (!this.dependencies.canReceive(attachment, latest.metadata))
        return new Response("Invite access denied", { status: 403 });
      if (this.dependencies.capacityFull(role, ip))
        return new Response("Match room is full", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      const pair = new WebSocketPair();
      pair[1].serializeAttachment(attachment);
      this.ctx.acceptWebSocket(pair[1], [
        "channel:matches",
        `match-role:${role}`,
        ...(role === "spectator" ? [`match-ip:${ip}`] : []),
      ]);
      acceptedSocket = pair[1];
      pair[1].send(
        JSON.stringify({
          schemaVersion: 1,
          type: "snapshot",
          snapshot: latest.snapshot,
        }),
      );
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": MATCH_SYNC_SOCKET_PROTOCOL },
      });
    } catch {
      if (acceptedSocket) {
        acceptedSocket.close(1011, "Match admission failed");
        this.closed(acceptedSocket);
      }
      return new Response("Match source unavailable", { status: 503 });
    } finally {
      const pending = (this.admissions.get(matchId) ?? 1) - 1;
      if (pending > 0) this.admissions.set(matchId, pending);
      else {
        this.admissions.delete(matchId);
        if (this.sockets(matchId).length === 0) {
          this.ctx.storage.sql.exec(
            "UPDATE match_sync_snapshots SET next_at_ms = NULL WHERE match_id = ?",
            matchId,
          );
        }
      }
    }
  }

  async alarm(): Promise<void> {
    const due = this.ctx.storage.sql
      .exec<{ match_id: string }>(
        "SELECT match_id FROM match_sync_snapshots WHERE next_at_ms IS NOT NULL AND next_at_ms <= ? ORDER BY next_at_ms",
        Date.now(),
      )
      .toArray();
    let cursor = 0;
    const run = async () => {
      while (cursor < due.length) {
        const { match_id: matchId } = due[cursor++];
        const socket = this.sockets(matchId)[0];
        const inviteId = (
          socket?.deserializeAttachment() as MatchSocketAttachment | undefined
        )?.inviteId;
        if (!inviteId) {
          if (this.admissions.get(matchId)) {
            this.ctx.storage.sql.exec(
              "UPDATE match_sync_snapshots SET next_at_ms = ? WHERE match_id = ?",
              Date.now() + MATCH_SYNC_REFRESH_MS,
              matchId,
            );
            continue;
          }
          this.ctx.storage.sql.exec(
            "UPDATE match_sync_snapshots SET next_at_ms = NULL WHERE match_id = ?",
            matchId,
          );
          continue;
        }
        try {
          await this.read(inviteId, matchId, true);
        } catch (error) {
          console.error({
            event: "match_sync_refresh_failed",
            inviteId,
            matchId,
            kind: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, due.length) }, run));
  }

  nextAlarm(): number | null {
    return this.ctx.storage.sql
      .exec<{ next_at_ms: number | null }>(
        "SELECT MIN(next_at_ms) AS next_at_ms FROM match_sync_snapshots",
      )
      .one().next_at_ms;
  }

  closed(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as MatchSocketAttachment;
    if (
      attachment?.channel === "matches" &&
      !this.admissions.get(attachment.matchId) &&
      this.sockets(attachment.matchId).length === 0
    ) {
      this.ctx.storage.sql.exec(
        "UPDATE match_sync_snapshots SET next_at_ms = NULL WHERE match_id = ?",
        attachment.matchId,
      );
    }
  }
}
