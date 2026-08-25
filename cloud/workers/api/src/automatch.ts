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
import {
  type StartAutomatchRequest,
  type StartAutomatchResponse,
} from "@mons/shared/navigation";
import * as monsRules from "mons-rules";
import {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionOutboxUpdates,
  buildMatchedAutomatchTelegramUpdates,
  buildPendingAutomatchTelegramSource,
  getAutomatchTelegramSourcePath,
} from "../../../functions/telegram/automatchSource.js";
import {
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} from "../../../functions/telegramDisplay.js";
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import {
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  firebaseRtdbIncrement,
} from "./firebaseRtdb.ts";
import type {
  GameplayProfile,
  GameplayRepository,
} from "./gameplayRepository.ts";
import { buildAutomatchProfileGameProjectionOutboxUpdates } from "./profileGameProjectionOutbox.ts";
import type {
  AutomatchProfileGameProjectionTask,
  ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import type {
  AutomatchTelegramProjectionTask,
  TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";

const MAX_AUTOMATCH_RETRY_COUNT = 3;
const AUTOMATCH_TOTAL_TIMEOUT_MS = 20_000;
const AUTOMATCH_PASSWORD_LENGTH = 15;
const AUTOMATCH_WAITING_EMOJI_ID = "5355002036817525409";
const gameVariantHelpers = createGameVariantHelpers(monsRules);

type AutomatchDependencies = {
  createProjectionRequestId?: () => string;
  enqueueProfileGameProjection?: (
    task: ProfileGameProjectionTask,
  ) => Promise<void>;
  enqueueTelegramProjection?: (task: TelegramProjectionTask) => Promise<void>;
  logProfileFailure?: () => void;
  logProfileGameProjectionFailure?: (
    task: AutomatchProfileGameProjectionTask,
  ) => void;
  logProjectionFailure?: (task: AutomatchTelegramProjectionTask) => void;
  random?: RandomSource;
  signal?: AbortSignal;
};

type QueuedAutomatch = {
  data: Record<string, unknown>;
  inviteId: string;
};

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

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number {
  const parsed =
    typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getFirstQueuedAutomatch(
  value: unknown,
): QueuedAutomatch | null {
  const queue = toRecord(value);
  if (!queue) {
    return null;
  }
  const first = Object.entries(queue)[0];
  if (!first) {
    return null;
  }
  const [inviteId, data] = first;
  return { inviteId, data: toRecord(data) || {} };
}

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

export function createAutomatchProjectionTask(
  inviteId: string,
  dependencies: AutomatchDependencies,
  requestId = (
    dependencies.createProjectionRequestId || (() => crypto.randomUUID())
  )(),
): AutomatchTelegramProjectionTask {
  return {
    kind: "automatch-telegram-projection",
    inviteId,
    requestId,
  };
}

export function createAutomatchProfileGameProjectionTask(
  inviteId: string,
  dependencies: AutomatchDependencies,
): AutomatchProfileGameProjectionTask {
  return {
    kind: "automatch-profile-game-projection",
    inviteId,
    requestId: (
      dependencies.createProjectionRequestId || (() => crypto.randomUUID())
    )(),
  };
}

export async function enqueueAutomatchProjection(
  task: AutomatchTelegramProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (!dependencies.enqueueTelegramProjection) {
    return;
  }
  try {
    await dependencies.enqueueTelegramProjection(task);
  } catch {
    (
      dependencies.logProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "automatch_telegram_projection_enqueue_failed",
            inviteId: failedTask.inviteId,
          }),
        ))
    )(task);
  }
}

export async function enqueueAutomatchProfileGameProjection(
  task: AutomatchProfileGameProjectionTask,
  dependencies: AutomatchDependencies,
): Promise<void> {
  if (!dependencies.enqueueProfileGameProjection) {
    return;
  }
  try {
    await dependencies.enqueueProfileGameProjection(task);
  } catch {
    (
      dependencies.logProfileGameProjectionFailure ||
      ((failedTask) =>
        console.error(
          JSON.stringify({
            event: "automatch_profile_game_projection_enqueue_failed",
            inviteId: failedTask.inviteId,
          }),
        ))
    )(task);
  }
}

