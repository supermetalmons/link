import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  isReadMatchSyncResponse,
  type ReadMatchSyncResponse,
} from "@mons/shared/match-sync";
import { AuthApiFailure } from "./authErrors.ts";
import type { WorkerExecutionContext } from "./sessionAuth.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  handleInviteReadRoute,
  resolveInviteReadRole,
  type InviteReadRouteDependencies,
} from "./inviteReadRoute.ts";
import { normalizeInviteMetadata } from "./inviteMetadata.ts";
import {
  isRegisteredSyncMatch,
  type MatchSyncReadResult,
} from "./matchSync.ts";

const MATCH_SYNC_ROUTE_PATTERN =
  /^\/invites\/([^/]+)\/matches\/([^/]+)\/(snapshot|socket)$/;

export type MatchSyncRouteDependencies = InviteReadRouteDependencies & {
  room?: {
    readMatches(
      inviteId: string,
      matchId: string,
    ): Promise<MatchSyncReadResult>;
    fetch(request: Request): Promise<Response>;
  };
};

export function isMatchSyncPath(pathname: string): boolean {
  return MATCH_SYNC_ROUTE_PATTERN.test(pathname);
}

function readRoute(request: Request) {
  const url = new URL(request.url);
  const match = MATCH_SYNC_ROUTE_PATTERN.exec(url.pathname);
  let inviteId = "";
  let matchId = "";
  try {
    inviteId = match ? decodeURIComponent(match[1]) : "";
    matchId = match ? decodeURIComponent(match[2]) : "";
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-match-id");
  }
  if (
    !isSafeRecordKey(inviteId) ||
    !isSafeRecordKey(matchId) ||
    inviteId !== inviteId.trim() ||
    matchId !== matchId.trim() ||
    url.search
  ) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-match-id");
  }
  return { inviteId, matchId, socket: match?.[3] === "socket" };
}

export async function handleMatchSyncRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: MatchSyncRouteDependencies = {},
): Promise<Response> {
  return handleInviteReadRoute(request, env, ctx, {
    channel: "matches",
    dependencies,
    readRoute,
    validateInvite(invite, { inviteId, matchId }) {
      const existence = normalizeInviteMetadata(inviteId, invite);
      if (existence.status === "missing") {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      if (existence.status !== "ok") {
        throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
      }
      if (!isRegisteredSyncMatch(existence, matchId)) {
        throw new AuthApiFailure(404, "not-found", "match-not-found");
      }
    },
    getRoom: (inviteId) =>
      dependencies.room || env.INVITE_REACTIONS.getByName(inviteId),
    async prepare(room, access) {
      const { inviteId, matchId } = access;
      const read = await room.readMatches(inviteId, matchId);
      if (read.status === "missing") {
        throw new AuthApiFailure(404, "not-found", "match-not-found");
      }
      if (read.status !== "ok") {
        throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
      }
      const metadata = read.metadata;
      const role = await resolveInviteReadRole(
        access,
        metadata.snapshot,
        metadata.passwordProtected,
      );
      const body: ReadMatchSyncResponse = { ok: true, snapshot: read.snapshot };
      if (
        !isReadMatchSyncResponse(body) ||
        body.snapshot.inviteId !== inviteId ||
        body.snapshot.matchId !== matchId ||
        body.snapshot.hostPlayerId !== metadata.snapshot.hostId ||
        body.snapshot.guestPlayerId !== metadata.snapshot.guestId ||
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
          MATCH_SYNC_MAX_MESSAGE_BYTES
      ) {
        throw new AuthApiFailure(503, "unavailable", "match-sync-unavailable");
      }
      return {
        body,
        role,
        revision: read.snapshot.revision,
        passwordProtected: metadata.passwordProtected,
        socketHeaders: { "X-Mons-Match-Match": encodeURIComponent(matchId) },
      };
    },
  });
}
