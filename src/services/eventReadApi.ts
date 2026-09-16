import {
  isEventSnapshotResponse,
  type EventSnapshotResponse,
} from "@mons/shared/events";
import type { AuthTokenProvider } from "./authApi";
import {
  GAMEPLAY_API_ROOT,
  conditionalGameplayRead,
  type ConditionalRead,
  type ConditionalReadOptions,
} from "./gameplayTransport";

export type {
  ConditionalRead,
  ConditionalReadOptions,
} from "./gameplayTransport";

export function readEventSnapshotViaApi(
  eventId: string,
  tokenProvider: AuthTokenProvider,
  options: ConditionalReadOptions = {},
): Promise<ConditionalRead<EventSnapshotResponse>> {
  const normalizedEventId = eventId.trim();
  const url = new URL(`${GAMEPLAY_API_ROOT}/events/snapshot`);
  url.searchParams.set("eventId", normalizedEventId);
  return conditionalGameplayRead(
    url,
    tokenProvider,
    (value): value is EventSnapshotResponse =>
      isEventSnapshotResponse(value) && value.eventId === normalizedEventId,
    options,
  );
}
