import {
  isHistoricalMatchPair,
  type HistoricalMatchPair,
} from "@mons/shared/game-sessions";
import {
  isMatchPresentationSnapshot,
  type MatchPresentationSnapshot,
} from "@mons/shared/match-presentation";
import {
  HistoricalMatchConflict,
  readHistoricalMatchSnapshot,
  writeHistoricalMatchSnapshot,
} from "./historicalMatchesD1.ts";

type PresentationSeed = { emojiId: number; aura: string };

export type FreezeHistoricalMatchPresentations = (
  inviteId: string,
  matchId: string,
  seeds: Record<string, PresentationSeed>,
) => Promise<MatchPresentationSnapshot>;

type HistoricalMatchArchiveInput = Omit<
  Parameters<typeof writeHistoricalMatchSnapshot>[1],
  "expectedRevision"
>;

function pairPresentations(pair: HistoricalMatchPair) {
  const presentations = new Map<string, PresentationSeed>();
  if (pair.hostMatch) {
    presentations.set(pair.hostPlayerId, {
      emojiId: pair.hostMatch.emojiId,
      aura: pair.hostMatch.aura,
    });
  }
  if (pair.guestPlayerId && pair.guestMatch) {
    presentations.set(pair.guestPlayerId, {
      emojiId: pair.guestMatch.emojiId,
      aura: pair.guestMatch.aura,
    });
  }
  return presentations;
}

function applyPresentations(
  pair: HistoricalMatchPair,
  presentations: Map<string, PresentationSeed>,
): HistoricalMatchPair {
  return {
    ...pair,
    hostMatch: pair.hostMatch
      ? { ...pair.hostMatch, ...presentations.get(pair.hostPlayerId) }
      : null,
    guestMatch:
      pair.guestPlayerId && pair.guestMatch
        ? { ...pair.guestMatch, ...presentations.get(pair.guestPlayerId) }
        : null,
  };
}

export async function archiveHistoricalMatchWithPresentation(
  db: D1Database,
  input: HistoricalMatchArchiveInput,
  freeze: FreezeHistoricalMatchPresentations,
): Promise<void> {
  if (!isHistoricalMatchPair(input.pair)) {
    throw new TypeError("invalid-historical-match-pair");
  }
  const { inviteId, pair } = input;
  const seeds = pairPresentations(pair);
  const frozen = new Map<string, PresentationSeed>();
  let existing = await readHistoricalMatchSnapshot(db, inviteId, pair.matchId);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (existing?.source === "rating" && input.source !== "rating") return;
    const presentations = existing
      ? pairPresentations(existing.pair)
      : new Map<string, PresentationSeed>();
    const missing = [...seeds].filter(
      ([actorUid]) => !presentations.has(actorUid) && !frozen.has(actorUid),
    );
    if (missing.length > 0) {
      const snapshot = await freeze(
        inviteId,
        pair.matchId,
        Object.fromEntries(missing),
      );
      if (
        !isMatchPresentationSnapshot(snapshot) ||
        snapshot.matchId !== pair.matchId
      ) {
        throw new Error("historical-match-presentation-unavailable");
      }
      for (const [actorUid] of missing) {
        const presentation = Object.hasOwn(snapshot.players, actorUid)
          ? snapshot.players[actorUid]
          : null;
        if (!presentation) {
          throw new Error("historical-match-presentation-unavailable");
        }
        frozen.set(actorUid, {
          emojiId: presentation.emojiId,
          aura: presentation.aura,
        });
      }
    }
    for (const [actorUid, presentation] of frozen) {
      if (!presentations.has(actorUid)) {
        presentations.set(actorUid, presentation);
      }
    }
    try {
      await writeHistoricalMatchSnapshot(db, {
        ...input,
        pair: applyPresentations(pair, presentations),
        expectedRevision: existing?.revision ?? null,
      });
      return;
    } catch (error) {
      if (!(error instanceof HistoricalMatchConflict) || attempt > 0) {
        throw error;
      }
      existing = await readHistoricalMatchSnapshot(db, inviteId, pair.matchId);
      if (!existing) throw error;
    }
  }
}
