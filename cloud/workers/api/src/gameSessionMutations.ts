import {
  MAX_GAME_SESSION_STATUS_BYTES,
  MAX_GAME_SESSION_TIMER_BYTES,
  isCreateInviteResponse,
  isEndRematchResponse,
  isEnsureMatchResponse,
  isJoinInviteResponse,
  isProposeRematchResponse,
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
} from "@mons/shared/game-sessions";
import { isEventOwnedInvite } from "@mons/shared/events";
import { createGameVariantHelpers } from "@mons/shared/game-variants";
import { isAutoInviteId, pickHostColor } from "@mons/shared/ids";
import {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} from "@mons/shared/match-protocol";
import {
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
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import {
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  firebaseRtdbIncrement,
} from "./firebaseRtdb.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  createGameplayRepository,
  type GameplayProfile,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { buildAutomatchProfileGameProjectionOutboxUpdates } from "./profileGameProjectionOutbox.ts";
import type {
  AutomatchProfileGameProjectionTask,
  ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";

const GAME_SESSION_MUTATION_LOCK_ROOT = "gameplayMutationLocks";
const GAME_SESSION_MUTATION_RECEIPT_ROOT = "gameplayMutationReceipts";
const GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT =
  "gameplayMutationReceiptExpirations";
const GAME_SESSION_MUTATION_LOCK_MS = 60_000;
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
  projectReason?: string;
  response: T;
  updates?: Record<string, unknown>;
};

type GameSessionMutationDependencies = {
  createOwnerId?: () => string;
  enqueueProfileGameProjection?: (
    task: ProfileGameProjectionTask,
  ) => Promise<void>;
  logger?: Pick<Console, "error" | "info">;
  now?: () => number;
  random?: () => number;
};

type ParticipantResolution = {
  actorUid: string;
  opponentUid: string;
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

function mutationLockPath(inviteId: string): string {
  return `${GAME_SESSION_MUTATION_LOCK_ROOT}/${inviteId}`;
}

function mutationReceiptPath(operationId: string): string {
  return `${GAME_SESSION_MUTATION_RECEIPT_ROOT}/${operationId}`;
}

function mutationReceiptExpirationPath(operationId: string): string {
  return `${GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT}/${operationId}`;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function normalizeMatch(value: unknown): GameSessionMatch | null {
  const record = toRecord(value);
  const color = record?.color;
  const emojiId = Number(record?.emojiId);
  const fen = typeof record?.fen === "string" ? record.fen : "";
  const flatMovesString =
    typeof record?.flatMovesString === "string" ? record.flatMovesString : "";
  const status = typeof record?.status === "string" ? record.status : "";
  const timer = typeof record?.timer === "string" ? record.timer : "";
  if (
    !record ||
    (color !== "white" && color !== "black") ||
    !Number.isSafeInteger(emojiId) ||
    emojiId <= 0 ||
    !fen ||
    !isMatchFenWithinLimit(fen) ||
    !isMatchHistoryWithinLimits(flatMovesString) ||
    !isBoundedString(status, MAX_GAME_SESSION_STATUS_BYTES) ||
    !isBoundedString(timer, MAX_GAME_SESSION_TIMER_BYTES)
  ) {
    return null;
  }
  return {
    version: Number.isSafeInteger(record.version)
      ? Number(record.version)
      : CONTROLLER_VERSION,
    color,
    emojiId,
    aura:
      typeof record.aura === "string" && record.aura.length <= 32
        ? record.aura
        : "",
    gameVariant: gameVariantHelpers.getStoredGameVariantForPersistence(
      record.gameVariant,
    ),
    fen,
    status,
    flatMovesString,
    timer,
  };
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
  inviteId: string,
  operationId: string,
  ownerId: string,
  repository: Pick<GameplayRepository, "transactRtdbPath">,
  nowMs: number,
): Promise<void> {
  const result = await repository.transactRtdbPath(
    mutationLockPath(inviteId),
    (current) => {
      const record = toRecord(current);
      const expiresAtMs = Number(record?.expiresAtMs);
      if (
        typeof record?.ownerId === "string" &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs > nowMs
      ) {
        return { commit: false, decision: "busy" };
      }
      return {
        value: {
          ownerId,
          operationId,
          expiresAtMs: nowMs + GAME_SESSION_MUTATION_LOCK_MS,
        },
        decision: "acquired",
      };
    },
  );
  if (!result.committed) {
    throw new AuthApiFailure(409, "aborted", "invite-busy");
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
  inviteId: string,
  operationId: string,
  ownerId: string,
  repository: Pick<GameplayRepository, "transactRtdbPath">,
  nowMs: number,
): Promise<void> {
  const result = await repository.transactRtdbPath(
    mutationLockPath(inviteId),
    (current) => {
      const record = toRecord(current);
      if (record?.ownerId !== ownerId || record.operationId !== operationId) {
        return { commit: false, decision: "lost" };
      }
      return {
        value: {
          ...record,
          expiresAtMs: nowMs + GAME_SESSION_MUTATION_LOCK_MS,
        },
        decision: "refreshed",
      };
    },
  );
  if (!result.committed) {
    throw new AuthApiFailure(409, "aborted", "invite-lease-lost");
  }
}

export async function releaseGameSessionMutationLease(
  inviteId: string,
  ownerId: string,
  repository: Pick<GameplayRepository, "transactRtdbPath">,
): Promise<void> {
  await repository.transactRtdbPath(mutationLockPath(inviteId), (current) =>
    toRecord(current)?.ownerId === ownerId
      ? { value: null, decision: "released" }
      : { commit: false, decision: "not-owner" },
  );
}

export async function withGameSessionMutationLease<T>(
  inviteId: string,
  operationId: string,
  repository: Pick<GameplayRepository, "transactRtdbPath">,
  work: () => Promise<T>,
  dependencies: Pick<
    GameSessionMutationDependencies,
    "createOwnerId" | "logger" | "now"
  > = {},
): Promise<T> {
  const ownerId = (dependencies.createOwnerId || (() => crypto.randomUUID()))();
  await acquireGameSessionMutationLease(
    inviteId,
    operationId,
    ownerId,
    repository,
    (dependencies.now || Date.now)(),
  );
  try {
    return await work();
  } finally {
    try {
      await releaseGameSessionMutationLease(inviteId, ownerId, repository);
    } catch {
      (dependencies.logger || console).error(
        JSON.stringify({
          event: "game_session_mutation_lock_release_failed",
          inviteId,
          operationId,
        }),
      );
    }
  }
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
  const now = dependencies.now || Date.now;
  const ownerId = (dependencies.createOwnerId || (() => crypto.randomUUID()))();
  const fingerprint = await mutationFingerprint(kind, request, requesterUid);
  await acquireGameSessionMutationLease(
    request.inviteId,
    request.operationId,
    ownerId,
    repository,
    now(),
  );
  try {
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
        buildAutomatchProfileGameProjectionOutboxUpdates({
          inviteId: request.inviteId,
          reason: outcome.projectReason,
          requestId: request.operationId,
          timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
        }),
      );
    }
    await refreshGameSessionMutationLease(
      request.inviteId,
      request.operationId,
      ownerId,
      repository,
      now(),
    );
    await repository.patchRtdbRoot(updates);
    if (projectionRequestId) {
      await dispatchProjection(
        request.inviteId,
        projectionRequestId,
        dependencies,
      );
    }
    return outcome.response;
  } finally {
    try {
      await releaseGameSessionMutationLease(
        request.inviteId,
        ownerId,
        repository,
      );
    } catch {
      (dependencies.logger || console).error(
        JSON.stringify({
          event: "game_session_mutation_lock_release_failed",
          inviteId: request.inviteId,
          operationId: request.operationId,
        }),
      );
    }
  }
}

async function resolveIdentityProfileId(
  identity: FirebaseIdentity,
  repository: GameplayRepository,
): Promise<string> {
  const linked = normalizeString(
    await repository
      .getRtdbPath(`players/${identity.uid}/profile`)
      .catch(() => null),
  );
  if (linked) {
    return linked;
  }
  const found = await repository
    .findProfileId(identity.uid, identity.idToken)
    .catch(() => null);
  return normalizeString(found) || normalizeString(identity.profileId);
}

async function resolveParticipant(
  identity: FirebaseIdentity,
  invite: Record<string, unknown>,
  repository: GameplayRepository,
): Promise<ParticipantResolution> {
  const hostUid = readStoredString(invite.hostId);
  const guestUid = readStoredString(invite.guestId);
  if (!isSafeFirebaseKey(hostUid) || !isSafeFirebaseKey(guestUid)) {
    throw failedPrecondition("missing-opponent");
  }
  if (identity.uid === hostUid) {
    return { actorUid: hostUid, opponentUid: guestUid, role: "host" };
  }
  if (identity.uid === guestUid) {
    return { actorUid: guestUid, opponentUid: hostUid, role: "guest" };
  }
  const identityProfileId = await resolveIdentityProfileId(
    identity,
    repository,
  );
  if (!identityProfileId) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  const [hostProfileId, guestProfileId] = await Promise.all([
    repository.getRtdbPath(`players/${hostUid}/profile`),
    repository.getRtdbPath(`players/${guestUid}/profile`),
  ]);
  if (normalizeString(hostProfileId) === identityProfileId) {
    return { actorUid: hostUid, opponentUid: guestUid, role: "host" };
  }
  if (normalizeString(guestProfileId) === identityProfileId) {
    return { actorUid: guestUid, opponentUid: hostUid, role: "guest" };
  }
  throw new AuthApiFailure(403, "permission-denied", "permission-denied");
}

async function profilesMatch(
  identity: FirebaseIdentity,
  otherUid: string,
  repository: GameplayRepository,
): Promise<boolean> {
  const identityProfileId = await resolveIdentityProfileId(
    identity,
    repository,
  );
  if (!identityProfileId) {
    return false;
  }
  return (
    normalizeString(
      await repository.getRtdbPath(`players/${otherUid}/profile`),
    ) === identityProfileId
  );
}

function ensureMutableInvite(invite: Record<string, unknown>): void {
  if (isEventOwnedInvite(invite)) {
    throw failedPrecondition("event-owned-invite");
  }
}

export async function createManualInvite(
  identity: FirebaseIdentity,
  request: CreateInviteRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies = {},
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

function emptyGameplayProfile(
  identity: FirebaseIdentity,
  request: JoinInviteRequest,
): GameplayProfile {
  return {
    aura: request.aura,
    emoji: request.emojiId,
    eth: "",
    profileId: normalizeString(identity.profileId),
    rating: 0,
    sol: "",
    username: "",
  };
}

async function joiningProfile(
  identity: FirebaseIdentity,
  request: JoinInviteRequest,
  repository: GameplayRepository,
): Promise<GameplayProfile> {
  return (
    (await repository
      .getGameplayProfile(identity.uid, identity.idToken)
      .catch(() => null)) || emptyGameplayProfile(identity, request)
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
  identity: FirebaseIdentity,
  request: JoinInviteRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies = {},
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
      const joinedExisting =
        currentGuestUid !== "" &&
        (currentGuestUid === identity.uid ||
          (await profilesMatch(identity, currentGuestUid, repository)));
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
      if (
        !currentGuestUid &&
        (identity.uid === hostUid ||
          (await profilesMatch(identity, hostUid, repository)))
      ) {
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
        const profile = await joiningProfile(identity, request, repository);
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
  return own.length > other.length ? null : latestCommon + 1;
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
  identity: FirebaseIdentity,
  request: ProposeRematchRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies = {},
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
  identity: FirebaseIdentity,
  request: EndRematchRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies = {},
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
      if (current.endsWith("x")) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            actorUid: participant.actorUid,
            rematches: current,
          },
        };
      }
      const rematches = `${current}x`;
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          actorUid: participant.actorUid,
          rematches,
        },
        projectReason: `manual-${field}-ended`,
        updates: {
          [`invites/${request.inviteId}/${field}`]: rematches,
        },
      };
    },
    dependencies,
  );
}

export async function ensureParticipantMatch(
  identity: FirebaseIdentity,
  request: EnsureMatchRequest,
  repository: GameplayRepository,
  dependencies: GameSessionMutationDependencies = {},
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
  GAME_SESSION_MUTATION_LOCK_MS,
  GAME_SESSION_MUTATION_LOCK_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS,
  GAME_SESSION_MUTATION_RECEIPT_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT,
};
export type { GameSessionMutationDependencies };
