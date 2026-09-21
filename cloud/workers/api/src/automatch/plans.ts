import { createGameVariantHelpers } from "@mons/shared/game-variants";
import {
  buildAutoInviteId,
  pickHostColor,
  randomAlphanumeric,
  type RandomSource,
} from "@mons/shared/ids";
import {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} from "@mons/shared/match-protocol";
import type { StartAutomatchRequest } from "@mons/shared/navigation";
import * as monsRules from "mons-rules";
import {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionChanges,
  buildMatchedAutomatchTelegramChanges,
  buildPendingAutomatchTelegramSource,
} from "../../../../runtime/telegram/automatchSource.js";
import {
  AUTOMATCH_WAITING_EMOJI_ID,
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} from "../../../../runtime/telegramDisplay.js";
import {
  STATE_SERVER_TIMESTAMP,
  stateIncrement,
} from "../stateCompatibility.ts";
import type { GameplayProfile } from "../gameplayRepository.ts";
import { requestAutomatchProfileProjection } from "../gameSessionProjectionChanges.ts";
import type { GameSessionChange } from "../gameSessionContracts.ts";
import type { AutomatchProfileGameProjectionTask } from "../profileGameProjectionTasks.ts";
import type { AutomatchTelegramProjectionTask } from "../telegramProjectionTasks.ts";
import { buildAutomatchReceiptChanges } from "./receipts.ts";
import type {
  AutomatchPlan,
  AutomatchPlanInput,
  MatchedAutomatchPlan,
  QueuedAutomatch,
  SuccessfulStartAutomatchResponse,
} from "./types.ts";

const AUTOMATCH_PASSWORD_LENGTH = 15;
const gameVariantHelpers = createGameVariantHelpers(monsRules);

