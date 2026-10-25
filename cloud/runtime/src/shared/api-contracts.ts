import type * as Auth from "./auth.js";
import type * as EventPrizes from "./event-prizes.js";
import type * as Events from "./events.js";
import type * as Bootstrap from "./game-bootstrap.js";
import type * as Sessions from "./game-sessions.js";
import type * as Metadata from "./invite-metadata.js";
import type * as WagersRead from "./invite-wagers.js";
import type * as Presentation from "./match-presentation.js";
import type * as Sync from "./match-sync.js";
import type * as Mining from "./mining.js";
import type * as Navigation from "./navigation.js";
import type * as Nfts from "./nfts.js";
import type * as Profiles from "./profiles.js";
import type * as Ratings from "./ratings.js";
import type * as Reactions from "./reactions.js";
import type * as SessionAuth from "./session-auth.js";
import type * as SessionBootstrap from "./session-bootstrap.js";
import type * as Timers from "./timers.js";
import type * as Usernames from "./usernames.js";
import type * as Wagers from "./wagers.js";
import type * as XRedirect from "./x-redirect.js";
export type ApiShortError = { ok: false; error: string };
export type ApiAuthError = ApiShortError & {
  message: string;
  details?: unknown;
};
export type ApiJson<Body, Status extends number = 200> = {
  kind: "json";
  status: Status;
  body: Body;
};
export type ApiEmpty<Status extends number> = { kind: "empty"; status: Status };
export type ApiText<Status extends number> = {
  kind: "text";
  status: Status;
  body: string;
};
export type ApiUpgrade<Message> = {
  kind: "websocket";
  status: 101;
  message: Message;
};
export type ApiConditional<Body> = ApiJson<Body> | ApiEmpty<304>;
export type ApiSocket<Message> =
  ApiUpgrade<Message> | ApiText<400 | 401 | 403 | 404 | 409 | 429 | 503>;
export type ApiFailure = ApiJson<
  ApiShortError | ApiAuthError,
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 410
  | 412
  | 413
  | 426
  | 429
  | 500
  | 502
  | 503
  | 504
>;
export type SessionTokenWireResponse = SessionAuth.SessionTokenResponse & {
  identityBootstrap?: SessionBootstrap.SessionIdentityBootstrap;
  gameBootstrap?: SessionBootstrap.SessionBootstrap;
  eventBootstrap?: SessionBootstrap.SessionEventBootstrap;
};
export type SessionBootstrapQuery = {
  bootstrapInviteId?: string;
  bootstrapSelection?: "current" | "approved";
  bootstrapEventId?: string;
  bootstrapIdentity?: "1";
};
export type EventMutationWireResponse<Body> = Body & {
  eventSnapshot?: Events.EventSnapshotSeed;
};
export type EventPrizeWithdrawalWireRequest = Omit<
  EventPrizes.EventPrizeWithdrawalRequest,
  "eventId"
> & { eventId: string };
export type TelegramInitialDeliveryRequest = {
  generation: string;
  messageKey: string;
  retrySequence: 0;
  revision: string;
  taskKind: "desired" | "manual-recovery";
};
export type TelegramRecoveryAction =
  "abandon" | "confirm-send-absent" | "confirm-send-applied";
export type TelegramSendCommand = {
  destination: string;
  generation: string;
  instanceKey: string;
  kind: "send";
  messageKey: string;
  parseMode?: "HTML" | null;
  silent?: boolean;
  sourceRevision: string | number;
  text: string;
};
export type TelegramRecoveryCommand = {
  messageKey: string;
} & (
  | { kind: "recovery-preview"; requestId?: never }
  | { kind: "recovery-request"; requestId: string }
) &
  (
    | { action: "confirm-send-applied"; messageId: number }
    | { action: "confirm-send-absent" | "abandon"; messageId?: never }
  );
