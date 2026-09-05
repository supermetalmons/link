import {
  EVENT_BOOKMARK_HEADER,
  EVENT_ETAG_HEADER,
  MAX_EVENT_READ_RESPONSE_BYTES,
  isEventSnapshotResponse,
  type EventSnapshotResponse,
} from "@mons/shared/events";
import {
  isProfileEventPrizesResponse,
  type ProfileEventPrizesResponse,
} from "@mons/shared/event-prizes";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  readEventRuntimeControl,
  readEventSnapshot,
  readProfileEventPrizes,
} from "./eventD1.ts";
import {
  verifyFirebaseRequest,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export const EVENT_SNAPSHOT_PATH = "/events/snapshot";
export const PROFILE_EVENT_PRIZES_PATH = "/events/prizes";

type ReadDependencies = {
  repository?: Pick<
    GameplayRepository,
    "getRtdbPath" | "readProfileOwnershipSnapshot"
  >;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
};

function safeKey(value: string): string {
  return value && value.trim() === value && isSafeFirebaseKey(value)
    ? value
    : "";
}

function etag(
  kind: "event-snapshot" | "profile-event-prizes",
  id: string,
  revision: number,
): string {
  return `W/"${kind}-${encodeURIComponent(id || "none")}-${revision}"`;
}

function readHeaders(
  corsHeaders: Record<string, string>,
  valueEtag: string,
  bookmark: string,
): Record<string, string> {
  return {
    ...corsHeaders,
    [EVENT_ETAG_HEADER]: valueEtag,
    [EVENT_BOOKMARK_HEADER]: bookmark,
    "Access-Control-Expose-Headers": `${EVENT_ETAG_HEADER}, ${EVENT_BOOKMARK_HEADER}`,
  };
}

function notModified(headers: Record<string, string>): Response {
  return new Response(null, {
    status: 304,
    headers: { ...headers, "Cache-Control": "no-store" },
  });
}

function assertBounded(value: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    MAX_EVENT_READ_RESPONSE_BYTES
  ) {
    throw new AuthApiFailure(503, "unavailable", "event-response-too-large");
  }
}

async function callerProfileId(
  repository: Pick<GameplayRepository, "readProfileOwnershipSnapshot">,
  identity: RequestIdentity,
): Promise<string | null> {
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid],
    profileIds: [],
  });
  return getLoginProfileId(ownership, identity.uid);
}

async function readEventResponse(
  session: D1DatabaseSession,
  eventId: string,
): Promise<EventSnapshotResponse> {
  const candidate: unknown = {
    ok: true,
    ...(await readEventSnapshot(session, eventId)),
  };
  if (!isEventSnapshotResponse(candidate)) {
    throw new AuthApiFailure(503, "unavailable", "event-data-invalid");
  }
  return candidate;
}

async function readPrizeResponse(
  session: D1DatabaseSession,
  profileId: string | null,
): Promise<ProfileEventPrizesResponse> {
  if (!profileId) {
    await readEventRuntimeControl(session);
    return { ok: true, profileId: null, revision: 0, prizes: {} };
  }
  const candidate: unknown = {
    ok: true,
    ...(await readProfileEventPrizes(session, profileId)),
  };
  if (!isProfileEventPrizesResponse(candidate)) {
    throw new AuthApiFailure(503, "unavailable", "event-prizes-invalid");
  }
  return candidate;
}

export async function handleEventReadRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: ReadDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, If-None-Match, X-D1-Bookmark",
      "Access-Control-Expose-Headers": "ETag, X-D1-Bookmark",
    };
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    if (request.method !== "GET") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    const url = new URL(request.url);
    const repository = dependencies.repository || createGameplayRepository(env);
    const requestedBookmark =
      request.headers.get(EVENT_BOOKMARK_HEADER)?.trim() || "";
    const session = env.EVENT_DB.withSession(
      requestedBookmark || "first-primary",
    );
    let body: EventSnapshotResponse | ProfileEventPrizesResponse;
    let valueEtag: string;
    if (url.pathname === EVENT_SNAPSHOT_PATH) {
      const eventId = safeKey(url.searchParams.get("eventId") || "");
      if (!eventId) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-event-id");
      }
      body = await readEventResponse(session, eventId);
      valueEtag = etag("event-snapshot", eventId, body.revision);
    } else if (url.pathname === PROFILE_EVENT_PRIZES_PATH) {
      const profileId = await callerProfileId(repository, identity);
      body = await readPrizeResponse(session, profileId);
      valueEtag = etag(
        "profile-event-prizes",
        "profileId" in body ? body.profileId || "none" : "none",
        body.revision,
      );
    } else {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    assertBounded(body);
    const bookmark = session.getBookmark() || "";
    const headers = readHeaders(corsHeaders, valueEtag, bookmark);
    if (request.headers.get("If-None-Match")?.trim() === valueEtag) {
      return notModified(headers);
    }
    return authJsonResponse(body, 200, headers);
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "event-read-unavailable");
    return authErrorResponse(failure, corsHeaders);
  }
}
