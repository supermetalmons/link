import type { AutomatchPersistence } from "./automatchPersistence.ts";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import type { ProfileOwnershipReader } from "./profileOwnership.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";

export type InviteAccessRepository = ProfileOwnershipReader &
  Pick<GameSessionPort, "readInviteMetadata">;

export type GameSessionRepository = InviteAccessRepository &
  Pick<
    GameSessionPort,
    "readAutomatchEntry" | "readMutationReceipt" | "commitSessionChanges"
  > &
  Pick<MatchStatePort, "readMatchRecord">;

export type AutomatchRepository = ProfileOwnershipReader &
  Pick<
    GameSessionPort,
    | "readInviteMetadata"
    | "readAutomatchEntry"
    | "listAutomatchEntriesByLogin"
    | "readFirstAutomatchEntry"
    | "readMutationReceipt"
    | "commitSessionChanges"
    | "readAutomatchProfileOutbox"
  > & {
    automatchPersistence: Pick<
      AutomatchPersistence,
      "readQueuedByLogins" | "recoverLogins"
    >;
  };
