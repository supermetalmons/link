import type {
  ApiEndpoint,
  ApiRequest,
  ApiResponse,
  ApiTransport,
  ApiQuery,
  ApiUrlPath,
  ApiSocketMessage,
} from "@mons/shared/api-contracts";
import { defineGameplayRoute } from "../src/gameplayRoutes/definition.ts";
import { authJsonResponse } from "../src/authHttp.ts";
type Assert<Value extends true> = Value;
type Rejects<Value, Contract> = [Value] extends [Contract] ? false : true;
type Accepts<Value, Contract> = [Value] extends [Contract] ? true : false;

export type UnknownPathRejected = Assert<Rejects<"POST /missing", ApiEndpoint>>;
export type WrongMethodRejected = Assert<
  Rejects<"GET /matches/move", ApiEndpoint>
>;
export type AllocationRequiresSecrets = Assert<
  Rejects<{ sessionId: string }, ApiRequest<"POST /auth/session/anonymous">>
>;
export type RefreshHasNoBody = Assert<
  Rejects<{ sessionId: string }, ApiRequest<"POST /auth/session/refresh">>
>;
export type SessionQueryUsesWireNames = Assert<
  Accepts<
    { bootstrapEventId: string; bootstrapIdentity: "1" },
    ApiQuery<"POST /auth/session/anonymous">
  >
>;
export type SessionQueryRejectsInventedNames = Assert<
  Rejects<
    { eventId: string; identity: "1" },
    ApiQuery<"POST /auth/session/anonymous">
  >
>;
export type LogoutIsEmpty = Assert<
  Accepts<
    { kind: "empty"; status: 204 },
    ApiTransport<"POST /auth/session/logout">
  >
>;
export type LogoutRejectsJsonSuccess = Assert<
  Rejects<
    { kind: "json"; status: 200; body: { ok: true } },
    ApiTransport<"POST /auth/session/logout">
  >
>;
export type ConditionalEventReadIsEmpty = Assert<
  Accepts<{ kind: "empty"; status: 304 }, ApiTransport<"GET /events/snapshot">>
>;
export type ConditionalEventReadRejectsJson304 = Assert<
  Rejects<
    { kind: "json"; status: 304; body: ApiResponse<"GET /events/snapshot"> },
    ApiTransport<"GET /events/snapshot">
  >
>;
export type ApplicationFailureCanUse200 = Assert<
  Accepts<
    { kind: "json"; status: 200; body: { ok: false } },
    ApiTransport<"POST /auth/methods/sol/verify">
  >
>;
export type ProcessingWithdrawalIsAccepted = Assert<
  Accepts<
    {
      kind: "json";
      status: 202;
      body: Extract<
        ApiResponse<"POST /events/prizes/withdrawals">,
        { status: "processing" }
      >;
    },
    ApiTransport<"POST /events/prizes/withdrawals">
  >
>;
export type ProcessingWithdrawalCannotComplete = Assert<
  Rejects<
    {
      kind: "json";
      status: 200;
      body: Extract<
        ApiResponse<"POST /events/prizes/withdrawals">,
        { status: "processing" }
      >;
    },
    ApiTransport<"POST /events/prizes/withdrawals">
  >
>;

export function checkWithdrawalPreconditionFailures(): void {
  const failure = {
    ok: false,
    error: "failed-precondition",
    message: "This prize is unavailable for withdrawal.",
  } as const;
  authJsonResponse<"POST /events/prizes/withdrawals", 412>(failure, 412, {});
  authJsonResponse<"POST /events/prizes/withdrawals/status", 412>(
    failure,
    412,
    {},
  );
}

export type WithdrawalStartRejectsStatusBody = Assert<
  Rejects<
    ApiRequest<"POST /events/prizes/withdrawals/status">,
    ApiRequest<"POST /events/prizes/withdrawals">
  >
>;
export type WithdrawalWireKeepsUnvalidatedEventId = Assert<
  Accepts<
    {
      eventId: string;
      prizeId: ApiRequest<"POST /events/prizes/withdrawals">["prizeId"];
      solanaAddress: string;
    },
    ApiRequest<"POST /events/prizes/withdrawals">
  >
>;
type PresentationConflictTransport = Extract<
  ApiTransport<"POST /invites/:inviteId/matches/:matchId/presentation">,
  { kind: "json"; status: 409; body: { error: "presentation-conflict" } }
