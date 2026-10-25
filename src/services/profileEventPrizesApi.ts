import type {
  ApiQuery,
  ApiResponse,
  ApiHttpUrl,
} from "@mons/shared/api-contracts";
import {
  MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH,
  profileEventPrizesPageEtag,
  isProfileEventPrizesPageResponse,
  isProfileEventPrizesResponse,
  type EventPrizeAssignmentWireRecord,
  type ProfileEventPrizesResponse,
} from "@mons/shared/event-prizes";
import { eventBookmarkEpoch } from "@mons/shared/events";
import type { AuthTokenProvider } from "./authApi";
import {
  GAMEPLAY_API_ROOT,
  GameplayApiError,
  withConditionalGameplayReads,
  type ConditionalRead,
  type ConditionalReadOptions,
} from "./gameplayTransport";
function invalidPrizeResponse(): GameplayApiError {
  return new GameplayApiError(
    "unavailable",
    "Gameplay service is unavailable.",
  );
}

function validateNotModified(
  result: Extract<ConditionalRead<never>, { kind: "not-modified" }>,
  profileId: string,
  requestedEtag: string | null | undefined,
): void {
  if (result.etag !== requestedEtag?.trim()) throw invalidPrizeResponse();
  if (!result.etag.startsWith('W/"profile-event-prizes-page-v1-')) return;
  const epoch = eventBookmarkEpoch(result.bookmark);
  const match = /-(0|[1-9][0-9]*)"$/.exec(result.etag);
  const revision = match ? Number(match[1]) : NaN;
  if (
    !epoch ||
    !Number.isSafeInteger(revision) ||
    result.etag !== profileEventPrizesPageEtag(epoch, profileId, revision)
  ) {
    throw invalidPrizeResponse();
  }
}

export function readProfileEventPrizesViaApi(
  profileId: string,
  tokenProvider: AuthTokenProvider,
  options: ConditionalReadOptions = {},
): Promise<ConditionalRead<ProfileEventPrizesResponse>> {
  const normalizedProfileId = profileId.trim();
  return withConditionalGameplayReads(tokenProvider, options, async (read) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let cursor: NonNullable<ApiQuery<"GET /events/prizes">["cursor"]> | null =
        null;
      let bookmark = attempt === 0 ? options.bookmark : null;
      const requestedEtag = attempt === 0 ? options.etag : null;
      let snapshot: { revision: number; etag: string; epoch: string } | null =
        null;
      const prizes = new Map<string, EventPrizeAssignmentWireRecord>();
      const cursors = new Set<string>();
      try {
        while (true) {
          const url = new URL(
            `${GAMEPLAY_API_ROOT}/events/prizes` satisfies ApiHttpUrl<"GET /events/prizes">,
          );
          url.searchParams.set(
            "pagination" satisfies keyof ApiQuery<"GET /events/prizes">,
            "1" satisfies NonNullable<
              ApiQuery<"GET /events/prizes">["pagination"]
            >,
          );
          if (cursor !== null)
            url.searchParams.set(
              "cursor" satisfies keyof ApiQuery<"GET /events/prizes">,
              cursor,
            );
          const result: ConditionalRead<ApiResponse<"GET /events/prizes">> =
            await read(
              url,
              (value): value is ApiResponse<"GET /events/prizes"> =>
                (isProfileEventPrizesPageResponse(value) ||
                  (cursor === null && isProfileEventPrizesResponse(value))) &&
                value.profileId === normalizedProfileId,
              { bookmark, etag: cursor === null ? requestedEtag : null },
            );
          if (result.kind === "not-modified") {
            if (cursor !== null) throw invalidPrizeResponse();
            validateNotModified(result, normalizedProfileId, requestedEtag);
            return result;
          }
          const page: ApiResponse<"GET /events/prizes"> = result.value;
          if (!("nextCursor" in page)) return result;
          const epoch = eventBookmarkEpoch(result.bookmark);
          if (
            !epoch ||
            result.etag !==
              profileEventPrizesPageEtag(
                epoch,
                page.profileId,
                page.revision,
              ) ||
            (snapshot !== null &&
              (page.revision !== snapshot.revision ||
                result.etag !== snapshot.etag ||
                epoch !== snapshot.epoch))
          ) {
            throw invalidPrizeResponse();
          }
          snapshot = { revision: page.revision, etag: result.etag, epoch };
          const entries = Object.entries(page.prizes);
          for (const [eventId, prize] of entries) {
            if (prizes.has(eventId)) throw invalidPrizeResponse();
            prizes.set(eventId, prize);
          }
          if (page.nextCursor === null) {
            return {
              kind: "modified",
              value: {
                ok: true,
                profileId: page.profileId,
                revision: page.revision,
                prizes: Object.fromEntries(prizes),
              },
              etag: result.etag,
              bookmark: result.bookmark,
            };
          }
          if (
            entries.length === 0 ||
            page.nextCursor.length === 0 ||
            page.nextCursor.length > MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH ||
            cursors.has(page.nextCursor)
          ) {
            throw invalidPrizeResponse();
          }
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
          bookmark = result.bookmark;
        }
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof GameplayApiError &&
          error.code === "aborted" &&
          error.message === "event-prizes-snapshot-changed"
        ) {
          continue;
        }
        throw error;
      }
    }
    throw invalidPrizeResponse();
  });
}
