import {
  isSurrenderMatchRequest,
  type SurrenderMatchRequest,
  type SurrenderMatchResponse,
} from "@mons/shared/game-sessions";
import { AuthApiFailure } from "./authErrors.ts";
import {
  authorizeMatchMutation,
  type MatchMutationAdmissionDependencies,
  type MatchMutationRepository,
} from "./matchMutationAdmission.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export type SurrenderMatchDependencies = MatchMutationAdmissionDependencies & {
  surrenderCanonical: (
    request: SurrenderMatchRequest,
  ) => Promise<SurrenderMatchResponse>;
};

export async function surrenderMatch(
  identity: RequestIdentity,
  request: SurrenderMatchRequest,
  repository: MatchMutationRepository,
  dependencies: SurrenderMatchDependencies,
): Promise<SurrenderMatchResponse> {
  if (!isSurrenderMatchRequest(request)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  await authorizeMatchMutation(identity, request, repository, dependencies);
  return dependencies.surrenderCanonical(request);
}