export type TelegramRecoveryStatusCommand = {
  kind: "recovery-status";
  messageKey: string;
  requestId: string;
};
export type TelegramReminderRefreshCommand = {
  kind: "event-reminder-refresh";
  eventId: string;
};
export type TelegramCommandRequest =
  | TelegramSendCommand
  | TelegramRecoveryCommand
  | TelegramRecoveryStatusCommand
  | TelegramReminderRefreshCommand;
export type TelegramCommandAcceptedResponse =
  | { ok: true; messageKey: string; revision: string }
  | {
      ok: true;
      messageKey: string;
      requestId: string;
      action: TelegramRecoveryAction;
    }
  | {
      ok: true;
      eventId: string;
      status: "queued";
      messageKey?: string;
      requestId?: string;
      reason?: string;
    };
export type TelegramCommandReadResponse =
  | {
      ok: true;
      dryRun: true;
      messageKey: string;
      action: TelegramRecoveryAction;
      messageId?: number;
      pendingRequestId?: string;
    }
  | {
      ok: true;
      messageKey: string;
      requestId: string;
      status: string;
      action?: string;
      deliveryStatus: string | null;
      code?: string;
    };
export type TelegramCommandResponse =
  TelegramCommandAcceptedResponse | TelegramCommandReadResponse;
type Endpoint<
  Request,
  Response,
  Transport = ApiJson<Response>,
  Parameters = undefined,
  Query = undefined,
  Failure = ApiFailure,
> = {
  request: Request;
  response: Response;
  transport: Transport | Failure;
  parameters: Parameters;
  query: Query;
};
type InviteParameters = { inviteId: string };
type MatchParameters = InviteParameters & { matchId: string };

