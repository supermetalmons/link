import { Buffer } from "node:buffer";
import {
  isHistoricalMatchPair,
  type HistoricalMatchPair,
} from "@mons/shared/game-sessions";
import {
  commitCanonicalPlan,
  readCanonicalRatingUpdate,
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  type CanonicalProfileSnapshot,
  type CanonicalExpectation,
  type CanonicalMutation,
  type CanonicalRatingUpdateSnapshot,
  type CanonicalRatingUpdateValue,
} from "./profileCanonicalD1.ts";
import { readCanonicalProfileIdMap } from "./profileCanonical/auth.ts";
import {
  canonicalRatingProjectionFields,
  buildCanonicalRatingProjectionMutation,
} from "./profileCanonical/accounting.ts";
import type {
  CanonicalRatingProjectionKind,
  RatingRow,
} from "./profileCanonical/types.ts";
import {
  nonempty,
  nullableSafeInteger,
  safeInteger,
} from "./profileCanonical/validation.ts";
import {
  patchCanonicalProfile,
  readCanonicalChallengeReplayProfiles,
  readCanonicalRatingProfiles,
  type CanonicalProfileMutationSnapshot,
} from "./profileMutationD1.ts";
import type {
  RatingGameplayReader,
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
  RatingProfilePatch,
  RatingProfileGameProjectionRepository,
  RatingProjectionRepository,
  RatingUpdateData,
} from "./ratingContracts.ts";
import {
  type CanonicalRepositoryOptions,
  type GameplayRepositoryOperation,
  reconciliationFailure,
  retryCount,
} from "./gameplayRepositoryPolicy.ts";
import { readRatingCompletion } from "./ratingCompletionD1.ts";

type CanonicalRatingRepository = RatingProjectionRepository &
  RatingEventProgressRepository &
  RatingProfileGameProjectionRepository;

type RatingRecoveryRow = Pick<RatingRow, "operation_id" | "revision">;

type RatingGameRecoveryRow = RatingRecoveryRow &
  Pick<RatingRow, "invite_id" | "match_id"> & { version: number | null };

type RatingEventRecoveryRow = RatingGameRecoveryRow & {
  event_id_hex: string | null;
};

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

async function canonicalProfileIds(
  db: D1Database,
  profileIds: readonly string[],
): Promise<Array<string | null>> {
  const canonicalIds = await readCanonicalProfileIdMap(db, profileIds);
  return profileIds.map((profileId) => canonicalIds.get(profileId) ?? null);
}

