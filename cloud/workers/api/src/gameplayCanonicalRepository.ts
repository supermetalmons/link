import {
  MATERIAL_KEYS,
  normalizeMaterials,
  normalizeMiningSnapshot,
  type MiningMaterialName,
} from "@mons/shared/mining";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
  parseCanonicalRatingUpdateRow,
  readCanonicalRatingUpdate,
  readStableCanonicalProfileAggregate,
  readStableCanonicalProfileAggregateByLogin,
  readCanonicalWagerSettlement,
  resolveCanonicalProfile,
  CanonicalProfileConflict,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileAggregateSnapshot,
  type CanonicalProfileSnapshot,
  type CanonicalProfileValue,
  type CanonicalExpectation,
  type CanonicalMutation,
  type CanonicalRatingUpdateSnapshot,
  type CanonicalRatingUpdateValue,
  type CanonicalSortKey,
  type CanonicalWagerSettlement,
} from "./profileCanonicalD1.ts";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";
import {
  deleteD1NavigationGame,
  getD1NavigationGame,
} from "./profileGamesD1.ts";
import type {
  GameplayProfile,
  GameplayRepository,
  PendingRatingEventProgress,
  PendingRatingProfileGameProjection,
  PendingRatingTelegramProjection,
  RatingCommitPlan,
  RatingEventProgressRepository,
  RatingFinalizeInput,
  RatingFinalizeResult,
  RatingLeaseInput,
  RatingLeaseResult,
  RatingProfile,
  RatingProfileGameProjectionRepository,
  RatingProjectionRepository,
  RatingUpdateData,
  WagerTransferInput,
  WagerTransferResult,
} from "./gameplayRepository.ts";

type CanonicalRepositoryOptions = {
  createFailure(): Error;
  maxAttempts: number;
  now(): number;
};

type CanonicalRatingRepository = RatingProjectionRepository &
  RatingEventProgressRepository &
  RatingProfileGameProjectionRepository;

type RatingRow = Parameters<typeof parseCanonicalRatingUpdateRow>[0];

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableProfileId(value: unknown): string | null {
  return string(value) || null;
}

function projectionState(value: unknown): "dead" | "done" | "pending" | null {
  return value === "dead" || value === "done" || value === "pending"
    ? value
    : null;
}

function projectionVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function retryCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 5;
}

function canonicalProfileFields(
  snapshot: CanonicalProfileSnapshot,
): Record<string, unknown> {
  const profile = snapshot.profile;
  const custom = {
    ...(snapshot.emojiPresent ? { emoji: profile.emoji } : {}),
    ...(profile.aura === undefined ? {} : { aura: profile.aura }),
    ...(profile.cardBackgroundId === undefined
      ? {}
      : { cardBackgroundId: profile.cardBackgroundId }),
    ...(profile.cardStickers === undefined
      ? {}
      : { cardStickers: profile.cardStickers }),
    ...(profile.cardSubtitleId === undefined
      ? {}
      : { cardSubtitleId: profile.cardSubtitleId }),
    ...(profile.profileCounter === undefined
      ? {}
      : { profileCounter: profile.profileCounter }),
    ...(profile.profileMons === undefined
      ? {}
      : { profileMons: profile.profileMons }),
    ...(profile.completedProblemIds === undefined
      ? {}
      : { completedProblems: profile.completedProblemIds }),
    ...(profile.isTutorialCompleted === undefined
      ? {}
      : { tutorialCompleted: profile.isTutorialCompleted }),
  };
  return {
    custom,
    eth: profile.eth || "",
    feb2026UniqueOpponentsCount: profile.feb2026UniqueOpponentsCount || 0,
    mining: profile.mining,
    sol: profile.sol || "",
    username: profile.username || "",
    ...(snapshot.sortPresence.nonce
      ? { nonce: snapshot.sortValues.nonce }
      : {}),
    ...(snapshot.sortPresence.rating
      ? { rating: snapshot.sortValues.rating }
      : {}),
    ...(snapshot.sortPresence.mp
      ? { totalManaPoints: snapshot.sortValues.mp }
      : {}),
    ...(snapshot.winPresent ? { win: profile.win } : {}),
    ...(!snapshot.emojiPresent && snapshot.gameplayEmoji !== ""
      ? { emoji: snapshot.gameplayEmoji }
      : {}),
    ...(snapshot.mergedIntoProfileId
      ? { mergedIntoProfileId: snapshot.mergedIntoProfileId }
      : {}),
  };
}

export { canonicalProfileFields };

