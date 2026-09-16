import type { SessionIdentityBootstrap } from "@mons/shared/session-bootstrap";
import {
  sessionAuth,
  type InitialIdentitySession,
  type SessionUser,
} from "../session/sessionAuth";
import {
  markAuthIdentityReady,
  markAuthRestoreStart,
} from "../session/authRestoreTiming";
import {
  AuthApiError,
  createUserBoundAuthTokenProvider,
  getIdentityViaApi,
} from "./authApi";

export type InitialIdentityRead = {
  readonly user: SessionUser;
  readonly read: () =>
    SessionIdentityBootstrap | { ok: false; status: "legacy" };
};

type Dependencies = {
  auth: {
    readonly currentUser: SessionUser | null;
    prepareInitialIdentity: () => Promise<InitialIdentitySession>;
  };
  read: typeof getIdentityViaApi;
};

export function createInitialIdentityBootstrap(dependencies: Dependencies) {
  let revision = 0;
  let pending: Promise<InitialIdentityRead> | null = null;
  let retained: InitialIdentityRead | null = null;
  let pendingUser: SessionUser | null = null;
  let consumedUser: SessionUser | null = null;
  const repairs = new WeakMap<
    InitialIdentityRead,
    Promise<InitialIdentityRead>
  >();
  const invalidate = () => {
    revision += 1;
    pending = null;
    retained = null;
    pendingUser = null;
    consumedUser = null;
  };
  const read = (): Promise<InitialIdentityRead> => {
    if (
      (retained && retained.user !== dependencies.auth.currentUser) ||
      (pendingUser && pendingUser !== dependencies.auth.currentUser)
    )
      invalidate();
    if (pending) return pending;
    consumedUser = null;
    markAuthRestoreStart();
    const expectedRevision = revision;
    pendingUser = dependencies.auth.currentUser;
    const assertCurrent = (user: SessionUser) => {
      if (
        expectedRevision !== revision ||
        user !== dependencies.auth.currentUser
      )
        throw new AuthApiError("unauthenticated", "authentication-changed");
    };
    const promise = dependencies.auth
      .prepareInitialIdentity()
      .then(async ({ user, bootstrap, support }) => {
        assertCurrent(user);
        let value: ReturnType<InitialIdentityRead["read"]>;
        if (support === "legacy") value = { ok: false, status: "legacy" };
        else if (bootstrap?.ok || bootstrap?.status === 409) value = bootstrap;
        else {
          try {
            value = await dependencies.read(
              createUserBoundAuthTokenProvider(
                user,
                () => dependencies.auth.currentUser,
              ),
            );
          } catch (error) {
            if (
              error instanceof AuthApiError &&
              error.code === "failed-precondition" &&
              error.message === "profile-repair-required"
            )
              value = { ok: false, status: 409 };
            else throw error;
          }
        }
        assertCurrent(user);
        if (value.ok) markAuthIdentityReady(value.profile !== null);
        const result: InitialIdentityRead = {
          user,
          read: () => {
            assertCurrent(user);
            return value;
          },
        };
        retained = result;
        return result;
      })
      .catch((error) => {
        if (pending === promise) {
          pending = null;
          retained = null;
        }
        throw error;
      });
    pending = promise;
    return promise;
  };
  return {
    read,
    start: () => {
      void read().catch(() => undefined);
    },
    invalidate,
    peek: (user: SessionUser): Promise<InitialIdentityRead> | null =>
      pending && (!pendingUser || pendingUser === user) ? pending : null,
    wasConsumed: (user: SessionUser): boolean =>
      consumedUser === user && user === dependencies.auth.currentUser,
    repair: (
      result: InitialIdentityRead,
      repair: () => Promise<unknown>,
    ): Promise<InitialIdentityRead> => {
      const existing = repairs.get(result);
      if (existing) return existing;
      const value = result.read();
      if (value.ok || value.status !== 409) return Promise.resolve(result);
      const promise = (async () => {
        await repair();
        result.read();
        invalidate();
        return read();
      })().catch((error) => {
        if (repairs.get(result) === promise) repairs.delete(result);
        throw error;
      });
      repairs.set(result, promise);
      return promise;
    },
    consume: (result: InitialIdentityRead) => {
      const value = result.read();
      if (retained === result) {
        consumedUser = value.ok && value.profile ? result.user : null;
        pending = null;
        retained = null;
      }
    },
  };
}

const initialIdentityBootstrap = createInitialIdentityBootstrap({
  auth: sessionAuth,
  read: getIdentityViaApi,
});

export const startInitialIdentityBootstrap = initialIdentityBootstrap.start;
export const readInitialIdentity = initialIdentityBootstrap.read;
export const invalidateInitialIdentity = initialIdentityBootstrap.invalidate;
export const consumeInitialIdentity = initialIdentityBootstrap.consume;
export const peekInitialIdentity = initialIdentityBootstrap.peek;
export const repairInitialIdentity = initialIdentityBootstrap.repair;
export const wasInitialIdentityConsumed = initialIdentityBootstrap.wasConsumed;