export type ApiEndpoints = {
  "GET /matches/snapshot": Endpoint<
    undefined,
    Sessions.ReadMatchSnapshotResponse,
    ApiJson<Sessions.ReadMatchSnapshotResponse>,
    undefined,
    Sessions.ReadMatchSnapshotRequest
  >;
  "GET /matches/history": Endpoint<
    undefined,
    Sessions.ReadHistoricalMatchResponse,
    ApiJson<Sessions.ReadHistoricalMatchResponse>,
    undefined,
    Sessions.ReadHistoricalMatchRequest
  >;
  "POST /internal/telegram/delivery": Endpoint<
    TelegramInitialDeliveryRequest,
    never,
    never
  >;
  "POST /internal/telegram/command": Endpoint<
    TelegramCommandRequest,
    TelegramCommandResponse,
    | ApiJson<TelegramCommandReadResponse, 200>
    | ApiJson<TelegramCommandAcceptedResponse, 202>
  >;
  "POST /auth/session/anonymous": Endpoint<
    SessionAuth.SessionCreateRequest,
    SessionTokenWireResponse,
    ApiJson<SessionTokenWireResponse>,
    undefined,
    SessionBootstrapQuery
  >;
  "POST /auth/session/refresh": Endpoint<
    undefined,
    SessionTokenWireResponse,
    ApiJson<SessionTokenWireResponse>,
    undefined,
    SessionBootstrapQuery
  >;
  "POST /auth/session/logout": Endpoint<undefined, never, ApiEmpty<204>>;
  "GET /invites/:inviteId/bootstrap": Endpoint<
    undefined,
    Bootstrap.ReadGameBootstrapResponse,
    ApiJson<Bootstrap.ReadGameBootstrapResponse>,
    InviteParameters,
    { selection?: "current" | "approved" }
  >;
  "GET /invites/:inviteId/matches/:matchId/snapshot": Endpoint<
    undefined,
    Sync.ReadMatchSyncResponse,
    ApiJson<Sync.ReadMatchSyncResponse>,
    MatchParameters
  >;
  "GET /invites/:inviteId/matches/:matchId/socket": Endpoint<
    undefined,
    never,
    ApiSocket<Sync.MatchSyncMessage>,
    MatchParameters
  >;
  "GET /invites/:inviteId/wagers": Endpoint<
    undefined,
    WagersRead.ReadInviteWagersResponse,
    ApiJson<WagersRead.ReadInviteWagersResponse>,
    InviteParameters
  >;
  "GET /invites/:inviteId/wagers/socket": Endpoint<
    undefined,
    never,
    ApiSocket<WagersRead.InviteWagersMessage>,
    InviteParameters
  >;
  "GET /invites/:inviteId/metadata": Endpoint<
    undefined,
    Metadata.ReadInviteMetadataResponse,
    ApiJson<Metadata.ReadInviteMetadataResponse>,
    InviteParameters
  >;
  "GET /invites/:inviteId/metadata/socket": Endpoint<
    undefined,
    never,
    ApiSocket<Metadata.InviteMetadataMessage>,
    InviteParameters
  >;
  "GET /invites/:inviteId/matches/:matchId/presentation": Endpoint<
    undefined,
    Presentation.ReadMatchPresentationResponse,
    ApiJson<Presentation.ReadMatchPresentationResponse>,
    MatchParameters
  >;
  "POST /invites/:inviteId/matches/:matchId/presentation": Endpoint<
    Presentation.UpdateMatchPresentationRequest,
    Presentation.UpdateMatchPresentationResponse,
    | ApiJson<Presentation.UpdateMatchPresentationResponse>
    | ApiJson<Presentation.MatchPresentationConflictResponse, 409>,
    MatchParameters
  >;
  "POST /invites/:inviteId/reactions": Endpoint<
    Reactions.InviteReaction,
    Reactions.SendInviteReactionResponse,
    ApiJson<Reactions.SendInviteReactionResponse>,
    InviteParameters
  >;
  "GET /invites/:inviteId/reactions/socket": Endpoint<
    undefined,
    never,
    ApiSocket<Reactions.InviteRoomMessage>,
    InviteParameters,
    { matchId: string }
  >;
  "GET /events/snapshot": Endpoint<
    undefined,
    Events.EventSnapshotResponse,
    ApiConditional<Events.EventSnapshotResponse>,
    undefined,
    { eventId: string }
  >;
  "GET /events/prizes": Endpoint<
    undefined,
    | EventPrizes.ProfileEventPrizesPageResponse
    | EventPrizes.ProfileEventPrizesResponse,
    ApiConditional<
      | EventPrizes.ProfileEventPrizesPageResponse
      | EventPrizes.ProfileEventPrizesResponse
    >,
    undefined,
    { pagination?: "1"; cursor?: string }
  >;
  "GET /auth/x/callback": Endpoint<
    undefined,
    never,
    ApiEmpty<302> | ApiText<400 | 405 | 503>,
    undefined,
    { state?: string; code?: string; error?: string },
    never
  >;
  "GET /auth/identity": Endpoint<undefined, Profiles.ProfileLookupResponse>;
  "POST /auth/intents": Endpoint<
    Auth.AuthIntentRequest,
    Auth.AuthIntentResponse
  >;
  "POST /auth/methods/apple/verify": Endpoint<
    Auth.AppleAuthVerificationRequest,
    Auth.AuthVerificationResponse
  >;
  "POST /auth/methods/eth/verify": Endpoint<
    Auth.EthereumAuthVerificationRequest,
    Auth.AuthVerificationResponse
  >;
  "GET /auth/methods": Endpoint<undefined, Auth.LinkedAuthMethodsResponse>;
  "POST /auth/methods/sol/verify": Endpoint<
    Auth.SolanaAuthVerificationRequest,
    Auth.AuthVerificationResponse
  >;
  "POST /auth/methods/unlink": Endpoint<
    Auth.AuthMethodUnlinkRequest,
    Auth.LinkedAuthMethodsResponse
  >;
  "POST /auth/profile/sync": Endpoint<
    Record<string, never>,
    Auth.LinkedAuthMethodsResponse
  >;
  "POST /auth/x/flows": Endpoint<
    XRedirect.XRedirectStartRequest,
    XRedirect.XRedirectStartResponse
  >;
  "POST /auth/x/flows/complete": Endpoint<
    Auth.XAuthCompletionRequest,
    Auth.AuthVerificationResponse
  >;
  "POST /automatch/cancel": Endpoint<
    Navigation.CancelAutomatchRequest,
    Navigation.CancelAutomatchResponse
  >;
  "POST /automatch/start": Endpoint<
    Navigation.StartAutomatchRequest,
    Navigation.StartAutomatchApiResponse,
    ApiJson<Navigation.StartAutomatchApiResponse>,
    undefined,
    { operationId: string; bootstrap?: "1" }
  >;
  "POST /invites/create": Endpoint<
    Sessions.CreateInviteRequest,
    Sessions.CreateInviteResponse
  >;
  "POST /invites/join": Endpoint<
    Sessions.JoinInviteRequest,
    Sessions.JoinInviteResponse
  >;
  "POST /invites/role/read": Endpoint<
    Sessions.ResolveInviteRoleRequest,
    Sessions.ResolveInviteRoleResponse
  >;
  "POST /matches/ensure": Endpoint<
    Sessions.EnsureMatchRequest,
    Sessions.EnsureMatchResponse
  >;
  "POST /rematches/propose": Endpoint<
    Sessions.ProposeRematchRequest,
    Sessions.ProposeRematchResponse
  >;
  "POST /rematches/end": Endpoint<
    Sessions.EndRematchRequest,
    Sessions.EndRematchResponse
  >;
  "POST /matches/move": Endpoint<
    Sessions.SubmitMoveRequest,
    Sessions.SubmitMoveResponse
  >;
  "POST /matches/surrender": Endpoint<
    Sessions.SurrenderMatchRequest,
    Sessions.SurrenderMatchResponse
  >;
  "POST /matches/timer/start": Endpoint<
    Timers.StartMatchTimerRequest,
    Timers.StartMatchTimerResponse
  >;
  "POST /matches/timer/claim": Endpoint<
    Timers.ClaimMatchVictoryByTimerRequest,
    Timers.ClaimMatchVictoryByTimerResponse
  >;
  "POST /navigation/games/read": Endpoint<
    Navigation.ReadNavigationGamesRequest,
    Navigation.ReadNavigationGamesResponse
  >;
  "POST /navigation/games/remove": Endpoint<
    Navigation.RemoveNavigationGameRequest,
    Navigation.RemoveNavigationGameResponse
  >;
  "POST /ratings/update": Endpoint<
    Ratings.RatingUpdateRequest,
    Ratings.RatingUpdateResponse
  >;
  "POST /wagers/frozen/read": Endpoint<
    Wagers.WagerFrozenReadRequest,
    Wagers.WagerFrozenReadResponse
  >;
  "POST /wagers/proposals/send": Endpoint<
    Wagers.WagerProposalSendRequest,
    Wagers.WagerProposalSendResponse
  >;
  "POST /wagers/proposals/accept": Endpoint<
    Wagers.WagerProposalAcceptRequest,
    Wagers.WagerProposalAcceptResponse
  >;
  "POST /wagers/proposals/cancel": Endpoint<
    Wagers.WagerProposalRemovalRequest,
    Wagers.WagerProposalRemovalResponse
  >;
  "POST /wagers/proposals/decline": Endpoint<
    Wagers.WagerProposalRemovalRequest,
    Wagers.WagerProposalRemovalResponse
  >;
  "POST /wagers/outcomes/resolve": Endpoint<
    Wagers.WagerOutcomeResolveRequest,
    Wagers.WagerOutcomeResolveResponse
  >;
  "POST /leaderboards/read": Endpoint<
    Profiles.LeaderboardReadRequest,
    Profiles.LeaderboardReadResponse
  >;
  "POST /profiles/custom": Endpoint<
    Profiles.ProfileCustomizationUpdateRequest,
    Profiles.ProfileCustomizationUpdateResponse
  >;
  "POST /profiles/lookup": Endpoint<
    Profiles.ProfileLookupRequest,
    Profiles.ProfileLookupResponse
  >;
  "POST /profiles/canonical-id": Endpoint<
    Profiles.ResolveProfileIdRequest,
    Profiles.ResolveProfileIdResponse
  >;
  "POST /profiles/username": Endpoint<
    Usernames.UsernameEditRequest,
    Usernames.UsernameEditResponse
  >;
  "POST /events/create": Endpoint<
    Events.CreateEventRequest,
    EventMutationWireResponse<Events.CreateEventResponse>,
    ApiJson<EventMutationWireResponse<Events.CreateEventResponse>>,
    undefined,
    { eventSnapshot?: "v1" }
  >;
  "POST /events/matches/winners/disqualify": Endpoint<
    Events.DisqualifyEventMatchWinnersRequest,
    EventMutationWireResponse<Events.DisqualifyEventMatchWinnersResponse>,
    ApiJson<
      EventMutationWireResponse<Events.DisqualifyEventMatchWinnersResponse>
    >,
    undefined,
    { eventSnapshot?: "v1" }
  >;
  "POST /events/participants/join": Endpoint<
    Events.JoinEventRequest,
    Events.JoinEventResponse
  >;
  "POST /events/participants/leave": Endpoint<
    Events.LeaveEventRequest,
    Events.LeaveEventResponse
  >;
  "POST /events/participants/remove": Endpoint<
    Events.RemoveEventParticipantRequest,
    Events.RemoveEventParticipantResponse
  >;
  "POST /events/prize-selections/toggle": Endpoint<
    EventPrizes.ToggleEventPrizeSelectionRequest,
    EventPrizes.ToggleEventPrizeSelectionResponse
  >;
  "POST /events/start/postpone": Endpoint<
    Events.PostponeEventStartRequest,
    EventMutationWireResponse<Events.PostponeEventStartResponse>,
    ApiJson<EventMutationWireResponse<Events.PostponeEventStartResponse>>,
    undefined,
    { eventSnapshot?: "v1" }
  >;
  "POST /events/state/sync": Endpoint<
    Events.SyncEventStateRequest,
    EventMutationWireResponse<Events.SyncEventStateResponse>,
    ApiJson<EventMutationWireResponse<Events.SyncEventStateResponse>>,
    undefined,
    { eventSnapshot?: "v1" }
  >;
  "POST /events/prizes/withdrawals": Endpoint<
    EventPrizeWithdrawalWireRequest,
    EventPrizes.EventPrizeWithdrawalResponse,
    | ApiJson<EventPrizes.EventPrizeWithdrawalCompletedResponse, 200>
    | ApiJson<EventPrizes.EventPrizeWithdrawalProcessingResponse, 202>
  >;
  "POST /events/prizes/withdrawals/status": Endpoint<
    EventPrizes.EventPrizeWithdrawalStatusRequest,
    EventPrizes.EventPrizeWithdrawalResponse,
    | ApiJson<EventPrizes.EventPrizeWithdrawalCompletedResponse, 200>
    | ApiJson<EventPrizes.EventPrizeWithdrawalProcessingResponse, 202>
  >;
  "POST /mining/rock": Endpoint<
    Mining.MineRockRequest,
    Mining.MineRockResponse
  >;
  "POST /nfts": Endpoint<Nfts.NftApiRequest, Nfts.NftApiResponse>;
};
export type ApiEndpoint = keyof ApiEndpoints;
export type ApiMethod = ApiEndpoint extends `${infer Method} ${string}`
  ? Method
  : never;