function gameplayProfile(snapshot: CanonicalProfileSnapshot): GameplayProfile {
  const profile = snapshot.profile;
  return {
    aura: profile.aura || "",
    emoji: snapshot.gameplayEmoji,
    eth: profile.eth || "",
    profileId: profile.id,
    rating:
      snapshot.sortPresence.rating && snapshot.sortValues.rating !== null
        ? snapshot.sortValues.rating
        : 1500,
    sol: profile.sol || "",
    username: profile.username || "",
  };
}

type StableLoginAggregate = {
  aggregate: CanonicalProfileAggregateSnapshot | null;
  owner: CanonicalLoginOwnerSnapshot | null;
};

async function aggregateByLogin(
  db: D1Database,
  loginUid: string,
  maxAttempts = 5,
): Promise<StableLoginAggregate> {
  const resolved = await readStableCanonicalProfileAggregateByLogin(
    db,
    loginUid,
    Math.min(8, Math.max(2, maxAttempts)),
  );
  return resolved || { aggregate: null, owner: null };
}

function ratingProfileFromAggregate(
  aggregate: CanonicalProfileAggregateSnapshot | null,
): RatingProfile | null {
  const snapshot = aggregate?.profile;
  if (!snapshot) return null;
  const profile = snapshot.profile;
  return {
    aura: profile.aura || "",
    emoji: snapshot.gameplayEmoji,
    eth: profile.eth || "",
    feb2026UniqueOpponents: aggregate.februaryOpponentProfileIds,
    nonce: snapshot.sortPresence.nonce ? (snapshot.sortValues.nonce ?? 0) : -1,
    profileId: profile.id,
    rating:
      snapshot.sortPresence.rating && snapshot.sortValues.rating !== null
        ? snapshot.sortValues.rating
        : 1500,
    sol: profile.sol || "",
    totalManaPoints: profile.totalManaPoints,
    username: profile.username || "",
  };
}

async function ratingProfileByLogin(
  db: D1Database,
  loginUid: string,
  maxAttempts = 5,
): Promise<RatingProfile | null> {
  return ratingProfileFromAggregate(
    (await aggregateByLogin(db, loginUid, maxAttempts)).aggregate,
  );
}

function profileValueFromSnapshot(
  snapshot: CanonicalProfileSnapshot,
  profile: CanonicalProfileSnapshot["profile"],
  updatedAtMs: number,
  sortUpdates: Partial<Record<CanonicalSortKey, number>> = {},
  winPresent = snapshot.winPresent,
): CanonicalProfileValue {
  return materializeCanonicalProfile({
    profile,
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs: Math.max(snapshot.updatedAtMs, updatedAtMs),
    legacyFields: snapshot.legacyFields,
    mergedAtMs: snapshot.mergedAtMs,
    mergedIntoProfileId: snapshot.mergedIntoProfileId,
    state: snapshot.state,
    sortPresence: {
      ...snapshot.sortPresence,
      ...Object.fromEntries(Object.keys(sortUpdates).map((key) => [key, true])),
    },
    sortValues: { ...snapshot.sortValues, ...sortUpdates },
    winPresent,
    emojiPresent: snapshot.emojiPresent,
    gameplayEmoji: snapshot.gameplayEmoji,
  });
}

function patchCanonicalProfile(
  snapshot: CanonicalProfileSnapshot,
  patch: Record<string, unknown>,
  updatedAtMs: number,
  miningSortKeys: readonly MiningMaterialName[] = MATERIAL_KEYS,
): CanonicalProfileValue {
  const profile = { ...snapshot.profile };
  const sortUpdates: Partial<Record<CanonicalSortKey, number>> = {};
  if (typeof patch.rating === "number" && Number.isFinite(patch.rating)) {
    profile.rating = patch.rating;
    sortUpdates.rating = patch.rating;
  }
  if (typeof patch.nonce === "number" && Number.isFinite(patch.nonce)) {
    profile.nonce = patch.nonce;
    sortUpdates.nonce = patch.nonce;
  }
  if (
    typeof patch.totalManaPoints === "number" &&
    Number.isFinite(patch.totalManaPoints)
  ) {
    profile.totalManaPoints = patch.totalManaPoints;
    sortUpdates.mp = patch.totalManaPoints;
  }
  let winPresent = snapshot.winPresent;
  if (typeof patch.win === "boolean") {
    profile.win = patch.win;
    winPresent = true;
  }
  if (
    typeof patch.feb2026UniqueOpponentsCount === "number" &&
    Number.isFinite(patch.feb2026UniqueOpponentsCount)
  ) {
    profile.feb2026UniqueOpponentsCount = patch.feb2026UniqueOpponentsCount;
  }
  if (patch.mining !== undefined) {
    profile.mining = normalizeMiningSnapshot(patch.mining);
    for (const material of miningSortKeys) {
      sortUpdates[material] = profile.mining.materials[material];
    }
  }
  return profileValueFromSnapshot(
    snapshot,
    profile,
    updatedAtMs,
    sortUpdates,
    winPresent,
  );
}