export function emptyAutomatchProfile(): GameplayProfile {
  return {
    aura: "",
    emoji: "",
    eth: "",
    profileId: "",
    rating: 0,
    sol: "",
    username: "",
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number {
  const parsed =
    typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function profileOrFallback(
  profile: GameplayProfile | null,
  request: StartAutomatchRequest,
): GameplayProfile {
  return (
    profile || {
      ...emptyAutomatchProfile(),
      aura: request.aura,
      emoji: request.emojiId,
    }
  );
}

export function matchedAutomatchResponse(
  inviteId: string,
): SuccessfulStartAutomatchResponse {
  return {
    ok: true,
    inviteId,
    mode: "matched",
    matchedImmediately: true,
  };
}

export function pendingAutomatchResponse(
  inviteId: string,
): SuccessfulStartAutomatchResponse {
  return {
    ok: true,
    inviteId,
    mode: "pending",
    matchedImmediately: false,
  };
}

export function buildAutomatchProjectionTask(
  inviteId: string,
  requestId: string,
): AutomatchTelegramProjectionTask {
  return {
    kind: "automatch-telegram-projection",
    inviteId,
    requestId,
  };
}

export function buildAutomatchProfileGameProjectionTask(
  inviteId: string,
  requestId: string,
): AutomatchProfileGameProjectionTask {
  return {
    kind: "automatch-profile-game-projection",
    inviteId,
    requestId,
  };
}

export function buildPendingAutomatchPlan(
  {
    requesterUid,
    request,
    profile,
    emojiId,
    aura,
    name,
    random,
  }: AutomatchPlanInput & {
    profile: GameplayProfile;
    random: RandomSource;
  },
  createProjectionRequestId: () => string,
): AutomatchPlan {
  const inviteId = buildAutoInviteId(random);
  const password = randomAlphanumeric(AUTOMATCH_PASSWORD_LENGTH, random);
  const hostColor = pickHostColor(random);
  const matchSeed = gameVariantHelpers.buildRandomGameSeed(random);
  const timestamp = STATE_SERVER_TIMESTAMP;
  const match = buildFreshMatchRecord({
    color: hostColor,
    emojiId,
    aura,
    seed: matchSeed,
  });
  const waitingText = `${name} is looking for a match https://mons.link ${getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)}`;
  const canceledText = `<i>${name} canceled an automatch</i>`;
  const response: SuccessfulStartAutomatchResponse = {
    ok: true,
    inviteId,
    mode: "pending",
    matchedImmediately: false,
  };
  const profileGameProjectionTask = buildAutomatchProfileGameProjectionTask(
    inviteId,
    createProjectionRequestId(),
  );
  const projectionTask = buildAutomatchProjectionTask(
    inviteId,
    profileGameProjectionTask.requestId,
  );
  const changes: GameSessionChange[] = [
    {
      kind: "match-create",
      playerId: requesterUid,
      matchId: inviteId,
      value: match,
    },
    {
      kind: "automatch-entry",
      inviteId,
      value: {
        uid: requesterUid,
        rating: profile.rating,
        timestamp,
        username: profile.username,
        ethAddress: profile.eth,
        solAddress: profile.sol,
        profileId: profile.profileId,
        hostColor,
        password,
        emojiId,
        gameVariant: matchSeed.gameVariant,
        telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION,
      },
    },
    {
      kind: "invite-merge",
      inviteId,
      value: {
        version: CONTROLLER_VERSION,
        hostId: requesterUid,
        hostColor,
        guestId: null,
        password,
        automatchStateHint: "pending",
        automatchCanceledAt: null,
        automatchOperationIds: {
          [requesterUid]: request.operationId,
        },
        telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION,
      },
    },
    {
      kind: "telegram-source",
      inviteId,
      value: buildPendingAutomatchTelegramSource({
        inviteId,
        waitingText,
        canceledText,
        timestamp,
      }),
    },
    ...buildAutomatchTelegramProjectionChanges({
      inviteId,
      requestId: projectionTask.requestId,
      timestamp,
    }),
    ...requestAutomatchProfileProjection({
      inviteId,
      requestId: profileGameProjectionTask.requestId,
      timestamp,
    }),
    ...buildAutomatchReceiptChanges(
      requesterUid,
      request,
      response,
      profileGameProjectionTask.requestId,
      true,
    ),
  ];
  return { response, changes, profileGameProjectionTask, projectionTask };
}

export function buildMatchedAutomatchPlan(
  {
    requesterUid,
    request,
    queued,
    existingUid,
    emojiId,
    aura,
    name,
  }: AutomatchPlanInput & {
    queued: QueuedAutomatch;
    existingUid: string;
  },
  createProjectionRequestId: () => string,
): MatchedAutomatchPlan {
  const matchSeed = gameVariantHelpers.buildGameSeedForStoredVariant(
    queued.data.gameVariant,
  );
  const hostColor = normalizeString(queued.data.hostColor);
  const existingPlayerName = getDisplayNameFromAddress(
    queued.data.username,
    queued.data.ethAddress,
    queued.data.solAddress,
    finiteNumber(queued.data.rating),
    queued.data.emojiId,
  );
  const usesTelegramDeliveryV2 =
    queued.data.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION;
  const invite: Record<string, unknown> = {
    version: CONTROLLER_VERSION,
    hostId: existingUid,
    hostColor,
    guestId: requesterUid,
    password: normalizeString(queued.data.password),
    automatchStateHint: "matched",
    automatchCanceledAt: null,
    automatchOperationIds: {
      [requesterUid]: request.operationId,
    },
    ...(usesTelegramDeliveryV2
      ? { telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION }
      : {}),
  };
  const match = buildFreshMatchRecord({
    color: hostColor === "white" ? "black" : "white",
    emojiId,
    aura,
    seed: matchSeed,
  });
  const matchedText = `${existingPlayerName} vs. ${name} https://mons.link/${queued.inviteId}`;
  const inviteChange: MatchedAutomatchPlan["inviteChange"] = {
    kind: "invite-merge",
    inviteId: queued.inviteId,
    value: invite,
  };
  const changes: GameSessionChange[] = [
    { kind: "automatch-entry", inviteId: queued.inviteId, value: null },
    inviteChange,
    {
      kind: "match-create",
      playerId: requesterUid,
      matchId: queued.inviteId,
      value: match,
    },
  ];
  const matchedResponse = matchedAutomatchResponse(queued.inviteId);
  const profileGameProjectionTask = buildAutomatchProfileGameProjectionTask(
    queued.inviteId,
    createProjectionRequestId(),
  );
  const projectionTask = usesTelegramDeliveryV2
    ? buildAutomatchProjectionTask(
        queued.inviteId,
        profileGameProjectionTask.requestId,
      )
    : null;
  changes.push(
    ...requestAutomatchProfileProjection({
      inviteId: queued.inviteId,
      requestId: profileGameProjectionTask.requestId,
      timestamp: STATE_SERVER_TIMESTAMP,
    }),
  );
  if (usesTelegramDeliveryV2) {
    changes.push(
      ...buildMatchedAutomatchTelegramChanges({
        inviteId: queued.inviteId,
        matchedText,
        timestamp: STATE_SERVER_TIMESTAMP,
        generation: stateIncrement(1),
      }),
    );
    changes.push(
      ...buildAutomatchTelegramProjectionChanges({
        inviteId: queued.inviteId,
        requestId: projectionTask?.requestId || "",
        timestamp: STATE_SERVER_TIMESTAMP,
      }),
    );
  }
  changes.push(
    ...buildAutomatchReceiptChanges(
      requesterUid,
      request,
      matchedResponse,
      profileGameProjectionTask.requestId,
      usesTelegramDeliveryV2,
    ),
  );
  return {
    response: matchedResponse,
    changes,
    profileGameProjectionTask,
    projectionTask,
    inviteChange,
  };
}
