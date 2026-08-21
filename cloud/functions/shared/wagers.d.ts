import type { MiningMaterialName, MiningSnapshot } from "./mining";

export const WAGER_OUTCOME_RESOLVE_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "match-not-found",
];

export type WagerOutcomeResolveFailureReason =
  (typeof WAGER_OUTCOME_RESOLVE_FAILURE_REASONS)[number];

export const WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS: readonly [
  "no-wager",
  "already-resolved",
];

export type WagerOutcomeResolveSuccessReason =
  (typeof WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS)[number];

export interface WagerOutcomeResolveRequest {
  inviteId: string;
  matchId: string;
}

export type WagerOutcomeResolveResponse =
  | { ok: true; mining: MiningSnapshot | null }
  | {
      ok: true;
      reason: WagerOutcomeResolveSuccessReason;
      mining: MiningSnapshot | null;
    }
  | { ok: false; reason: WagerOutcomeResolveFailureReason };

export const WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
];

export type WagerProposalRemovalFailureReason =
  (typeof WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS)[number];

export interface WagerProposalRemovalRequest {
  inviteId: string;
  matchId: string;
}

export type WagerProposalRemovalResponse =
  { ok: true } | { ok: false; reason: WagerProposalRemovalFailureReason };

export const WAGER_PROPOSAL_SEND_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "insufficient-materials",
  "proposal-unavailable",
];

export type WagerProposalSendFailureReason =
  (typeof WAGER_PROPOSAL_SEND_FAILURE_REASONS)[number];

export const WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS: readonly [
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
  "insufficient-materials",
  "proposal-unavailable",
];

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
  | { ok: true; count: number; agreed?: WagerAgreement }
  | { ok: false; reason: WagerProposalSendFailureReason };

export type WagerProposalAcceptResponse =
  | { ok: true; count: number }
  | { ok: false; reason: WagerProposalAcceptFailureReason };

export function isWagerProposalRemovalRequest(
  value: unknown,
): value is WagerProposalRemovalRequest;
export function isWagerOutcomeResolveRequest(
  value: unknown,
): value is WagerOutcomeResolveRequest;
export function isWagerOutcomeResolveResponse(
  value: unknown,
): value is WagerOutcomeResolveResponse;
export function isWagerProposalRemovalResponse(
  value: unknown,
): value is WagerProposalRemovalResponse;
export function isWagerProposalSendRequest(
  value: unknown,
): value is WagerProposalSendRequest;
export function isWagerProposalAcceptRequest(
  value: unknown,
): value is WagerProposalAcceptRequest;
export function isWagerAgreement(value: unknown): value is WagerAgreement;
export function isWagerProposalSendResponse(
  value: unknown,
): value is WagerProposalSendResponse;
export function isWagerProposalAcceptResponse(
  value: unknown,
): value is WagerProposalAcceptResponse;
