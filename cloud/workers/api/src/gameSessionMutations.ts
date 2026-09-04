import {
  isCreateInviteResponse,
  isEndRematchResponse,
  isEnsureMatchResponse,
  isJoinInviteResponse,
  isProposeRematchResponse,
  normalizeHistoricalMatchRecord,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type EndRematchRequest,
  type EndRematchResponse,
  type EnsureMatchRequest,
  type EnsureMatchResponse,
  type GameSessionMatch,
  type JoinInviteRequest,
  type JoinInviteResponse,
  type ProposeRematchRequest,
  type ProposeRematchResponse,
  type ResolveInviteRoleRequest,
  type ResolveInviteRoleResponse,
} from "@mons/shared/game-sessions";
import { isEventOwnedInvite } from "@mons/shared/events";
import { createGameVariantHelpers } from "@mons/shared/game-variants";
import { isAutoInviteId, pickHostColor } from "@mons/shared/ids";
import {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} from "@mons/shared/match-protocol";
import {
  getLatestApprovedRematchIndex,
  getLatestRematchIndex,
  parseInviteMatchIndex,
  parseRematchIndices,
  rematchSeriesEnded,
} from "@mons/shared/rematches";
import * as monsRules from "mons-rules";
import {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionOutboxUpdates,
  buildMatchedAutomatchTelegramUpdates,
} from "../../../functions/telegram/automatchSource.js";
import { getDisplayNameFromAddress } from "../../../functions/telegramDisplay.js";
import { AuthApiFailure } from "./authErrors.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import {
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  firebaseRtdbIncrement,
} from "./firebaseRtdb.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  createGameplayRepository,
  type GameplayProfile,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  GameSessionMutationLockFailure,
  type GameSessionMutationLockStore,
} from "./gameplayCoordinationD1.ts";
import { buildAutomatchProfileGameProjectionOutboxMergeUpdates } from "./profileGameProjectionOutbox.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";
import type {
  AutomatchProfileGameProjectionTask,
  ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import {
  getLoginProfileId,
  getOwnershipProfile,
  loginsShareProfile,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

const GAME_SESSION_MUTATION_RECEIPT_ROOT = "gameplayMutationReceipts";
const GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT =
  "gameplayMutationReceiptExpirations";
const GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT = 1000;
const gameVariantHelpers = createGameVariantHelpers(monsRules);

type GameSessionMutationKind =
  | "invite-create"
  | "invite-join"
  | "match-ensure"
  | "rematch-end"
  | "rematch-propose";

type GameSessionResponse =
  | CreateInviteResponse
  | EndRematchResponse
  | EnsureMatchResponse
  | JoinInviteResponse
  | ProposeRematchResponse;

type GameSessionRequest =
  | CreateInviteRequest
  | EndRematchRequest
  | EnsureMatchRequest
  | JoinInviteRequest
  | ProposeRematchRequest;

type GameSessionMutationReceipt = {
  completedAtMs: number;
  fingerprint: string;
  inviteId: string;
  kind: GameSessionMutationKind;
  operationId: string;
  projectionRequestId: string | null;
  requesterUid: string;
  response: GameSessionResponse;
  schemaVersion: 1;
};

type GameSessionMutationOutcome<T extends GameSessionResponse> = {
  historicalMatches?: HistoricalMatchDescriptor[];
  projectReason?: string;
  response: T;
  updates?: Record<string, unknown>;
};

type GameSessionMutationDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  createOwnerId?: () => string;
  enqueueProfileGameProjection?: (
    task: ProfileGameProjectionTask,
  ) => Promise<void>;
  logger?: Pick<Console, "error" | "info">;
  mutationLocks: GameSessionMutationLockStore;
  now?: () => number;
  random?: () => number;
};

type ParticipantResolution = {
  actorUid: string;
  opponentUid: string;
  ownership: ProfileOwnershipSnapshot | null;
  role: "guest" | "host";
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStoredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

function mutationReceiptPath(operationId: string): string {
  return `${GAME_SESSION_MUTATION_RECEIPT_ROOT}/${operationId}`;
}

function mutationReceiptExpirationPath(operationId: string): string {
  return `${GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT}/${operationId}`;
}

function normalizeMatch(value: unknown): GameSessionMatch | null {
  const match = normalizeHistoricalMatchRecord(value);
  return match?.fen ? match : null;
}

function buildMirroredMatch(
  source: GameSessionMatch,
  emojiId: number,
  aura: string,
): GameSessionMatch {
  const color = source.color === "white" ? "black" : "white";
  return {
    ...buildFreshMatchRecord({
      color,
      emojiId,
      aura,
      seed: {
        gameVariant: source.gameVariant,
        fen: source.fen,
      },
    }),
    color,
    status: source.status,
    flatMovesString: source.flatMovesString,
    timer: source.timer,
  };
}

async function mutationFingerprint(
  kind: GameSessionMutationKind,
  request: GameSessionRequest,
  requesterUid: string,
): Promise<string> {
  const presentation =
    "emojiId" in request ? [request.emojiId, request.aura] : [null, null];
  const matchId = "matchId" in request ? request.matchId : null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        kind,
        request.operationId,
        request.inviteId,
        matchId,
        requesterUid,
        ...presentation,
      ]),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseReceipt(value: unknown): GameSessionMutationReceipt | null {
  const record = toRecord(value);
  const response = record?.response;
  if (
    record?.schemaVersion !== 1 ||
    typeof record.completedAtMs !== "number" ||
    !Number.isFinite(record.completedAtMs) ||
    typeof record.fingerprint !== "string" ||
    typeof record.inviteId !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.operationId !== "string" ||
    typeof record.requesterUid !== "string" ||
    !record.requesterUid ||
    !(
      record.projectionRequestId === null ||
      typeof record.projectionRequestId === "string"
    ) ||
    !(
      isCreateInviteResponse(response) ||
      isJoinInviteResponse(response) ||
      isProposeRematchResponse(response) ||
      isEndRematchResponse(response) ||
      isEnsureMatchResponse(response)
    )
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    completedAtMs: Math.floor(record.completedAtMs),
    fingerprint: record.fingerprint,
    inviteId: record.inviteId,
    kind: record.kind as GameSessionMutationKind,
    operationId: record.operationId,
    projectionRequestId: record.projectionRequestId,
    requesterUid: record.requesterUid,
    response,
  };
}

async function dispatchProjection(
  inviteId: string,
  requestId: string,
  dependencies: GameSessionMutationDependencies,
): Promise<void> {
  if (!dependencies.enqueueProfileGameProjection) {
    return;
  }
  const task: AutomatchProfileGameProjectionTask = {
    kind: "automatch-profile-game-projection",
    inviteId,
    requestId,
  };
  try {
    await dependencies.enqueueProfileGameProjection(task);
  } catch {
    (dependencies.logger || console).error(
      JSON.stringify({
        event: "game_session_projection_enqueue_failed",
        inviteId,
        requestId,
      }),
    );
  }
}

export async function acquireGameSessionMutationLease(
  lockId: string,
  operationId: string,
  ownerId: string,
  store: GameSessionMutationLockStore,
  nowMs: number,
): Promise<void> {
  try {
    await store.acquire({ lockId, operationId }, ownerId, nowMs);
  } catch (error) {
    if (
      error instanceof GameSessionMutationLockFailure &&
      error.operation === "busy"
    ) {
      throw new AuthApiFailure(409, "aborted", "invite-busy");
    }
    throw error;
  }
}

export async function enforceGameSessionMutationRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `game-session:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many game session attempts.",
    );
  }
}

export async function refreshGameSessionMutationLease(
  lockId: string,
  operationId: string,
  ownerId: string,
  store: GameSessionMutationLockStore,
  nowMs: number,
): Promise<void> {
  try {
    await store.refresh({ lockId, operationId }, ownerId, nowMs);
  } catch (error) {
    if (
      error instanceof GameSessionMutationLockFailure &&
      error.operation === "lost"
    ) {
      throw new AuthApiFailure(409, "aborted", "invite-lease-lost");
    }
    throw error;
  }
}

export async function releaseGameSessionMutationLease(
  lockId: string,
  operationId: string,
  ownerId: string,
  store: GameSessionMutationLockStore,
): Promise<void> {
  await store.release({ lockId, operationId }, ownerId);
}

export class GameSessionMutationLeaseReleaseFailure extends GameSessionMutationLockFailure {
  readonly workCompleted: boolean;
  readonly workError: unknown;

  constructor(
    releaseError: unknown,
    workError: unknown,
    workCompleted: boolean,
  ) {
    super("release", releaseError);
    this.workCompleted = workCompleted;
    this.workError = workError;
  }
}

function leaseErrorCode(error: unknown): string {
  if (error instanceof GameSessionMutationLockFailure) {
    return error.operation;
  }
  if (error instanceof AuthApiFailure) {
    return error.code;
  }
  return "unknown";
}

export async function withGameSessionMutationLease<T>(
  lockId: string,
  operationId: string,
  store: GameSessionMutationLockStore,
  work: (refresh: () => Promise<void>) => Promise<T>,
  dependencies: Pick<
    GameSessionMutationDependencies,
    "createOwnerId" | "logger" | "now"
  > = {},
): Promise<T> {
  const ownerId = (dependencies.createOwnerId || (() => crypto.randomUUID()))();
  const now = dependencies.now || Date.now;
  await acquireGameSessionMutationLease(
    lockId,
    operationId,
    ownerId,
    store,
    now(),
  );
  let workCompleted = false;
  let value: T | undefined;
  let workError: unknown;
  try {
    value = await work(() =>
      refreshGameSessionMutationLease(
        lockId,
        operationId,
        ownerId,
        store,
        now(),
      ),
    );
    workCompleted = true;
  } catch (error) {
    workError = error;
  }
  try {
    await releaseGameSessionMutationLease(lockId, operationId, ownerId, store);
  } catch (releaseError) {
    (dependencies.logger || console).error(
      JSON.stringify({
        event: "game_session_mutation_lock_release_failed",
        inviteId: lockId,
        operationId,
        releaseCode: leaseErrorCode(releaseError),
        workCode: workCompleted ? "none" : leaseErrorCode(workError),
      }),
    );
    throw new GameSessionMutationLeaseReleaseFailure(
      releaseError,
      workCompleted ? undefined : workError,
      workCompleted,
    );
  }
  if (!workCompleted) throw workError;
  return value as T;
}

async function runGameSessionMutation<T extends GameSessionResponse>(
  kind: GameSessionMutationKind,
  requesterUid: string,
  request: GameSessionRequest,
  repository: GameplayRepository,
  validateResponse: (value: unknown) => value is T,
  build: () => Promise<GameSessionMutationOutcome<T>>,
  dependencies: GameSessionMutationDependencies,
): Promise<T> {
  const fingerprint = await mutationFingerprint(kind, request, requesterUid);
  return withGameSessionMutationLease(
    request.inviteId,
    request.operationId,
    dependencies.mutationLocks,
    async (refresh) => {
      const rawReceipt = await repository.getRtdbPath(
        mutationReceiptPath(request.operationId),
      );
      const existing = parseReceipt(rawReceipt);
      if (rawReceipt !== null && rawReceipt !== undefined && !existing) {
        throw failedPrecondition("operation-conflict");
      }
      if (existing) {
        if (
          existing.kind !== kind ||
          existing.inviteId !== request.inviteId ||
          existing.requesterUid !== requesterUid ||
          existing.fingerprint !== fingerprint ||
          !validateResponse(existing.response)
        ) {
          throw failedPrecondition("operation-conflict");
        }
        if (existing.projectionRequestId) {
          await dispatchProjection(
            request.inviteId,
            existing.projectionRequestId,
            dependencies,
          );
        }
        return existing.response;
      }
      const outcome = await build();
      const projectionRequestId = outcome.projectReason
        ? request.operationId
        : null;
      const updates: Record<string, unknown> = {
        ...(outcome.updates || {}),
        [mutationReceiptPath(request.operationId)]: {
          schemaVersion: 1,
          operationId: request.operationId,
          kind,
          inviteId: request.inviteId,
          fingerprint,
          projectionRequestId,
          requesterUid,
          response: outcome.response,
          completedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
        },
        [mutationReceiptExpirationPath(request.operationId)]: {
          completedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
        },
      };
      if (outcome.projectReason) {
        Object.assign(
          updates,
          buildAutomatchProfileGameProjectionOutboxMergeUpdates({
            historicalMatches: outcome.historicalMatches,
            inviteId: request.inviteId,
            reason: outcome.projectReason,
            requestId: request.operationId,
            timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
          }),
        );
      }
      await dependencies.assertMutationAllowed?.();
      await refresh();
      await repository.patchRtdbRoot(updates);
      if (projectionRequestId) {
        await dispatchProjection(
          request.inviteId,
          projectionRequestId,
          dependencies,
        );
      }
      return outcome.response;
    },
    dependencies,
  );
}

export async function resolveInviteRole(
  identity: RequestIdentity,
  request: ResolveInviteRoleRequest,
  repository: GameplayRepository,
): Promise<ResolveInviteRoleResponse> {
  const storedInvite = await repository.getRtdbPath(
    `invites/${request.inviteId}`,
  );
  if (storedInvite === null || storedInvite === undefined) {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  const invite = toRecord(storedInvite);
  if (!invite) {
    throw failedPrecondition("invite-invalid");
  }
  const hostId = readStoredString(invite.hostId);
  const storedGuestId = invite.guestId;
  const guestId =
    storedGuestId === null || storedGuestId === undefined
      ? null
      : readStoredString(storedGuestId);
  const passwordProtected = Object.hasOwn(invite, "password");
  if (
    !isCanonicalFirebaseUid(hostId) ||
    (guestId !== null &&
      (!isCanonicalFirebaseUid(guestId) || guestId === hostId))
  ) {
    throw failedPrecondition("invite-invalid");
  }
  const response = (
    actorUid: string | null,
    role: "host" | "guest" | "watch",
  ): ResolveInviteRoleResponse => {
    if (passwordProtected && guestId === null && role === "watch") {
      throw new AuthApiFailure(403, "permission-denied", "permission-denied");
    }
    return {
      ok: true,
      inviteId: request.inviteId,
      hostId,
      guestId,
      actorUid,
      role,
    };
  };
  if (identity.uid === hostId) {
    return response(hostId, "host");
  }
  if (guestId && identity.uid === guestId) {
    return response(guestId, "guest");
  }
  const ownershipUids = guestId
    ? [identity.uid, hostId, guestId]
    : [identity.uid, hostId];
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: ownershipUids,
    profileIds: [],
  });
  const identityProfileId = getLoginProfileId(ownership, identity.uid);
  const hostProfileId = getLoginProfileId(ownership, hostId);
  const guestProfileId = guestId ? getLoginProfileId(ownership, guestId) : null;
  if (!identityProfileId) {
    return response(null, "watch");
  }
  if (hostProfileId === identityProfileId) {
    return response(hostId, "host");
  }
  if (guestId && guestProfileId === identityProfileId) {
    return response(guestId, "guest");
  }
  return response(null, "watch");
}

async function resolveParticipant(
  identity: RequestIdentity,
  invite: Record<string, unknown>,
  repository: GameplayRepository,
): Promise<ParticipantResolution> {
  const hostUid = readStoredString(invite.hostId);
  const guestUid = readStoredString(invite.guestId);
  if (!isSafeFirebaseKey(hostUid) || !isSafeFirebaseKey(guestUid)) {
    throw failedPrecondition("missing-opponent");
  }
  if (identity.uid === hostUid) {
    return {
      actorUid: hostUid,
      opponentUid: guestUid,
      ownership: null,
      role: "host",
    };
  }
  if (identity.uid === guestUid) {
    return {
      actorUid: guestUid,
      opponentUid: hostUid,
      ownership: null,
      role: "guest",
    };
  }
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid, hostUid, guestUid],
    profileIds: [],
  });
  const identityProfileId = getLoginProfileId(ownership, identity.uid);
  const hostProfileId = getLoginProfileId(ownership, hostUid);
  const guestProfileId = getLoginProfileId(ownership, guestUid);
  if (!identityProfileId) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  if (hostProfileId === identityProfileId) {
    return {
      actorUid: hostUid,
      opponentUid: guestUid,
      ownership,
      role: "host",
    };
  }
  if (guestProfileId === identityProfileId) {
    return {
      actorUid: guestUid,
      opponentUid: hostUid,
      ownership,
      role: "guest",
    };
  }
  throw new AuthApiFailure(403, "permission-denied", "permission-denied");
}

function ensureMutableInvite(invite: Record<string, unknown>): void {
  if (isEventOwnedInvite(invite)) {
    throw failedPrecondition("event-owned-invite");
  }
}

export async function createManualInvite(
  identity: RequestIdentity,
  request: CreateInviteRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<CreateInviteResponse> {
  return runGameSessionMutation(
    "invite-create",
    identity.uid,
    request,
    repository,
    isCreateInviteResponse,
    async () => {
      if (await repository.getRtdbPath(`invites/${request.inviteId}`)) {
        throw failedPrecondition("invite-already-exists");
      }
      const random = dependencies.random || secureRandom;
      const hostColor = pickHostColor(random);
      const match = buildFreshMatchRecord({
        color: hostColor,
        emojiId: request.emojiId,
        aura: request.aura,
        seed: gameVariantHelpers.buildRandomGameSeed(random),
      });
      const response: CreateInviteResponse = {
        ok: true,
        inviteId: request.inviteId,
        hostId: identity.uid,
        matchId: request.inviteId,
      };
      return {
        response,
        projectReason: "manual-invite-created",
        updates: {
          [`invites/${request.inviteId}`]: {
            version: CONTROLLER_VERSION,
            hostId: identity.uid,
            hostColor,
            guestId: null,
            wagers: {},
          },
          [`players/${identity.uid}/matches/${request.inviteId}`]: match,
        },
      };
    },
    dependencies,
  );
}

function emptyGameplayProfile(request: JoinInviteRequest): GameplayProfile {
  return {
    aura: request.aura,
    emoji: request.emojiId,
    eth: "",
    profileId: "",
    rating: 0,
    sol: "",
    username: "",
  };
}

function joiningProfile(
  identity: RequestIdentity,
  request: JoinInviteRequest,
  ownership: ProfileOwnershipSnapshot,
): GameplayProfile {
  const profileId = getLoginProfileId(ownership, identity.uid);
  return (
    (profileId && getOwnershipProfile(ownership, profileId)?.profile) ||
    emptyGameplayProfile(request)
  );
}

function automatchJoinUpdates(
  inviteId: string,
  operationId: string,
  automatch: Record<string, unknown>,
  profile: GameplayProfile,
): Record<string, unknown> {
  if (automatch.telegramDeliveryVersion !== TELEGRAM_AUTOMATCH_VERSION) {
    return { [`automatch/${inviteId}`]: null };
  }
  const existingName = getDisplayNameFromAddress(
    automatch.username,
    automatch.ethAddress,
    automatch.solAddress,
    automatch.rating,
    automatch.emojiId,
  );
  const joiningName = getDisplayNameFromAddress(
    profile.username,
    profile.eth,
    profile.sol,
    profile.rating,
    profile.emoji,
  );
  return {
    [`automatch/${inviteId}`]: null,
    ...buildMatchedAutomatchTelegramUpdates({
      inviteId,
      matchedText: `${existingName} vs. ${joiningName} https://mons.link/${inviteId}`,
      timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
      generation: firebaseRtdbIncrement(1),
    }),
    ...buildAutomatchTelegramProjectionOutboxUpdates({
      inviteId,
      requestId: operationId,
      timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
    }),
  };
}

