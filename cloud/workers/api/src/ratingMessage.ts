import {
  inviteRatingWager,
  type InviteDocument,
} from "@mons/shared/invite-records";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import {
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} from "../../../runtime/telegramDisplay.js";
import type { RatingProfile } from "./ratingContracts.ts";

const materialTelegramEmojiIds: Record<string, string> = {
  dust: "5235835141238063097",
  slime: "5235497595463303384",
  gum: "5233425978117621609",
  metal: "5235794850149863190",
  ice: "5233743994676086020",
};

const matchStatusTelegramEmojiIds = {
  timer: "5229098317530568280",
  whiteFlag: "5228702136862282659",
};

function wagerSuffix(invite: InviteDocument, matchId: string): string {
  const { material, count } = inviteRatingWager(invite, matchId);
  const emojiId = materialTelegramEmojiIds[material] || "";
  const icon = getTelegramEmojiTag(emojiId);
  if (!icon || !Number.isFinite(count) || count <= 0) {
    return "";
  }
  return `${icon} ${Math.round(count)}`;
}

export function buildRatingDisplayNames({
  player,
  opponent,
  playerMatch,
  opponentMatch,
  result,
}: {
  player: RatingProfile;
  opponent: RatingProfile;
  playerMatch: { emojiId: unknown };
  opponentMatch: { emojiId: unknown };
  result: "gg" | "win";
}): { winnerDisplayName: string; loserDisplayName: string } {
  const playerEmoji = player.emoji === "" ? playerMatch.emojiId : player.emoji;
  const opponentEmoji =
    opponent.emoji === "" ? opponentMatch.emojiId : opponent.emoji;
  const playerDisplayName = getDisplayNameFromAddress(
    player.username,
    player.eth,
    player.sol,
    0,
    playerEmoji,
    false,
  );
  const opponentDisplayName = getDisplayNameFromAddress(
    opponent.username,
    opponent.eth,
    opponent.sol,
    0,
    opponentEmoji,
    false,
  );
  const winnerDisplayName =
    result === "win" ? playerDisplayName : opponentDisplayName;
  const loserDisplayName =
    result === "win" ? opponentDisplayName : playerDisplayName;
  return { winnerDisplayName, loserDisplayName };
}

export function buildRatingMessage({
  winnerDisplayName,
  loserDisplayName,
  winnerNewRating,
  loserNewRating,
  winnerScore,
  loserScore,
  shouldApplyRatingDelta,
  playerMatch,
  opponentMatch,
  invite,
  matchId,
}: {
  winnerDisplayName: string;
  loserDisplayName: string;
  winnerNewRating: number;
  loserNewRating: number;
  winnerScore: number;
  loserScore: number;
  shouldApplyRatingDelta: boolean;
  playerMatch: { status: string; timer: string };
  opponentMatch: { status: string; timer: string };
  invite: InviteDocument;
  matchId: string;
}): string {
  let suffix = ` (${winnerScore} - ${loserScore})`;
  if (
    playerMatch.status === "surrendered" ||
    opponentMatch.status === "surrendered"
  ) {
    const icon = getTelegramEmojiTag(matchStatusTelegramEmojiIds.whiteFlag);
    if (icon) {
      suffix += ` ${icon}`;
    }
  } else if (
    playerMatch.timer === MATCH_TIMER_TERMINAL ||
    opponentMatch.timer === MATCH_TIMER_TERMINAL
  ) {
    const icon = getTelegramEmojiTag(matchStatusTelegramEmojiIds.timer);
    if (icon) {
      suffix += ` ${icon}`;
    }
  }
  const wager = wagerSuffix(invite, matchId);
  if (wager) {
    suffix += ` ${wager}`;
  }
  return shouldApplyRatingDelta
    ? `${winnerDisplayName} ${winnerNewRating}↑ ${loserDisplayName} ${loserNewRating}↓${suffix}`
    : `${winnerDisplayName} ↑ ${loserDisplayName}${suffix}`;
}
