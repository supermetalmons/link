import type { WagerFrozenStore } from "./wagerFrozenStore.ts";
import {
  notifyInviteSessionCommitted,
  notifyInviteSourceChanged,
} from "./inviteWagersNotifications.ts";
import {
  createAutomatchPersistence,
  type AutomatchPersistence,
} from "./automatchPersistence.ts";
import { prepareCreatedMatchPresentations } from "./matchPresentationRegistry.ts";
import { measureAutomatchPhase } from "./automatchTelemetry.ts";
import {
  createWagerStateReader,
  type WagerReader,
  type WagerWriter,
} from "./wagerStateRepository.ts";
import { createMatchStateSource } from "./matchStateSource.ts";
import type {
  MiningMaterialName,
  MiningMaterials,
  MiningSnapshot,
} from "@mons/shared/mining";
import type { MatchStatePort } from "./repositoryContracts.ts";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import { createCanonicalGameplayRepository } from "./gameplayCanonicalRepository.ts";
import { createGameplayRepositoryFailure } from "./gameplayRepositoryPolicy.ts";
import type {
  ProfileOwnershipProfile,
  ProfileOwnershipReader,
} from "./profileOwnership.ts";

const MAX_WAGER_TRANSFER_TRANSACTION_ATTEMPTS = 5;

export type NavigationGameDocument = {
  status: string | null;
};

export type NavigationGameDeleteResult = "deleted" | "missing";

export type WagerTransferInput = {
  appliedAtMs: number;
  count: number;
  fingerprint: string;
  loserProfileId: string;
  material: MiningMaterialName;
  operationId: string;
  winnerProfileId: string;
};

export type WagerTransferResult =
  "applied" | "insufficient-materials" | "replayed";

export type GameplayProfile = ProfileOwnershipProfile;

export type GameplayRepository = ProfileOwnershipReader &
  GameSessionPort &
  MatchStatePort & {
    wagers: WagerReader;
    wagerWriter?: WagerWriter;
    automatchPersistence: AutomatchPersistence;
    wagerFrozen?: WagerFrozenStore;
    applyWagerTransferOnce: (
      input: WagerTransferInput,
    ) => Promise<WagerTransferResult>;
    deleteNavigationGame: (
      profileId: string,
      inviteId: string,
    ) => Promise<NavigationGameDeleteResult>;
    getNavigationGame: (
      profileId: string,
      inviteId: string,
    ) => Promise<NavigationGameDocument | null>;
    getMiningMaterials: (profileId: string) => Promise<MiningMaterials>;
    getMiningSnapshot: (profileId: string) => Promise<MiningSnapshot | null>;
  };

type GameplayRepositoryDependencies = {
  wagerFrozen?: WagerFrozenStore;
  d1?: D1Database;
  fetcher?: typeof fetch;
  now?: () => number;
  stateClient?: MatchStatePort;
  timeoutMs?: number;
};

export function createGameplayRepository(
  env: Env,
  {
    d1 = env.PROFILE_GAMES_DB,
    wagerFrozen,
    now = Date.now,
    stateClient,
  }: GameplayRepositoryDependencies = {},
): GameplayRepository {
  const matchSource = stateClient || createMatchStateSource(env);
  const automatchPersistence = createAutomatchPersistence(d1, matchSource, {
    now,
    prepareMatchPresentations: (creations) =>
      prepareCreatedMatchPresentations(env, creations),
    onCommitted: (inviteId) =>
      measureAutomatchPhase("notification", async () => {
        if (env.AUTOMATCH_DELIVERY_MODE === "bootstrap") {
          await notifyInviteSessionCommitted(env, [inviteId]);
          return;
        }
        await notifyInviteSourceChanged(env, {
          metadataInviteIds: [inviteId],
          wagerInviteIds: [inviteId],
        });
      }),
  });
  return {
    ...createCanonicalGameplayRepository(env.PROFILE_DB, d1, {
      createFailure: createGameplayRepositoryFailure,
      maxAttempts: MAX_WAGER_TRANSFER_TRANSACTION_ATTEMPTS,
      now,
    }),
    ...matchSource,
    ...automatchPersistence.client,
    wagers: createWagerStateReader(env.PROFILE_DB),
    wagerFrozen,
    automatchPersistence,
  };
}
