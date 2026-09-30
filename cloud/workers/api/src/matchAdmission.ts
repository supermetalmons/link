import { AuthApiFailure } from "./authErrors.ts";
import {
  loginsShareProfile,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipReader,
} from "./profileOwnership.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

const MATCH_ADMISSION_TIMEOUT_MS = 20_000;

export type MatchAdmissionDependencies = {
  assertMutationAllowed?: () => Promise<void>;
  signal?: AbortSignal;
};

export function createMatchAdmissionSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MATCH_ADMISSION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function authorizeMatchPlayer(
  identity: RequestIdentity,
  playerId: string,
  repository: ProfileOwnershipReader,
  {
    signal,
    additionalLoginUids = [],
  }: {
    signal?: AbortSignal;
    additionalLoginUids?: readonly string[];
  } = {},
): Promise<void> {
  if (identity.uid === playerId) return;
  signal?.throwIfAborted();
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid, playerId, ...additionalLoginUids],
    profileIds: [],
  });
  if (!loginsShareProfile(ownership, identity.uid, playerId)) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
}
