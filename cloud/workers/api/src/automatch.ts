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
  buildAutomatchTelegramLifecycleUpdates,
  buildMatchedAutomatchTelegramUpdates,
  buildPendingAutomatchTelegramSource,
  getAutomatchTelegramSourcePath,
} from "../../../functions/telegram/automatchSource.js";
import {
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} from "../../../functions/telegramDisplay.js";
import { AuthApiFailure } from "./authErrors.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
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
import { withGameSessionMutationLease } from "./gameSessionMutations.ts";
import {
  getLoginProfileId,
  getOwnershipProfile,
  getProfileLoginUids,
  loginsShareProfile,
  profileOwnershipUnavailable,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

const MAX_AUTOMATCH_RETRY_COUNT = 3;
export const AUTOMATCH_TOTAL_TIMEOUT_MS = 20_000;
const AUTOMATCH_PASSWORD_LENGTH = 15;
const AUTOMATCH_WAITING_EMOJI_ID = "5355002036817525409";
const AUTOMATCH_OWNER_LOCK_MIN_RETRY_MS = 25;
const AUTOMATCH_OWNER_LOCK_MAX_RETRY_MS = 1_000;
const AUTOMATCH_LOGIN_UID_QUERY_CONCURRENCY = 10;
const AUTOMATCH_UID_LOOKUP_LIMIT = 2;
const AUTOMATCH_OWNER_LOGIN_UID_LIMIT = 512;
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
  now?: () => number;
  random?: RandomSource;
  signal?: AbortSignal;
  wait?: (milliseconds: number) => Promise<void>;
};

export type QueuedAutomatch = {
  data: Record<string, unknown>;
  inviteId: string;
};

