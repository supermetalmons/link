import { MATCH_SNAPSHOT_PATH } from "@mons/shared/game-sessions";
import { APPLICATION_RELEASE_PATH } from "@mons/shared/data-contract";
import {
  ApplicationDataUnavailable,
  readApplicationDataControl,
} from "./applicationDataControl.ts";
import { runApplicationOperation } from "./applicationExecution.ts";
import {
  applicationContractResponse,
  gateApplicationRequest,
} from "./applicationDataHttp.ts";
import { jsonResponse } from "./http.ts";
import { handleNftRoute } from "./nftRoute.ts";
import type { WorkerDependencies } from "./provider.ts";
import {
  handleXCallback,
  type XCallbackDependencyOverrides,
} from "./xCallback.ts";
import { AUTH_PATHS } from "./authHttp.ts";
import { SESSION_PATHS } from "@mons/shared/session-auth";
import {
  handleSessionRoute,
  type SessionRouteDependencies,
} from "./sessionRoutes.ts";
import { handleAuthRoute, type AuthRouteDependencies } from "./authRoutes.ts";
import {
  handleMiningRoute,
  type MiningRouteDependencies,
} from "./miningRoute.ts";
import {
  GAMEPLAY_PATHS,
  handleGameplayRoute,
  type GameplayRouteDependencies,
} from "./gameplayRoute.ts";
import {
  PROFILE_PATHS,
  handleProfileRoute,
  type ProfileRouteDependencies,
} from "./profileRoute.ts";
import type { WorkerExecutionContext } from "./sessionAuth.ts";
import { EVENT_PATHS, handleEventRoute } from "./eventRoute.ts";
import {
  EVENT_SNAPSHOT_PATH,
  PROFILE_EVENT_PRIZES_PATH,
  handleEventReadRoute,
} from "./eventReadRoute.ts";
import {
  EVENT_PRIZE_WITHDRAWAL_PATH,
  EVENT_PRIZE_WITHDRAWAL_STATUS_PATH,
  handleEventPrizeWithdrawalRoute,
} from "./eventPrizeWithdrawal/route.ts";
import {
  handleInviteReactionRoute,
  isInviteReactionPath,
  type InviteReactionRouteDependencies,
} from "./inviteReactionRoute.ts";
import {
  handleMatchPresentationRoute,
  isMatchPresentationPath,
  type MatchPresentationRouteDependencies,
} from "./matchPresentationRoute.ts";
import {
  handleInviteMetadataRoute,
  isInviteMetadataPath,
  type InviteMetadataRouteDependencies,
} from "./inviteMetadataRoute.ts";
import {
  handleInviteWagersRoute,
  isInviteWagersPath,
  type InviteWagersRouteDependencies,
} from "./inviteWagersRoute.ts";
import {
  handleMatchSyncRoute,
  isMatchSyncPath,
  type MatchSyncRouteDependencies,
} from "./matchSyncRoute.ts";
import {
  handleGameBootstrapRoute,
  isGameBootstrapPath,
  type GameBootstrapRouteDependencies,
} from "./gameBootstrapRoute.ts";
import { handleMatchSnapshotRoute } from "./matchSnapshotRoute.ts";
import {
  handleHistoricalMatchRoute,
  HISTORICAL_MATCH_PATH,
} from "./historicalMatchRoute.ts";
import { handleTelegramBridge } from "./telegramBridge.ts";
import {
  handleTelegramCommand,
  TELEGRAM_COMMAND_PATH,
} from "./telegramCommand.ts";

type RequestDependencies = Partial<WorkerDependencies> & {
  auth?: AuthRouteDependencies;
  session?: SessionRouteDependencies;
  gameplay?: GameplayRouteDependencies;
  mining?: MiningRouteDependencies;
  profile?: ProfileRouteDependencies;
  reactions?: InviteReactionRouteDependencies;
  presentation?: MatchPresentationRouteDependencies;
  metadata?: InviteMetadataRouteDependencies;
  wagers?: InviteWagersRouteDependencies;
  matchSync?: MatchSyncRouteDependencies;
  gameBootstrap?: GameBootstrapRouteDependencies;
  xCallback?: XCallbackDependencyOverrides;
};

type RouteInput = {
  request: Request;
  env: Env;
  overrides: RequestDependencies;
};

type HttpRoute = {
  matches: (pathname: string) => boolean;
  fetchOnly?: true;
} & (
  | {
      needsContext: false;
      run: (input: RouteInput) => Promise<Response>;
    }
  | {
      needsContext: true;
      run: (
        input: RouteInput & { ctx: WorkerExecutionContext },
      ) => Promise<Response>;
    }
);