function ratingData(snapshot: CanonicalRatingUpdateSnapshot): RatingUpdateData {
  const fields = snapshot.payload;
  return {
    completedAtMs: number(fields.completedAtMs),
    eventId: string(fields.eventId),
    eventOwned: fields.eventOwned === true,
    eventProgressReason: string(fields.eventProgressReason),
    eventProgressState: string(fields.eventProgressState),
    eventProgressUpdatedAtMs: number(fields.eventProgressUpdatedAtMs),
    eventProgressVersion: number(fields.eventProgressVersion),
    inviteId: string(fields.inviteId) || snapshot.inviteId,
    isEventMatch: fields.isEventMatch === true,
    leaseExpiresAtMs: snapshot.leaseExpiresAtMs,
    matchId: string(fields.matchId) || snapshot.matchId,
    opponentId: string(fields.opponentId) || snapshot.opponentId,
    opponentProfileId:
      string(fields.opponentProfileId) || snapshot.opponentProfileId || "",
    ownerToken: string(fields.ownerToken) || snapshot.ownerToken,
    playerId: string(fields.playerId) || snapshot.playerId,
    playerProfileId:
      string(fields.playerProfileId) || snapshot.playerProfileId || "",
    profileGameProjectionReason: string(fields.profileGameProjectionReason),
    profileGameProjectionState:
      string(fields.profileGameProjectionState) ||
      snapshot.profileGameProjectionState ||
      "",
    profileGameProjectionUpdatedAtMs:
      snapshot.profileGameProjectionUpdatedAtMs || 0,
    profileGameProjectionVersion: snapshot.profileGameProjectionVersion || 0,
    shouldUpdateFebruaryChallenge:
      fields.shouldUpdateFebruaryChallenge === true,
    startedAtMs: snapshot.startedAtMs,
    status: snapshot.status,
    telegramDeliveryVersion:
      number(fields.telegramDeliveryVersion) > 0
        ? number(fields.telegramDeliveryVersion)
        : null,
    telegramProjectionReason: string(fields.telegramProjectionReason),
    telegramProjectionState:
      string(fields.telegramProjectionState) ||
      snapshot.telegramProjectionState ||
      "",
    telegramProjectionUpdatedAtMs: snapshot.telegramProjectionUpdatedAtMs || 0,
    telegramProjectionVersion: snapshot.telegramProjectionVersion || 0,
    updateRatingMessage: string(fields.updateRatingMessage),
  };
}

function sameRatingOperation(
  data: RatingUpdateData | null,
  input: Pick<
    RatingLeaseInput,
    "inviteId" | "matchId" | "opponentId" | "playerId"
  >,
): data is RatingUpdateData {
  return (
    data !== null &&
    data.inviteId === input.inviteId &&
    data.matchId === input.matchId &&
    data.playerId === input.playerId &&
    data.opponentId === input.opponentId
  );
}

function ratingValue(
  operationId: string,
  fields: Record<string, unknown>,
): CanonicalRatingUpdateValue {
  const status = fields.status === "done" ? "done" : "processing";
  const startedAtMs = number(fields.startedAtMs);
  const completedAtMs =
    status === "done" ? nullableNumber(fields.completedAtMs) : null;
  if (status === "done" && completedAtMs === null) {
    throw new TypeError("invalid-canonical-rating-completion");
  }
  return {
    operationId,
    payload: fields,
    status,
    inviteId: string(fields.inviteId),
    matchId: string(fields.matchId),
    playerId: string(fields.playerId),
    opponentId: string(fields.opponentId),
    playerProfileId: nullableProfileId(fields.playerProfileId),
    opponentProfileId: nullableProfileId(fields.opponentProfileId),
    ownerUid: string(fields.ownerUid),
    ownerToken: string(fields.ownerToken),
    startedAtMs,
    updatedAtMs: number(fields.updatedAtMs),
    leaseExpiresAtMs: number(fields.leaseExpiresAtMs),
    completedAtMs,
    telegramProjectionState: projectionState(fields.telegramProjectionState),
    telegramProjectionUpdatedAtMs: nullableNumber(
      fields.telegramProjectionUpdatedAtMs,
    ),
    telegramProjectionVersion: projectionVersion(
      fields.telegramProjectionVersion,
    ),
    profileGameProjectionState: projectionState(
      fields.profileGameProjectionState,
    ),
    profileGameProjectionUpdatedAtMs: nullableNumber(
      fields.profileGameProjectionUpdatedAtMs,
    ),
    profileGameProjectionVersion: projectionVersion(
      fields.profileGameProjectionVersion,
    ),
    eventProgressState: projectionState(fields.eventProgressState),
    eventProgressUpdatedAtMs: nullableNumber(fields.eventProgressUpdatedAtMs),
    eventProgressVersion: projectionVersion(fields.eventProgressVersion),
  };
}

