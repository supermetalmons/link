import {
  isToggleEventPrizeSelectionRequest,
  type ToggleEventPrizeSelectionRequest,
} from "@mons/shared/event-prizes";
import {
  isCreateEventRequest,
  isDisqualifyEventMatchWinnersRequest,
  isJoinEventRequest,
  isPostponeEventStartRequest,
  isRemoveEventParticipantRequest,
  isSyncEventStateRequest,
  type CreateEventRequest,
  type DisqualifyEventMatchWinnersRequest,
  type JoinEventRequest,
  type PostponeEventStartRequest,
  type RemoveEventParticipantRequest,
  type SyncEventStateRequest,
} from "@mons/shared/events";
import { normalizeRecordKey } from "@mons/shared/ids";
import { AuthApiFailure } from "./authErrors.ts";
import {
  createEvent,
  disqualifyEventMatchWinners,
  postponeEventStart,
  syncEventState,
  type EventControlDependencies,
} from "./eventOperations.ts";
import {
  joinEvent,
  removeEventParticipant,
  toggleEventPrizeSelection,
  type EventParticipationDependencies,
} from "./eventParticipation.ts";
import type { EventGameplayRepository } from "./eventRepository.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export type EventRequestBody =
  | CreateEventRequest
  | DisqualifyEventMatchWinnersRequest
  | JoinEventRequest
  | PostponeEventStartRequest
  | RemoveEventParticipantRequest
  | SyncEventStateRequest
  | ToggleEventPrizeSelectionRequest;

type EventRouteContext = {
  env: Env;
  identity: RequestIdentity;
  repository: EventGameplayRepository;
  control: EventControlDependencies;
  participation: EventParticipationDependencies;
};

export type PreparedEventRoute = {
  body: EventRequestBody;
  execute(context: EventRouteContext): Promise<unknown>;
};

export type EventRoute = {
  path: string;
  kind: "participation" | "control";
  prepare(body: unknown): PreparedEventRoute;
};

function defineEventRoute<Body extends EventRequestBody>(definition: {
  path: string;
  kind: EventRoute["kind"];
  parse(body: unknown): Body;
  handle(body: Body, context: EventRouteContext): Promise<unknown>;
}): EventRoute {
  return {
    path: definition.path,
    kind: definition.kind,
    prepare(value) {
      const body = definition.parse(value);
      return {
        body,
        execute: (context) => definition.handle(body, context),
      };
    },
  };
}

function validateBody<Body>(
  body: unknown,
  validate: (value: unknown) => value is Body,
): Body {
  if (!validate(body))
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  return body;
}

export const eventRoutes: ReadonlyMap<string, EventRoute> = new Map(
  [
    defineEventRoute({
      path: "/events/create",
      kind: "control",
      parse: (body) => validateBody(body, isCreateEventRequest),
      handle: (body, { env, identity, control }) =>
        createEvent(env, identity, body, control),
    }),
    defineEventRoute({
      path: "/events/matches/winners/disqualify",
      kind: "control",
      parse: (body) => validateBody(body, isDisqualifyEventMatchWinnersRequest),
      handle: (body, { env, identity, control }) =>
        disqualifyEventMatchWinners(env, identity, body, control),
    }),
    defineEventRoute({
      path: "/events/participants/join",
      kind: "participation",
      parse(body) {
        const value = validateBody(body, isJoinEventRequest);
        return { eventId: normalizeRecordKey(value.eventId) || "" };
      },
      handle: (body, { identity, repository, participation }) =>
        joinEvent(identity, body, repository, participation),
    }),
    defineEventRoute({
      path: "/events/participants/remove",
      kind: "participation",
      parse(body) {
        const value = validateBody(body, isRemoveEventParticipantRequest);
        return {
          eventId: normalizeRecordKey(value.eventId) || "",
          participantProfileId:
            normalizeRecordKey(value.participantProfileId) || "",
        };
      },
      handle: (body, { identity, repository, participation }) =>
        removeEventParticipant(identity, body, repository, participation),
    }),
    defineEventRoute({
      path: "/events/prize-selections/toggle",
      kind: "participation",
      parse: (body) => validateBody(body, isToggleEventPrizeSelectionRequest),
      handle: (body, { identity, repository, participation }) =>
        toggleEventPrizeSelection(identity, body, repository, participation),
    }),
    defineEventRoute({
      path: "/events/start/postpone",
      kind: "control",
      parse: (body) => validateBody(body, isPostponeEventStartRequest),
      handle: (body, { env, identity, control }) =>
        postponeEventStart(env, identity, body, control),
    }),
    defineEventRoute({
      path: "/events/state/sync",
      kind: "control",
      parse: (body) => validateBody(body, isSyncEventStateRequest),
      handle: (body, { env, identity, control }) =>
        syncEventState(env, identity, body, control),
    }),
  ].map((route) => [route.path, route]),
);
