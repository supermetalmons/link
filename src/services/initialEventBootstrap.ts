import {
  isEventSnapshotSeed,
  type EventSnapshotResponse,
} from "@mons/shared/events";
import { subscribeToNavigationState } from "../navigation/appNavigation";
import {
  getCurrentRouteState,
  type RouteState,
} from "../navigation/routeState";
import {
  sessionAuth,
  type InitialGameSessionOwner,
  type SessionAuth,
  type SessionUser,
} from "../session/sessionAuth";
import { createUserBoundAuthTokenProvider } from "./authApi";
import { readEventSnapshotViaApi, type ConditionalRead } from "./eventReadApi";

type InitialEventBootstrap = {
  promise: Promise<ConditionalRead<EventSnapshotResponse>>;
  abort: () => void;
};

type Dependencies = {
  auth: Pick<
    SessionAuth,
    "currentUser" | "onAuthStateChanged" | "prepareInitialEvent"
  >;
  read: typeof readEventSnapshotViaApi;
  route: () => RouteState;
  subscribeRoute: (listener: (route: RouteState) => void) => () => void;
};

export function createInitialEventBootstrap(dependencies: Dependencies) {
  let initial:
    | (InitialEventBootstrap & {
        eventId: string;
        user: SessionUser | null;
        isOwnedBy: (user: SessionUser) => boolean;
        cleanup: () => void;
      })
    | null = null;
  let started = false;

  return {
    start(route: RouteState): void {
      if (started) return;
      started = true;
      if (route.mode === "invite" || !route.eventId) return;
      performance.clearMarks("event:bootstrap-start");
      performance.mark("event:bootstrap-start");
      const eventId = route.eventId;
      const controller = new AbortController();
      let owner: InitialGameSessionOwner | null = null;
      const isOwnedBy = (user: SessionUser) =>
        owner === null ||
        (owner.sessionId === user.sessionId &&
          owner.generation === user.generation);
      const matchesRoute = (target: RouteState) =>
        target.mode !== "invite" && target.eventId === eventId;
      const preparation = dependencies.auth.prepareInitialEvent(eventId, {
        signal: controller.signal,
        onSessionBound: (session) => {
          owner ??= session;
        },
      });
      let unsubscribeAuth = () => {};
      let unsubscribeRoute = () => {};
      const cleanup = () => {
        unsubscribeAuth();
        unsubscribeRoute();
      };
      const abort = () => {
        controller.abort();
        cleanup();
        if (initial === request) initial = null;
      };
      const assertCurrentRoute = () => {
        if (controller.signal.aborted || !matchesRoute(dependencies.route()))
          throw new Error("initial-event-bootstrap-canceled");
      };
      const request: NonNullable<typeof initial> = {
        eventId,
        user: dependencies.auth.currentUser,
        isOwnedBy,
        abort,
        cleanup,
        promise: preparation.then(async ({ user, bootstrap }) => {
          assertCurrentRoute();
          if (!isOwnedBy(user))
            throw new Error("initial-event-bootstrap-changed");
          request.user = user;
          const tokenProvider = createUserBoundAuthTokenProvider(
            user,
            () => dependencies.auth.currentUser,
          );
          tokenProvider.assertCurrentUser();
          const result: ConditionalRead<EventSnapshotResponse> =
            isEventSnapshotSeed(bootstrap) &&
            bootstrap.snapshot.eventId === eventId
              ? {
                  kind: "modified",
                  value: bootstrap.snapshot,
                  etag: bootstrap.etag,
                  bookmark: bootstrap.bookmark,
                }
              : await dependencies.read(eventId, tokenProvider, {
                  signal: controller.signal,
                });
          tokenProvider.assertCurrentUser();
          assertCurrentRoute();
          return result;
        }),
      };
      initial = request;
      unsubscribeAuth = dependencies.auth.onAuthStateChanged((user) => {
        if (
          (request.user && user !== request.user) ||
          (user && !isOwnedBy(user))
        )
          abort();
        else request.user = user;
      });
      unsubscribeRoute = dependencies.subscribeRoute((target) => {
        if (!matchesRoute(target)) abort();
      });
      void request.promise.catch(() => undefined);
    },
    take(eventId: string, user: SessionUser): InitialEventBootstrap | null {
      const request = initial;
      if (!request) return null;
      if (
        request.eventId !== eventId ||
        dependencies.auth.currentUser !== user ||
        !request.isOwnedBy(user) ||
        (request.user !== null && request.user !== user) ||
        dependencies.route().mode === "invite" ||
        dependencies.route().eventId !== eventId
      ) {
        request.abort();
        return null;
      }
      initial = null;
      request.cleanup();
      return {
        abort: request.abort,
        promise: request.promise.then((result) => {
          if (
            request.user !== user ||
            dependencies.auth.currentUser !== user ||
            !request.isOwnedBy(user)
          )
            throw new Error("initial-event-bootstrap-changed");
          return result;
        }),
      };
    },
  };
}

const initialEventBootstrap = createInitialEventBootstrap({
  auth: sessionAuth,
  read: readEventSnapshotViaApi,
  route: getCurrentRouteState,
  subscribeRoute: subscribeToNavigationState,
});

export const startInitialEventBootstrap = initialEventBootstrap.start;
export const takeInitialEventBootstrap = initialEventBootstrap.take;