function mergedRatingValue(
  snapshot: CanonicalRatingUpdateSnapshot,
  patch: Record<string, unknown>,
): CanonicalRatingUpdateValue {
  return ratingValue(snapshot.operationId, {
    ...snapshot.payload,
    updatedAtMs: snapshot.updatedAtMs,
    ...patch,
  });
}

function mapFailure(error: unknown, createFailure: () => Error): never {
  throw error instanceof CanonicalProfileConflict ? createFailure() : error;
}

function replayWagerSettlement(
  settlement: CanonicalWagerSettlement,
  fingerprint: string,
): WagerTransferResult {
  if (settlement.fingerprint !== fingerprint) {
    throw new CanonicalProfileConflict();
  }
  return settlement.outcome === "insufficient-materials"
    ? "insufficient-materials"
    : "replayed";
}

export function createCanonicalGameplayRepository(
  db: D1Database,
  profileGamesDb: D1Database,
  rtdb: FirebaseRtdbClient,
  options: CanonicalRepositoryOptions,
): GameplayRepository {
  const attempts = retryCount(options.maxAttempts);
  return {
    async applyWagerTransferOnce(input: WagerTransferInput) {
      if (
        !input.operationId ||
        !input.fingerprint ||
        !input.winnerProfileId ||
        !input.loserProfileId ||
        !(MATERIAL_KEYS as readonly string[]).includes(input.material) ||
        !Number.isSafeInteger(input.count) ||
        input.count <= 0 ||
        !Number.isSafeInteger(input.appliedAtMs) ||
        input.appliedAtMs < 0
      ) {
        throw options.createFailure();
      }
      try {
        const existing = await readCanonicalWagerSettlement(
          db,
          input.operationId,
        );
        if (existing) {
          return replayWagerSettlement(existing, input.fingerprint);
        }
      } catch {
        throw options.createFailure();
      }
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const [winner, loser] = await Promise.all([
            resolveCanonicalProfile(db, input.winnerProfileId),
            resolveCanonicalProfile(db, input.loserProfileId),
          ]);
          if (!winner || !loser) throw options.createFailure();
          const mutations: CanonicalMutation[] = [];
          const expectations: CanonicalExpectation[] = [
            { kind: "wager-settlement-absent", operationId: input.operationId },
          ];
          let outcome: "applied" | "insufficient-materials" = "applied";
          if (winner.profileId !== loser.profileId) {
            const material = input.material;
            const winnerMaterials = normalizeMaterials(
              winner.profile.mining.materials,
            );
            const loserMaterials = normalizeMaterials(
              loser.profile.mining.materials,
            );
            if (loserMaterials[material] < input.count) {
              outcome = "insufficient-materials";
              expectations.push({
                kind: "profile-revision",
                profileId: loser.profileId,
                revision: loser.revision,
              });
            } else {
              const nextWinnerMaterials = {
                ...winnerMaterials,
                [material]: winnerMaterials[material] + input.count,
              };
              const nextLoserMaterials = {
                ...loserMaterials,
                [material]: loserMaterials[material] - input.count,
              };
              expectations.push(
                {
                  kind: "profile-revision",
                  profileId: winner.profileId,
                  revision: winner.revision,
                },
                {
                  kind: "profile-revision",
                  profileId: loser.profileId,
                  revision: loser.revision,
                },
              );
              mutations.push(
                {
                  kind: "update-active-profile",
                  value: patchCanonicalProfile(
                    winner,
                    {
                      mining: {
                        ...winner.profile.mining,
                        materials: nextWinnerMaterials,
                      },
                    },
                    input.appliedAtMs,
                    [material],
                  ),
                },
                {
                  kind: "update-active-profile",
                  value: patchCanonicalProfile(
                    loser,
                    {
                      mining: {
                        ...loser.profile.mining,
                        materials: nextLoserMaterials,
                      },
                    },
                    input.appliedAtMs,
                    [material],
                  ),
                },
              );
            }
          }
          mutations.push({
            kind: "insert-wager-settlement",
            value: {
              operationId: input.operationId,
              fingerprint: input.fingerprint,
              winnerProfileId: winner.profileId,
              loserProfileId: loser.profileId,
              material: input.material,
              count: input.count,
              appliedAtMs: input.appliedAtMs,
              outcome,
              revision: 1,
            },
          });
          await commitCanonicalPlan(db, { expectations, mutations });
          return outcome;
        } catch (error) {
          try {
            const existing = await readCanonicalWagerSettlement(
              db,
              input.operationId,
            );
            if (existing) {
              return replayWagerSettlement(existing, input.fingerprint);
            }
          } catch {
            throw options.createFailure();
          }
          if (!(error instanceof CanonicalProfileConflict)) {
            throw options.createFailure();
          }
        }
      }
      throw options.createFailure();
    },

    async findProfileId(uid) {
      try {
        return (
          (await aggregateByLogin(db, uid, attempts)).aggregate?.profile
            ?.profileId || null
        );
      } catch {
        throw options.createFailure();
      }
    },

    async getGameplayProfile(uid) {
      try {
        const aggregate = (await aggregateByLogin(db, uid, attempts)).aggregate;
        return aggregate?.profile ? gameplayProfile(aggregate.profile) : null;
      } catch {
        throw options.createFailure();
      }
    },

    async getMiningMaterials(profileId) {
      try {
        const snapshot = await resolveCanonicalProfile(db, profileId);
        return normalizeMaterials(snapshot?.profile.mining.materials);
      } catch {
        throw options.createFailure();
      }
    },

    async getMiningSnapshot(profileId) {
      try {
        return (
          (await resolveCanonicalProfile(db, profileId))?.profile.mining || null
        );
      } catch {
        throw options.createFailure();
      }
    },

    getRtdbPath: rtdb.getPath,
    patchRtdbRoot: rtdb.patchRoot,
    transactRtdbPath: rtdb.transactPath,

    async getNavigationGame(profileId, inviteId) {
      return getD1NavigationGame(profileGamesDb, profileId, inviteId);
    },

    async deleteNavigationGame(profileId, inviteId) {
      return deleteD1NavigationGame(profileGamesDb, profileId, inviteId);
    },
  };
}

