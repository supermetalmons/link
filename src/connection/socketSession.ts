import { REACTION_AUTH_PROTOCOL_PREFIX } from "@mons/shared/reactions";

export function socketSessionRefreshDelay(
  protocols?: string[],
  getTokenRemainingMs?: (token: string) => number,
): number | null {
  const protocol = protocols?.find((value) =>
    value.startsWith(REACTION_AUTH_PROTOCOL_PREFIX),
  );
  if (!protocol || !getTokenRemainingMs) return null;
  const remainingMs = getTokenRemainingMs(
    protocol.slice(REACTION_AUTH_PROTOCOL_PREFIX.length),
  );
  return Number.isFinite(remainingMs) ? Math.max(0, remainingMs - 30_000) : 0;
}
