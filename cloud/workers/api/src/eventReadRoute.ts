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
  readEventSnapshotIfChanged,
  readProfileEventPrizesIfChanged,
  type ConditionalSnapshot,
} from "./eventD1.ts";
import {
  verifySessionRequest,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import {
  eventBookmarkConstraint,
  requireEventBookmarkEpoch,
  scopeEventBookmark,
} from "./eventBookmarks.ts";

export const EVENT_SNAPSHOT_PATH = "/events/snapshot";
export const PROFILE_EVENT_PRIZES_PATH = "/events/prizes";

type ReadDependencies = {
  repository?: Pick<
    GameplayRepository,
    "getStatePath" | "readProfileOwnershipSnapshot"
  >;
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
};

function safeKey(value: string): string {
  return value && value.trim() === value && isSafeRecordKey(value) ? value : "";
}

function etag(
  kind: "event-snapshot" | "profile-event-prizes",
  id: string,
  revision: number,
): string {
  return `W/"${kind}-${encodeURIComponent(id || "none")}-${revision}"`;
}

function knownRevision(
  header: string | null,
  kind: "event-snapshot" | "profile-event-prizes",
  id: string,
): number | null {
  const value = header?.trim() || "";
  const match = /-(0|[1-9][0-9]*)"$/.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && etag(kind, id, revision) === value
    ? revision
    : null;
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
  revision: number | null,
): Promise<ConditionalSnapshot<EventSnapshotResponse>> {
  const result = await readEventSnapshotIfChanged(session, eventId, revision);
  if (result.notModified) return result;
  const candidate: unknown = {
    ok: true,
    ...result.snapshot,
  };
  if (!isEventSnapshotResponse(candidate)) {
    throw new AuthApiFailure(503, "unavailable", "event-data-invalid");
  }
  return { notModified: false, snapshot: candidate };
}

async function readPrizeResponse(
  session: D1DatabaseSession,
  profileId: string | null,
  revision: number | null,
): Promise<ConditionalSnapshot<ProfileEventPrizesResponse>> {
  if (!profileId) {
    await readEventRuntimeControl(session);
    return revision === 0
      ? { notModified: true, revision: 0 }
      : {
          notModified: false,
          snapshot: { ok: true, profileId: null, revision: 0, prizes: {} },
        };
  }
  const result = await readProfileEventPrizesIfChanged(
    session,
    profileId,
    revision,
  );
  if (result.notModified) return result;
  const candidate: unknown = {
    ok: true,
    ...result.snapshot,
  };
  if (!isProfileEventPrizesResponse(candidate)) {
    throw new AuthApiFailure(503, "unavailable", "event-prizes-invalid");
  }
  return { notModified: false, snapshot: candidate };
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
      dependencies.verifyIdentity || verifySessionRequest
    )(request, env, ctx);
    const url = new URL(request.url);
    const repository = dependencies.repository || createGameplayRepository(env);
    const bookmarkEpoch = requireEventBookmarkEpoch(
      env.EVENT_DB_BOOKMARK_EPOCH,
    );
    const session = env.EVENT_DB.withSession(
      eventBookmarkConstraint(
        request.headers.get(EVENT_BOOKMARK_HEADER),
        bookmarkEpoch,
      ),
    );
    let result: ConditionalSnapshot<
      EventSnapshotResponse | ProfileEventPrizesResponse
    >;
    let valueEtag: string;
    const conditionalHeader = request.headers.get("If-None-Match");
    if (url.pathname === EVENT_SNAPSHOT_PATH) {
      const eventId = safeKey(url.searchParams.get("eventId") || "");
      if (!eventId) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-event-id");
      }
      result = await readEventResponse(
        session,
        eventId,
        knownRevision(conditionalHeader, "event-snapshot", eventId),
      );
      valueEtag = etag(
        "event-snapshot",
        eventId,
        result.notModified ? result.revision : result.snapshot.revision,
      );
    } else if (url.pathname === PROFILE_EVENT_PRIZES_PATH) {
      const profileId = await callerProfileId(repository, identity);
      result = await readPrizeResponse(
        session,
        profileId,
        knownRevision(
          conditionalHeader,
          "profile-event-prizes",
          profileId || "none",
        ),
      );
      valueEtag = etag(
        "profile-event-prizes",
        profileId || "none",
        result.notModified ? result.revision : result.snapshot.revision,
      );
    } else {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    if (!result.notModified) assertBounded(result.snapshot);
    const bookmark = scopeEventBookmark(session.getBookmark(), bookmarkEpoch);
    const headers = readHeaders(corsHeaders, valueEtag, bookmark);
    if (result.notModified) {
      return notModified(headers);
    }
    return authJsonResponse(result.snapshot, 200, headers);
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "event-read-unavailable");
    return authErrorResponse(failure, corsHeaders);
  }
}