const routes: readonly HttpRoute[] = [
  {
    matches: (path) => path === MATCH_SNAPSHOT_PATH,
    fetchOnly: true,
    needsContext: false,
    run: ({ request, env }) => handleMatchSnapshotRoute(request, env),
  },
  {
    matches: (path) => path === HISTORICAL_MATCH_PATH,
    fetchOnly: true,
    needsContext: false,
    run: ({ request, env }) => handleHistoricalMatchRoute(request, env),
  },
  {
    matches: (path) => path === "/internal/telegram/delivery",
    fetchOnly: true,
    needsContext: false,
    run: ({ request, env }) => handleTelegramBridge(request, env),
  },
  {
    matches: (path) => path === TELEGRAM_COMMAND_PATH,
    fetchOnly: true,
    needsContext: false,
    run: ({ request, env }) => handleTelegramCommand(request, env),
  },
  {
    matches: (path) => SESSION_PATHS.includes(path),
    needsContext: false,
    run: ({ request, env, overrides }) =>
      handleSessionRoute(request, env, overrides.session),
  },
  {
    matches: isGameBootstrapPath,
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleGameBootstrapRoute(request, env, ctx, overrides.gameBootstrap),
  },
  {
    matches: isMatchSyncPath,
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleMatchSyncRoute(request, env, ctx, overrides.matchSync),
  },
  {
    matches: isInviteWagersPath,
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleInviteWagersRoute(request, env, ctx, overrides.wagers),
  },
  {
    matches: isInviteMetadataPath,
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleInviteMetadataRoute(request, env, ctx, overrides.metadata),
  },
  {
    matches: isMatchPresentationPath,
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleMatchPresentationRoute(request, env, ctx, overrides.presentation),
  },
  {
    matches: isInviteReactionPath,
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleInviteReactionRoute(request, env, ctx, overrides.reactions),
  },
  {
    matches: (path) =>
      path === EVENT_SNAPSHOT_PATH || path === PROFILE_EVENT_PRIZES_PATH,
    needsContext: true,
    run: ({ request, env, ctx }) => handleEventReadRoute(request, env, ctx),
  },
  {
    matches: (path) => path === "/auth/x/callback",
    needsContext: false,
    run: ({ request, env, overrides }) =>
      handleXCallback(request, env, overrides.xCallback),
  },
  {
    matches: (path) => AUTH_PATHS.has(path),
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleAuthRoute(request, env, ctx, overrides.auth),
  },
  {
    matches: (path) => GAMEPLAY_PATHS.has(path),
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleGameplayRoute(request, env, ctx, overrides.gameplay),
  },
  {
    matches: (path) => PROFILE_PATHS.has(path),
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleProfileRoute(request, env, ctx, overrides.profile),
  },
  {
    matches: (path) => EVENT_PATHS.has(path),
    needsContext: true,
    run: ({ request, env, ctx }) => handleEventRoute(request, env, ctx),
  },
  {
    matches: (path) =>
      path === EVENT_PRIZE_WITHDRAWAL_PATH ||
      path === EVENT_PRIZE_WITHDRAWAL_STATUS_PATH,
    needsContext: true,
    run: ({ request, env, ctx }) =>
      handleEventPrizeWithdrawalRoute(request, env, ctx),
  },
  {
    matches: (path) => path === "/mining/rock",
    needsContext: true,
    run: ({ request, env, ctx, overrides }) =>
      handleMiningRoute(request, env, ctx, overrides.mining),
  },
  {
    matches: (path) => path === "/nfts",
    needsContext: false,
    run: ({ request, env, overrides }) =>
      handleNftRoute(request, env, overrides),
  },
];

async function dispatchRequest(
  entrypoint: "request" | "fetch",
  request: Request,
  env: Env,
  overrides: RequestDependencies,
  ctx?: WorkerExecutionContext,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const route = routes.find(
    (candidate) =>
      (entrypoint === "fetch" || !candidate.fetchOnly) &&
      candidate.matches(pathname),
  );
  if (!route && pathname !== APPLICATION_RELEASE_PATH) {
    return jsonResponse({ ok: false, error: "not-found" }, 404);
  }
  if (route?.needsContext && !ctx)
    return jsonResponse({ ok: false, error: "unavailable" }, 503);
  if (request.method !== "OPTIONS") {
    try {
      const gate = gateApplicationRequest(
        request,
        await readApplicationDataControl(env.PROFILE_GAMES_DB),
      );
      if (gate) return gate;
    } catch {
      return applicationContractResponse(request, "maintenance");
    }
  }
  if (!route) return jsonResponse({ ok: false, error: "not-found" }, 404);
  const run = (
    admittedEnv: Env,
    admittedContext: WorkerExecutionContext | undefined,
  ) => {
    if (route.needsContext) {
      if (!admittedContext)
        return Promise.resolve(
          jsonResponse({ ok: false, error: "unavailable" }, 503),
        );
      return route.run({
        request,
        env: admittedEnv,
        overrides,
        ctx: admittedContext,
      });
    }
    return route.run({ request, env: admittedEnv, overrides });
  };
  if (request.method === "OPTIONS") return run(env, ctx);
  try {
    return await runApplicationOperation(env, "http", 1, run, ctx);
  } catch (error) {
    if (error instanceof ApplicationDataUnavailable)
      return applicationContractResponse(request, "maintenance");
    throw error;
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  dependencyOverrides: RequestDependencies = {},
  ctx?: WorkerExecutionContext,
): Promise<Response> {
  return dispatchRequest("request", request, env, dependencyOverrides, ctx);
}

export function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return dispatchRequest("fetch", request, env, {}, ctx);
}
