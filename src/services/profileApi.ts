import {
  isLeaderboardReadResponse,
  isProfileCustomizationUpdateResponse,
  isProfileLookupResponse,
  type CompletePlayerProfile,
  type LeaderboardReadRequest,
  type LeaderboardReadResponse,
  type LeaderboardReadType,
  type ProfileLookupRequest,
  type ProfileLookupResponse,
  type ProfileCustomizationUpdateRequest,
  type ProfileCustomizationUpdateResponse,
} from "@mons/shared/profiles";
import type { AuthTokenProvider } from "./authApi";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > PROFILE_API_MAX_RESPONSE_BYTES
  ) {
    cancelBody(response);
    throw new ProfileApiError("unavailable", "Profile service is unavailable.");
  }
  if (!response.body) {
    throw new ProfileApiError("unavailable", "Profile service is unavailable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > PROFILE_API_MAX_RESPONSE_BYTES) {
        throw new Error("oversized-response");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new ProfileApiError("unavailable", "Profile service is unavailable.");
  }
}

function responseError(value: unknown, status: number): ProfileApiError {
  const body = isRecord(value) ? value : {};
  const code =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : status === 401
        ? "unauthenticated"
        : "unavailable";
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Profile service is unavailable.";
  return new ProfileApiError(code, message, body.details);
}

async function profileRequest<T>(
  path: string,
  body:
    | ProfileLookupRequest
    | LeaderboardReadRequest
    | ProfileCustomizationUpdateRequest
    | UsernameEditRequest,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  options: { keepalive?: boolean } = {},
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new ProfileApiError("unavailable", "Profile request timed out."));
    }, PROFILE_API_TIMEOUT_MS);
  });
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await tokenProvider(attempt === 1);
        if (controller.signal.aborted) {
          throw new ProfileApiError(
            "unavailable",
            "Profile request timed out.",
          );
        }
        const response = await fetch(`${PROFILE_API_ROOT}${path}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          cache: "no-store",
          keepalive: options.keepalive,
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
          continue;
        }
        const payload = await readBoundedJson(response);
        if (!response.ok) {
          throw responseError(payload, response.status);
        }
        if (!validate(payload)) {
          throw new ProfileApiError(
            "unavailable",
            "Profile service is unavailable.",
          );
        }
        return payload;
      } catch (error) {
        if (error instanceof ProfileApiError) {
          throw error;
        }
        throw new ProfileApiError(
          "unavailable",
          "Profile service is unavailable.",
        );
      }
    }
    throw new ProfileApiError("unauthenticated", "authentication-required");
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
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
