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
import type { HistoricalMatchPair } from "@mons/shared/game-sessions";
import type {
  MiningMaterialName,
  MiningMaterials,
  MiningSnapshot,
} from "@mons/shared/mining";
import type { MatchStatePort } from "./repositoryContracts.ts";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import type { EventProgressOutboxRecord } from "../../../runtime/events.js";
import { createEventGameplayRepository } from "./eventRepository.ts";
import {
  createCanonicalGameplayRepository,
  createCanonicalRatingRepository,
  type GameplayRepositoryOperation,
} from "./gameplayCanonicalRepository.ts";
import { classifyD1Failure } from "./d1Failure.ts";
import type {
  ProfileOwnershipProfile,
  ProfileOwnershipReader,
} from "./profileOwnership.ts";

const MAX_RATING_TRANSACTION_ATTEMPTS = 5;
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

export type RatingProfile = GameplayProfile & {
  feb2026UniqueOpponents: string[];
  nonce: number;
  totalManaPoints: number;
};

export type RatingUpdateData = {
  completedAtMs?: number;
  eventId?: string;
  eventOwned?: boolean;
  eventProgressReason?: string;
  eventProgressState?: string;
  eventProgressUpdatedAtMs?: number;
  eventProgressVersion?: number;
  historicalMatchArchiveVersion?: number;
  inviteId: string;
  historicalMatchPair?: HistoricalMatchPair;
  isEventMatch?: boolean;
  leaseExpiresAtMs: number;
  matchId: string;
  opponentId: string;
  opponentManaPoints?: number;
  opponentProfileId: string;
  ownerToken: string;
  playerId: string;
  playerManaPoints?: number;
  playerProfileId: string;
  profileGameProjectionReason?: string;
  profileGameProjectionState?: string;
  profileGameProjectionUpdatedAtMs?: number;
  profileGameProjectionVersion?: number;
  shouldUpdateFebruaryChallenge: boolean;
  startedAtMs: number;
  status: string;
  telegramDeliveryVersion?: number | null;
  telegramProjectionReason?: string;
  telegramProjectionState?: string;
  telegramProjectionUpdatedAtMs?: number;
  telegramProjectionVersion?: number;
  updateRatingMessage?: string;
};

export type PendingRatingTelegramProjection = {
  operationId: string;
  updateTime: string;
};

export type PendingRatingProfileGameProjection = {
  inviteId: string;
  matchId: string;
  operationId: string;
  updateTime: string;
  version: number;
};

export type PendingRatingEventProgress = {
  eventId: string;
  inviteId: string;
  matchId: string;
  operationId: string;
  updateTime: string;
  version: number;
};

export type RatingLeaseInput = {
  inviteId: string;
  matchId: string;
  opponentId: string;
  ownerToken: string;
  ownerUid: string;
  playerId: string;
  leaseMs: number;
};

export type RatingLeaseResult = {
  data: RatingUpdateData | null;
  status: "acquired" | "busy" | "done";
};

export type RatingProfilePatch = {
  rating?: number;
  nonce?: number;
  win?: boolean;
  totalManaPoints?: number;
};

export type RatingCompletionPatch = {
  status: "done";
  completedAtMs: number;
  updatedAtMs: number;
  leaseExpiresAtMs: number;
  inviteId?: string;
  matchId?: string;
  playerId?: string;
  opponentId?: string;
  playerProfileId?: string;
  opponentProfileId?: string;
  historicalMatchArchiveVersion?: number;
  historicalMatchPair?: HistoricalMatchPair;
  result?: "gg" | "win";
  canUpdateRatings?: boolean;
  didApplyRatingDelta?: boolean;
  winnerDisplayName?: string;
  loserDisplayName?: string;
  winnerNewRating?: number | null;
  loserNewRating?: number | null;
  playerManaPoints?: number;
  opponentManaPoints?: number;
  shouldUpdateFebruaryChallenge?: boolean;
  updateRatingMessage?: string;
  telegramDeliveryVersion?: number | null;
  isEventMatch?: boolean;
  eventOwned?: boolean;
  eventId?: string | null;
  profileGameProjectionVersion?: number;
  profileGameProjectionState?: "pending";
  profileGameProjectionUpdatedAtMs?: number;
  profileGameProjectionReason?: string | null;
  telegramProjectionVersion?: number;
  telegramProjectionState?: "pending";
  telegramProjectionUpdatedAtMs?: number;
  telegramProjectionReason?: string | null;
  eventProgressVersion?: number;
  eventProgressState?: "pending";
  eventProgressUpdatedAtMs?: number;
  eventProgressReason?: string | null;
};

export type RatingCommitPlan = {
  opponentUpdate: RatingProfilePatch | null;
  playerUpdate: RatingProfilePatch | null;
  repairData: RatingRepairData;
  ratingUpdate: RatingCompletionPatch;
};

