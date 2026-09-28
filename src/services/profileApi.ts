import {
  isLeaderboardReadResponse,
  isProfileCustomizationUpdateResponse,
  isProfileLookupResponse,
  isResolveProfileIdResponse,
  type CompletePlayerProfile,
  type LeaderboardReadRequest,
  type LeaderboardReadResponse,
  type LeaderboardReadType,
  type ProfileLookupRequest,
  type ProfileLookupResponse,
  type ResolveProfileIdRequest,
  type ProfileCustomizationUpdateRequest,
  type ProfileCustomizationUpdateResponse,
} from "@mons/shared/profiles";
import {
  authenticatedJsonRequest,
  type ApiErrorPolicy,
  type AuthTokenProvider,
} from "./apiTransport";
import {
  isUsernameEditResponse,
  type UsernameEditRequest,
  type UsernameEditResponse,
} from "@mons/shared/usernames";

const PROFILE_API_ROOT = "https://api.mons.link";
const PROFILE_API_TIMEOUT_MS = 15_000;
const PROFILE_API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ProfileApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ProfileApiError";
    this.code = code;
    this.details = details;
  }
}

const profileErrorPolicy: ApiErrorPolicy = {
  createError: (code, message, details) =>
    new ProfileApiError(code, message, details),
  normalizeError: (error) =>
    error instanceof ProfileApiError ? error : undefined,
  unavailableMessage: "Profile service is unavailable.",
  timeoutMessage: "Profile request timed out.",
};

async function profileRequest<T>(
  path: string,
  body:
    | ProfileLookupRequest
    | ResolveProfileIdRequest
    | LeaderboardReadRequest
    | ProfileCustomizationUpdateRequest
    | UsernameEditRequest,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  options: { keepalive?: boolean } = {},
): Promise<T> {
  return authenticatedJsonRequest({
    url: `${PROFILE_API_ROOT}${path}`,
    createRequestInit: () => ({
      method: "POST",
      body: JSON.stringify(body),
      keepalive: options.keepalive,
    }),
    tokenProvider,
    validate,
    timeoutMs: PROFILE_API_TIMEOUT_MS,
    maxResponseBytes: PROFILE_API_MAX_RESPONSE_BYTES,
    errors: profileErrorPolicy,
  });
}

async function lookupProfile(
  request: ProfileLookupRequest,
  tokenProvider: AuthTokenProvider,
): Promise<ProfileLookupResponse> {
  return profileRequest(
    "/profiles/lookup",
    request,
    tokenProvider,
    isProfileLookupResponse,
  );
}

export async function getProfileByLoginIdViaApi(
  loginId: string,
  tokenProvider: AuthTokenProvider,
): Promise<CompletePlayerProfile> {
  const response = await lookupProfile(
    { kind: "login", id: loginId },
    tokenProvider,
  );
  if (!response.profile) {
    throw new ProfileApiError("not-found", "Profile not found");
  }
  return response.profile;
}

export async function getProfileByIdViaApi(
  profileId: string,
  tokenProvider: AuthTokenProvider,
): Promise<CompletePlayerProfile | null> {
  return (
    await lookupProfile({ kind: "profile", id: profileId }, tokenProvider)
  ).profile;
}

export async function resolveProfileIdViaApi(
  profileId: string,
  tokenProvider: AuthTokenProvider,
): Promise<string | null> {
  const response = await profileRequest(
    "/profiles/canonical-id",
    { profileId },
    tokenProvider,
    isResolveProfileIdResponse,
  );
  return response.profileId;
}

export async function readLeaderboardViaApi(
  type: LeaderboardReadType,
  tokenProvider: AuthTokenProvider,
): Promise<CompletePlayerProfile[]> {
  const response: LeaderboardReadResponse = await profileRequest(
    "/leaderboards/read",
    { type },
    tokenProvider,
    isLeaderboardReadResponse,
  );
  return response.profiles;
}

export function editUsernameViaApi(
  username: string,
  tokenProvider: AuthTokenProvider,
): Promise<UsernameEditResponse> {
  return profileRequest(
    "/profiles/username",
    { username },
    tokenProvider,
    isUsernameEditResponse,
  );
}

export function updateProfileCustomizationViaApi(
  request: ProfileCustomizationUpdateRequest,
  tokenProvider: AuthTokenProvider,
): Promise<ProfileCustomizationUpdateResponse> {
  return profileRequest(
    "/profiles/custom",
    request,
    tokenProvider,
    isProfileCustomizationUpdateResponse,
    { keepalive: true },
  );
}

export {
  PROFILE_API_MAX_RESPONSE_BYTES,
  PROFILE_API_ROOT,
  PROFILE_API_TIMEOUT_MS,
};
