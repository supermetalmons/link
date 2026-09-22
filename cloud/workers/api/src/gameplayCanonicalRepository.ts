import { MATERIAL_KEYS, normalizeMaterials } from "@mons/shared/mining";
import {
  commitCanonicalPlan,
  readCanonicalProfileOwnershipSnapshot,
  readCanonicalWagerSettlement,
  resolveCanonicalProfile,
  CanonicalProfileConflict,
  type CanonicalProfileSnapshot,
  type CanonicalExpectation,
  type CanonicalMutation,
  type CanonicalWagerSettlement,
} from "./profileCanonicalD1.ts";
import { patchCanonicalProfile } from "./profileMutationD1.ts";
import {
  deleteD1NavigationGame,
  getD1NavigationGame,
} from "./profileGamesD1.ts";
import type {
  GameplayRepository,
  WagerTransferInput,
  WagerTransferResult,
} from "./gameplayRepository.ts";
import {
  type CanonicalRepositoryOptions,
  reconciliationFailure,
  retryCount,
} from "./gameplayRepositoryPolicy.ts";
import { mapCanonicalOwnershipSnapshot } from "./profileOwnershipMapping.ts";

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
  options: CanonicalRepositoryOptions,
): Pick<
  GameplayRepository,
  | "applyWagerTransferOnce"
  | "readProfileOwnershipSnapshot"
  | "getMiningMaterials"
  | "getMiningSnapshot"
  | "getNavigationGame"
  | "deleteNavigationGame"
> {
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
        throw options.createFailure("applyWagerTransferOnce");
      }
      try {
        const existing = await readCanonicalWagerSettlement(
          db,
          input.operationId,
        );
        if (existing) {
          return replayWagerSettlement(existing, input.fingerprint);
        }
      } catch (error) {
        throw options.createFailure("applyWagerTransferOnce", { cause: error });
      }
      let lastConflict: CanonicalProfileConflict | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const [winner, loser] = await Promise.all([
            resolveCanonicalProfile(db, input.winnerProfileId),
            resolveCanonicalProfile(db, input.loserProfileId),
          ]);
          if (!winner || !loser) throw new Error("wager-profile-unavailable");
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
                  kind: "patch-active-profile",
                  current: winner,
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
                  kind: "patch-active-profile",
                  current: loser,
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
          } catch (readError) {
            throw options.createFailure("applyWagerTransferOnce", {
              cause: reconciliationFailure(error, readError),
            });
          }
          if (!(error instanceof CanonicalProfileConflict)) {
            throw options.createFailure("applyWagerTransferOnce", {
              cause: error,
            });
          }
          lastConflict = error;
        }
      }
      throw options.createFailure("applyWagerTransferOnce", {
        cause: lastConflict,
      });
    },

    async readProfileOwnershipSnapshot(query) {
      try {
        return mapCanonicalOwnershipSnapshot(
          await readCanonicalProfileOwnershipSnapshot(db, query),
        );
      } catch (error) {
        throw options.createFailure("readProfileOwnershipSnapshot", {
          cause: error,
        });
      }
    },

    async getMiningMaterials(profileId) {
      try {
        const snapshot = await resolveCanonicalProfile(db, profileId);
        return normalizeMaterials(snapshot?.profile.mining.materials);
      } catch (error) {
        throw options.createFailure("getMiningMaterials", { cause: error });
      }
    },

    async getMiningSnapshot(profileId) {
      try {
        return (
          (await resolveCanonicalProfile(db, profileId))?.profile.mining || null
        );
      } catch (error) {
        throw options.createFailure("getMiningSnapshot", { cause: error });
      }
    },

    async getNavigationGame(profileId, inviteId) {
      return getD1NavigationGame(profileGamesDb, profileId, inviteId);
    },

    async deleteNavigationGame(profileId, inviteId) {
      return deleteD1NavigationGame(profileGamesDb, profileId, inviteId);
    },
  };
}
