import { buildAutoInviteId, type RandomSource } from "@mons/shared/ids";
import { AuthApiFailure } from "./authErrors.ts";

export const RETIRED_INVITE_IDS = [
  "auto_UvYcAmAcgwV",
  "auto_tye5L1mHNQJ",
] as const;

export function isRetiredInviteId(inviteId: string): boolean {
  return RETIRED_INVITE_IDS.some((retired) => retired === inviteId);
}

export function assertInviteNotRetired(inviteId: string): void {
  if (isRetiredInviteId(inviteId))
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
}

export function buildAvailableAutoInviteId(random: RandomSource): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const inviteId = buildAutoInviteId(random);
    if (!isRetiredInviteId(inviteId)) return inviteId;
  }
  throw new AuthApiFailure(503, "unavailable", "automatch-id-unavailable");
}
