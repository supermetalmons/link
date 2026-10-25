import type { ApiQuery } from "@mons/shared/api-contracts";
import { Buffer } from "node:buffer";
import {
  MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH,
  PROFILE_EVENT_PRIZES_PAGE_SIZE,
  profileEventPrizesPageEtag,
  type ProfileEventPrizesPageResponse,
} from "@mons/shared/event-prizes";
import { MAX_EVENT_READ_RESPONSE_BYTES } from "@mons/shared/events";
import { AuthApiFailure } from "./authErrors.ts";
import { requireEventBookmarkEpoch } from "./eventBookmarks.ts";
import { readEventRuntimeControl } from "./eventD1/coordination.ts";
import { readProfileEventPrizePage } from "./eventD1/reads.ts";
import { exactKey, isRecord } from "./eventD1/validation.ts";
import type { ConditionalSnapshot } from "./eventD1/types.ts";
type PrizePageCursor = {
  version: 1;
  profileId: string;
  epoch: string;
  revision: number;
  afterEventId: string;
};

function encodeCursor(
  cursor: PrizePageCursor,
): NonNullable<ApiQuery<"GET /events/prizes">["cursor"]> {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(
  value: NonNullable<ApiQuery<"GET /events/prizes">["cursor"]> | null,
): PrizePageCursor | null {
  if (value === null) return null;
  try {
    if (
      value.length > MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new Error();
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const cursor: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !isRecord(cursor) ||
      Object.keys(cursor).length !== 5 ||
      cursor.version !== 1 ||
      typeof cursor.profileId !== "string" ||
      !exactKey(cursor.profileId) ||
      !cursor.profileId.isWellFormed() ||
      typeof cursor.afterEventId !== "string" ||
      !exactKey(cursor.afterEventId) ||
      !cursor.afterEventId.isWellFormed() ||
      typeof cursor.revision !== "number" ||
      !Number.isSafeInteger(cursor.revision) ||
      cursor.revision < 0 ||
      cursor.epoch !== requireEventBookmarkEpoch(cursor.epoch)
    ) {
      throw new Error();
    }
    return {
      version: 1,
      profileId: cursor.profileId,
      epoch: cursor.epoch,
      revision: cursor.revision,
      afterEventId: cursor.afterEventId,
    };
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-prize-cursor");
  }
}

function snapshotChanged(): never {
  throw new AuthApiFailure(409, "aborted", "event-prizes-snapshot-changed");
}

function conditionalRevision(
  header: string | null,
  epoch: string,
  profileId: string | null,
): number | null {
  const value = header?.trim() || "";
  const match = /-(0|[1-9][0-9]*)"$/.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) &&
    value === profileEventPrizesPageEtag(epoch, profileId, revision)
    ? revision
    : null;
}

function boundedPage(
  profileId: string,
  epoch: string,
  page: Awaited<ReturnType<typeof readProfileEventPrizePage>>,
): ProfileEventPrizesPageResponse {
  const response: ProfileEventPrizesPageResponse = {
    ok: true,
    profileId,
    revision: page.revision,
    prizes: Object.create(null),
    nextCursor: null,
  };
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(response)).byteLength;
  let count = 0;
  const entries = page.entries.slice(0, PROFILE_EVENT_PRIZES_PAGE_SIZE);
  for (const [index, entry] of entries.entries()) {
    const nextCursor =
      index + 1 < page.entries.length
        ? encodeCursor({
            version: 1,
            profileId,
            epoch,
            revision: page.revision,
            afterEventId: entry.eventId,
          })
        : null;
    const entryBytes =
      encoder.encode(
        `${JSON.stringify(entry.eventId)}:${JSON.stringify(entry.assignment)}`,
      ).byteLength + (index > 0 ? 1 : 0);
    bytes += entryBytes;
    if (bytes > MAX_EVENT_READ_RESPONSE_BYTES) break;
    const cursorBytes = nextCursor === null ? 0 : nextCursor.length - 2;
    if (bytes + cursorBytes <= MAX_EVENT_READ_RESPONSE_BYTES) {
      response.nextCursor = nextCursor;
      count = index + 1;
    }
  }
  if (count === 0 && page.entries.length > 0) {
    throw new AuthApiFailure(503, "unavailable", "event-response-too-large");
  }
  for (const entry of entries.slice(0, count)) {
    response.prizes[entry.eventId] = entry.assignment;
  }
  return response;
}

export async function readProfileEventPrizesPageResponse(
  session: D1DatabaseSession,
  profileId: string | null,
  epoch: string,
  parameters: URLSearchParams,
  conditionalHeader: string | null,
): Promise<{
  result: ConditionalSnapshot<ProfileEventPrizesPageResponse>;
  etag: string;
}> {
  if (
    parameters.getAll(
      "pagination" satisfies keyof ApiQuery<"GET /events/prizes">,
    ).length !== 1 ||
    parameters.getAll("cursor" satisfies keyof ApiQuery<"GET /events/prizes">)
      .length > 1
  ) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-prize-page");
  }
  const cursor = decodeCursor(
    parameters.get("cursor" satisfies keyof ApiQuery<"GET /events/prizes">),
  );
  if (cursor && (cursor.profileId !== profileId || cursor.epoch !== epoch))
    snapshotChanged();
  const knownRevision = cursor
    ? null
    : conditionalRevision(conditionalHeader, epoch, profileId);
  let result: ConditionalSnapshot<ProfileEventPrizesPageResponse>;
  if (profileId === null) {
    await readEventRuntimeControl(session);
    result =
      knownRevision === 0
        ? { notModified: true, revision: 0 }
        : {
            notModified: false,
            snapshot: {
              ok: true,
              profileId: null,
              revision: 0,
              prizes: {},
              nextCursor: null,
            },
          };
  } else {
    const page = await readProfileEventPrizePage(session, profileId, {
      afterEventId: cursor?.afterEventId,
      expectedRevision: cursor?.revision,
      knownRevision,
    });
    if (cursor && cursor.revision !== page.revision) snapshotChanged();
    result =
      knownRevision === page.revision
        ? { notModified: true, revision: page.revision }
        : { notModified: false, snapshot: boundedPage(profileId, epoch, page) };
  }
  return {
    result,
    etag: profileEventPrizesPageEtag(
      epoch,
      profileId,
      result.notModified ? result.revision : result.snapshot.revision,
    ),
  };
}
