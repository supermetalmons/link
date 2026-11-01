import {
  MATERIAL_KEYS,
  cloneMaterials,
  createEmptyMaterials,
} from "@mons/shared/mining";
import {
  commitCanonicalPlan,
  readCanonicalWagerSettlement,
  resolveCanonicalPublicProfile,
  CanonicalProfileConflict,
  type CanonicalExpectation,
  type CanonicalMutation,
  type CanonicalWagerSettlement,
} from "./profileCanonicalD1.ts";
import { resolveMutableProfiles } from "./profileMutableD1.ts";
import { buildMutableGameplayProfileMutation } from "./profileMutableGameplay.ts";
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
import { createD1ProfileOwnershipReader } from "./profileOwnershipD1.ts";

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
    ...createD1ProfileOwnershipReader(db, options),
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
          const [winner, loser] = await resolveMutableProfiles(db, [
            input.winnerProfileId,
            input.loserProfileId,
          ]);
          if (!winner || !loser) throw new Error("wager-profile-unavailable");
          const mutations: CanonicalMutation[] = [];
          const expectations: CanonicalExpectation[] = [
            { kind: "wager-settlement-absent", operationId: input.operationId },
          ];
          let outcome: "applied" | "insufficient-materials" = "applied";
          if (winner.profileId !== loser.profileId) {
            const material = input.material;
            const winnerMaterials = cloneMaterials(
              winner.profile.mining.materials,
            );
            const loserMaterials = cloneMaterials(
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
                buildMutableGameplayProfileMutation(
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
                buildMutableGameplayProfileMutation(
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

    async getMiningMaterials(profileId) {
      try {
        const snapshot = await resolveCanonicalPublicProfile(db, profileId);
        return snapshot
          ? cloneMaterials(snapshot.profile.mining.materials)
          : createEmptyMaterials();
      } catch (error) {
        throw options.createFailure("getMiningMaterials", { cause: error });
      }
    },

    async getMiningSnapshot(profileId) {
      try {
        const snapshot = await resolveCanonicalPublicProfile(db, profileId);
        return snapshot?.profile.mining || null;
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