export async function joinInvite(
  identity: RequestIdentity,
  request: JoinInviteRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<JoinInviteResponse> {
  return runGameSessionMutation(
    "invite-join",
    identity.uid,
    request,
    repository,
    isJoinInviteResponse,
    async () => {
      const invite = toRecord(
        await repository.getRtdbPath(`invites/${request.inviteId}`),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const hostUid = readStoredString(invite.hostId);
      if (!isSafeFirebaseKey(hostUid)) {
        throw failedPrecondition("invite-invalid");
      }
      const currentGuestUid = readStoredString(invite.guestId);
      if (currentGuestUid && !isSafeFirebaseKey(currentGuestUid)) {
        throw failedPrecondition("invite-invalid");
      }
      let ownership: ProfileOwnershipSnapshot | null = null;
      const readOwnership = async () => {
        ownership ||= await requireProfileOwnershipSnapshot(repository, {
          loginUids: [
            identity.uid,
            hostUid,
            ...(currentGuestUid ? [currentGuestUid] : []),
          ],
          profileIds: [],
        });
        return ownership;
      };
      let joinedExisting =
        currentGuestUid !== "" && currentGuestUid === identity.uid;
      if (currentGuestUid && !joinedExisting) {
        joinedExisting = loginsShareProfile(
          await readOwnership(),
          identity.uid,
          currentGuestUid,
        );
      }
      if (currentGuestUid && !joinedExisting) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            guestId: currentGuestUid,
            joined: false,
            matchId: null,
          },
        };
      }
      const joiningHost =
        !currentGuestUid &&
        (identity.uid === hostUid ||
          loginsShareProfile(await readOwnership(), identity.uid, hostUid));
      if (joiningHost) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            guestId: null,
            joined: false,
            matchId: null,
          },
        };
      }
      let pendingAutomatch: Record<string, unknown> | null = null;
      if (isAutoInviteId(request.inviteId) && !currentGuestUid) {
        pendingAutomatch = toRecord(
          await repository.getRtdbPath(`automatch/${request.inviteId}`),
        );
        if (readStoredString(pendingAutomatch?.uid) !== hostUid) {
          throw failedPrecondition("automatch-not-pending");
        }
      }
      const guestUid = currentGuestUid || identity.uid;
      const existingMatch = normalizeMatch(
        await repository.getRtdbPath(
          `players/${guestUid}/matches/${request.inviteId}`,
        ),
      );
      if (joinedExisting && existingMatch) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            guestId: guestUid,
            joined: true,
            matchId: request.inviteId,
          },
        };
      }
      const hostMatch = normalizeMatch(
        await repository.getRtdbPath(
          `players/${hostUid}/matches/${request.inviteId}`,
        ),
      );
      if (!hostMatch) {
        throw failedPrecondition("host-match-not-found");
      }
      const match = buildMirroredMatch(
        hostMatch,
        request.emojiId,
        request.aura,
      );
      const updates: Record<string, unknown> = {
        [`invites/${request.inviteId}/guestId`]: guestUid,
        [`players/${guestUid}/matches/${request.inviteId}`]: match,
      };
      if (isAutoInviteId(request.inviteId)) {
        const automatch =
          pendingAutomatch ||
          toRecord(
            await repository.getRtdbPath(`automatch/${request.inviteId}`),
          ) ||
          {};
        const profile = joiningProfile(
          identity,
          request,
          await readOwnership(),
        );
        Object.assign(
          updates,
          automatchJoinUpdates(
            request.inviteId,
            request.operationId,
            automatch,
            profile,
          ),
          {
            [`invites/${request.inviteId}/automatchStateHint`]: "matched",
            [`invites/${request.inviteId}/automatchCanceledAt`]: null,
          },
        );
      }
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          guestId: guestUid,
          joined: true,
          matchId: request.inviteId,
        },
        projectReason: "manual-invite-joined",
        updates,
      };
    },
    dependencies,
  );
}

