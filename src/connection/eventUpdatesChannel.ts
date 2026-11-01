import {
  EVENT_UPDATES_MAX_MESSAGE_BYTES,
  EVENT_UPDATES_SOCKET_PROTOCOL,
  isEventUpdateMessage,
  type EventUpdateMessage,
} from "@mons/shared/events";
import { APPLICATION_DATA_SOCKET_PROTOCOL } from "@mons/shared/data-contract";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  isReactionSocketToken,
} from "@mons/shared/reactions";
import { getEventUpdatesSocketUrl } from "../services/eventReadApi";
import {
  SnapshotChannel,
  type SnapshotChannelDependencies,
} from "./snapshotChannel";

type EventUpdatesChannelDependencies = Pick<
  SnapshotChannelDependencies<
    EventUpdateMessage,
    { snapshot: EventUpdateMessage }
  >,
  | "createSocket"
  | "getProtocols"
  | "getTokenRemainingMs"
  | "isActive"
  | "isOnline"
  | "isVisible"
  | "addWakeListener"
  | "onError"
  | "setTimer"
  | "clearTimer"
  | "random"
  | "now"
> & {
  eventId: string;
  onUpdate: (update: EventUpdateMessage) => void;
};

export function createEventUpdatesSocketProtocols(token: string): string[] {
  if (!isReactionSocketToken(token)) {
    throw new Error("invalid-event-updates-socket-token");
  }
  return [
    EVENT_UPDATES_SOCKET_PROTOCOL,
    `${REACTION_AUTH_PROTOCOL_PREFIX}${token}`,
    APPLICATION_DATA_SOCKET_PROTOCOL,
  ];
}

export class EventUpdatesChannel extends SnapshotChannel<
  EventUpdateMessage,
  { snapshot: EventUpdateMessage }
> {
  constructor(dependencies: EventUpdatesChannelDependencies) {
    super({
      ...dependencies,
      socketUrl: getEventUpdatesSocketUrl(dependencies.eventId),
      socketProtocol: EVENT_UPDATES_SOCKET_PROTOCOL,
      maxMessageBytes: EVENT_UPDATES_MAX_MESSAGE_BYTES,
      refreshMs: 2_000,
      parseMessage: (message) =>
        isEventUpdateMessage(message) &&
        message.eventId === dependencies.eventId
          ? message
          : null,
      retryAfterMs: () => 0,
      readError: () => new Error("event-updates-unavailable"),
      channelError: () => new Error("event-updates-channel-unavailable"),
      onSnapshot: dependencies.onUpdate,
    });
  }
}
