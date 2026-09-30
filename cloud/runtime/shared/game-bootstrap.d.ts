// Generated from src/shared/game-bootstrap.ts. Run npm run generate:runtime.
import type {
  InviteMetadataSnapshot,
  InviteMetadataViewer,
} from "./invite-metadata.js";
import type { MatchSyncSnapshot } from "./match-sync.js";
export type ReadGameBootstrapResponse = {
  ok: true;
  schemaVersion: 1;
  metadata: InviteMetadataSnapshot;
  viewer: InviteMetadataViewer;
  match: MatchSyncSnapshot;
  hasPendingProposal: boolean;
};
declare const GAME_BOOTSTRAP_MAX_RESPONSE_BYTES: number;
declare function isReadGameBootstrapResponse(
  value: unknown,
): value is ReadGameBootstrapResponse;
export { GAME_BOOTSTRAP_MAX_RESPONSE_BYTES, isReadGameBootstrapResponse };