export function nextRematchIndex(
  invite: Record<string, unknown>,
  role: "guest" | "host",
): number | null {
  if (rematchSeriesEnded(invite)) {
    return null;
  }
  const hostIndices = parseRematchIndices(invite.hostRematches);
  const guestIndices = parseRematchIndices(invite.guestRematches);
  const own = role === "host" ? hostIndices : guestIndices;
  const other = role === "host" ? guestIndices : hostIndices;
  const common = hostIndices.filter((index) => guestIndices.includes(index));
  const latestCommon = common.at(-1) || 0;
  if (latestCommon === 0) {
    if (own.length === 0 && other.length === 0) {
      return 1;
    }
    return own.length < other.length && own.length === 0 ? 1 : null;
  }
  if (own.length > other.length) {
    return null;
  }
  const nextIndex = latestCommon + 1;
  return Number.isSafeInteger(nextIndex) ? nextIndex : null;
}

function rematchColor(
  invite: Record<string, unknown>,
  role: "guest" | "host",
  index: number,
): "black" | "white" {
  const hostColor = invite.hostColor === "black" ? "black" : "white";
  const guestColor = hostColor === "white" ? "black" : "white";
  if (index % 2 === 0) {
    return role === "host" ? hostColor : guestColor;
  }
  return role === "host" ? guestColor : hostColor;
}

