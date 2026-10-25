import {
  commitCanonicalPlan,
  readCanonicalRatingUpdate,
  CanonicalProfileConflict,
  type CanonicalExpectation,
  type CanonicalMutation,
} from "../profileCanonicalD1.ts";
import { readCanonicalRatingUpdates } from "../profileCanonical/accounting.ts";
import {
  readMutableRatingProfiles,
  type CanonicalMutableProfileSnapshot,
  type CanonicalOwnedMutableProfileSnapshot,
} from "../profileMutableD1.ts";
import { buildMutableGameplayProfileMutation } from "../profileMutableGameplay.ts";
import type {
  RatingCommitPlan,
  RatingFinalizeInput,
  RatingFinalizeResult,
  RatingLeaseInput,
  RatingLeaseResult,
  RatingProfile,
  RatingProfilePatch,
  RatingProjectionRepository,
  RatingUpdateData,
} from "../ratingContracts.ts";
import {
  type CanonicalRepositoryOptions,
  type GameplayRepositoryOperation,
  reconciliationFailure,
} from "../gameplayRepositoryPolicy.ts";
import {
  readRatingCompletion,
  readRatingLeaseSnapshot,
} from "../ratingCompletionD1.ts";
import {
  number,
  ratingData,
  ratingValue,
  ratingLeasePayload,
  mergedRatingValue,
  ratingProfileFromSnapshot,
} from "./codec.ts";

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

export function mapFailure(
  error: unknown,
  createFailure: CanonicalRepositoryOptions["createFailure"],
  operation: GameplayRepositoryOperation,
  cause = error,
): never {
  throw error instanceof CanonicalProfileConflict
    ? createFailure(operation, { cause })
    : error;
}

export function createRatingOperations(
  db: D1Database,
  options: CanonicalRepositoryOptions,
  attempts: number,
): Pick<
  RatingProjectionRepository,
  | "readRatingUpdate"
  | "readRatingUpdates"
  | "hasCompletedRatingUpdate"
  | "tryAcquireRatingLease"
  | "finalizeRatingUpdate"
> {
  const readOperation = async (operationId: string) => {
    const snapshot = await readCanonicalRatingUpdate(db, operationId);
    return snapshot ? ratingData(snapshot) : null;
  };
  return {
    readRatingUpdate: readOperation,
    async readRatingUpdates(operationIds) {
      const snapshots = await readCanonicalRatingUpdates(db, operationIds);
      return snapshots.map((snapshot) =>
        snapshot ? ratingData(snapshot) : null,
      );
    },
    hasCompletedRatingUpdate: (inviteId, matchId) =>
      readRatingCompletion(db, inviteId, matchId),

    async tryAcquireRatingLease(input): Promise<RatingLeaseResult> {
      const operationId = `${input.inviteId}__${input.matchId}`;
      const initial = await readRatingLeaseSnapshot(
        db,
        input.inviteId,
        input.matchId,
      );
      let lastConflict: CanonicalProfileConflict | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const snapshot =
          attempt === 0
            ? initial.snapshot
            : await readCanonicalRatingUpdate(db, operationId);
        const data = snapshot ? ratingData(snapshot) : null;
        if (
          data &&
          (data.inviteId !== input.inviteId || data.matchId !== input.matchId)
        ) {
          throw options.createFailure("tryAcquireRatingLease");
        }
        if (initial.legacyCompleted || data?.status === "done")
          return { status: "done", data };
        const attemptNowMs = options.now();
        if (
          data?.status === "processing" &&
          data.leaseExpiresAtMs > attemptNowMs &&
          data.ownerToken &&
          data.ownerToken !== input.ownerToken
        ) {
          return { status: "busy", data };
        }
        const fields = ratingLeasePayload(snapshot, input, data, attemptNowMs);
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
        let playerSnapshot: CanonicalOwnedMutableProfileSnapshot | null;
        let opponentSnapshot: CanonicalOwnedMutableProfileSnapshot | null;
        try {
          ({ player: playerSnapshot, opponent: opponentSnapshot } =
            await readMutableRatingProfiles(db, {
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
          {
            snapshot: CanonicalMutableProfileSnapshot;
            patch: RatingProfilePatch;
          }
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
          mutations.push(
            buildMutableGameplayProfileMutation(
              snapshot,
              patch,
              number(plan.ratingUpdate.updatedAtMs) || options.now(),
            ),
          );
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
  };
}
