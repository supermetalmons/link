import type { Aura } from "@mons/shared/appearance";
import type {
  AutomatchEntryFields,
  AutomatchReceiptView,
} from "../../../../runtime/automatchRecords.js";
import type { RandomSource } from "@mons/shared/ids";
import type {
  StartAutomatchRequest,
  StartAutomatchResponse,
} from "@mons/shared/navigation";
import type { GameplayProfile } from "../gameplayRepository.ts";
import type { GameSessionMutationLockStore } from "../gameplayCoordinationD1.ts";
import type { GameSessionChange } from "../gameSessionContracts.ts";
import type {
  AutomatchProfileGameProjectionTask,
  ProfileGameProjectionTask,
} from "../profileGameProjectionTasks.ts";
import type {
  AutomatchTelegramProjectionTask,
  TelegramProjectionTask,
} from "../telegramProjectionTasks.ts";

export type AutomatchDependencies = {
  assertMutationAllowed?: () => Promise<void>;
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
  mutationLocks: GameSessionMutationLockStore;
  now?: () => number;
  random?: RandomSource;
  signal?: AbortSignal;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type StartAutomatchOperationRequest = StartAutomatchRequest & {
  operationId: string;
};

export type QueuedAutomatch = {
  data: AutomatchEntryFields;
  inviteId: string;
};

export type AutomatchRequesterSnapshot = Readonly<{
  loginUids: readonly string[];
  profile: GameplayProfile | null;
}>;

export type SuccessfulStartAutomatchResponse = Extract<
  StartAutomatchResponse,
  { ok: true }
>;

export type AutomatchPlanDependencies = Pick<
  AutomatchDependencies,
  "createProjectionRequestId"
>;

export type AutomatchPlanInput = {
  requesterUid: string;
  request: StartAutomatchOperationRequest;
  emojiId: GameplayProfile["emoji"];
  aura: Aura;
  name: string;
};

export type AutomatchPlan = {
  response: SuccessfulStartAutomatchResponse;
  changes: GameSessionChange[];
  profileGameProjectionTask: AutomatchProfileGameProjectionTask;
  projectionTask: AutomatchTelegramProjectionTask | null;
};

export type MatchedAutomatchPlan = AutomatchPlan & {
  inviteChange: Extract<GameSessionChange, { kind: "invite-merge" }>;
};

export type AutomatchReceipt = AutomatchReceiptView;
