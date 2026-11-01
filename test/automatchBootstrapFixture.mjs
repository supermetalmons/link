export const automatchOperationId = "00000000-0000-4000-8000-000000000001";

/** @returns {import("@mons/shared/game-bootstrap").ReadGameBootstrapResponse} */
export function automatchBootstrap({
  inviteId = "auto_bootstrap",
  hostId = "h".repeat(28),
  guestId = "g".repeat(28),
  operationId = automatchOperationId,
} = {}) {
  /**
   * @param {import("@mons/shared/game-sessions").GameSessionMatch["color"]} color
   * @returns {import("@mons/shared/game-sessions").GameSessionMatch}
   */
  const record = (color) => ({
    schemaVersion: 1,
    version: 2,
    color,
    emojiId: 1,
    aura: "none",
    gameVariant: "Classic",
    fen: "initial",
    status: "active",
    flatMovesString: "",
    timer: { state: "idle" },
  });
  return {
    ok: true,
    schemaVersion: 1,
    metadata: {
      inviteId,
      revision: 2,
      hostId,
      guestId,
      hostColor: "white",
      hostRematches: { state: "open", indices: [] },
      guestRematches: { state: "open", indices: [] },
      automatchStateHint: "matched",
      eventId: null,
      eventOwned: false,
    },
    viewer: {
      role: "host",
      actorUid: hostId,
      automatchOperationId: operationId,
    },
    match: {
      inviteId,
      matchId: inviteId,
      revision: 3,
      hostPlayerId: hostId,
      guestPlayerId: guestId,
      hostMatch: record("white"),
      guestMatch: record("black"),
    },
    hasPendingProposal: false,
  };
}
