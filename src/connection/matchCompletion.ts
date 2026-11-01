import { resolveMatch } from "mons-rules";
import { buildOrderedMoveHistory } from "@mons/shared/match-protocol";
import type { MatchSyncSnapshot } from "@mons/shared/match-sync";

export function isCompletedMatchPair({
  hostMatch: host,
  guestMatch: guest,
}: Pick<MatchSyncSnapshot, "hostMatch" | "guestMatch">): boolean {
  if (!host || !guest) return false;
  if (
    [host, guest].some(
      (match) =>
        match.status === "surrendered" || match.timer.state === "finished",
    )
  )
    return true;
  if (host.color === guest.color || !host.fen || !guest.fen) return false;
  try {
    const moves = buildOrderedMoveHistory(host, guest);
    const white = host.color === "white" ? host : guest;
    const black = host.color === "black" ? host : guest;
    return (
      resolveMatch({
        white: { fen: white.fen, moves: moves.white },
        black: { fen: black.fen, moves: moves.black },
      }).kind === "winner"
    );
  } catch {
    return false;
  }
}