function parseRevision(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

async function claimProjection(
  db: D1Database,
  operationId: string,
  updateTime: string,
  claimedAtMs: number,
  field:
    | "eventProgressUpdatedAtMs"
    | "profileGameProjectionUpdatedAtMs"
    | "telegramProjectionUpdatedAtMs",
): Promise<boolean> {
  const revision = parseRevision(updateTime);
  if (!revision) return false;
  const snapshot = await readCanonicalRatingUpdate(db, operationId);
  if (!snapshot || snapshot.revision !== revision) return false;
  try {
    await commitCanonicalPlan(db, {
      expectations: [{ kind: "rating-update-revision", operationId, revision }],
      mutations: [
        {
          kind: "update-rating-update",
          value: mergedRatingValue(snapshot, { [field]: claimedAtMs }),
        },
      ],
    });
    return true;
  } catch (error) {
    if (error instanceof CanonicalProfileConflict) return false;
    throw error;
  }
}

async function listDueRatings(
  db: D1Database,
  stateColumn: string,
  updatedColumn: string,
  updatedBeforeMs: number,
  limit: number,
): Promise<CanonicalRatingUpdateSnapshot[]> {
  if (
    !Number.isSafeInteger(updatedBeforeMs) ||
    updatedBeforeMs < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new TypeError("invalid-rating-projection-list");
  }
  const allowed = new Set([
    "event_progress_state:event_progress_updated_at_ms",
    "profile_game_projection_state:profile_game_projection_updated_at_ms",
    "telegram_projection_state:telegram_projection_updated_at_ms",
  ]);
  if (!allowed.has(`${stateColumn}:${updatedColumn}`)) {
    throw new TypeError("invalid-rating-projection-columns");
  }
  const result = await db
    .prepare(
      `SELECT * FROM rating_updates
       WHERE ${stateColumn} = 'pending' AND ${updatedColumn} <= ?
       ORDER BY ${updatedColumn} ASC, operation_id ASC
       LIMIT ?`,
    )
    .bind(updatedBeforeMs, limit)
    .all<RatingRow>();
  return result.results.map(parseCanonicalRatingUpdateRow);
}

async function markProjection(
  db: D1Database,
  operationId: string,
  state: "dead" | "done",
  updatedAtMs: number,
  reason: string | undefined,
  fields: {
    reason: string;
    state: string;
    updated: string;
  },
  attempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await readCanonicalRatingUpdate(db, operationId);
    if (!snapshot) throw new TypeError("rating-operation-missing");
    try {
      await commitCanonicalPlan(db, {
        expectations: [
          {
            kind: "rating-update-revision",
            operationId,
            revision: snapshot.revision,
          },
        ],
        mutations: [
          {
            kind: "update-rating-update",
            value: mergedRatingValue(snapshot, {
              [fields.state]: state,
              [fields.updated]: updatedAtMs,
              [fields.reason]: reason?.trim() || null,
            }),
          },
        ],
      });
      return;
    } catch (error) {
      if (!(error instanceof CanonicalProfileConflict)) throw error;
    }
  }
  throw new CanonicalProfileConflict();
}

