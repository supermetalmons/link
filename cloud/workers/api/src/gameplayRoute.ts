import {
  inferAutomatchStateHint,
  isRemoveNavigationGameRequest,
  isStartAutomatchRequest,
  type CancelAutomatchResponse,
  type RemoveNavigationGameResponse,
} from "@mons/shared/navigation";
import {
  isWagerOutcomeResolveRequest,
  isWagerProposalAcceptRequest,
  isWagerProposalRemovalRequest,
  isWagerProposalSendRequest,
  type WagerProposalAcceptRequest,
  type WagerProposalSendRequest,
} from "@mons/shared/wagers";
import {
  isClaimMatchVictoryByTimerRequest,
  isStartMatchTimerRequest,
  type ClaimMatchVictoryByTimerRequest,
  type StartMatchTimerRequest,
} from "@mons/shared/timers";
import {
  isRatingUpdateRequest,
  type RatingUpdateRequest,
} from "@mons/shared/ratings";
import {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionOutboxUpdates,
  buildAutomatchTelegramLifecycleUpdates,
} from "../../../functions/telegram/automatchSource.js";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  verifyFirebaseRequest,
  type FirebaseIdentity,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import {
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  firebaseRtdbIncrement,
} from "./firebaseRtdb.ts";
import {
  MAX_FIREBASE_KEY_BYTES,
  isSafeFirebaseKey,
  isSafeFirestoreDocumentId,
} from "./firebaseKeys.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
  createRatingRepository,
  type RatingRepository,
} from "./gameplayRepository.ts";
import { readBoundedJson } from "./http.ts";
import {
  createAutomatchProjectionTask,
  enqueueAutomatchProjection,
  startAutomatch,
  type AutomatchDependencies,
} from "./automatch.ts";
import {
  claimMatchVictoryByTimer,
  enforceMatchTimerClaimRateLimit,
  enforceMatchTimerRateLimit,
  startMatchTimer,
  type MatchTimerDependencies,
} from "./matchTimer.ts";
import {
  acceptWagerProposal,
  removeWagerProposal,
  sendWagerProposal,
  type WagerProposalDependencies,
} from "./wagerProposal.ts";
import {
  enforceWagerOutcomeRateLimit,
  resolveWagerOutcome,
  type WagerOutcomeDependencies,
} from "./wagerOutcome.ts";
import {
  updateRatings,
  type RatingUpdateDependencies,
} from "./ratingUpdate.ts";
import {
  ensureEventProgressWorkflow,
  type EventProgressPlan,
} from "./eventProgress.ts";
import type { TelegramProjectionTask } from "./telegramProjectionTasks.ts";

const MAX_NAVIGATION_DELETE_ATTEMPTS = 3;

export const GAMEPLAY_PATHS = new Set([
  "/automatch/cancel",
  "/automatch/start",
  "/matches/timer/claim",
  "/matches/timer/start",
  "/navigation/games/remove",
  "/ratings/update",
  "/wagers/proposals/accept",
  "/wagers/proposals/cancel",
  "/wagers/proposals/decline",
  "/wagers/proposals/send",
  "/wagers/outcomes/resolve",
]);

type QueuedAutomatchCandidate = {
  inviteId: string;
  profileId: string;
  telegramDeliveryVersion: number | null;
  timestamp: number;
  uid: string;
};

type QueuedAutomatch = {
  inviteId: string | null;
  telegramDeliveryVersion?: number | null;
};

