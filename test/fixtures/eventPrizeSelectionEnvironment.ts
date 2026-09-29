import type {
  EventPrizeId,
  EventPrizeSelections,
  EventRecord,
} from "../../src/connection/connectionModels";

type Subscription = {
  eventId: string;
  active: boolean;
  update: (selections: EventPrizeSelections) => void;
};

export const environment = {
  initialSelections: { p1: "1092" } as EventPrizeSelections,
  subscriptions: [] as Subscription[],
  mutations: [] as {
    eventId: string;
    prizeId: EventPrizeId;
    resolve: (value: EventPrizeId | null) => void;
    reject: (error: Error) => void;
  }[],
  event: null as EventRecord | null,
  eventListeners: new Set<(event: EventRecord | null) => void>(),
  participantClicks: [] as string[],
};

export const connection = {
  subscribeToEventPrizeSelections(
    eventId: string,
    update: Subscription["update"],
  ) {
    const subscription = { eventId, update, active: true };
    environment.subscriptions.push(subscription);
    update({ ...environment.initialSelections });
    return () => {
      subscription.active = false;
    };
  },
  toggleEventPrizeSelection(eventId: string, prizeId: EventPrizeId) {
    return new Promise<EventPrizeId | null>((resolve, reject) => {
      environment.mutations.push({ eventId, prizeId, resolve, reject });
    });
  },
  subscribeToEventFreshness(
    _eventId: string,
    update: (fresh: boolean) => void,
  ) {
    update(true);
    return () => {};
  },
  subscribeToEvent(
    _eventId: string,
    update: (event: EventRecord | null) => void,
  ) {
    environment.eventListeners.add(update);
    update(environment.event);
    return () => environment.eventListeners.delete(update);
  },
  resolveProfileId: async (id: string) => id,
  syncEventState: async () => {},
};