export async function proposeRematch(
  identity: RequestIdentity,
  request: ProposeRematchRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<ProposeRematchResponse> {
  return runGameSessionMutation(
    "rematch-propose",
    identity.uid,
    request,
    repository,
    isProposeRematchResponse,
    async () => {
      const invite = toRecord(
        await repository.getRtdbPath(`invites/${request.inviteId}`),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const participant = await resolveParticipant(
        identity,
        invite,
        repository,
      );
      const ownership =
        participant.ownership ||
        (await requireProfileOwnershipSnapshot(repository, {
          loginUids: [participant.actorUid, participant.opponentUid],
          profileIds: [],
        }));
      if (
        loginsShareProfile(
          ownership,
          participant.actorUid,
          participant.opponentUid,
        )
      ) {
        throw failedPrecondition("rematch-unavailable");
      }
      const index = nextRematchIndex(invite, participant.role);
      if (!index) {
        throw failedPrecondition("rematch-unavailable");
      }
      const matchId = `${request.inviteId}${index}`;
      const opponentMatch = normalizeMatch(
        await repository.getRtdbPath(
          `players/${participant.opponentUid}/matches/${matchId}`,
        ),
      );
      const seed = opponentMatch
        ? {
            gameVariant: opponentMatch.gameVariant,
            fen: opponentMatch.fen,
          }
        : gameVariantHelpers.buildDeterministicGameSeed(`rematch:${matchId}`);
      const color = rematchColor(invite, participant.role, index);
      const match: GameSessionMatch = {
        ...buildFreshMatchRecord({
          color,
          emojiId: request.emojiId,
          aura: request.aura,
          seed,
        }),
        color,
      };
      const field =
        participant.role === "host" ? "hostRematches" : "guestRematches";
      const opponentField =
        participant.role === "host" ? "guestRematches" : "hostRematches";
      const firstProposal = !parseRematchIndices(
        invite[opponentField],
      ).includes(index);
      const current = normalizeString(invite[field]);
      const rematches = current ? `${current};${index}` : String(index);
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          actorUid: participant.actorUid,
          matchId,
          rematches,
          match,
        },
        projectReason: `manual-${field}-updated`,
        ...(firstProposal
          ? {
              historicalMatches: [
                {
                  finalizedAtMs: (dependencies.now || Date.now)(),
                  guestPlayerId: String(invite.guestId),
                  hostPlayerId: String(invite.hostId),
                  matchId:
                    index === 1
                      ? request.inviteId
                      : `${request.inviteId}${index - 1}`,
                  source: "transition" as const,
                },
              ],
            }
          : {}),
        updates: {
          [`invites/${request.inviteId}/${field}`]: rematches,
          [`players/${participant.actorUid}/matches/${matchId}`]: match,
        },
      };
    },
    dependencies,
  );
}

