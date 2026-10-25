import {
  readInviteDocument,
  inviteMatchesParticipants,
  inviteRatingEvent,
  inviteMutationParticipants,
  inviteProjectionState,
} from "@mons/shared/invite-records";
import { isAutoInviteId } from "@mons/shared/ids";
import { readGameplayMatchPair } from "./gameplayMatchReads.ts";
import {
  type RatingUpdateRequest,
  type RatingUpdateResponse,
} from "@mons/shared/ratings";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import { TELEGRAM_AUTOMATCH_VERSION } from "../../../runtime/telegram/automatchSource.js";
import { AuthApiFailure } from "./authErrors.ts";
import type { MatchTimerStartStore } from "./gameplayCoordinationD1.ts";
import { buildHistoricalMatchPair } from "./historicalMatches.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import type {
  RatingRepairData,
  RatingRepository,
  RatingUpdateData,
} from "./ratingContracts.ts";
import type {
  RatingTelegramProjectionTask,
  TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import type {
  ProfileGameProjectionTask,
  RatingProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import { authorizeMatchPlayer } from "./matchAdmission.ts";
import {
  buildEventProgressPlan,
  type EventProgressPlan,
} from "./eventProgressCodec.ts";
import {
  FEB_CHALLENGE_END_UTC,
  FEB_CHALLENGE_START_UTC,
  buildRatingPlan,
  readMatchRecord,
  resolveRatingResult,
} from "./ratingPlan.ts";

const RATING_UPDATE_LEASE_MS = 30_000;
export type RatingUpdateDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  createOwnerToken?: (uid: string) => string;
  enqueueEventProgress?: (plan: EventProgressPlan) => Promise<void>;
  enqueueProfileGameProjection?: (
    task: ProfileGameProjectionTask,
  ) => Promise<void>;
  enqueueTelegramProjection?: (task: TelegramProjectionTask) => Promise<void>;
  logProfileGameProjectionFailure?: (
    task: RatingProfileGameProjectionTask,
  ) => void;
  logProjectionFailure?: (task: RatingTelegramProjectionTask) => void;
  now?: () => number;
  timerStarts: MatchTimerStartStore;
};

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

async function enqueueRatingProjection(
  operationId: string,
  dependencies: RatingUpdateDependencies,
): Promise<void> {
  if (!dependencies.enqueueTelegramProjection) {
    return;
  }
  const task: RatingTelegramProjectionTask = {
    kind: "rating-telegram-projection",
    operationId,
  };
  try {
    await dependencies.enqueueTelegramProjection(task);
  } catch {
    (
      dependencies.logProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "rating_telegram_projection_enqueue_failed",
            operationId: failedTask.operationId,
          }),
        ))
    )(task);
  }
}

async function enqueueProfileGameProjection(
  operationId: string,
  dependencies: RatingUpdateDependencies,
): Promise<void> {
  if (!dependencies.enqueueProfileGameProjection) {
    return;
  }
  const task: RatingProfileGameProjectionTask = {
    kind: "rating-profile-game-projection",
    operationId,
  };
  try {
    await dependencies.enqueueProfileGameProjection(task);
  } catch {
    (
      dependencies.logProfileGameProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "rating_profile_game_projection_enqueue_failed",
            operationId: failedTask.operationId,
          }),
        ))
    )(task);
  }
}

async function repairRatingSideEffects(
  request: RatingUpdateRequest,
  data: RatingRepairData | null,
  repository: RatingRepository,
  timerStarts: MatchTimerStartStore,
  assertMutationAllowed: (() => Promise<void>) | undefined,
  eventId: string | null,
  nowMs: number,
): Promise<EventProgressPlan | null> {
  const progress = eventId
    ? await buildEventProgressPlan(
        {
          eventId,
          sourceKey: `rating:${request.inviteId}:${request.matchId}`,
          reason: "match-rating-updated",
        },
        nowMs,
      )
    : null;
  if (progress) {
    await assertMutationAllowed?.();
    await repository.putEventProgressOutbox(progress.outboxId, progress.outbox);
  }
  await assertMutationAllowed?.();
  await timerStarts.deletePair(
    request.playerId,
    request.opponentId,
    request.matchId,
  );
  if (
    data?.shouldUpdateFebruaryChallenge &&
    data.playerProfileId &&
    data.opponentProfileId
  ) {
    await repository.applyFebruaryChallengeReplay(
      data.playerProfileId,
      data.opponentProfileId,
    );
  }
  return progress;
}

async function dispatchEventProgress(
  progress: EventProgressPlan | null,
  dependencies: RatingUpdateDependencies,
): Promise<void> {
  if (!progress || !dependencies.enqueueEventProgress) {
    return;
  }
  try {
    await dependencies.enqueueEventProgress(progress);
  } catch {
    console.error(
      JSON.stringify({
        event: "rating_event_progress_enqueue_failed",
        eventId: progress.params.eventId,
        sourceKey: progress.params.sourceKey,
      }),
    );
  }
}

type RatingCompletion =
  | { kind: "observed"; data: RatingUpdateData | null }
  | {
      kind: "finalized";
      data: RatingRepairData;
      telegramProjection: boolean;
    };

