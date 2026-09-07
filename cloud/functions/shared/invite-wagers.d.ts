import type { MiningMaterialName } from "./mining";

export const INVITE_WAGERS_SOCKET_PROTOCOL: "mons-invite-wagers-v1";
export const INVITE_WAGERS_MAX_MESSAGE_BYTES: number;
export const INVITE_WAGERS_REFRESH_MS: 5000;

export type PublicWagerProposal = {
  material: MiningMaterialName;
  count: number;
  createdAt?: number;
};

export type PublicWagerAgreement = {
  material: MiningMaterialName;
  count: number;
  total?: number;
  proposerId: string;
  accepterId: string;
  acceptedAt?: number;
};

export type PublicWagerResolution = {
  winnerId: string;
  loserId: string;
  material: MiningMaterialName;
  count: number;
  total?: number;
  resolvedAt?: number;
};

export type PublicMatchWagerState = {
  proposals?: Record<string, PublicWagerProposal>;
  proposedBy?: Record<string, boolean>;
  agreed?: PublicWagerAgreement;
  resolved?: PublicWagerResolution;
};

export type InviteWagersSnapshot = {
  inviteId: string;
  revision: number;
  wagers: Record<string, PublicMatchWagerState>;
};

export type ReadInviteWagersResponse = {
  ok: true;
  snapshot: InviteWagersSnapshot;
};

export type InviteWagersMessage = {
  schemaVersion: 1;
  type: "snapshot";
  snapshot: InviteWagersSnapshot;
};

export function isPublicWagerProposal(
  value: unknown,
): value is PublicWagerProposal;
export function isPublicWagerAgreement(
  value: unknown,
): value is PublicWagerAgreement;
export function isPublicWagerResolution(
  value: unknown,
): value is PublicWagerResolution;
export function isPublicMatchWagerState(
  value: unknown,
): value is PublicMatchWagerState;
export function isInviteWagersSnapshot(
  value: unknown,
): value is InviteWagersSnapshot;
export function isReadInviteWagersResponse(
  value: unknown,
): value is ReadInviteWagersResponse;
export function isInviteWagersMessage(
  value: unknown,
): value is InviteWagersMessage;
