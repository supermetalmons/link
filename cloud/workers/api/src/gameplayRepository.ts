import type {
  MiningMaterialName,
  MiningMaterials,
  MiningSnapshot,
} from "@mons/shared/mining";
import {
  createAutomatchPersistence,
  type AutomatchPersistence,
} from "./automatchPersistence.ts";
import { measureAutomatchPhase } from "./automatchTelemetry.ts";
import type {
  GameSessionPort,
  GameSessionRecoveryContext,
} from "./gameSessionContracts.ts";
import { createCanonicalGameplayRepository } from "./gameplayCanonicalRepository.ts";
import { createGameplayRepositoryFailure } from "./gameplayRepositoryPolicy.ts";
import { notifyInviteSessionCommitted } from "./inviteWagersNotifications.ts";
import { prepareCreatedMatchPresentations } from "./matchPresentationRegistry.ts";
import { createMatchStateSource } from "./matchStateSource.ts";
import type {
  ProfileOwnershipProfile,
  ProfileOwnershipReader,
} from "./profileOwnership.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import type { WagerFrozenStore } from "./wagerFrozenStore.ts";
import {
  createWagerStateReader,
  type WagerReader,
  type WagerWriter,
} from "./wagerStateRepository.ts";

const MAX_WAGER_TRANSFER_TRANSACTION_ATTEMPTS = 5;

type NavigationGameDocument = {
  status: string | null;
};

type NavigationGameDeleteResult = "deleted" | "missing";

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
  GameSessionRecoveryContext &
  MatchStatePort & {
    wagers: WagerReader;
    automatchPersistence: AutomatchPersistence;
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

export type WagerWriteRepository = GameplayRepository & {
  wagerWriter: WagerWriter;
  wagerFrozen: WagerFrozenStore;
};

type GameplayRepositoryDependencies = {
  d1?: D1Database;
  now?: () => number;
  stateClient?: MatchStatePort;
};

export function createGameplayRepository(
  env: Env,
  {
    d1 = env.PROFILE_GAMES_DB,
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
        await notifyInviteSessionCommitted(env, [inviteId]);
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
    automatchPersistence,
  };
}
