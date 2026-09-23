import {
  isSubmitMoveRequest,
  type SubmitMoveRequest,
  type SubmitMoveResponse,
} from "@mons/shared/game-sessions";
import { AuthApiFailure } from "./authErrors.ts";
import {
  authorizeMatchMutation,
  type MatchMutationAdmissionDependencies,
  type MatchMutationRepository,
} from "./matchMutationAdmission.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export type SubmitMoveDependencies = MatchMutationAdmissionDependencies & {
  submitCanonical: (request: SubmitMoveRequest) => Promise<SubmitMoveResponse>;
};

export async function enforceMatchMoveRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `match-move:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many move attempts.",
    );
  }
}

export async function submitMove(
  identity: RequestIdentity,
  request: SubmitMoveRequest,
  repository: MatchMutationRepository,
  dependencies: SubmitMoveDependencies,
): Promise<SubmitMoveResponse> {
  if (!isSubmitMoveRequest(request)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  await authorizeMatchMutation(identity, request, repository, dependencies);
  return dependencies.submitCanonical(request);
}
