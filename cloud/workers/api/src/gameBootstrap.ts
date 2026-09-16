import {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
  type ReadGameBootstrapResponse,
} from "@mons/shared/game-bootstrap";
import { selectInviteMatch } from "@mons/shared/rematches";
import type { SessionBootstrapTarget } from "@mons/shared/session-bootstrap";
import { AuthApiFailure } from "./authErrors.ts";
import { readGameBootstrapAdmission } from "./gameBootstrapAdmission.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  normalizeInviteMetadata,
  type InviteMetadataReadResult,
} from "./inviteMetadata.ts";
import { resolveInviteReadRole } from "./inviteReadRoute.ts";
import type { MatchSyncReadResult } from "./matchSync.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import type { SessionIdentity } from "./sessionAuth.ts";

export type GameBootstrapMeasure = <T>(
  name: string,
  work: () => Promise<T>,
) => Promise<T>;

export type GameBootstrapDependencies = {
  readAdmission?: (inviteId: string, signal: AbortSignal) => Promise<unknown>;
  repository?: GameplayRepository;
  room?: {
    readMetadata(inviteId: string): Promise<InviteMetadataReadResult>;
    readMatches(
      inviteId: string,
      matchId: string,
      options?: { fresh?: boolean },
    ): Promise<MatchSyncReadResult>;
  };
  measure?: GameBootstrapMeasure;
};

export class GameBootstrapRateLimitFailure extends AuthApiFailure {
  readonly retryAfterMs = 60_000;

  constructor() {
    super(429, "resource-exhausted", "rate-limited");
  }
}

function requireMetadata(read: InviteMetadataReadResult) {
  if (read.status === "missing") {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  if (read.status !== "ok") {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  return read;
}

function sameMetadata(
  first: Extract<InviteMetadataReadResult, { status: "ok" }>,
  second: Extract<InviteMetadataReadResult, { status: "ok" }>,
): boolean {
  return (
    first.passwordProtected === second.passwordProtected &&
    Object.entries(first.snapshot).every(
      ([key, value]) =>
        key === "revision" ||
        second.snapshot[key as keyof typeof second.snapshot] === value,
    ) &&
    Object.keys(first.automatchOperationIds).length ===
      Object.keys(second.automatchOperationIds).length &&
    Object.entries(first.automatchOperationIds).every(
      ([uid, operationId]) => second.automatchOperationIds[uid] === operationId,
    )
  );
}

export async function readAuthenticatedGameBootstrap(
  {
    inviteId,
    selection,
    identity,
    signal,
  }: SessionBootstrapTarget & {
    identity: RequestIdentity | SessionIdentity;
    signal: AbortSignal;
  },
  env: Env,
  dependencies: GameBootstrapDependencies = {},
): Promise<ReadGameBootstrapResponse> {
  const preferApproved = selection === "approved";
  const measure: GameBootstrapMeasure = async (name, work) => {
    signal.throwIfAborted();
    const result = dependencies.measure
      ? await dependencies.measure(name, work)
      : await work();
    signal.throwIfAborted();
    return result;
  };
  const readAdmission =
    dependencies.readAdmission ||
    ((inviteId: string, signal: AbortSignal) =>
      readGameBootstrapAdmission(env.PROFILE_GAMES_DB, inviteId, signal));
  const limited = await measure("limit", () =>
    env.MATCH_SYNC_RATE_LIMITER.limit({
      key: `game-bootstrap:read:identity:${identity.uid}`,
    }),
  );
  if (!limited.success) throw new GameBootstrapRateLimitFailure();
  const repository = dependencies.repository || createGameplayRepository(env);
  let metadata = requireMetadata(
    await measure("admission", async () =>
      normalizeInviteMetadata(inviteId, await readAdmission(inviteId, signal)),
    ),
  );
  const roles = new Map<string, ReturnType<typeof resolveInviteReadRole>>();
  const resolveRole = (source: typeof metadata) => {
    const key = JSON.stringify([
      source.snapshot.hostId,
      source.snapshot.guestId,
      source.passwordProtected,
    ]);
    let role = roles.get(key);
    if (!role) {
      role = measure("role", () =>
        resolveInviteReadRole(
          { inviteId, identity, repository },
          source.snapshot,
          source.passwordProtected,
        ),
      );
      roles.set(key, role);
    }
    return role;
  };
  let role = await resolveRole(metadata);
  signal.throwIfAborted();
  const room = dependencies.room || env.INVITE_REACTIONS.getByName(inviteId);
  let fresh = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const selected = selectInviteMatch(
      inviteId,
      metadata.snapshot,
      role.actorUid,
      { preferApproved },
    );
    const read = await measure("match", () =>
      room.readMatches(inviteId, selected.matchId, { fresh }),
    );
    if (read.status === "missing") {
      metadata = requireMetadata(
        await measure("match", () => room.readMetadata(inviteId)),
      );
      role = await resolveRole(metadata);
      fresh = true;
      continue;
    }
    if (read.status !== "ok") {
      throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
    }
    if (!fresh && !sameMetadata(metadata, read.metadata)) {
      fresh = true;
      continue;
    }
    metadata = read.metadata;
    role = await resolveRole(metadata);
    const current = selectInviteMatch(
      inviteId,
      metadata.snapshot,
      role.actorUid,
      { preferApproved },
    );
    if (current.matchId !== selected.matchId) {
      fresh = true;
      continue;
    }
    const body: ReadGameBootstrapResponse = {
      ok: true,
      schemaVersion: 1,
      metadata: metadata.snapshot,
      viewer: {
        role: role.role,
        actorUid: role.actorUid,
        automatchOperationId:
          metadata.automatchOperationIds[identity.uid] ?? null,
      },
      match: read.snapshot,
      hasPendingProposal: current.hasPendingProposal,
    };
    if (
      !isReadGameBootstrapResponse(body) ||
      body.metadata.inviteId !== inviteId ||
      body.match.matchId !== current.matchId ||
      new TextEncoder().encode(JSON.stringify(body)).byteLength >
        GAME_BOOTSTRAP_MAX_RESPONSE_BYTES
    ) {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "game-bootstrap-unavailable",
      );
    }
    signal.throwIfAborted();
    return body;
  }
  throw new AuthApiFailure(503, "unavailable", "game-bootstrap-kept-changing");
}
