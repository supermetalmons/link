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
const FIREBASE_EVENT_SNAPSHOT_TIMEOUT_MS = 10_000;
const FIREBASE_EVENT_BOOKMARK = "firebase";

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

type EventReadBackend =
  | { kind: "d1"; session: D1DatabaseSession }
  | {
      kind: "firebase";
      repository: Pick<GameplayRepository, "getRtdbPath">;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeKey(value: string): string {
  return value && value.trim() === value && isSafeFirebaseKey(value)
    ? value
    : "";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function responseRevision(value: unknown): Promise<number> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  const bytes = new Uint8Array(digest);
  let revision = 0;
  for (let index = 0; index < 6; index += 1) {
    revision = revision * 256 + bytes[index];
  }
  return revision || 1;
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

export async function readFirebaseEvent(
  repository: Pick<GameplayRepository, "getRtdbPath">,
  eventId: string,
): Promise<EventSnapshotResponse> {
  let stable: [unknown, unknown] | null = null;
  const signal = AbortSignal.timeout(FIREBASE_EVENT_SNAPSHOT_TIMEOUT_MS);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const eventBefore = await repository.getRtdbPath(
      `events/${eventId}`,
      undefined,
      signal,
    );
    const selectionValue = await repository.getRtdbPath(
      `eventPrizeSelections/${eventId}`,
      undefined,
      signal,
    );
    const eventAfter = await repository.getRtdbPath(
      `events/${eventId}`,
      undefined,
      signal,
    );
    if (canonicalJson(eventBefore) === canonicalJson(eventAfter)) {
      stable = [eventAfter, selectionValue];
      break;
    }
  }
  if (!stable) {
    throw new AuthApiFailure(503, "unavailable", "event-snapshot-unstable");
  }
  const [eventValue, selectionValue] = stable;
  if (eventValue === null || eventValue === undefined) {
    return {
      ok: true,
      eventId,
      revision: 0,
      event: null,
      prizeSelections: {},
    };
  }
  const event = isRecord(eventValue) ? eventValue : null;
  const prizeSelections = isRecord(selectionValue) ? selectionValue : {};
  const revision = await responseRevision({ event, prizeSelections });
  const response = { ok: true, eventId, revision, event, prizeSelections };
  if (!isEventSnapshotResponse(response)) {
    throw new AuthApiFailure(503, "unavailable", "event-data-invalid");
  }
  return response;
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

async function readFirebasePrizes(
  repository: Pick<GameplayRepository, "getRtdbPath">,
  profileId: string | null,
): Promise<ProfileEventPrizesResponse> {
  if (!profileId) {
    return { ok: true, profileId: null, revision: 0, prizes: {} };
  }
  const value = await repository.getRtdbPath(`profileEventPrizes/${profileId}`);
  const prizes = isRecord(value) ? value : {};
  const revision = await responseRevision(prizes);
  const response = { ok: true, profileId, revision, prizes };
  if (!isProfileEventPrizesResponse(response)) {
    throw new AuthApiFailure(503, "unavailable", "event-prizes-invalid");
  }
  return response;
}

function createReadBackend(
  env: Env,
  source: "firebase" | "d1" | null,
  repository: Pick<GameplayRepository, "getRtdbPath">,
  requestedBookmark: string,
): EventReadBackend {
  if (source !== "d1") return { kind: "firebase", repository };
  return {
    kind: "d1",
    session: env.EVENT_DB.withSession(
      requestedBookmark && requestedBookmark !== FIREBASE_EVENT_BOOKMARK
        ? requestedBookmark
        : "first-primary",
    ),
  };
}

async function readEventResponse(
  backend: EventReadBackend,
  eventId: string,
): Promise<EventSnapshotResponse> {
  if (backend.kind === "firebase") {
    return readFirebaseEvent(backend.repository, eventId);
  }
  const candidate: unknown = {
    ok: true,
    ...(await readEventSnapshot(backend.session, eventId)),
  };
  if (!isEventSnapshotResponse(candidate)) {
    throw new AuthApiFailure(503, "unavailable", "event-data-invalid");
  }
  return candidate;
}

async function readPrizeResponse(
  backend: EventReadBackend,
  profileId: string | null,
): Promise<ProfileEventPrizesResponse> {
  if (backend.kind === "firebase") {
    return readFirebasePrizes(backend.repository, profileId);
  }
  if (!profileId) {
    return { ok: true, profileId: null, revision: 0, prizes: {} };
  }
  const candidate: unknown = {
    ok: true,
    ...(await readProfileEventPrizes(backend.session, profileId)),
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
    const control = await readEventRuntimeControl(env.EVENT_DB);
    const source =
      control.storageMode === "frozen"
        ? control.previousStorageMode
        : control.storageMode;
    const requestedBookmark =
      request.headers.get(EVENT_BOOKMARK_HEADER)?.trim() || "";
    const backend = createReadBackend(
      env,
      source,
      repository,
      requestedBookmark,
    );
    let body: EventSnapshotResponse | ProfileEventPrizesResponse;
    let valueEtag: string;
    if (url.pathname === EVENT_SNAPSHOT_PATH) {
      const eventId = safeKey(url.searchParams.get("eventId") || "");
      if (!eventId) {
        throw new AuthApiFailure(400, "invalid-argument", "invalid-event-id");
      }
      body = await readEventResponse(backend, eventId);
      valueEtag = etag("event-snapshot", eventId, body.revision);
    } else if (url.pathname === PROFILE_EVENT_PRIZES_PATH) {
      const profileId = await callerProfileId(repository, identity);
      body = await readPrizeResponse(backend, profileId);
      valueEtag = etag(
        "profile-event-prizes",
        "profileId" in body ? body.profileId || "none" : "none",
        body.revision,
      );
    } else {
      throw new AuthApiFailure(404, "not-found", "not-found");
    }
    assertBounded(body);
    const bookmark =
      backend.kind === "d1"
        ? backend.session.getBookmark() || FIREBASE_EVENT_BOOKMARK
        : FIREBASE_EVENT_BOOKMARK;
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