export type ApiPath<Method extends ApiMethod> =
  Extract<ApiEndpoint, `${Method} ${string}`> extends `${Method} ${infer Path}`
    ? Path
    : never;
export type ApiKey<
  Method extends ApiMethod,
  Path extends ApiPath<Method>,
> = Extract<`${Method} ${Path}`, ApiEndpoint>;
export type ApiRequest<Key extends ApiEndpoint> = ApiEndpoints[Key]["request"];
export type ApiResponse<Key extends ApiEndpoint> =
  ApiEndpoints[Key]["response"];
export type ApiTransport<Key extends ApiEndpoint> =
  ApiEndpoints[Key]["transport"];
export type ApiParameters<Key extends ApiEndpoint> =
  ApiEndpoints[Key]["parameters"];
export type ApiQuery<Key extends ApiEndpoint> = ApiEndpoints[Key]["query"];
type ExpandedPath<Path extends string> =
  Path extends `${infer Before}:${string}/${infer After}`
    ? `${Before}${string}/${ExpandedPath<After>}`
    : Path extends `${infer Before}:${string}`
      ? `${Before}${string}`
      : Path;
export type ApiUrlPath<Key extends ApiEndpoint> =
  Key extends `${string} ${infer Path}`
    ? ExpandedPath<Path> | `${ExpandedPath<Path>}?${string}`
    : never;