export async function endRematchSeries(
  identity: RequestIdentity,
  request: EndRematchRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<EndRematchResponse> {
  return runGameSessionMutation(
    "rematch-end",
    identity.uid,
    request,
    repository,
    isEndRematchResponse,
    async () => {
      const invite = toRecord(
        await repository.getRtdbPath(`invites/${request.inviteId}`),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const participant = await resolveParticipant(
        identity,
        invite,
        repository,
      );
      const field =
        participant.role === "host" ? "hostRematches" : "guestRematches";
      const current = normalizeString(invite[field]);
      if (rematchSeriesEnded(invite)) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            actorUid: participant.actorUid,
            rematches: current.endsWith("x") ? current : `${current}x`,
          },
        };
      }
      const rematches = `${current}x`;
      const latestApprovedIndex = getLatestApprovedRematchIndex(invite);
      const latestProposedIndex = getLatestRematchIndex(invite);
      const matchId =
        latestApprovedIndex === 0
          ? request.inviteId
          : `${request.inviteId}${latestApprovedIndex}`;
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          actorUid: participant.actorUid,
          rematches,
        },
        projectReason: `manual-${field}-ended`,
        ...(latestApprovedIndex === latestProposedIndex
          ? {
              historicalMatches: [
                {
                  finalizedAtMs: (dependencies.now || Date.now)(),
                  guestPlayerId: String(invite.guestId),
                  hostPlayerId: String(invite.hostId),
                  matchId,
                  source: "transition" as const,
                },
              ],
            }
          : {}),
        updates: {
          [`invites/${request.inviteId}/${field}`]: rematches,
        },
      };
    },
    dependencies,
  );
}