export type RatingRepairData = Pick<
  RatingUpdateData,
  "opponentProfileId" | "playerProfileId" | "shouldUpdateFebruaryChallenge"
>;

export type RatingFinalizeInput = {
  inviteId: string;
  matchId: string;
  opponentId: string;
  operationId: string;
  ownerToken: string;
  playerId: string;
};

export type RatingFinalizeResult =
  | { data: RatingUpdateData; status: "replayed" }
  | { data: RatingRepairData; status: "committed" }
  | { status: "lost" };

export type RatingRepository = Pick<
  GameplayRepository,
  | "readInviteMetadata"
  | "readMatchRecord"
  | "readProfileOwnershipSnapshot"
  | "readMatchPair"
> & {
  putEventProgressOutbox(
    outboxId: string,
    record: EventProgressOutboxRecord,
  ): Promise<void>;
  applyFebruaryChallengeReplay: (
    playerProfileId: string,
    opponentProfileId: string,
  ) => Promise<void>;
  finalizeRatingUpdate: (
    input: RatingFinalizeInput,
    buildPlan: (
      player: RatingProfile | null,
      opponent: RatingProfile | null,
    ) => RatingCommitPlan,
  ) => Promise<RatingFinalizeResult>;
  readRatingUpdate: (operationId: string) => Promise<RatingUpdateData | null>;
  hasCompletedRatingUpdate: (
    inviteId: string,
    matchId: string,
  ) => Promise<boolean>;
  tryAcquireRatingLease: (
    input: RatingLeaseInput,
  ) => Promise<RatingLeaseResult>;
};

export type RatingEventProgressRepository = RatingRepository & {
  claimRatingEventProgress: (
    operationId: string,
    updateTime: string,
    claimedAtMs: number,
  ) => Promise<boolean>;
  listDueRatingEventProgress: (
    updatedBeforeMs: number,
    limit: number,
  ) => Promise<PendingRatingEventProgress[]>;
  markRatingEventProgress: (
    operationId: string,
    state: "dead" | "done",
    updatedAtMs: number,
    reason?: string,
  ) => Promise<void>;
};

export type RatingProjectionRepository = RatingRepository & {
  claimRatingTelegramProjection: (
    operationId: string,
    updateTime: string,
    claimedAtMs: number,
  ) => Promise<boolean>;
  listDueRatingTelegramProjections: (
    updatedBeforeMs: number,
    limit: number,
  ) => Promise<PendingRatingTelegramProjection[]>;
  markRatingTelegramProjection: (
    operationId: string,
    state: "dead" | "done",
    updatedAtMs: number,
    reason?: string,
  ) => Promise<void>;
};

export type RatingProfileGameProjectionRepository = RatingRepository & {
  claimRatingProfileGameProjection: (
    operationId: string,
    updateTime: string,
    claimedAtMs: number,
  ) => Promise<boolean>;
  listDueRatingProfileGameProjections: (
    updatedBeforeMs: number,
    limit: number,
  ) => Promise<PendingRatingProfileGameProjection[]>;
  markRatingProfileGameProjection: (
    operationId: string,
    state: "dead" | "done",
    updatedAtMs: number,
    reason?: string,
  ) => Promise<void>;
};

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

type RatingRepositoryDependencies = {
  maxTransactionAttempts?: number;
  now?: () => number;
};

export class GameplayRepositoryFailure extends Error {
  readonly operation: GameplayRepositoryOperation;

  constructor(operation: GameplayRepositoryOperation, options?: ErrorOptions) {
    super("gameplay-repository-unavailable", options);
    this.operation = operation;
  }
}

function createGameplayRepositoryFailure(
  operation: GameplayRepositoryOperation,
  options?: ErrorOptions,
): GameplayRepositoryFailure {
  console.error(
    JSON.stringify({
      event: "gameplay_repository_failure",
      operation,
      failureKind: classifyD1Failure(options?.cause),
    }),
  );
  return new GameplayRepositoryFailure(operation, options);
}

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

export function createRatingRepository(
  env: Env,
  gameplayRepository: GameplayRepository,
  {
    maxTransactionAttempts = MAX_RATING_TRANSACTION_ATTEMPTS,
    now = Date.now,
  }: RatingRepositoryDependencies = {},
): RatingProjectionRepository &
  RatingEventProgressRepository &
  RatingProfileGameProjectionRepository {
  const attempts =
    Number.isInteger(maxTransactionAttempts) && maxTransactionAttempts > 0
      ? maxTransactionAttempts
      : MAX_RATING_TRANSACTION_ATTEMPTS;
  return {
    ...createCanonicalRatingRepository(env.PROFILE_DB, gameplayRepository, {
      createFailure: createGameplayRepositoryFailure,
      maxAttempts: attempts,
      now,
    }),
    putEventProgressOutbox: (outboxId, record) =>
      createEventGameplayRepository(
        env,
        gameplayRepository,
      ).putEventProgressOutbox(outboxId, record),
  };
}
