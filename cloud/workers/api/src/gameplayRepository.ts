import type {
  MiningMaterialName,
  MiningMaterials,
  MiningSnapshot,
} from "@mons/shared/mining";
import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
  type FirebaseRtdbQuery,
  type FirebaseRtdbTransactionResult,
} from "./firebaseRtdb.ts";
import {
  createCanonicalGameplayRepository,
  createCanonicalRatingRepository,
} from "./gameplayCanonicalRepository.ts";

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

export type GameplayProfile = {
  aura: string;
  emoji: number | string;
  eth: string;
  profileId: string;
  rating: number;
  sol: string;
  username: string;
};

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
  inviteId: string;
  isEventMatch?: boolean;
  leaseExpiresAtMs: number;
  matchId: string;
  opponentId: string;
  opponentProfileId: string;
  ownerToken: string;
  playerId: string;
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

export type RatingCommitPlan = {
  opponentUpdate: Record<string, unknown> | null;
  playerUpdate: Record<string, unknown> | null;
  repairData: RatingRepairData;
  ratingUpdate: Record<string, unknown>;
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
  "getRtdbPath" | "patchRtdbRoot"
> & {
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
  getRatingProfile: (uid: string) => Promise<RatingProfile | null>;
  readRatingUpdate: (operationId: string) => Promise<RatingUpdateData | null>;
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

export type GameplayRepository = {
  applyWagerTransferOnce: (
    input: WagerTransferInput,
  ) => Promise<"applied" | "replayed">;
  deleteNavigationGame: (
    profileId: string,
    inviteId: string,
  ) => Promise<NavigationGameDeleteResult>;
  findProfileId: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<string | null>;
  getGameplayProfile: (
    uid: string,
    firebaseIdToken: string,
    signal?: AbortSignal,
  ) => Promise<GameplayProfile | null>;
  getNavigationGame: (
    profileId: string,
    inviteId: string,
    firebaseIdToken: string,
  ) => Promise<NavigationGameDocument | null>;
  getMiningMaterials: (
    profileId: string,
    firebaseIdToken: string,
  ) => Promise<MiningMaterials>;
  getMiningSnapshot: (profileId: string) => Promise<MiningSnapshot | null>;
  getRtdbPath: (
    path: string,
    query?: FirebaseRtdbQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchRtdbRoot: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
  transactRtdbPath: (
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ) => Promise<FirebaseRtdbTransactionResult>;
};

type GameplayRepositoryDependencies = {
  d1?: D1Database;
  fetcher?: typeof fetch;
  now?: () => number;
  rtdbClient?: FirebaseRtdbClient;
  timeoutMs?: number;
};

type RatingRepositoryDependencies = {
  maxTransactionAttempts?: number;
  now?: () => number;
};

export class GameplayRepositoryFailure extends Error {
  constructor() {
    super("gameplay-repository-unavailable");
  }
}

export function createGameplayRepository(
  env: Env,
  {
    d1 = env.PROFILE_GAMES_DB,
    fetcher = fetch,
    now = Date.now,
    timeoutMs,
    rtdbClient = createFirebaseRtdbClient(env, {
      credentials: {
        email: env.GAMEPLAY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
      fetcher,
      now,
      timeoutMs,
    }),
  }: GameplayRepositoryDependencies = {},
): GameplayRepository {
  return createCanonicalGameplayRepository(env.PROFILE_DB, d1, rtdbClient, {
    createFailure: () => new GameplayRepositoryFailure(),
    maxAttempts: MAX_WAGER_TRANSFER_TRANSACTION_ATTEMPTS,
    now,
  });
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
  return createCanonicalRatingRepository(env.PROFILE_DB, gameplayRepository, {
    createFailure: () => new GameplayRepositoryFailure(),
    maxAttempts: attempts,
    now,
  });
}