export type AutomatchRequesterSnapshot = Readonly<{
  loginUids: readonly string[];
  profile: GameplayProfile | null;
}>;

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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareQueuedAutomatches(
  left: QueuedAutomatch,
  right: QueuedAutomatch,
): number {
  return (
    finiteNumber(right.data.timestamp) - finiteNumber(left.data.timestamp) ||
    compareStrings(left.inviteId, right.inviteId)
  );
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

function getQueuedAutomatchesForUid(
  value: unknown,
  expectedUid: string,
): QueuedAutomatch[] {
  const queue = toRecord(value);
  if (!queue) return [];
  return Object.entries(queue)
    .filter(([, data]) => normalizeString(toRecord(data)?.uid) === expectedUid)
    .sort(([left], [right]) => compareStrings(left, right))
    .slice(0, AUTOMATCH_UID_LOOKUP_LIMIT)
    .map(([inviteId, data]) => ({ inviteId, data: toRecord(data) || {} }));
}

async function readQueuedAutomatchesByUid(
  uid: string,
  repository: GameplayRepository,
  signal?: AbortSignal,
): Promise<QueuedAutomatch[]> {
  return getQueuedAutomatchesForUid(
    await repository.getRtdbPath(
      "automatch",
      {
        orderBy: "uid",
        equalTo: uid,
        limitToFirst: AUTOMATCH_UID_LOOKUP_LIMIT,
      },
      signal,
    ),
    uid,
  );
}

export async function findOwnedQueuedAutomatches(
  loginUids: readonly string[],
  repository: GameplayRepository,
  signal?: AbortSignal,
): Promise<QueuedAutomatch[]> {
  const uniqueLoginUids = Array.from(new Set(loginUids));
  const allCandidates: QueuedAutomatch[] = [];
  for (
    let offset = 0;
    offset < uniqueLoginUids.length;
    offset += AUTOMATCH_LOGIN_UID_QUERY_CONCURRENCY
  ) {
    signal?.throwIfAborted();
    const batchCandidates = await Promise.all(
      uniqueLoginUids
        .slice(offset, offset + AUTOMATCH_LOGIN_UID_QUERY_CONCURRENCY)
        .map((loginUid) =>
          readQueuedAutomatchesByUid(loginUid, repository, signal),
        ),
    );
    allCandidates.push(...batchCandidates.flat());
  }
  signal?.throwIfAborted();
  return allCandidates.sort(compareQueuedAutomatches);
}

export async function findOwnedQueuedAutomatch(
  loginUids: readonly string[],
  repository: GameplayRepository,
  signal?: AbortSignal,
): Promise<QueuedAutomatch | null> {
  return (
    (await findOwnedQueuedAutomatches(loginUids, repository, signal))[0] || null
  );
}

export async function readAutomatchRequesterSnapshot(
  uid: string,
  repository: GameplayRepository,
  logFailure: () => void = () => undefined,
): Promise<AutomatchRequesterSnapshot> {
  let ownership: ProfileOwnershipSnapshot;
  try {
    ownership = await requireProfileOwnershipSnapshot(repository, {
      loginUids: [uid],
      profileIds: [],
    });
  } catch (error) {
    logFailure();
    throw error;
  }
  const profileId = getLoginProfileId(ownership, uid);
  if (!profileId) {
    return Object.freeze({ loginUids: Object.freeze([uid]), profile: null });
  }
  const loginUids = [...getProfileLoginUids(ownership, profileId)].sort(
    compareStrings,
  );
  if (loginUids.length > AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
    logFailure();
    throw profileOwnershipUnavailable();
  }
  return Object.freeze({
    loginUids: Object.freeze(loginUids),
    profile: getOwnershipProfile(ownership, profileId)?.profile || null,
  });
}

async function automatchOwnerLockId(owner: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(owner),
  );
  return `automatch-owner-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
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

function automatchTimestamp(value: unknown): number {
  return Math.floor(finiteNumber(value));
}

function automatchTelegramDeliveryVersion(value: unknown): number | null {
  return value === TELEGRAM_AUTOMATCH_VERSION
    ? TELEGRAM_AUTOMATCH_VERSION
    : null;
}

export async function cancelQueuedAutomatch(
  queued: QueuedAutomatch,
  repository: GameplayRepository,
  dependencies: AutomatchDependencies = {},
  signal: AbortSignal = dependencies.signal ||
    AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS),
): Promise<boolean> {
  const expectedUid = normalizeString(queued.data.uid);
  if (!expectedUid) return false;
  const expectedTimestamp = automatchTimestamp(queued.data.timestamp);
  const expectedTelegramDeliveryVersion = automatchTelegramDeliveryVersion(
    queued.data.telegramDeliveryVersion,
  );
  const profileGameProjectionTask = createAutomatchProfileGameProjectionTask(
    queued.inviteId,
    dependencies,
  );
  const projectionTask = expectedTelegramDeliveryVersion
    ? createAutomatchProjectionTask(
        queued.inviteId,
        dependencies,
        profileGameProjectionTask.requestId,
      )
    : null;
  let patchAttempted = false;
  let canceled = false;
  try {
    canceled = await withGameSessionMutationLease(
      queued.inviteId,
      profileGameProjectionTask.requestId,
      repository,
      async () => {
        const [currentQueueValue, currentGuestId, currentHostId] =
          await Promise.all([
            repository.getRtdbPath(
              `automatch/${queued.inviteId}`,
              undefined,
              signal,
            ),
            repository.getRtdbPath(
              `invites/${queued.inviteId}/guestId`,
              undefined,
              signal,
            ),
            repository.getRtdbPath(
              `invites/${queued.inviteId}/hostId`,
              undefined,
              signal,
            ),
          ]);
        const currentQueue = toRecord(currentQueueValue);
        const currentUid = normalizeString(currentQueue?.uid);
        if (
          !currentQueue ||
          currentUid !== expectedUid ||
          automatchTimestamp(currentQueue.timestamp) !== expectedTimestamp ||
          automatchTelegramDeliveryVersion(
            currentQueue.telegramDeliveryVersion,
          ) !== expectedTelegramDeliveryVersion ||
          normalizeString(currentGuestId) ||
          normalizeString(currentHostId) !== currentUid
        ) {
          return false;
        }
        const updates: Record<string, unknown> = {
          [`automatch/${queued.inviteId}`]: null,
          [`invites/${queued.inviteId}/automatchStateHint`]: "canceled",
          [`invites/${queued.inviteId}/automatchCanceledAt`]:
            FIREBASE_RTDB_SERVER_TIMESTAMP,
          ...buildAutomatchProfileGameProjectionOutboxUpdates({
            inviteId: queued.inviteId,
            requestId: profileGameProjectionTask.requestId,
            timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
          }),
        };
        if (expectedTelegramDeliveryVersion) {
          Object.assign(
            updates,
            buildAutomatchTelegramLifecycleUpdates({
              inviteId: queued.inviteId,
              lifecycle: "canceled",
              timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
              generation: firebaseRtdbIncrement(1),
            }),
            buildAutomatchTelegramProjectionOutboxUpdates({
              inviteId: queued.inviteId,
              requestId: projectionTask?.requestId || "",
              timestamp: FIREBASE_RTDB_SERVER_TIMESTAMP,
            }),
          );
        }
        patchAttempted = true;
        await repository.patchRtdbRoot(updates, signal);
        return true;
      },
      {},
    );
  } catch (error) {
    if (!patchAttempted) throw error;
    const current = await repository
      .getRtdbPath(`automatch/${queued.inviteId}`, undefined, signal)
      .catch(() => undefined);
    if (current !== null) throw error;
    canceled = true;
  }
  if (!canceled) return false;
  if (projectionTask) {
    await enqueueAutomatchProjection(projectionTask, dependencies);
  }
  await enqueueAutomatchProfileGameProjection(
    profileGameProjectionTask,
    dependencies,
  );
  return true;
}

async function convergeOwnedQueuedAutomatches(
  loginUids: readonly string[],
  repository: GameplayRepository,
  signal: AbortSignal,
  dependencies: AutomatchDependencies,
): Promise<QueuedAutomatch | null> {
  let cancellationAttempts = 0;
  while (true) {
    signal.throwIfAborted();
    const queued = await findOwnedQueuedAutomatches(
      loginUids,
      repository,
      signal,
    );
    const survivor = queued[0] || null;
    if (queued.length <= 1) return survivor;
    for (const candidate of queued) {
      if (candidate.inviteId === survivor?.inviteId) continue;
      if (cancellationAttempts >= AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
        throw profileOwnershipUnavailable();
      }
      cancellationAttempts += 1;
      signal.throwIfAborted();
      await cancelQueuedAutomatch(candidate, repository, dependencies, signal);
    }
  }
}

async function withAutomatchOwnerLease<T>(
  requester: AutomatchRequesterSnapshot,
  uid: string,
  repository: GameplayRepository,
  signal: AbortSignal,
  dependencies: AutomatchDependencies,
  work: () => Promise<T>,
): Promise<T> {
  const lockId = await automatchOwnerLockId(
    requester.profile ? `profile:${requester.profile.profileId}` : `uid:${uid}`,
  );
  const wait =
    dependencies.wait ||
    ((milliseconds: number) => scheduler.wait(milliseconds, { signal }));
  const now = dependencies.now || Date.now;
  const lockDeadlineMs = now() + AUTOMATCH_TOTAL_TIMEOUT_MS;
  let contentionAttempts = 0;
  while (true) {
    try {
      return await withGameSessionMutationLease(
        lockId,
        crypto.randomUUID(),
        repository,
        work,
        { now },
      );
    } catch (error) {
      const retryDelayMs = Math.min(
        AUTOMATCH_OWNER_LOCK_MAX_RETRY_MS,
        AUTOMATCH_OWNER_LOCK_MIN_RETRY_MS * 2 ** contentionAttempts,
      );
      if (
        !(error instanceof AuthApiFailure) ||
        error.status !== 409 ||
        error.message !== "invite-busy" ||
        signal.aborted ||
        now() + retryDelayMs >= lockDeadlineMs
      ) {
        throw error;
      }
      contentionAttempts += 1;
      await wait(
        retryDelayMs + Math.floor(retryDelayMs * 0.25 * secureRandom()),
      );
    }
  }
}

export async function cancelOwnedQueuedAutomatches(
  uid: string,
  repository: GameplayRepository,
  dependencies: AutomatchDependencies = {},
): Promise<boolean> {
  const signal =
    dependencies.signal || AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS);
  const directQueues = await readQueuedAutomatchesByUid(
    uid,
    repository,
    signal,
  );
  let requester: AutomatchRequesterSnapshot;
  try {
    requester = await readAutomatchRequesterSnapshot(uid, repository);
  } catch (error) {
    if (directQueues.length === 0) throw error;
    requester = Object.freeze({
      loginUids: Object.freeze([uid]),
      profile: null,
    });
  }
  return withAutomatchOwnerLease(
    requester,
    uid,
    repository,
    signal,
    dependencies,
    async () => {
      let canceledAny = false;
      let attempts = 0;
      let previousBlockedSignature = "";
      while (true) {
        const queued = await findOwnedQueuedAutomatches(
          requester.loginUids,
          repository,
          signal,
        );
        if (queued.length === 0) return canceledAny;
        let madeProgress = false;
        for (const candidate of queued) {
          if (attempts >= AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
            throw profileOwnershipUnavailable();
          }
          attempts += 1;
          if (
            await cancelQueuedAutomatch(
              candidate,
              repository,
              dependencies,
              signal,
            )
          ) {
            canceledAny = true;
            madeProgress = true;
          }
        }
        if (madeProgress) {
          previousBlockedSignature = "";
          continue;
        }
        const blockedSignature = JSON.stringify(
          queued.map((candidate) => [
            candidate.inviteId,
            normalizeString(candidate.data.uid),
            automatchTimestamp(candidate.data.timestamp),
            automatchTelegramDeliveryVersion(
              candidate.data.telegramDeliveryVersion,
            ),
          ]),
        );
        if (blockedSignature === previousBlockedSignature) return canceledAny;
        previousBlockedSignature = blockedSignature;
      }
    },
  );
}

function profileOrFallback(
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

function matchedAutomatchResponse(inviteId: string): StartAutomatchResponse {
  return {
    ok: true,
    inviteId,
    mode: "matched",
    matchedImmediately: true,
  };
}

function pendingAutomatchResponse(inviteId: string): StartAutomatchResponse {
  return {
    ok: true,
    inviteId,
    mode: "pending",
    matchedImmediately: false,
  };
}

async function attemptAutomatch(
  identity: RequestIdentity,
  request: StartAutomatchRequest,
  requester: AutomatchRequesterSnapshot,
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
  let profile = profileOrFallback(requester.profile, request);
  const existingUid = queued ? normalizeString(queued.data.uid) : "";
  if (queued && existingUid !== identity.uid) {
    const pairOwnership = await requireProfileOwnershipSnapshot(repository, {
      loginUids: [identity.uid, existingUid],
      profileIds: [],
    });
    const existingProfileId = getLoginProfileId(pairOwnership, existingUid);
    const existingLoginUids = existingProfileId
      ? getProfileLoginUids(pairOwnership, existingProfileId)
      : [existingUid];
    if (existingLoginUids.length > AUTOMATCH_OWNER_LOGIN_UID_LIMIT) {
      throw profileOwnershipUnavailable();
    }
    const existingSurvivor = await convergeOwnedQueuedAutomatches(
      existingLoginUids,
      repository,
      signal,
      dependencies,
    );
    if (!existingSurvivor) {
      return attemptAutomatch(
        identity,
        request,
        requester,
        repository,
        random,
        signal,
        retryCount + 1,
        dependencies,
      );
    }
    if (loginsShareProfile(pairOwnership, identity.uid, existingUid)) {
      return pendingAutomatchResponse(existingSurvivor.inviteId);
    }
    if (existingSurvivor.inviteId !== queued.inviteId) {
      return attemptAutomatch(
        identity,
        request,
        requester,
        repository,
        random,
        signal,
        retryCount + 1,
        dependencies,
      );
    }
    const profileId = getLoginProfileId(pairOwnership, identity.uid);
    profile = profileOrFallback(
      profileId
        ? getOwnershipProfile(pairOwnership, profileId)?.profile || null
        : null,
      request,
    );
  }
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
    await withGameSessionMutationLease(
      inviteId,
      profileGameProjectionTask.requestId,
      repository,
      async () => {
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
      },
      {},
    );
    await enqueueAutomatchProjection(projectionTask, dependencies);
    await enqueueAutomatchProfileGameProjection(
      profileGameProjectionTask,
      dependencies,
    );
    return response;
  }

  const pendingResponse = pendingAutomatchResponse(queued.inviteId);
  if (existingUid === identity.uid) {
    return pendingResponse;
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
  let matchResult: "matched" | "stale" = "stale";
  let patchAttempted = false;
  try {
    matchResult = await withGameSessionMutationLease(
      queued.inviteId,
      profileGameProjectionTask.requestId,
      repository,
      async () => {
        const [currentQueueValue, currentGuestId] = await Promise.all([
          repository.getRtdbPath(
            `automatch/${queued.inviteId}`,
            undefined,
            signal,
          ),
          readGuestId(),
        ]);
        if (
          normalizeString(toRecord(currentQueueValue)?.uid) !== existingUid ||
          currentGuestId
        ) {
          return "stale" as const;
        }
        patchAttempted = true;
        await repository.patchRtdbRoot(updates, signal);
        return "matched" as const;
      },
      {},
    );
  } catch (patchFailure) {
    if (!patchAttempted) {
      throw patchFailure;
    }
    try {
      if ((await readGuestId()) === identity.uid) {
        matchResult = "matched";
      }
    } catch {}
    if (matchResult !== "matched") {
      throw patchFailure;
    }
  }
  if (matchResult === "stale") {
    return attemptAutomatch(
      identity,
      request,
      requester,
      repository,
      random,
      signal,
      retryCount + 1,
      dependencies,
    );
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
    requester,
    repository,
    random,
    signal,
    retryCount + 1,
    dependencies,
  );
}

export async function startAutomatch(
  identity: RequestIdentity,
  request: StartAutomatchRequest,
  repository: GameplayRepository,
  dependencies: AutomatchDependencies = {},
): Promise<StartAutomatchResponse> {
  const signal =
    dependencies.signal || AbortSignal.timeout(AUTOMATCH_TOTAL_TIMEOUT_MS);
  if (signal.aborted) {
    return { ok: false };
  }
  const directQueue = await findOwnedQueuedAutomatch(
    [identity.uid],
    repository,
    signal,
  );
  let requester: AutomatchRequesterSnapshot;
  try {
    requester = await readAutomatchRequesterSnapshot(
      identity.uid,
      repository,
      directQueue
        ? () => undefined
        : dependencies.logProfileFailure ||
            (() =>
              console.error(
                JSON.stringify({ event: "automatch_profile_read_failure" }),
              )),
    );
  } catch (error) {
    if (directQueue && normalizeString(directQueue.data.uid) === identity.uid) {
      return pendingAutomatchResponse(directQueue.inviteId);
    }
    throw error;
  }
  return withAutomatchOwnerLease(
    requester,
    identity.uid,
    repository,
    signal,
    dependencies,
    async () => {
      const ownedSurvivor = await convergeOwnedQueuedAutomatches(
        requester.loginUids,
        repository,
        signal,
        dependencies,
      );
      if (ownedSurvivor) {
        return pendingAutomatchResponse(ownedSurvivor.inviteId);
      }
      return attemptAutomatch(
        identity,
        request,
        requester,
        repository,
        dependencies.random || secureRandom,
        signal,
        0,
        dependencies,
      );
    },
  );
}

export type { AutomatchDependencies };
