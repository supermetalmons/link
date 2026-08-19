import {
  isLeaderboardReadRequest,
  isProfileLookupRequest,
  type LeaderboardReadResponse,
  type ProfileLookupResponse,
} from "@mons/shared/profiles";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  verifyFirebaseRequest,
  type FirebaseIdentity,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import { readBoundedJson } from "./http.ts";
import {
  createProfileRepository,
  type ProfileRepository,
} from "./profileRepository.ts";

export const PROFILE_PATHS = new Set([
  "/leaderboards/read",
  "/profiles/lookup",
]);

export type ProfileRouteDependencies = {
  logFailure?: (kind: string) => void;
  repository?: ProfileRepository;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<FirebaseIdentity>;
};

function validLookupId(kind: "login" | "profile", id: string): boolean {
  const bytes = new TextEncoder().encode(id);
  const characters = Array.from(id).length;
  const hasControlCharacter = Array.from(id).some((character) => {
    const code = character.codePointAt(0) || 0;
    return code <= 0x1f || code === 0x7f;
  });
  return (
    bytes.byteLength > 0 &&
    (kind === "login" ? characters <= 128 : bytes.byteLength <= 1_500) &&
    !hasControlCharacter &&
    (kind !== "profile" || (!id.includes("/") && id !== "." && id !== ".."))
  );
}

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await readBoundedJson(request);
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
}

export async function handleProfileRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: ProfileRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    if (request.method !== "POST") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    const body = await parseBody(request);
    const repository = dependencies.repository || createProfileRepository();
    const pathname = new URL(request.url).pathname;

    if (pathname === "/profiles/lookup") {
      if (!isProfileLookupRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const id = body.id.trim();
      if (!validLookupId(body.kind, id)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const profile =
        body.kind === "login"
          ? await repository.getProfileByLoginId(id, identity.idToken)
          : await repository.getProfileById(id, identity.idToken);
      const response: ProfileLookupResponse = { ok: true, profile };
      return authJsonResponse(response, 200, corsHeaders);
    }

    if (pathname === "/leaderboards/read") {
      if (!isLeaderboardReadRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const response: LeaderboardReadResponse = {
        ok: true,
        profiles: await repository.readLeaderboard(body.type, identity.idToken),
      };
      return authJsonResponse(response, 200, corsHeaders);
    }

    throw new AuthApiFailure(404, "not-found", "not-found");
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "profile-service-unavailable");
    if (failure.status >= 500) {
      (
        dependencies.logFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "profile_route_failure", kind }),
          ))
      )(failure.message);
    }
    return authErrorResponse(failure, corsHeaders);
  }
}

export { validLookupId };
