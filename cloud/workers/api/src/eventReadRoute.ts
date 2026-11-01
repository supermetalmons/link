import type {
  ApiQuery,
  ApiResponse,
  ApiTransportStatus,
} from "@mons/shared/api-contracts";
import {
  EVENT_BOOKMARK_HEADER,
  EVENT_ETAG_HEADER,
  eventSnapshotEtag,
} from "@mons/shared/events";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import type { ConditionalSnapshot } from "./eventD1.ts";
import {
  verifySessionRequest,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import { createD1ProfileOwnershipReader } from "./profileOwnershipD1.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipReader,
} from "./profileOwnership.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import {
  eventBookmarkConstraint,
  requireEventBookmarkEpoch,
  scopeEventBookmark,
} from "./eventBookmarks.ts";
import { readEventSnapshotResponse } from "./eventSnapshotResponse.ts";
import { readProfileEventPrizesPageResponse } from "./profileEventPrizePagination.ts";
export const EVENT_SNAPSHOT_PATH = "/events/snapshot";
export const PROFILE_EVENT_PRIZES_PATH = "/events/prizes";

type ReadDependencies = {
  repository?: ProfileOwnershipReader;
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
};

function safeKey(value: string): string {
  return value && value.trim() === value && isSafeRecordKey(value) ? value : "";
}

function knownRevision(header: string | null, eventId: string): number | null {
  const value = header?.trim() || "";
  const match = /-(0|[1-9][0-9]*)"$/.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) &&
    eventSnapshotEtag(eventId, revision) === value
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
    "Access-Control-Expose-Headers": `${EVENT_ETAG_HEADER}, ${EVENT_BOOKMARK_HEADER}, Server-Timing`,
  };
}

function notModified(headers: Record<string, string>): Response {
  return new Response(null, {
    status: 304 satisfies ApiTransportStatus<
      "GET /events/snapshot" | "GET /events/prizes",
      "empty"
    >,
    headers: { ...headers, "Cache-Control": "no-store" },
  });
}

async function callerProfileId(
  repository: ProfileOwnershipReader,
  identity: RequestIdentity,
): Promise<string | null> {
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid],
    profileIds: [],
  });
  return getLoginProfileId(ownership, identity.uid);
}

export async function handleEventReadRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: ReadDependencies = {},
): Promise<Response> {
  const startedAt = Date.now();
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, If-None-Match, X-D1-Bookmark, X-Mons-Data-Epoch",
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
    const authenticatedAt = Date.now();
    const url = new URL(request.url);
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
      ApiResponse<"GET /events/snapshot" | "GET /events/prizes">
    >;
    let valueEtag: string;
    const conditionalHeader = request.headers.get("If-None-Match");
    const readStartedAt = Date.now();
    if (url.pathname === EVENT_SNAPSHOT_PATH) {
      const eventId: ApiQuery<"GET /events/snapshot">["eventId"] = safeKey(
        url.searchParams.get(
          "eventId" satisfies keyof ApiQuery<"GET /events/snapshot">,
        ) || "",
      );
      if (!eventId) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-event-id");
      }
      result = (await readEventSnapshotResponse(
        session,
        eventId,
        knownRevision(conditionalHeader, eventId),
      )) satisfies ConditionalSnapshot<ApiResponse<"GET /events/snapshot">>;
      valueEtag = eventSnapshotEtag(
        eventId,
        result.notModified ? result.revision : result.snapshot.revision,
      );
    } else if (url.pathname === PROFILE_EVENT_PRIZES_PATH) {
      const repository =
        dependencies.repository ||
        createD1ProfileOwnershipReader(env.PROFILE_DB);
      const profileId = await callerProfileId(repository, identity);
      const page = await readProfileEventPrizesPageResponse(
        session,
        profileId,
        bookmarkEpoch,
        url.searchParams,
        conditionalHeader,
      );
      result = page.result;
      valueEtag = page.etag;
    } else {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    const bookmark = scopeEventBookmark(session.getBookmark(), bookmarkEpoch);
    const headers = readHeaders(corsHeaders, valueEtag, bookmark);
    headers["Server-Timing"] =
      `auth;dur=${authenticatedAt - startedAt}, event_snapshot;dur=${Date.now() - readStartedAt}, total;dur=${Date.now() - startedAt}`;
    const origin = headers["Access-Control-Allow-Origin"];
    if (origin) headers["Timing-Allow-Origin"] = origin;
    if (result.notModified) {
      return notModified(headers);
    }
    return authJsonResponse<"GET /events/snapshot" | "GET /events/prizes", 200>(
      result.snapshot,
      200,
      headers,
    );
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "event-read-unavailable");
    return authErrorResponse(failure, corsHeaders);
  }
}