>;
export type PresentationConflictCarriesCurrentState = Assert<
  Accepts<
    {
      kind: "json";
      status: 409;
      body: {
        ok: false;
        error: "presentation-conflict";
        presentation: ApiResponse<"POST /invites/:inviteId/matches/:matchId/presentation">["presentation"];
      };
    },
    PresentationConflictTransport
  >
>;
export type PresentationConflictRejectsReadSnapshot = Assert<
  Rejects<
    {
      kind: "json";
      status: 409;
      body: {
        ok: false;
        error: "presentation-conflict";
        presentation: ApiResponse<"GET /invites/:inviteId/matches/:matchId/presentation">["presentation"];
      };
    },
    PresentationConflictTransport
  >
>;
export type SocketUsesUpgrade = Assert<
  Accepts<
    {
      kind: "websocket";
      status: 101;
      message: ApiSocketMessage<"GET /invites/:inviteId/matches/:matchId/socket">;
    },
    ApiTransport<"GET /invites/:inviteId/matches/:matchId/socket">
  >
>;
export type SocketRejectsJsonSuccess = Assert<
  Rejects<
    { kind: "json"; status: 200; body: { ok: true } },
    ApiTransport<"GET /invites/:inviteId/matches/:matchId/socket">
  >
>;
export type CallbackRedirectIsEmpty = Assert<
  Accepts<{ kind: "empty"; status: 302 }, ApiTransport<"GET /auth/x/callback">>
>;
export type CallbackFailureIsText = Assert<
  Accepts<
    { kind: "text"; status: 400; body: string },
    ApiTransport<"GET /auth/x/callback">
  >
>;
export type CallbackRejectsJsonFailure = Assert<
  Rejects<
    { kind: "json"; status: 400; body: { ok: false; error: string } },
    ApiTransport<"GET /auth/x/callback">
  >
>;
export type RetiredDeliveryHasNoSuccess = Assert<
  Rejects<
    { kind: "json"; status: 200; body: { ok: true } },
    ApiTransport<"POST /internal/telegram/delivery">
  >
>;
export type TelegramRequestNeedsRecoveryIdentity = Assert<
  Rejects<
    { kind: "recovery-request"; messageKey: string; action: "abandon" },
    ApiRequest<"POST /internal/telegram/command">
  >
>;
export type TelegramPreviewNeedsAppliedMessage = Assert<
  Rejects<
    {
      kind: "recovery-preview";
      messageKey: string;
      action: "confirm-send-applied";
    },
    ApiRequest<"POST /internal/telegram/command">
  >
>;
export type DynamicPathIsPreserved = Assert<
  Accepts<
    "/invites/invite/matches/match/presentation",
    ApiUrlPath<"GET /invites/:inviteId/matches/:matchId/presentation">
  >
>;
export type WrongDynamicSuffixRejected = Assert<
  Rejects<
    "/invites/invite/matches/match/missing",
    ApiUrlPath<"GET /invites/:inviteId/matches/:matchId/presentation">
  >
>;

export function checkGameplayEndpointDefinition(
  request: ApiRequest<"POST /matches/move">,
  response: ApiResponse<"POST /matches/move">,
): void {
  defineGameplayRoute({
    path: "/matches/move",
    readOnly: false,
    runtime: () => null,
    parse: () => ({ ...request, parsed: true as const }),
    handle(body) {
      const parsed: true = body.parsed;
      void parsed;
      return Promise.resolve(response);
    },
  });
  defineGameplayRoute({
    path: "/matches/move",
    readOnly: false,
    runtime: () => null,
    // @ts-expect-error The literal move path cannot infer a different request body.
    parse: () => ({ eventId: "event" }),
    handle: () => Promise.resolve(response),
  });
  defineGameplayRoute({
    path: "/matches/move",
    readOnly: false,
    runtime: () => null,
    parse: () => request,
    // @ts-expect-error The handler cannot return a different endpoint's result.
    handle: () => Promise.resolve({ ok: true, eventId: "event" }),
  });
  authJsonResponse<"POST /matches/move", 200>(response, 200, {});
  authJsonResponse<"POST /matches/move", 200>(
    // @ts-expect-error A keyed serializer cannot accept an unrelated JSON success body.
    { ok: true, eventId: "event" },
    200,
    {},
  );
  // @ts-expect-error The serializer's explicit status must match its status argument.
  authJsonResponse<"POST /matches/move", 200>(response, 202, {});
}