export type GameplayRouteDependencies = {
  automatch?: AutomatchDependencies;
  logFailure?: (kind: string) => void;
  repository?: GameplayRepository;
  rating?: RatingUpdateDependencies;
  ratingRepository?: RatingRepository;
  timer?: MatchTimerDependencies;
  wager?: WagerProposalDependencies;
  wagerOutcome?: WagerOutcomeDependencies;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<FirebaseIdentity>;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteTimestamp(value: unknown): number {
  const parsed =
    typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export function getQueuedAutomatchCandidates(
  value: unknown,
): QueuedAutomatchCandidate[] {
  const records = toRecord(value);
  if (!records) {
    return [];
  }
  return Object.entries(records)
    .reduce<QueuedAutomatchCandidate[]>((candidates, [inviteId, raw]) => {
      const payload = toRecord(raw) || {};
      if (!isSafeFirebaseKey(inviteId)) {
        return candidates;
      }
      candidates.push({
        inviteId,
        uid: normalizeString(payload.uid),
        profileId: normalizeString(payload.profileId),
        timestamp: finiteTimestamp(payload.timestamp),
        telegramDeliveryVersion:
          payload.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION
            ? TELEGRAM_AUTOMATCH_VERSION
            : null,
      });
      return candidates;
    }, [])
    .sort((left, right) => right.timestamp - left.timestamp);
}

async function resolveProfileId(
  identity: FirebaseIdentity,
  repository: GameplayRepository,
): Promise<string> {
  try {
    const linkedProfileId = normalizeString(
      await repository.getRtdbPath(`players/${identity.uid}/profile`),
    );
    if (linkedProfileId) {
      return linkedProfileId;
    }
  } catch {}
  try {
    const profileId = await repository.findProfileId(
      identity.uid,
      identity.idToken,
    );
    if (profileId) {
      return profileId;
    }
  } catch {}
  return normalizeString(identity.profileId);
}

async function inviteHostMatchesProfile(
  inviteId: string,
  profileId: string,
  repository: GameplayRepository,
): Promise<boolean> {
  try {
    const invite = toRecord(
      await repository.getRtdbPath(`invites/${inviteId}`),
    );
    const hostUid = normalizeString(invite?.hostId);
    if (!hostUid) {
      return false;
    }
    const hostProfileId = normalizeString(
      await repository.getRtdbPath(`players/${hostUid}/profile`),
    );
    return hostProfileId !== "" && hostProfileId === profileId;
  } catch {
    return false;
  }
}

async function resolveQueuedAutomatch(
  uid: string,
  profileId: string,
  repository: GameplayRepository,
): Promise<QueuedAutomatch> {
  const byUid = getQueuedAutomatchCandidates(
    await repository.getRtdbPath("automatch", {
      orderBy: "uid",
      equalTo: uid,
    }),
  );
  if (byUid.length > 0) {
    return byUid[0];
  }
  if (!profileId) {
    return { inviteId: null };
  }
  const byProfile = getQueuedAutomatchCandidates(
    await repository.getRtdbPath("automatch", {
      orderBy: "profileId",
      equalTo: profileId,
    }),
  );
  for (const candidate of byProfile) {
    if (
      await inviteHostMatchesProfile(candidate.inviteId, profileId, repository)
    ) {
      return candidate;
    }
  }
  return { inviteId: null };
}

export async function cancelAutomatch(
  identity: FirebaseIdentity,
  repository: GameplayRepository,
  dependencies: AutomatchDependencies = {},
): Promise<CancelAutomatchResponse> {
  const profileId = await resolveProfileId(identity, repository);
  const queued = await resolveQueuedAutomatch(
    identity.uid,
    profileId,
    repository,
  );
  if (!queued.inviteId) {
    return { ok: false };
  }
  const inviteId = queued.inviteId;
  if (
    normalizeString(await repository.getRtdbPath(`invites/${inviteId}/guestId`))
  ) {
    return { ok: false };
  }
  const usesTelegramDeliveryV2 =
    queued.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION;
  const projectionTask = usesTelegramDeliveryV2
    ? createAutomatchProjectionTask(inviteId, dependencies)
    : null;
  const canceledUpdates: Record<string, unknown> = {
    [`automatch/${inviteId}`]: null,
    [`invites/${inviteId}/automatchStateHint`]: "canceled",
    [`invites/${inviteId}/automatchCanceledAt`]: FIREBASE_RTDB_SERVER_TIMESTAMP,
  };
  if (usesTelegramDeliveryV2) {
    Object.assign(
      canceledUpdates,
      buildAutomatchTelegramLifecycleUpdates({
        inviteId,
        lifecycle: "canceled",
        timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
        generation: firebaseRtdbIncrement(1),
      }),
    );
    Object.assign(
      canceledUpdates,
      buildAutomatchTelegramProjectionOutboxUpdates({
        inviteId,
        requestId: projectionTask?.requestId || "",
        timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
      }),
    );
  }
  await repository.patchRtdbRoot(canceledUpdates);
  if (projectionTask) {
    await enqueueAutomatchProjection(projectionTask, dependencies);
  }
  if (
    !normalizeString(
      await repository.getRtdbPath(`invites/${inviteId}/guestId`),
    )
  ) {
    return { ok: true };
  }
  const matchedUpdates: Record<string, unknown> = {
    [`invites/${inviteId}/automatchStateHint`]: "matched",
    [`invites/${inviteId}/automatchCanceledAt`]: null,
  };
  const matchedProjectionTask = usesTelegramDeliveryV2
    ? createAutomatchProjectionTask(inviteId, dependencies)
    : null;
  if (usesTelegramDeliveryV2) {
    Object.assign(
      matchedUpdates,
      buildAutomatchTelegramLifecycleUpdates({
        inviteId,
        lifecycle: "matched",
        timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
        generation: firebaseRtdbIncrement(1),
      }),
    );
    Object.assign(
      matchedUpdates,
      buildAutomatchTelegramProjectionOutboxUpdates({
        inviteId,
        requestId: matchedProjectionTask?.requestId || "",
        timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
      }),
    );
  }
  await repository.patchRtdbRoot(matchedUpdates);
  if (matchedProjectionTask) {
    await enqueueAutomatchProjection(matchedProjectionTask, dependencies);
  }
  return { ok: false };
}

function skippedNavigationResponse(
  inviteId: string,
  reason: string,
): RemoveNavigationGameResponse {
  return { ok: true, skipped: true, reason, inviteId };
}

export async function removeNavigationGame(
  identity: FirebaseIdentity,
  inviteId: string,
  repository: GameplayRepository,
): Promise<RemoveNavigationGameResponse> {
  const profileId = await resolveProfileId(identity, repository);
  if (!profileId) {
    return skippedNavigationResponse(inviteId, "profile-unresolved");
  }
  const [inviteValue, automatchValue] = await Promise.all([
    repository.getRtdbPath(`invites/${inviteId}`),
    repository.getRtdbPath(`automatch/${inviteId}`),
  ]);
  const invite = toRecord(inviteValue);
  if (!invite) {
    return skippedNavigationResponse(inviteId, "invite-missing");
  }
  const guestId = normalizeString(invite.guestId);
  if (guestId) {
    return skippedNavigationResponse(inviteId, "invite-active");
  }
  if (
    inferAutomatchStateHint({
      inviteId,
      queueValue: automatchValue,
      hasGuest: false,
      storedStateHint: invite.automatchStateHint,
    }) === "pending"
  ) {
    return skippedNavigationResponse(inviteId, "pending-automatch");
  }
  for (let attempt = 0; attempt < MAX_NAVIGATION_DELETE_ATTEMPTS; attempt++) {
    const game = await repository.getNavigationGame(
      profileId,
      inviteId,
      identity.idToken,
    );
    if (!game) {
      return {
        ...skippedNavigationResponse(inviteId, "not-found"),
        deleted: false,
      };
    }
    if (game.status !== "waiting") {
      return {
        ...skippedNavigationResponse(
          inviteId,
          game.status ? `status-${game.status}` : "status-missing",
        ),
        deleted: false,
      };
    }
    const result = await repository.deleteNavigationGame(
      profileId,
      inviteId,
      game.updateTime,
    );
    if (result === "deleted") {
      return {
        ok: true,
        skipped: false,
        deleted: true,
        reason: null,
        inviteId,
      };
    }
    if (result === "missing") {
      return {
        ...skippedNavigationResponse(inviteId, "not-found"),
        deleted: false,
      };
    }
  }
  throw new AuthApiFailure(
    503,
    "unavailable",
    "navigation-game-write-conflict",
  );
}

async function readGameplayBody(
  request: Request,
  pathname: string,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null;
  try {
    body = toRecord(await readBoundedJson(request));
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  if (!body) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  if (pathname === "/automatch/cancel") {
    if (Object.keys(body).length !== 0) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/automatch/start") {
    if (!isStartAutomatchRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return body;
  }
  if (pathname === "/matches/timer/start") {
    if (!isStartMatchTimerRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const playerId = body.playerId.trim();
    const opponentId = body.opponentId.trim();
    const matchId = body.matchId.trim();
    const inviteId = body.inviteId.trim();
    return {
      playerId,
      opponentId,
      matchId,
      inviteId,
    } satisfies StartMatchTimerRequest;
  }
  if (pathname === "/matches/timer/claim") {
    if (!isClaimMatchVictoryByTimerRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const playerId = body.playerId.trim();
    const opponentId = body.opponentId.trim();
    const matchId = body.matchId.trim();
    const inviteId = body.inviteId.trim();
    return {
      playerId,
      opponentId,
      matchId,
      inviteId,
    } satisfies ClaimMatchVictoryByTimerRequest;
  }
  if (pathname.startsWith("/wagers/proposals/")) {
    if (pathname === "/wagers/proposals/send") {
      if (!isWagerProposalSendRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const inviteId = body.inviteId.trim();
      const matchId = body.matchId.trim();
      if (!isSafeFirebaseKey(inviteId) || !isSafeFirebaseKey(matchId)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      return {
        inviteId,
        matchId,
        material: body.material,
        count: body.count,
      } satisfies WagerProposalSendRequest;
    }
    if (!isWagerProposalAcceptRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const inviteId = body.inviteId.trim();
    const matchId = body.matchId.trim();
    if (!isSafeFirebaseKey(inviteId) || !isSafeFirebaseKey(matchId)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return { inviteId, matchId } satisfies WagerProposalAcceptRequest;
  }
  if (pathname === "/wagers/outcomes/resolve") {
    if (!isWagerOutcomeResolveRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const inviteId = body.inviteId.trim();
    const matchId = body.matchId.trim();
    if (!isSafeFirebaseKey(inviteId) || !isSafeFirebaseKey(matchId)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return { inviteId, matchId };
  }
  if (pathname === "/ratings/update") {
    if (!isRatingUpdateRequest(body)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    const playerId = body.playerId.trim();
    const opponentId = body.opponentId.trim();
    const inviteId = body.inviteId.trim();
    const matchId = body.matchId.trim();
    if (
      !isSafeFirebaseKey(playerId) ||
      !isSafeFirebaseKey(opponentId) ||
      !isSafeFirebaseKey(inviteId) ||
      !isSafeFirebaseKey(matchId) ||
      !isSafeFirestoreDocumentId(`${inviteId}__${matchId}`)
    ) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return {
      playerId,
      opponentId,
      inviteId,
      matchId,
    } satisfies RatingUpdateRequest;
  }
  if (!isRemoveNavigationGameRequest(body)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  const inviteId = body.inviteId.trim();
  if (!isSafeFirebaseKey(inviteId)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  return { inviteId };
}

export async function handleGameplayRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: GameplayRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    if (request.method !== "POST") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const pathname = new URL(request.url).pathname;
    if (!GAMEPLAY_PATHS.has(pathname)) {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    if (pathname === "/wagers/outcomes/resolve") {
      await enforceWagerOutcomeRateLimit(env.AUTH_RATE_LIMITER, identity.uid);
    }
    const body = await readGameplayBody(request, pathname);
    const repository = dependencies.repository || createGameplayRepository(env);
    const defaultEnqueueEventProgress = async (plan: EventProgressPlan) => {
      ctx.waitUntil(
        ensureEventProgressWorkflow(env.EVENT_PROGRESS_WORKFLOW, plan).catch(
          () => {
            console.error(
              JSON.stringify({
                event: "event_progress_enqueue_failed",
                eventId: plan.params.eventId,
                sourceKey: plan.params.sourceKey,
              }),
            );
          },
        ),
      );
    };
    const defaultEnqueueTelegramProjection = async (
      task: TelegramProjectionTask,
    ) => {
      ctx.waitUntil(
        env.TELEGRAM_PROJECTION_QUEUE.send(task).catch(() => {
          console.error(
            JSON.stringify({
              event: "telegram_projection_enqueue_failed",
              kind: task.kind,
            }),
          );
        }),
      );
    };
    const automatchDependencies: AutomatchDependencies = {
      ...dependencies.automatch,
      enqueueTelegramProjection:
        dependencies.automatch?.enqueueTelegramProjection ||
        defaultEnqueueTelegramProjection,
    };
    const ratingDependencies: RatingUpdateDependencies = {
      ...dependencies.rating,
      enqueueEventProgress:
        dependencies.rating?.enqueueEventProgress ||
        defaultEnqueueEventProgress,
      enqueueTelegramProjection:
        dependencies.rating?.enqueueTelegramProjection ||
        defaultEnqueueTelegramProjection,
    };
    let response;
    if (pathname === "/automatch/cancel") {
      response = await cancelAutomatch(
        identity,
        repository,
        automatchDependencies,
      );
    } else if (pathname === "/automatch/start") {
      if (!isStartAutomatchRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await startAutomatch(
        identity,
        body,
        repository,
        automatchDependencies,
      );
    } else if (pathname === "/matches/timer/start") {
      if (!isStartMatchTimerRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceMatchTimerRateLimit(env.AUTH_RATE_LIMITER, identity.uid);
      response = await startMatchTimer(identity, body, repository, {
        ...dependencies.timer,
        enqueueEventProgress:
          dependencies.timer?.enqueueEventProgress ||
          defaultEnqueueEventProgress,
        signal: dependencies.timer?.signal || request.signal,
      });
    } else if (pathname === "/matches/timer/claim") {
      if (!isClaimMatchVictoryByTimerRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      await enforceMatchTimerClaimRateLimit(
        env.AUTH_RATE_LIMITER,
        identity.uid,
      );
      response = await claimMatchVictoryByTimer(identity, body, repository, {
        ...dependencies.timer,
        enqueueEventProgress:
          dependencies.timer?.enqueueEventProgress ||
          defaultEnqueueEventProgress,
        signal: dependencies.timer?.signal || request.signal,
      });
    } else if (pathname === "/navigation/games/remove") {
      response = await removeNavigationGame(
        identity,
        normalizeString(body.inviteId),
        repository,
      );
    } else if (pathname === "/ratings/update") {
      if (!isRatingUpdateRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await updateRatings(
        identity,
        body,
        dependencies.ratingRepository ||
          createRatingRepository(env, repository),
        ratingDependencies,
      );
    } else if (pathname === "/wagers/proposals/send") {
      if (!isWagerProposalSendRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await sendWagerProposal(
        identity,
        body,
        repository,
        dependencies.wager,
      );
    } else if (pathname === "/wagers/proposals/accept") {
      if (!isWagerProposalAcceptRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await acceptWagerProposal(
        identity,
        body,
        repository,
        dependencies.wager,
      );
    } else if (pathname === "/wagers/outcomes/resolve") {
      if (!isWagerOutcomeResolveRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await resolveWagerOutcome(identity, body, repository, {
        ...dependencies.wagerOutcome,
        scheduleRetry:
          dependencies.wagerOutcome?.scheduleRetry ||
          (async (task) => {
            await env.TELEGRAM_DELIVERY_QUEUE.send(task);
          }),
        signal: dependencies.wagerOutcome?.signal || request.signal,
      });
    } else {
      if (!isWagerProposalRemovalRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      response = await removeWagerProposal(
        identity,
        body,
        pathname.endsWith("/cancel") ? "cancel" : "decline",
        repository,
        dependencies.wager,
      );
    }
    return authJsonResponse(response, 200, corsHeaders);
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(
            503,
            "unavailable",
            "gameplay-service-unavailable",
          );
    if (failure.status >= 500) {
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "gameplay_route_failure", kind }),
          ))
      )(failure.message);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}

export {
  MAX_FIREBASE_KEY_BYTES,
  MAX_NAVIGATION_DELETE_ATTEMPTS,
  isSafeFirebaseKey,
  readGameplayBody,
  resolveProfileId,
  resolveQueuedAutomatch,
};