export type ApiPathRequest<
  Method extends ApiMethod,
  Path extends ApiPath<Method>,
> = ApiRequest<ApiKey<Method, Path>>;
export type ApiPathResponse<
  Method extends ApiMethod,
  Path extends ApiPath<Method>,
> = ApiResponse<ApiKey<Method, Path>>;
export type GameplayPath =
  | "/automatch/cancel"
  | "/automatch/start"
  | "/invites/create"
  | "/invites/join"
  | "/invites/role/read"
  | "/matches/ensure"
  | "/rematches/propose"
  | "/rematches/end"
  | "/matches/move"
  | "/matches/surrender"
  | "/matches/timer/start"
  | "/matches/timer/claim"
  | "/navigation/games/read"
  | "/navigation/games/remove"
  | "/ratings/update"
  | "/wagers/frozen/read"
  | "/wagers/proposals/send"
  | "/wagers/proposals/accept"
  | "/wagers/proposals/cancel"
  | "/wagers/proposals/decline"
  | "/wagers/outcomes/resolve";
export type EventControlPath =
  | "/events/create"
  | "/events/matches/winners/disqualify"
  | "/events/start/postpone"
  | "/events/state/sync";
export type EventParticipationPath =
  | "/events/participants/join"
  | "/events/participants/leave"
  | "/events/participants/remove"
  | "/events/prize-selections/toggle";