export function createCanonicalRatingRepository(
  db: D1Database,
  gameplay: GameplayRepository,
  options: CanonicalRepositoryOptions,
): CanonicalRatingRepository {
  const attempts = retryCount(options.maxAttempts);
  const readOperation = async (operationId: string) => {
    const snapshot = await readCanonicalRatingUpdate(db, operationId);
    return snapshot ? ratingData(snapshot) : null;
  };
  return {
    getRtdbPath: gameplay.getRtdbPath,
    patchRtdbRoot: gameplay.patchRtdbRoot,

    async getRatingProfile(uid) {
      try {
        return await ratingProfileByLogin(db, uid, attempts);
      } catch {
        throw options.createFailure();
      }
    },

    readRatingUpdate: readOperation,

    async tryAcquireRatingLease(input): Promise<RatingLeaseResult> {
      const operationId = `${input.inviteId}__${input.matchId}`;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const snapshot = await readCanonicalRatingUpdate(db, operationId);
        const data = snapshot ? ratingData(snapshot) : null;
        if (data?.status === "done") return { status: "done", data };
        const attemptNowMs = options.now();
        if (
          data?.status === "processing" &&
          data.leaseExpiresAtMs > attemptNowMs &&
          data.ownerToken &&
          data.ownerToken !== input.ownerToken
        ) {
          return { status: "busy", data };
        }
        const fields = {
          ...(snapshot?.payload || {}),
          inviteId: input.inviteId,
          matchId: input.matchId,
          playerId: input.playerId,
          opponentId: input.opponentId,
          ownerUid: input.ownerUid,
          ownerToken: input.ownerToken,
          status: "processing",
          startedAtMs: data?.startedAtMs || attemptNowMs,
          updatedAtMs: attemptNowMs,
          leaseExpiresAtMs: attemptNowMs + input.leaseMs,
        };
        try {
          await commitCanonicalPlan(db, {
            expectations: [
              snapshot
                ? {
                    kind: "rating-update-revision" as const,
                    operationId,
                    revision: snapshot.revision,
                  }
                : { kind: "rating-update-absent" as const, operationId },
            ],
            mutations: [
              {
                kind: snapshot
                  ? ("update-rating-update" as const)
                  : ("insert-rating-update" as const),
                value: ratingValue(operationId, fields),
              },
            ],
          });
          return { status: "acquired", data };
        } catch (error) {
          let durable: RatingUpdateData | null;
          try {
            durable = await readOperation(operationId);
          } catch {
            mapFailure(error, options.createFailure);
          }
          if (sameRatingOperation(durable, input)) {
            if (durable.status === "done") {
              return { status: "done", data: durable };
            }
            if (
              durable.status === "processing" &&
              durable.ownerToken === input.ownerToken
            ) {
              return { status: "acquired", data: durable };
            }
            if (
              durable.status === "processing" &&
              durable.leaseExpiresAtMs > options.now() &&
              durable.ownerToken
            ) {
              return { status: "busy", data: durable };
            }
          }
          if (!(error instanceof CanonicalProfileConflict)) {
            mapFailure(error, options.createFailure);
          }
        }
      }
      throw options.createFailure();
    },

    async finalizeRatingUpdate(
      input: RatingFinalizeInput,
      buildPlan: (
        player: RatingProfile | null,
        opponent: RatingProfile | null,
      ) => RatingCommitPlan,
    ): Promise<RatingFinalizeResult> {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const operation = await readCanonicalRatingUpdate(
          db,
          input.operationId,
        );
        if (!operation) return { status: "lost" };
        const data = ratingData(operation);
        if (data.status === "done") return { status: "replayed", data };
        if (
          data.status !== "processing" ||
          data.ownerToken !== input.ownerToken ||
          !sameRatingOperation(data, input)
        ) {
          return { status: "lost" };
        }
        let playerSnapshot: StableLoginAggregate;
        let opponentSnapshot: StableLoginAggregate;
        try {
          [playerSnapshot, opponentSnapshot] = await Promise.all([
            aggregateByLogin(db, input.playerId, attempts),
            aggregateByLogin(db, input.opponentId, attempts),
          ]);
        } catch (error) {
          if (error instanceof CanonicalProfileConflict) continue;
          mapFailure(error, options.createFailure);
        }
        const playerAggregate = playerSnapshot.aggregate;
        const opponentAggregate = opponentSnapshot.aggregate;
        const player = ratingProfileFromAggregate(playerAggregate);
        const opponent = ratingProfileFromAggregate(opponentAggregate);
        const plan = buildPlan(player, opponent);
        const expectations: CanonicalExpectation[] = [
          {
            kind: "rating-update-revision",
            operationId: input.operationId,
            revision: operation.revision,
          },
        ];
        for (const [loginUid, snapshot] of [
          [input.playerId, playerSnapshot],
          [input.opponentId, opponentSnapshot],
        ] as const) {
          expectations.push(
            snapshot.owner
              ? {
                  kind: "login-owner-revision",
                  loginUid,
                  profileId: snapshot.owner.profileId,
                  revision: snapshot.owner.revision,
                }
              : { kind: "login-owner-absent", loginUid },
          );
          if (snapshot.aggregate?.profile) {
            expectations.push({
              kind: "profile-revision",
              profileId: snapshot.aggregate.profile.profileId,
              revision: snapshot.aggregate.profile.revision,
            });
          }
        }
        const mutations: CanonicalMutation[] = [];
        const profileWrites = new Map<
          string,
          { snapshot: CanonicalProfileSnapshot; patch: Record<string, unknown> }
        >();
        if (playerAggregate?.profile && plan.playerUpdate) {
          profileWrites.set(playerAggregate.profile.profileId, {
            snapshot: playerAggregate.profile,
            patch: plan.playerUpdate,
          });
        }
        if (opponentAggregate?.profile && plan.opponentUpdate) {
          const existing = profileWrites.get(
            opponentAggregate.profile.profileId,
          );
          profileWrites.set(opponentAggregate.profile.profileId, {
            snapshot: opponentAggregate.profile,
            patch: { ...(existing?.patch || {}), ...plan.opponentUpdate },
          });
        }
        for (const { snapshot, patch } of profileWrites.values()) {
          mutations.push({
            kind: "update-active-profile",
            value: patchCanonicalProfile(
              snapshot,
              patch,
              number(plan.ratingUpdate.updatedAtMs) || options.now(),
            ),
          });
        }
        const nextRating = mergedRatingValue(operation, plan.ratingUpdate);
        mutations.push({ kind: "update-rating-update", value: nextRating });
        try {
          await commitCanonicalPlan(db, { expectations, mutations });
          return { status: "committed", data: plan.repairData };
        } catch (error) {
          let replay: RatingUpdateData | null;
          try {
            replay = await readOperation(input.operationId);
          } catch {
            mapFailure(error, options.createFailure);
          }
          if (replay?.status === "done" && sameRatingOperation(replay, input)) {
            return { status: "replayed", data: replay };
          }
          if (!(error instanceof CanonicalProfileConflict)) {
            mapFailure(error, options.createFailure);
          }
        }
      }
      throw options.createFailure();
    },

    async applyFebruaryChallengeReplay(playerProfileId, opponentProfileId) {
      if (
        !playerProfileId ||
        !opponentProfileId ||
        playerProfileId === opponentProfileId
      ) {
        return;
      }
      for (let attempt = 0; attempt < attempts; attempt++) {
        const [player, opponent] = await Promise.all([
          readStableCanonicalProfileAggregate(db, playerProfileId),
          readStableCanonicalProfileAggregate(db, opponentProfileId),
        ]);
        const changes = [
          [player, opponentProfileId],
          [opponent, playerProfileId],
        ] as const;
        const expectations: CanonicalExpectation[] = [];
        const mutations: CanonicalMutation[] = [];
        for (const [aggregate, otherProfileId] of changes) {
          const snapshot = aggregate.profile;
          if (
            !snapshot ||
            aggregate.februaryOpponentProfileIds.includes(otherProfileId)
          ) {
            continue;
          }
          expectations.push({
            kind: "profile-revision",
            profileId: snapshot.profileId,
            revision: snapshot.revision,
          });
          expectations.push({
            kind: "february-opponent-absent",
            profileId: snapshot.profileId,
            opponentProfileId: otherProfileId,
          });
          mutations.push(
            {
              kind: "insert-february-opponent",
              profileId: snapshot.profileId,
              opponentProfileId: otherProfileId,
              recordedAtMs: options.now(),
            },
            {
              kind: "update-active-profile",
              value: patchCanonicalProfile(
                snapshot,
                {
                  feb2026UniqueOpponentsCount:
                    aggregate.februaryOpponentProfileIds.length + 1,
                },
                options.now(),
              ),
            },
          );
        }
        if (mutations.length === 0) return;
        try {
          await commitCanonicalPlan(db, { expectations, mutations });
          return;
        } catch (error) {
          if (!(error instanceof CanonicalProfileConflict)) {
            mapFailure(error, options.createFailure);
          }
        }
      }
      throw options.createFailure();
    },

    async claimRatingEventProgress(operationId, updateTime, claimedAtMs) {
      return claimProjection(
        db,
        operationId,
        updateTime,
        claimedAtMs,
        "eventProgressUpdatedAtMs",
      );
    },

    async claimRatingProfileGameProjection(
      operationId,
      updateTime,
      claimedAtMs,
    ) {
      return claimProjection(
        db,
        operationId,
        updateTime,
        claimedAtMs,
        "profileGameProjectionUpdatedAtMs",
      );
    },

    async claimRatingTelegramProjection(operationId, updateTime, claimedAtMs) {
      return claimProjection(
        db,
        operationId,
        updateTime,
        claimedAtMs,
        "telegramProjectionUpdatedAtMs",
      );
    },

    async listDueRatingEventProgress(
      updatedBeforeMs,
      limit,
    ): Promise<PendingRatingEventProgress[]> {
      return (
        await listDueRatings(
          db,
          "event_progress_state",
          "event_progress_updated_at_ms",
          updatedBeforeMs,
          limit,
        )
      ).map((snapshot) => ({
        eventId: string(snapshot.payload.eventId),
        inviteId: snapshot.inviteId,
        matchId: snapshot.matchId,
        operationId: snapshot.operationId,
        updateTime: String(snapshot.revision),
        version: snapshot.eventProgressVersion || 0,
      }));
    },

    async listDueRatingProfileGameProjections(
      updatedBeforeMs,
      limit,
    ): Promise<PendingRatingProfileGameProjection[]> {
      return (
        await listDueRatings(
          db,
          "profile_game_projection_state",
          "profile_game_projection_updated_at_ms",
          updatedBeforeMs,
          limit,
        )
      ).map((snapshot) => ({
        inviteId: snapshot.inviteId,
        matchId: snapshot.matchId,
        operationId: snapshot.operationId,
        updateTime: String(snapshot.revision),
        version: snapshot.profileGameProjectionVersion || 0,
      }));
    },

    async listDueRatingTelegramProjections(
      updatedBeforeMs,
      limit,
    ): Promise<PendingRatingTelegramProjection[]> {
      return (
        await listDueRatings(
          db,
          "telegram_projection_state",
          "telegram_projection_updated_at_ms",
          updatedBeforeMs,
          limit,
        )
      ).map((snapshot) => ({
        operationId: snapshot.operationId,
        updateTime: String(snapshot.revision),
      }));
    },

    async markRatingEventProgress(operationId, state, updatedAtMs, reason) {
      return markProjection(
        db,
        operationId,
        state,
        updatedAtMs,
        reason,
        {
          state: "eventProgressState",
          updated: "eventProgressUpdatedAtMs",
          reason: "eventProgressReason",
        },
        attempts,
      );
    },

    async markRatingProfileGameProjection(
      operationId,
      state,
      updatedAtMs,
      reason,
    ) {
      return markProjection(
        db,
        operationId,
        state,
        updatedAtMs,
        reason,
        {
          state: "profileGameProjectionState",
          updated: "profileGameProjectionUpdatedAtMs",
          reason: "profileGameProjectionReason",
        },
        attempts,
      );
    },

    async markRatingTelegramProjection(
      operationId,
      state,
      updatedAtMs,
      reason,
    ) {
      return markProjection(
        db,
        operationId,
        state,
        updatedAtMs,
        reason,
        {
          state: "telegramProjectionState",
          updated: "telegramProjectionUpdatedAtMs",
          reason: "telegramProjectionReason",
        },
        attempts,
      );
    },
  };
}