function ratingProfileFromSnapshot(
  value: CanonicalProfileMutationSnapshot | null,
): RatingProfile | null {
  if (!value) return null;
  const snapshot = value.profile;
  const profile = snapshot.profile;
  return {
    aura: profile.aura || "",
    emoji: snapshot.gameplayEmoji,
    eth: profile.eth || "",
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

function ratingData(snapshot: CanonicalRatingUpdateSnapshot): RatingUpdateData {
  const fields = snapshot.payload;
  const historicalMatchArchiveVersion = Object.hasOwn(
    fields,
    "historicalMatchArchiveVersion",
  )
    ? typeof fields.historicalMatchArchiveVersion === "number" &&
      Number.isSafeInteger(fields.historicalMatchArchiveVersion)
      ? fields.historicalMatchArchiveVersion
      : -1
    : undefined;
  const historicalMatchPair: HistoricalMatchPair | undefined =
    isHistoricalMatchPair(fields.historicalMatchPair)
      ? fields.historicalMatchPair
      : undefined;
  return {
    completedAtMs: number(fields.completedAtMs),
    eventId: string(fields.eventId),
    eventOwned: fields.eventOwned === true,
    eventProgressReason: string(fields.eventProgressReason),
    eventProgressState: string(fields.eventProgressState),
    eventProgressUpdatedAtMs: number(fields.eventProgressUpdatedAtMs),
    eventProgressVersion: number(fields.eventProgressVersion),
    ...(historicalMatchArchiveVersion === undefined
      ? {}
      : { historicalMatchArchiveVersion }),
    inviteId: string(fields.inviteId) || snapshot.inviteId,
    ...(historicalMatchPair ? { historicalMatchPair } : {}),
    isEventMatch: fields.isEventMatch === true,
    leaseExpiresAtMs: snapshot.leaseExpiresAtMs,
    matchId: string(fields.matchId) || snapshot.matchId,
    opponentId: string(fields.opponentId) || snapshot.opponentId,
    ...(typeof fields.opponentManaPoints === "number" &&
    Number.isFinite(fields.opponentManaPoints)
      ? { opponentManaPoints: fields.opponentManaPoints }
      : {}),
    opponentProfileId:
      string(fields.opponentProfileId) || snapshot.opponentProfileId || "",
    ownerToken: string(fields.ownerToken) || snapshot.ownerToken,
    playerId: string(fields.playerId) || snapshot.playerId,
    ...(typeof fields.playerManaPoints === "number" &&
    Number.isFinite(fields.playerManaPoints)
      ? { playerManaPoints: fields.playerManaPoints }
      : {}),
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

function mapFailure(
  error: unknown,
  createFailure: CanonicalRepositoryOptions["createFailure"],
  operation: GameplayRepositoryOperation,
  cause = error,
): never {
  throw error instanceof CanonicalProfileConflict
    ? createFailure(operation, { cause })
    : error;
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
  projection: CanonicalRatingProjectionKind,
): Promise<boolean> {
  const revision = parseRevision(updateTime);
  if (!revision) return false;
  const snapshot = await readCanonicalRatingUpdate(db, operationId);
  if (!snapshot || snapshot.revision !== revision) return false;
  const fields = canonicalRatingProjectionFields(projection);
  try {
    await commitCanonicalPlan(db, {
      expectations: [{ kind: "rating-update-revision", operationId, revision }],
      mutations: [
        buildCanonicalRatingProjectionMutation(
          snapshot,
          mergedRatingValue(snapshot, { [fields.updated]: claimedAtMs }),
          projection,
        ),
      ],
    });
    return true;
  } catch (error) {
    if (error instanceof CanonicalProfileConflict) return false;
    throw error;
  }
}

function parseRatingRecoveryRow(
  row: RatingRecoveryRow,
): PendingRatingTelegramProjection {
  return {
    operationId: nonempty(row.operation_id),
    updateTime: String(safeInteger(row.revision, 1)),
  };
}

function parseRatingGameRecoveryRow(
  row: RatingGameRecoveryRow,
): PendingRatingProfileGameProjection {
  return {
    ...parseRatingRecoveryRow(row),
    inviteId: nonempty(row.invite_id),
    matchId: nonempty(row.match_id),
    version: nullableSafeInteger(row.version) ?? 0,
  };
}

function parseRatingEventId(hex: string | null): string {
  if (hex === null) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.from(hex, "hex"))
      .trim();
  } catch {
    throw new CanonicalProfileCorruption();
  }
}

async function listDueRatings<Row>(
  db: D1Database,
  query: string,
  updatedBeforeMs: number,
  limit: number,
): Promise<Row[]> {
  if (
    !Number.isSafeInteger(updatedBeforeMs) ||
    updatedBeforeMs < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new TypeError("invalid-rating-projection-list");
  }
  const result = await db
    .prepare(query)
    .bind(updatedBeforeMs, limit)
    .all<Row>();
  return result.results;
}

async function markProjection(
  db: D1Database,
  operationId: string,
  state: "dead" | "done",
  updatedAtMs: number,
  reason: string | undefined,
  projection: CanonicalRatingProjectionKind,
  attempts: number,
): Promise<void> {
  const fields = canonicalRatingProjectionFields(projection);
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
          buildCanonicalRatingProjectionMutation(
            snapshot,
            mergedRatingValue(snapshot, {
              [fields.state]: state,
              [fields.updated]: updatedAtMs,
              [fields.reason]: reason?.trim() || null,
            }),
            projection,
          ),
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
  gameplay: RatingGameplayReader,
  options: CanonicalRepositoryOptions,
): Omit<CanonicalRatingRepository, "putEventProgressOutbox"> {
  const attempts = retryCount(options.maxAttempts);
  const readOperation = async (operationId: string) => {
    const snapshot = await readCanonicalRatingUpdate(db, operationId);
    return snapshot ? ratingData(snapshot) : null;
  };
  return {
    readInviteMetadata: gameplay.readInviteMetadata,
    readMatchRecord: gameplay.readMatchRecord,
    readMatchPair: gameplay.readMatchPair,
    readProfileOwnershipSnapshot: gameplay.readProfileOwnershipSnapshot,

    readRatingUpdate: readOperation,
    hasCompletedRatingUpdate: (inviteId, matchId) =>
      readRatingCompletion(db, inviteId, matchId),

    async tryAcquireRatingLease(input): Promise<RatingLeaseResult> {
      const operationId = `${input.inviteId}__${input.matchId}`;
      if (await readRatingCompletion(db, input.inviteId, input.matchId)) {
        const data = await readOperation(operationId);
        if (
          data &&
          (data.inviteId !== input.inviteId || data.matchId !== input.matchId)
        ) {
          throw options.createFailure("tryAcquireRatingLease");
        }
        return { status: "done", data };
      }
      let lastConflict: CanonicalProfileConflict | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const snapshot = await readCanonicalRatingUpdate(db, operationId);
        const data = snapshot ? ratingData(snapshot) : null;
        if (
          data &&
          (data.inviteId !== input.inviteId || data.matchId !== input.matchId)
        ) {
          throw options.createFailure("tryAcquireRatingLease");
        }
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
          } catch (readError) {
            mapFailure(
              error,
              options.createFailure,
              "tryAcquireRatingLease",
              reconciliationFailure(error, readError),
            );
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
            mapFailure(error, options.createFailure, "tryAcquireRatingLease");
          }
          lastConflict = error;
        }
      }
      throw options.createFailure("tryAcquireRatingLease", {
        cause: lastConflict,
      });
    },

    async finalizeRatingUpdate(
      input: RatingFinalizeInput,
      buildPlan: (
        player: RatingProfile | null,
        opponent: RatingProfile | null,
      ) => RatingCommitPlan,
    ): Promise<RatingFinalizeResult> {
      let lastConflict: CanonicalProfileConflict | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const operation = await readCanonicalRatingUpdate(
          db,
          input.operationId,
        );
        if (!operation) return { status: "lost" };
        const data = ratingData(operation);
        if (
          data.inviteId !== input.inviteId ||
          data.matchId !== input.matchId
        ) {
          throw options.createFailure("finalizeRatingUpdate");
        }
        if (data.status === "done") return { status: "replayed", data };
        if (
          data.status !== "processing" ||
          data.ownerToken !== input.ownerToken ||
          !sameRatingOperation(data, input)
        ) {
          return { status: "lost" };
        }
        let playerSnapshot: CanonicalProfileMutationSnapshot | null;
        let opponentSnapshot: CanonicalProfileMutationSnapshot | null;
        try {
          ({ player: playerSnapshot, opponent: opponentSnapshot } =
            await readCanonicalRatingProfiles(db, {
              playerLoginUid: input.playerId,
              opponentLoginUid: input.opponentId,
            }));
        } catch (error) {
          if (error instanceof CanonicalProfileConflict) {
            lastConflict = error;
            continue;
          }
          mapFailure(error, options.createFailure, "finalizeRatingUpdate");
        }
        const player = ratingProfileFromSnapshot(playerSnapshot);
        const opponent = ratingProfileFromSnapshot(opponentSnapshot);
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
            snapshot
              ? {
                  kind: "login-owner-revision",
                  loginUid,
                  profileId: snapshot.owner.profileId,
                  revision: snapshot.owner.revision,
                }
              : { kind: "login-owner-absent", loginUid },
          );
          if (snapshot) {
            expectations.push({
              kind: "profile-revision",
              profileId: snapshot.profile.profileId,
              revision: snapshot.profile.revision,
            });
          }
        }
        const mutations: CanonicalMutation[] = [];
        const profileWrites = new Map<
          string,
          { snapshot: CanonicalProfileSnapshot; patch: RatingProfilePatch }
        >();
        if (playerSnapshot && plan.playerUpdate) {
          profileWrites.set(playerSnapshot.profile.profileId, {
            snapshot: playerSnapshot.profile,
            patch: plan.playerUpdate,
          });
        }
        if (opponentSnapshot && plan.opponentUpdate) {
          const existing = profileWrites.get(
            opponentSnapshot.profile.profileId,
          );
          profileWrites.set(opponentSnapshot.profile.profileId, {
            snapshot: opponentSnapshot.profile,
            patch: { ...(existing?.patch || {}), ...plan.opponentUpdate },
          });
        }
        for (const { snapshot, patch } of profileWrites.values()) {
          mutations.push({
            kind: "patch-active-profile",
            current: snapshot,
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
          } catch (readError) {
            mapFailure(
              error,
              options.createFailure,
              "finalizeRatingUpdate",
              reconciliationFailure(error, readError),
            );
          }
          if (replay?.status === "done" && sameRatingOperation(replay, input)) {
            return { status: "replayed", data: replay };
          }
          if (!(error instanceof CanonicalProfileConflict)) {
            mapFailure(error, options.createFailure, "finalizeRatingUpdate");
          }
          lastConflict = error;
        }
      }
      throw options.createFailure("finalizeRatingUpdate", {
        cause: lastConflict,
      });
    },

    async applyFebruaryChallengeReplay(playerProfileId, opponentProfileId) {
      if (!playerProfileId || !opponentProfileId) {
        return;
      }
      let lastConflict: CanonicalProfileConflict | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        let resolvedProfileIds: Array<string | null>;
        try {
          resolvedProfileIds = await canonicalProfileIds(db, [
            playerProfileId,
            opponentProfileId,
          ]);
        } catch (error) {
          mapFailure(
            error,
            options.createFailure,
            "applyFebruaryChallengeReplay",
          );
        }
        const [resolvedPlayerProfileId, resolvedOpponentProfileId] =
          resolvedProfileIds;
        if (
          !resolvedPlayerProfileId ||
          !resolvedOpponentProfileId ||
          resolvedPlayerProfileId === resolvedOpponentProfileId
        ) {
          return;
        }
        const { player, opponent } = await readCanonicalChallengeReplayProfiles(
          db,
          {
            playerProfileId: resolvedPlayerProfileId,
            opponentProfileId: resolvedOpponentProfileId,
          },
        );
        if (
          player.profile?.state !== "active" ||
          player.profile.profileId !== resolvedPlayerProfileId ||
          opponent.profile?.state !== "active" ||
          opponent.profile.profileId !== resolvedOpponentProfileId
        ) {
          continue;
        }
        const storedOpponentProfileIds = Array.from(
          new Set([
            ...player.februaryOpponentProfileIds,
            ...opponent.februaryOpponentProfileIds,
          ]),
        );
        let resolvedStoredOpponentProfileIds: Array<string | null>;
        try {
          resolvedStoredOpponentProfileIds = await canonicalProfileIds(
            db,
            storedOpponentProfileIds,
          );
        } catch (error) {
          mapFailure(
            error,
            options.createFailure,
            "applyFebruaryChallengeReplay",
          );
        }
        const canonicalOpponentByStoredId = new Map(
          storedOpponentProfileIds.map((storedProfileId, index) => [
            storedProfileId,
            resolvedStoredOpponentProfileIds[index] || storedProfileId,
          ]),
        );
        const changes = [
          [player, resolvedOpponentProfileId],
          [opponent, resolvedPlayerProfileId],
        ] as const;
        const expectations: CanonicalExpectation[] = [];
        const mutations: CanonicalMutation[] = [];
        for (const [aggregate, otherProfileId] of changes) {
          const snapshot = aggregate.profile;
          const canonicalOpponentProfileIds = new Set(
            aggregate.februaryOpponentProfileIds
              .map(
                (storedProfileId) =>
                  canonicalOpponentByStoredId.get(storedProfileId) ||
                  storedProfileId,
              )
              .filter((profileId) => profileId !== snapshot?.profileId),
          );
          if (!snapshot || canonicalOpponentProfileIds.has(otherProfileId)) {
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
          expectations.push({
            kind: "canonical-february-opponent-absent",
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
              kind: "patch-active-profile",
              current: snapshot,
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
            mapFailure(
              error,
              options.createFailure,
              "applyFebruaryChallengeReplay",
            );
          }
          lastConflict = error;
        }
      }
      throw options.createFailure("applyFebruaryChallengeReplay", {
        cause: lastConflict,
      });
    },

    async claimRatingEventProgress(operationId, updateTime, claimedAtMs) {
      return claimProjection(
        db,
        operationId,
        updateTime,
        claimedAtMs,
        "event-progress",
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
        "profile-game",
      );
    },

    async claimRatingTelegramProjection(operationId, updateTime, claimedAtMs) {
      return claimProjection(
        db,
        operationId,
        updateTime,
        claimedAtMs,
        "telegram",
      );
    },

    async listDueRatingEventProgress(
      updatedBeforeMs,
      limit,
    ): Promise<PendingRatingEventProgress[]> {
      return (
        await listDueRatings<RatingEventRecoveryRow>(
          db,
          `SELECT operation_id, revision, invite_id, match_id,
                  event_progress_version AS version,
                  (SELECT CASE WHEN type = 'text' THEN hex(atom) ELSE NULL END
                   FROM json_each(rating_updates.payload_json)
                   WHERE key = 'eventId'
                   ORDER BY id DESC LIMIT 1) AS event_id_hex
           FROM rating_updates
           WHERE event_progress_state = 'pending' AND event_progress_updated_at_ms <= ?
           ORDER BY event_progress_updated_at_ms ASC, operation_id ASC
           LIMIT ?`,
          updatedBeforeMs,
          limit,
        )
      ).map((row) => ({
        ...parseRatingGameRecoveryRow(row),
        eventId: parseRatingEventId(row.event_id_hex),
      }));
    },

    async listDueRatingProfileGameProjections(
      updatedBeforeMs,
      limit,
    ): Promise<PendingRatingProfileGameProjection[]> {
      return (
        await listDueRatings<RatingGameRecoveryRow>(
          db,
          `SELECT operation_id, revision, invite_id, match_id,
                  profile_game_projection_version AS version
           FROM rating_updates
           WHERE profile_game_projection_state = 'pending' AND profile_game_projection_updated_at_ms <= ?
           ORDER BY profile_game_projection_updated_at_ms ASC, operation_id ASC
           LIMIT ?`,
          updatedBeforeMs,
          limit,
        )
      ).map(parseRatingGameRecoveryRow);
    },

    async listDueRatingTelegramProjections(
      updatedBeforeMs,
      limit,
    ): Promise<PendingRatingTelegramProjection[]> {
      return (
        await listDueRatings<RatingRecoveryRow>(
          db,
          `SELECT operation_id, revision
           FROM rating_updates
           WHERE telegram_projection_state = 'pending' AND telegram_projection_updated_at_ms <= ?
           ORDER BY telegram_projection_updated_at_ms ASC, operation_id ASC
           LIMIT ?`,
          updatedBeforeMs,
          limit,
        )
      ).map(parseRatingRecoveryRow);
    },

    async markRatingEventProgress(operationId, state, updatedAtMs, reason) {
      return markProjection(
        db,
        operationId,
        state,
        updatedAtMs,
        reason,
        "event-progress",
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
        "profile-game",
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
        "telegram",
        attempts,
      );
    },
  };
}