async function finishRatingUpdate(
  request: RatingUpdateRequest,
  operationId: string,
  completion: RatingCompletion,
  repository: RatingRepository,
  dependencies: RatingUpdateDependencies,
  eventId: string | null,
  nowMs: number,
): Promise<RatingUpdateResponse> {
  const progress = await repairRatingSideEffects(
    request,
    completion.data,
    repository,
    dependencies.timerStarts,
    dependencies.assertMutationAllowed,
    eventId,
    nowMs,
  );
  await dispatchEventProgress(progress, dependencies);
  if (completion.kind === "observed") {
    if (completion.data?.telegramProjectionState === "pending") {
      await enqueueRatingProjection(operationId, dependencies);
    }
    if (completion.data?.profileGameProjectionState === "pending") {
      await enqueueProfileGameProjection(operationId, dependencies);
    }
  } else {
    await enqueueProfileGameProjection(operationId, dependencies);
    if (completion.telegramProjection) {
      await enqueueRatingProjection(operationId, dependencies);
    }
  }
  return { ok: true };
}

export async function updateRatings(
  identity: RequestIdentity,
  request: RatingUpdateRequest,
  repository: RatingRepository,
  dependencies: RatingUpdateDependencies,
): Promise<RatingUpdateResponse> {
  if (!isAutoInviteId(request.inviteId)) {
    return { ok: false };
  }
  if (parseInviteMatchIndex(request.inviteId, request.matchId) === null) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  await authorizeMatchPlayer(identity, request.playerId, repository, {
    additionalLoginUids: [request.opponentId],
  });
  const operationId = `${request.inviteId}__${request.matchId}`;
  const [inviteValue, completed] = await Promise.all([
    repository.readInviteMetadata(request.inviteId),
    repository.hasCompletedRatingUpdate(request.inviteId, request.matchId),
  ]);
  const invite = readInviteDocument(inviteValue);
  if (
    !invite ||
    !inviteMatchesParticipants(invite, request.playerId, request.opponentId)
  ) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  const eventMetadata = inviteRatingEvent(invite);
  const progressEventId =
    eventMetadata.isEventMatch &&
    eventMetadata.eventOwned &&
    eventMetadata.eventId
      ? eventMetadata.eventId
      : null;
  const now = dependencies.now || Date.now;
  const existing = await repository.readRatingUpdate(operationId);
  if (
    existing &&
    (existing.inviteId !== request.inviteId ||
      existing.matchId !== request.matchId)
  ) {
    throw new AuthApiFailure(503, "unavailable", "rating-completion-conflict");
  }
  if (completed === true || existing?.status === "done") {
    return finishRatingUpdate(
      request,
      operationId,
      { kind: "observed", data: existing },
      repository,
      dependencies,
      progressEventId,
      now(),
    );
  }
  const [playerValue, opponentValue] = await readGameplayMatchPair(repository, {
    inviteId: request.inviteId,
    matchId: request.matchId,
    playerId: request.playerId,
    opponentId: request.opponentId,
  });
  const playerMatch = readMatchRecord(playerValue);
  const opponentMatch = readMatchRecord(opponentValue);
  const { hostId: hostPlayerId, guestId: guestPlayerId } =
    inviteMutationParticipants(invite);
  const historicalMatchPair = buildHistoricalMatchPair({
    matchId: request.matchId,
    hostPlayerId,
    guestPlayerId,
    hostMatch:
      request.playerId === hostPlayerId
        ? playerValue
        : request.opponentId === hostPlayerId
          ? opponentValue
          : null,
    guestMatch:
      request.playerId === guestPlayerId
        ? playerValue
        : request.opponentId === guestPlayerId
          ? opponentValue
          : null,
  });
  if (!historicalMatchPair) {
    throw failedPrecondition("something is wrong with the game state.");
  }
  const result = resolveRatingResult(playerMatch, opponentMatch);
  const ownerToken = (
    dependencies.createOwnerToken ||
    ((uid: string) => `${uid}_${crypto.randomUUID()}`)
  )(identity.uid);
  const lease = await repository.tryAcquireRatingLease({
    inviteId: request.inviteId,
    matchId: request.matchId,
    opponentId: request.opponentId,
    ownerToken,
    ownerUid: identity.uid,
    playerId: request.playerId,
    leaseMs: RATING_UPDATE_LEASE_MS,
  });
  if (lease.status === "done") {
    return finishRatingUpdate(
      request,
      operationId,
      { kind: "observed", data: lease.data },
      repository,
      dependencies,
      progressEventId,
      now(),
    );
  }
  if (lease.status !== "acquired") {
    return { ok: true, skipped: true };
  }
  const finalized = await repository.finalizeRatingUpdate(
    {
      inviteId: request.inviteId,
      matchId: request.matchId,
      opponentId: request.opponentId,
      operationId,
      ownerToken,
      playerId: request.playerId,
    },
    (player, opponent) => {
      return buildRatingPlan({
        historicalMatchPair,
        invite,
        matchId: request.matchId,
        nowMs: now(),
        opponent,
        opponentMatch,
        player,
        playerMatch,
        request,
        result,
      });
    },
  );
  if (finalized.status === "lost") {
    return { ok: true, skipped: true };
  }
  return finishRatingUpdate(
    request,
    operationId,
    {
      kind: "finalized",
      data: finalized.data,
      telegramProjection:
        inviteProjectionState(invite).telegramDeliveryVersion ===
          TELEGRAM_AUTOMATCH_VERSION && !eventMetadata.isEventMatch,
    },
    repository,
    dependencies,
    progressEventId,
    now(),
  );
}

export {
  FEB_CHALLENGE_END_UTC,
  FEB_CHALLENGE_START_UTC,
  RATING_UPDATE_LEASE_MS,
  buildRatingPlan,
  readMatchRecord,
  resolveRatingResult,
};