export async function ensureParticipantMatch(
  identity: RequestIdentity,
  request: EnsureMatchRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<EnsureMatchResponse> {
  return runGameSessionMutation(
    "match-ensure",
    identity.uid,
    request,
    repository,
    isEnsureMatchResponse,
    async () => {
      const invite = toRecord(
        await repository.getRtdbPath(`invites/${request.inviteId}`),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const index = parseInviteMatchIndex(request.inviteId, request.matchId);
      if (index === null || index > getLatestRematchIndex(invite)) {
        throw failedPrecondition("match-not-current");
      }
      const participant = await resolveParticipant(
        identity,
        invite,
        repository,
      );
      const existing = normalizeMatch(
        await repository.getRtdbPath(
          `players/${participant.actorUid}/matches/${request.matchId}`,
        ),
      );
      if (existing) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            actorUid: participant.actorUid,
            matchId: request.matchId,
            created: false,
            match: existing,
          },
        };
      }
      const opponent = normalizeMatch(
        await repository.getRtdbPath(
          `players/${participant.opponentUid}/matches/${request.matchId}`,
        ),
      );
      if (!opponent) {
        throw failedPrecondition("opponent-match-not-found");
      }
      const match = buildMirroredMatch(opponent, request.emojiId, request.aura);
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          actorUid: participant.actorUid,
          matchId: request.matchId,
          created: true,
          match,
        },
        projectReason: "manual-match-created",
        updates: {
          [`players/${participant.actorUid}/matches/${request.matchId}`]: match,
        },
      };
    },
    dependencies,
  );
}