export type EventPath = EventControlPath | EventParticipationPath;

export type ApiJsonStatus<Key extends ApiEndpoint> = Extract<
  ApiTransport<Key>,
  { kind: "json" }
>["status"];
type JsonBodyAt<Transport, Status extends number> =
  Transport extends ApiJson<infer Body, infer AllowedStatus>
    ? Status extends AllowedStatus
      ? Body
      : never
    : never;
export type ApiJsonBody<
  Key extends ApiEndpoint,
  Status extends ApiJsonStatus<Key>,
> = JsonBodyAt<ApiTransport<Key>, Status>;
export type ApiTransportStatus<
  Key extends ApiEndpoint,
  Kind extends ApiTransport<Key>["kind"],
> = Extract<ApiTransport<Key>, { kind: Kind }>["status"];

export type ApiRequestValidator<Key extends ApiEndpoint> = (
  value: unknown,
) => value is ApiRequest<Key>;

export type ApiHttpUrl<Key extends ApiEndpoint> =
  `http${"" | "s"}://${string}${ApiUrlPath<Key>}`;

export type ApiRoutePath<Key extends ApiEndpoint> =
  Key extends `${string} ${infer Path}` ? ExpandedPath<Path> : never;
export type ApiSocketEndpoint = {
  [Key in ApiEndpoint]: Extract<
    ApiTransport<Key>,
    { kind: "websocket" }
  > extends never
    ? never
    : Key;
}[ApiEndpoint];
export type ApiSocketMessage<Key extends ApiSocketEndpoint> = Extract<
  ApiTransport<Key>,
  { kind: "websocket" }
>["message"];
export type ApiSocketUrl<Key extends ApiSocketEndpoint> =
  `${string}${ApiRoutePath<Key>}`;
