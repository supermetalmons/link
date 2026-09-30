// Generated from src/shared/invite-wagers.ts. Run npm run generate:runtime.
import type { MiningMaterialName } from "./mining.js";
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
declare const INVITE_WAGERS_SOCKET_PROTOCOL = "mons-invite-wagers-v1";
declare const INVITE_WAGERS_MAX_MESSAGE_BYTES: number;
declare const INVITE_WAGERS_REFRESH_MS = 5000;
declare function isPublicWagerProposal(
  value: unknown,
): value is PublicWagerProposal;
declare function isPublicWagerAgreement(
  value: unknown,
): value is PublicWagerAgreement;
declare function isPublicWagerResolution(
  value: unknown,
): value is PublicWagerResolution;
declare function isPublicMatchWagerState(
  value: unknown,
): value is PublicMatchWagerState;
declare function isInviteWagersSnapshot(
  value: unknown,
): value is InviteWagersSnapshot;
declare function isReadInviteWagersResponse(
  value: unknown,
): value is ReadInviteWagersResponse;
declare function isInviteWagersMessage(
  value: unknown,
): value is InviteWagersMessage;
export {
  INVITE_WAGERS_SOCKET_PROTOCOL,
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  INVITE_WAGERS_REFRESH_MS,
  isPublicWagerProposal,
  isPublicWagerAgreement,
  isPublicWagerResolution,
  isPublicMatchWagerState,
  isInviteWagersSnapshot,
  isReadInviteWagersResponse,
  isInviteWagersMessage,
};
