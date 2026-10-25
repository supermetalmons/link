import type {
  ApiQuery,
  ApiHttpUrl,
  ApiResponse,
} from "@mons/shared/api-contracts";
import { isEventSnapshotResponse } from "@mons/shared/events";
import type { AuthTokenProvider } from "./authApi";
import {
  GAMEPLAY_API_ROOT,
  conditionalGameplayRead,
  type ConditionalRead,
  type ConditionalReadOptions,
} from "./gameplayTransport";
type EventSnapshotResponse = ApiResponse<"GET /events/snapshot">;

export type {
  ConditionalRead,
  ConditionalReadOptions,
} from "./gameplayTransport";

export function readEventSnapshotViaApi(
  eventId: string,
  tokenProvider: AuthTokenProvider,
  options: ConditionalReadOptions = {},
): Promise<ConditionalRead<EventSnapshotResponse>> {
  const normalizedEventId: ApiQuery<"GET /events/snapshot">["eventId"] =
    eventId.trim();
  const url = new URL(
    `${GAMEPLAY_API_ROOT}/events/snapshot` satisfies ApiHttpUrl<"GET /events/snapshot">,
  );
  url.searchParams.set(
    "eventId" satisfies keyof ApiQuery<"GET /events/snapshot">,
    normalizedEventId,
  );
  return conditionalGameplayRead(
    url,
    tokenProvider,
    (value): value is EventSnapshotResponse =>
      isEventSnapshotResponse(value) && value.eventId === normalizedEventId,
    options,
  );
}
