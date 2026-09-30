import type {
  InviteMetadataSnapshot,
  InviteMetadataViewer,
} from "./invite-metadata.js";
import type { MatchSyncSnapshot } from "./match-sync.js";
import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  isReadInviteMetadataResponse,
} from "./invite-metadata.js";
import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  isMatchSyncSnapshot,
} from "./match-sync.js";
import { selectInviteMatch } from "./rematches.js";

export type ReadGameBootstrapResponse = {
  ok: true;
  schemaVersion: 1;
  metadata: InviteMetadataSnapshot;
  viewer: InviteMetadataViewer;
  match: MatchSyncSnapshot;
  hasPendingProposal: boolean;
};

const GAME_BOOTSTRAP_MAX_RESPONSE_BYTES: number =
  INVITE_METADATA_MAX_MESSAGE_BYTES + MATCH_SYNC_MAX_MESSAGE_BYTES + 4096;

function isReadGameBootstrapResponse(
  value: unknown,
): value is ReadGameBootstrapResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(value).length !== 6 ||
    !Object.keys(value).every((key) =>
      [
        "ok",
        "schemaVersion",
        "metadata",
        "viewer",
        "match",
        "hasPendingProposal",
      ].includes(key),
    ) ||
    record.ok !== true ||
    record.schemaVersion !== 1 ||
    typeof record.hasPendingProposal !== "boolean" ||
    !isReadInviteMetadataResponse({
      ok: true,
      snapshot: record.metadata,
      viewer: record.viewer,
    }) ||
    !isMatchSyncSnapshot(record.match) ||
    record.match.inviteId !==
      (record.metadata as InviteMetadataSnapshot).inviteId ||
    record.match.hostPlayerId !==
      (record.metadata as InviteMetadataSnapshot).hostId ||
    record.match.guestPlayerId !==
      (record.metadata as InviteMetadataSnapshot).guestId
  ) {
    return false;
  }
  const response = record as ReadGameBootstrapResponse;
  const selection = selectInviteMatch(
    response.metadata.inviteId,
    response.metadata,
    response.viewer.actorUid,
    { preferApproved: !response.hasPendingProposal },
  );
  return (
    selection.matchId === response.match.matchId &&
    selection.hasPendingProposal === response.hasPendingProposal
  );
}

export { GAME_BOOTSTRAP_MAX_RESPONSE_BYTES, isReadGameBootstrapResponse };