export async function sweepGameSessionMutationReceipts(
  env: Env,
  {
    now = Date.now,
    repository = createGameplayRepository(env),
  }: {
    now?: () => number;
    repository?: GameplayRepository;
  } = {},
): Promise<number> {
  const cutoff = now() - GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS;
  const value = toRecord(
    await repository.getRtdbPath(
      GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT,
      {
        orderBy: "completedAtMs",
        endAt: cutoff,
        limitToFirst: GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT,
      },
    ),
  );
  if (!value) {
    return 0;
  }
  const updates = Object.entries(value).reduce<Record<string, null>>(
    (result, [operationId, raw]) => {
      const completedAtMs = Number(toRecord(raw)?.completedAtMs);
      if (
        isSafeFirebaseKey(operationId) &&
        Number.isFinite(completedAtMs) &&
        completedAtMs <= cutoff
      ) {
        result[`${GAME_SESSION_MUTATION_RECEIPT_ROOT}/${operationId}`] = null;
        result[
          `${GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT}/${operationId}`
        ] = null;
      }
      return result;
    },
    {},
  );
  const count = Object.keys(updates).length / 2;
  if (count > 0) {
    await repository.patchRtdbRoot(updates);
  }
  return count;
}

export {
  GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS,
  GAME_SESSION_MUTATION_RECEIPT_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT,
};
export type { GameSessionMutationDependencies };
