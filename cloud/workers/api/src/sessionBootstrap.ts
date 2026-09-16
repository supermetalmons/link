import {
  isSessionBootstrap,
  isSessionBootstrapTarget,
  isSessionEventBootstrapTarget,
  type SessionBootstrap,
  type SessionBootstrapFailure,
  type SessionBootstrapTarget,
  type SessionEventBootstrap,
  type SessionEventBootstrapTarget,
} from "@mons/shared/session-bootstrap";
import {
  SESSION_ANONYMOUS_PATH,
  SESSION_REFRESH_PATH,
  type SessionTokenResponse,
} from "@mons/shared/session-auth";
import { AuthApiFailure } from "./authErrors.ts";
import {
  GameBootstrapRateLimitFailure,
  readAuthenticatedGameBootstrap,
  type GameBootstrapDependencies,
  type GameBootstrapMeasure,
} from "./gameBootstrap.ts";
import {
  readOptionalEventSnapshotSeed,
  type EventSnapshotSeedDependencies,
} from "./eventSnapshotResponse.ts";

export const GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS = 10_000;
type Timer = ReturnType<typeof setTimeout> | number;

export type SessionBootstrapDependencies = GameBootstrapDependencies &
  EventSnapshotSeedDependencies & {
    now?: () => number;
    logFailure?: () => void;
    setTimer?: (callback: () => void, delayMs: number) => Timer;
    clearTimer?: (timer: Timer) => void;
  };

export function readSessionBootstrapTarget(
  request: Request,
): SessionBootstrapTarget | SessionEventBootstrapTarget | null {
  const url = new URL(request.url);
  const params = url.searchParams;
  if (params.has("bootstrapEventId")) {
    const target = { eventId: params.get("bootstrapEventId") };
    if (
      (url.pathname !== SESSION_ANONYMOUS_PATH &&
        url.pathname !== SESSION_REFRESH_PATH) ||
      params.getAll("bootstrapEventId").length !== 1 ||
      [...params.keys()].some((key) => key !== "bootstrapEventId") ||
      !isSessionEventBootstrapTarget(target)
    )
      throw new AuthApiFailure(
        400,
        "invalid-argument",
        "invalid-bootstrap-request",
      );
    return target;
  }
  if (!params.has("bootstrapInviteId") && !params.has("bootstrapSelection"))
    return null;
  const target = {
    inviteId: params.get("bootstrapInviteId"),
    selection: params.get("bootstrapSelection") ?? "current",
  };
  if (
    (url.pathname !== SESSION_ANONYMOUS_PATH &&
      url.pathname !== SESSION_REFRESH_PATH) ||
    params.getAll("bootstrapInviteId").length !== 1 ||
    params.getAll("bootstrapSelection").length > 1 ||
    [...params.keys()].some(
      (key) => key !== "bootstrapInviteId" && key !== "bootstrapSelection",
    ) ||
    !isSessionBootstrapTarget(target)
  )
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "invalid-bootstrap-request",
    );
  return target;
}

export async function readSessionEventBootstrap(
  request: Request,
  target: SessionEventBootstrapTarget,
  env: Env,
  dependencies: EventSnapshotSeedDependencies = {},
): Promise<SessionEventBootstrap> {
  const seed = await readOptionalEventSnapshotSeed(
    env,
    target.eventId,
    request.signal,
    dependencies,
  );
  return { ...target, result: seed || { ok: false, status: 503 } };
}

function failure(error: unknown): SessionBootstrapFailure {
  if (error instanceof GameBootstrapRateLimitFailure)
    return { ok: false, status: 429, retryAfterMs: error.retryAfterMs };
  if (error instanceof AuthApiFailure) {
    const status = error.status;
    if (
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 429 ||
      status === 503
    )
      return { ok: false, status };
  }
  return { ok: false, status: 503 };
}

export async function readSessionBootstrap(
  request: Request,
  target: SessionBootstrapTarget,
  session: SessionTokenResponse,
  env: Env,
  dependencies: SessionBootstrapDependencies = {},
): Promise<SessionBootstrap> {
  const now = dependencies.now || Date.now;
  const deadline = now() + GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = () =>
    new AuthApiFailure(503, "unavailable", "game-bootstrap-timeout");
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    controller.abort();
    rejectCancellation(timeout());
  };
  const assertCurrent = () => {
    if (
      controller.signal.aborted ||
      request.signal.aborted ||
      now() >= deadline
    ) {
      controller.abort();
      throw timeout();
    }
  };
  const measure: GameBootstrapMeasure = async (name, work) => {
    assertCurrent();
    const value = dependencies.measure
      ? await dependencies.measure(name, work)
      : await work();
    assertCurrent();
    return value;
  };
  const timer = (dependencies.setTimer || setTimeout)(
    cancel,
    GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS,
  );
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    assertCurrent();
    const result = await Promise.race([
      readAuthenticatedGameBootstrap(
        {
          ...target,
          identity: {
            uid: session.uid,
            sid: session.sessionId,
            authExpiresAtMs: session.accessExpiresAtMs,
          },
          signal: controller.signal,
        },
        env,
        { ...dependencies, measure },
      ),
      cancellation,
    ]);
    assertCurrent();
    const bootstrap = { ...target, result };
    return isSessionBootstrap(bootstrap)
      ? bootstrap
      : { ...target, result: failure(null) };
  } catch (error) {
    if (!(error instanceof AuthApiFailure) && !controller.signal.aborted)
      (
        dependencies.logFailure ||
        (() => console.error({ event: "session_bootstrap_failure" }))
      )();
    return { ...target, result: failure(error) };
  } finally {
    (dependencies.clearTimer || clearTimeout)(timer);
    request.signal.removeEventListener("abort", cancel);
  }
}
