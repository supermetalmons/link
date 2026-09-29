import type {
  EventPrizeId,
  EventPrizeSelections,
  EventRecord,
  PlayerProfile,
} from "../../src/connection/connectionModels";
import { getCurrentViewUrl } from "../../src/navigation/routeState";

export type PendingRequest = {
  kind: string;
  args: unknown[];
  resolve: (value?: any) => void;
  reject: (error: Error) => void;
};
export const environment = {
  requests: [] as PendingRequest[],
  events: [] as {
    eventId: string;
    active: boolean;
    update: (event: EventRecord | null) => void;
    fail: () => void;
  }[],
  freshness: [] as {
    eventId: string;
    active: boolean;
    update: (fresh: boolean) => void;
  }[],
  selections: [] as {
    active: boolean;
    eventId: string;
    update: (value: EventPrizeSelections) => void;
  }[],
  fresh: true,
  canonicalIds: {} as Record<string, string>,
  deferredCanonicalIds: false,
  stashedProfiles: {} as Record<string, PlayerProfile>,
  popups: [] as string[],
  cards: [] as { profile: PlayerProfile; name: string }[],
  copies: [] as string[],
  connections: [] as string[],
  alerts: [] as string[],
  prompts: [] as string[],
  promptAnswers: [] as (string | null)[],
  confirmations: [] as string[],
  confirmAnswers: [] as boolean[],
};
const request = (kind: string, ...args: unknown[]): Promise<any> =>
  new Promise((resolve, reject) =>
    environment.requests.push({ kind, args, resolve, reject }),
  );

export const connection = {
  subscribeToEvent(
    eventId: string,
    update: (event: EventRecord | null) => void,
    fail: () => void,
  ) {
    const subscription = { eventId, active: true, update, fail };
    environment.events.push(subscription);
    return () => {
      subscription.active = false;
    };
  },
  subscribeToEventFreshness(eventId: string, update: (fresh: boolean) => void) {
    const subscription = { eventId, active: true, update };
    environment.freshness.push(subscription);
    update(environment.fresh);
    return () => {
      subscription.active = false;
    };
  },
  subscribeToEventPrizeSelections(
    eventId: string,
    update: (value: EventPrizeSelections) => void,
  ) {
    const subscription = { eventId, active: true, update };
    environment.selections.push(subscription);
    update({});
    return () => {
      subscription.active = false;
    };
  },
  resolveProfileId: (id: string) =>
    environment.deferredCanonicalIds
      ? request("canonical", id)
      : Promise.resolve(environment.canonicalIds[id] ?? id),
  joinEvent: (id: string) => request("join", id),
  leaveEvent: (id: string) => request("leave", id),
  syncEventState: (id: string) => request("sync", id),
  toggleEventPrizeSelection: (id: string, prizeId: EventPrizeId) =>
    request("prize", id, prizeId),
  postponeEventStart: (id: string, minutes: number) =>
    request("postpone", id, minutes),
  removeEventParticipant: (id: string, profileId: string) =>
    request("remove", id, profileId),
  disqualifyEventMatchWinners: (id: string, matchKey: string) =>
    request("disqualify", id, matchKey),
  getProfileById: (id: string) => request("profile", id),
  getProfileByLoginId: (id: string) => request("login", id),
  writeEventLinkToClipboard: (id: string, link?: string) => {
    if (id) environment.copies.push(link ?? getCurrentViewUrl());
  },
  connectToInvite: (id: string) => {
    environment.connections.push(id);
  },
};
export const openProfileSignInPopupForEvent = () => {
  environment.popups.push("signin");
};
export const showShinyCard = async (profile: PlayerProfile, name: string) => {
  environment.cards.push({ profile, name });
};
export const getStashedPlayerProfile = (id: string) =>
  environment.stashedProfiles[id];