async function readProfile(
  identity: FirebaseIdentity,
  request: StartAutomatchRequest,
  repository: GameplayRepository,
  logProfileFailure: () => void,
  signal: AbortSignal,
): Promise<GameplayProfile> {
  const fallbackProfile = {
    ...emptyAutomatchProfile(),
    aura: request.aura,
    emoji: request.emojiId,
    profileId: normalizeString(identity.profileId),
  };
  try {
    return (
      (await repository.getGameplayProfile(
        identity.uid,
        identity.idToken,
        signal,
      )) || fallbackProfile
    );
  } catch {
    logProfileFailure();
    return fallbackProfile;
  }
}

function matchedAutomatchResponse(inviteId: string): StartAutomatchResponse {
  return {
    ok: true,
    inviteId,
    mode: "matched",
    matchedImmediately: true,
  };
}

async function attemptAutomatch(
  identity: FirebaseIdentity,
  request: StartAutomatchRequest,
  profile: GameplayProfile,
  repository: GameplayRepository,
  random: RandomSource,
  signal: AbortSignal,
  retryCount: number,
  dependencies: AutomatchDependencies,
): Promise<StartAutomatchResponse> {
  if (signal.aborted) {
    throw new Error("automatch-operation-timeout");
  }
  if (retryCount > MAX_AUTOMATCH_RETRY_COUNT) {
    return { ok: false };
  }

  const queued = getFirstQueuedAutomatch(
    await repository.getRtdbPath(
      "automatch",
      {
        orderBy: "$key",
        limitToFirst: 1,
      },
      signal,
    ),
  );
  const hasProfile = profile.profileId !== "";
  const emojiId = hasProfile ? profile.emoji : request.emojiId;
  const aura = (hasProfile ? profile.aura : request.aura) || null;
  const name = getDisplayNameFromAddress(
    profile.username,
    profile.eth,
    profile.sol,
    profile.rating,
    emojiId,
  );

  if (!queued) {
    const inviteId = buildAutoInviteId(random);
    const password = randomAlphanumeric(AUTOMATCH_PASSWORD_LENGTH, random);
    const hostColor = pickHostColor(random);
    const matchSeed = gameVariantHelpers.buildRandomGameSeed(random);
    const timestamp = FIREBASE_RTDB_SERVER_TIMESTAMP;
    const match = buildFreshMatchRecord({
      color: hostColor,
      emojiId,
      aura,
      seed: matchSeed,
    });
    const waitingText = `${name} is looking for a match https://mons.link ${getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)}`;
    const canceledText = `<i>${name} canceled an automatch</i>`;
    const response: StartAutomatchResponse = {
      ok: true,
      inviteId,
      mode: "pending",
      matchedImmediately: false,
    };
    const profileGameProjectionTask = createAutomatchProfileGameProjectionTask(
      inviteId,
      dependencies,
    );
    const projectionTask = createAutomatchProjectionTask(
      inviteId,
      dependencies,
      profileGameProjectionTask.requestId,
    );
    await repository.patchRtdbRoot(
      {
        [`players/${identity.uid}/matches/${inviteId}`]: match,
        [`automatch/${inviteId}`]: {
          uid: identity.uid,
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
        [`invites/${inviteId}`]: {
          version: CONTROLLER_VERSION,
          hostId: identity.uid,
          hostColor,
          guestId: null,
          password,
          automatchStateHint: "pending",
          automatchCanceledAt: null,
          telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION,
        },
        [getAutomatchTelegramSourcePath(inviteId)]:
          buildPendingAutomatchTelegramSource({
            inviteId,
            waitingText,
            canceledText,
            timestamp,
          }),
        ...buildAutomatchTelegramProjectionOutboxUpdates({
          inviteId,
          requestId: projectionTask.requestId,
          timestamp,
        }),
        ...buildAutomatchProfileGameProjectionOutboxUpdates({
          inviteId,
          requestId: profileGameProjectionTask.requestId,
          timestamp,
        }),
      },
      signal,
    );
    await enqueueAutomatchProjection(projectionTask, dependencies);
    await enqueueAutomatchProfileGameProjection(
      profileGameProjectionTask,
      dependencies,
    );
    return response;
  }

  const existingUid = normalizeString(queued.data.uid);
  const existingProfileId = normalizeString(queued.data.profileId);
  const shouldMatch =
    existingUid !== identity.uid &&
    (profile.profileId === "" || profile.profileId !== existingProfileId);
  if (!shouldMatch) {
    const response: StartAutomatchResponse = {
      ok: true,
      inviteId: queued.inviteId,
      mode: "pending",
      matchedImmediately: false,
    };
    return response;
  }

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
    guestId: identity.uid,
    password: normalizeString(queued.data.password),
    automatchStateHint: "matched",
    automatchCanceledAt: null,
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
  const updates: Record<string, unknown> = {
    [`automatch/${queued.inviteId}`]: null,
    [`invites/${queued.inviteId}`]: invite,
    [`players/${identity.uid}/matches/${queued.inviteId}`]: match,
  };
  const matchedResponse = matchedAutomatchResponse(queued.inviteId);
  const profileGameProjectionTask = createAutomatchProfileGameProjectionTask(
    queued.inviteId,
    dependencies,
  );
  const projectionTask = usesTelegramDeliveryV2
    ? createAutomatchProjectionTask(
        queued.inviteId,
        dependencies,
        profileGameProjectionTask.requestId,
      )
    : null;
  Object.assign(
    updates,
    buildAutomatchProfileGameProjectionOutboxUpdates({
      inviteId: queued.inviteId,
      requestId: profileGameProjectionTask.requestId,
      timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
    }),
  );
  if (usesTelegramDeliveryV2) {
    Object.assign(
      updates,
      buildMatchedAutomatchTelegramUpdates({
        inviteId: queued.inviteId,
        matchedText,
        timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
        generation: firebaseRtdbIncrement(1),
      }),
    );
    Object.assign(
      updates,
      buildAutomatchTelegramProjectionOutboxUpdates({
        inviteId: queued.inviteId,
        requestId: projectionTask?.requestId || "",
        timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
      }),
    );
  }
  const readGuestId = async () =>
    normalizeString(
      await repository.getRtdbPath(
        `invites/${queued.inviteId}/guestId`,
        undefined,
        signal,
      ),
    );
  let committed = false;
  try {
    await repository.patchRtdbRoot(updates, signal);
    committed = true;
  } catch (patchFailure) {
    try {
      if ((await readGuestId()) === identity.uid) {
        committed = true;
      }
    } catch {}
    if (!committed) {
      throw patchFailure;
    }
  }
  if (projectionTask) {
    await enqueueAutomatchProjection(projectionTask, dependencies);
  }
  await enqueueAutomatchProfileGameProjection(
    profileGameProjectionTask,
    dependencies,
  );
  if ((await readGuestId()) === identity.uid) {
    return matchedResponse;
  }
  return attemptAutomatch(
    identity,
    request,
    profile,
    repository,
    random,
    signal,
    retryCount + 1,
    dependencies,
  );
}

export async function startAutomatch(
  identity: FirebaseIdentity,
  request: StartAutomatchRequest,
  repository: GameplayRepository,
  dependencies: AutomatchDependencies = {},
): Promise<StartAutomatchResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS);
  if (signal.aborted) {
    return { ok: false };
  }
  const profile = await readProfile(
    identity,
    request,
    repository,
    dependencies.logProfileFailure ||
      (() =>
        console.error(
          JSON.stringify({ event: "automatch_profile_read_failure" }),
        )),
    signal,
  );
  return attemptAutomatch(
    identity,
    request,
    profile,
    repository,
    dependencies.random || secureRandom,
    signal,
    0,
    dependencies,
  );
}

export type { AutomatchDependencies };
