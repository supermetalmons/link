// Generated from src/shared/wagers.ts. Run npm run generate:runtime.
import type {
  MiningMaterialName,
  MiningMaterials,
  MiningSnapshot,
} from "./mining.js";
export interface WagerFrozenReadRequest {
  playerUid: string;
}
export interface WagerFrozenReadResponse {
  ok: true;
  playerUid: string;
  revision: number;
  frozen: MiningMaterials;
}
export type WagerOutcomeResolveFailureReason =
  (typeof WAGER_OUTCOME_RESOLVE_FAILURE_REASONS)[number];
export type WagerOutcomeResolveSuccessReason =
  (typeof WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS)[number];
export interface WagerOutcomeResolveRequest {
  inviteId: string;
  matchId: string;
}
export type WagerOutcomeResolveResponse =
  | {
      ok: true;
      mining: MiningSnapshot | null;
    }
  | {
      ok: true;
      reason: WagerOutcomeResolveSuccessReason;
      mining: MiningSnapshot | null;
    }
  | {
      ok: false;
      reason: WagerOutcomeResolveFailureReason;
    };
export type WagerProposalRemovalFailureReason =
  (typeof WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS)[number];
export interface WagerProposalRemovalRequest {
  inviteId: string;
  matchId: string;
}
export type WagerProposalRemovalResponse =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: WagerProposalRemovalFailureReason;
    };
export type WagerProposalSendFailureReason =
  (typeof WAGER_PROPOSAL_SEND_FAILURE_REASONS)[number];
export type WagerProposalAcceptFailureReason =
  (typeof WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS)[number];
export interface WagerProposalSendRequest {
  inviteId: string;
  matchId: string;
  material: MiningMaterialName;
  count: number;
}
export type WagerProposalAcceptRequest = WagerProposalRemovalRequest;
export interface WagerAgreement {
  material: MiningMaterialName;
  count: number;
  total: number;
  proposerId: string;
  accepterId: string;
  acceptedAt: number;
}
export type WagerProposalSendResponse =
  | {
      ok: true;
      count: number;
      agreed?: WagerAgreement;
    }
  | {
      ok: false;
      reason: WagerProposalSendFailureReason;
    };
export type WagerProposalAcceptResponse =
  | {
      ok: true;
      count: number;
    }
  | {
      ok: false;
      reason: WagerProposalAcceptFailureReason;
    };
declare const WAGER_STORAGE_VERSION_HEADER = "X-Mons-Wager-Storage-Version";
declare const WAGER_STORAGE_VERSION = "1";
declare const WAGER_FROZEN_READ_PATH = "/wagers/frozen/read";
declare const WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
];
declare const WAGER_PROPOSAL_SEND_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "insufficient-materials",
  "proposal-unavailable",
];
declare const WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
  "insufficient-materials",
  "proposal-unavailable",
];
declare const WAGER_OUTCOME_RESOLVE_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "match-not-found",
];
declare const WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS: readonly [
  "no-wager",
  "already-resolved",
];
declare const isWagerFrozenReadRequest: (
  value: unknown,
) => value is WagerFrozenReadRequest;
declare const isWagerFrozenReadResponse: (
  value: unknown,
) => value is WagerFrozenReadResponse;
declare const isWagerProposalRemovalRequest: (
  value: unknown,
) => value is WagerProposalRemovalRequest;
declare const isWagerProposalSendRequest: (
  value: unknown,
) => value is WagerProposalSendRequest;
declare const isWagerOutcomeResolveRequest: (
  value: unknown,
) => value is WagerOutcomeResolveRequest;
declare const isWagerAgreement: (value: unknown) => value is WagerAgreement;
declare const isWagerProposalRemovalResponse: (
  value: unknown,
) => value is WagerProposalRemovalResponse;
declare const isWagerProposalSendResponse: (
  value: unknown,
) => value is WagerProposalSendResponse;
declare const isWagerProposalAcceptResponse: (
  value: unknown,
) => value is WagerProposalAcceptResponse;
declare const isWagerOutcomeResolveResponse: (
  value: unknown,
) => value is WagerOutcomeResolveResponse;
export {
  WAGER_STORAGE_VERSION_HEADER,
  WAGER_STORAGE_VERSION,
  WAGER_FROZEN_READ_PATH,
  WAGER_OUTCOME_RESOLVE_FAILURE_REASONS,
  WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS,
  WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS,
  WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS,
  WAGER_PROPOSAL_SEND_FAILURE_REASONS,
  isWagerAgreement,
  isWagerFrozenReadRequest,
  isWagerFrozenReadResponse,
  isWagerOutcomeResolveRequest,
  isWagerOutcomeResolveResponse,
  isWagerProposalRemovalRequest as isWagerProposalAcceptRequest,
  isWagerProposalAcceptResponse,
  isWagerProposalRemovalRequest,
  isWagerProposalRemovalResponse,
  isWagerProposalSendRequest,
  isWagerProposalSendResponse,
};
