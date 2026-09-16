export const automatchOperationId = "00000000-0000-4000-8000-000000000001";

export function automatchBootstrap({
  inviteId = "auto_bootstrap",
  hostId = "h".repeat(28),
  guestId = "g".repeat(28),
  operationId = automatchOperationId,
} = {}) {
  const record = (color) => ({
    version: 2,
    color,
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "initial",
    status: "",
    flatMovesString: "",
    timer: "",
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
      hostRematches: "",
      guestRematches: "",
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
