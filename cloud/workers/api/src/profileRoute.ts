import {
  isLeaderboardReadRequest,
  isProfileCustomizationUpdateRequest,
  isProfileLookupRequest,
  type LeaderboardReadResponse,
  type ProfileCustomizationUpdateResponse,
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
  createProfileCustomizationRepository,
  type ProfileCustomizationRepository,
} from "./profileCustomizationRepository.ts";
import { authorizeProfileCustomization } from "./profileCustomizationPolicy.ts";
import { type ProfileRepository } from "./profileRepository.ts";
import { createConfiguredProfileRepository } from "./profileReadRepository.ts";
import { scheduleProfileReadProjection } from "./profileReadProjection.ts";
import {
  createUsernameRepository,
  type UsernameRepository,
} from "./usernameRepository.ts";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_VALIDATION_MESSAGES,
  isAlphanumericUsername,
  isReservedExplicitUsername,
  isUsernameEditRequest,
  type UsernameEditResponse,
} from "@mons/shared/usernames";

export const PROFILE_PATHS = new Set([
  "/leaderboards/read",
  "/profiles/custom",
  "/profiles/lookup",
  "/profiles/username",
]);

export type ProfileRouteDependencies = {
  logFailure?: (kind: string) => void;
  authorizeCustomization?: typeof authorizeProfileCustomization;
  customizationRepository?: ProfileCustomizationRepository;
  customizationSignal?: AbortSignal;
  repository?: ProfileRepository;
  usernameRepository?: UsernameRepository;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<FirebaseIdentity>;
};

const PROFILE_CUSTOMIZATION_TIMEOUT_MS = 12_000;

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
    const pathname = new URL(request.url).pathname;
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    const body = await parseBody(request);

    if (pathname === "/profiles/username") {
      if (!isUsernameEditRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const username = body.username.trim();
      let validationError = "";
      if (isReservedExplicitUsername(username)) {
        validationError = USERNAME_VALIDATION_MESSAGES.reserved;
      } else if (username.length > USERNAME_MAX_LENGTH) {
        validationError = USERNAME_VALIDATION_MESSAGES.tooLong;
      } else if (username && !isAlphanumericUsername(username)) {
        validationError = USERNAME_VALIDATION_MESSAGES.alphanumeric;
      }
      if (validationError) {
        const response: UsernameEditResponse = {
          ok: false,
          validationError,
        };
        return authJsonResponse(response, 200, corsHeaders);
      }
      const usernameRepository =
        dependencies.usernameRepository ||
        createUsernameRepository(env, {
          projectionCommitted: (profileId) =>
            scheduleProfileReadProjection(ctx, env, profileId),
        });
      const outcome = await usernameRepository.editUsername(
        identity.uid,
        username,
      );
      if (outcome === "taken") {
        return authJsonResponse(
          {
            ok: false,
            validationError: "That name has been taken. Choose another.",
          } satisfies UsernameEditResponse,
          200,
          corsHeaders,
        );
      }
      if (outcome === "cannot-clear") {
        return authJsonResponse(
          {
            ok: false,
            validationError: "Can't be empty.",
          } satisfies UsernameEditResponse,
          200,
          corsHeaders,
        );
      }
      return authJsonResponse(
        { ok: outcome === "updated" } satisfies UsernameEditResponse,
        200,
        corsHeaders,
      );
    }

    if (pathname === "/profiles/custom") {
      if (!isProfileCustomizationUpdateRequest(body)) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
      }
      const signal =
        dependencies.customizationSignal ||
        AbortSignal.timeout(PROFILE_CUSTOMIZATION_TIMEOUT_MS);
      const customizationRepository =
        dependencies.customizationRepository ||
        createProfileCustomizationRepository(env, {
          signal,
          projectionCommitted: (profileId) =>
            scheduleProfileReadProjection(ctx, env, profileId),
        });
      signal.throwIfAborted();
      const outcome = await customizationRepository.updateCustomization(
        identity.uid,
        body,
        (profile) =>
          (
            dependencies.authorizeCustomization || authorizeProfileCustomization
          )(body, profile, env, { signal }),
      );
      if (outcome === "profile-not-found") {
        throw new AuthApiFailure(404, "not-found", "profile-not-found");
      }
      if (outcome === "login-profile-conflict") {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "login-profile-conflict",
        );
      }
      return authJsonResponse(
        { ok: true } satisfies ProfileCustomizationUpdateResponse,
        200,
        corsHeaders,
      );
    }

    const repository =
      dependencies.repository || createConfiguredProfileRepository(env);

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
