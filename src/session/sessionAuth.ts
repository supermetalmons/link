import { AuthApiError } from "../services/authApi";
import {
  sessionApi,
  SessionApiError,
  type SessionTokenResult,
} from "../services/sessionApi";
import { storage } from "../utils/storage";
import {
  createIndexedDbSessionStore,
  createLocalStorageLogoutIntents,
  SESSION_LOGOUT_INTENT_PREFIX,
  type SessionLogoutIntents,
  type SessionState,
  type SessionStore,
  type StoredSession,
} from "./sessionStore";

const SESSION_SYNC_KEY = "__mons_link_session_revision__";
const SESSION_RESET_NOTICE_KEY = "__mons_link_session_reset_notice__";
const REFRESH_MARGIN_MS = 30_000;

export type SessionUser = {
  readonly uid: string;
  readonly sessionId: string;
  readonly generation: string;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
};

export type SessionAuthDependencies = {
  store: SessionStore;
  logoutIntents?: SessionLogoutIntents;
  api: typeof sessionApi;
  now: () => number;
  createSession: () => StoredSession;
  newGeneration: () => string;
  initializeIdentity?: () => void;
  clearLogoutIdentity?: () => void;
  notify?: () => void;
};

export class SessionAuth {
  currentUser: SessionUser | null = null;
  private readonly dependencies: SessionAuthDependencies;
  private state: SessionState | null = null;
  private bootstrap: Promise<void> | null = null;
  private signingIn: Promise<void> | null = null;
  private refreshing: { user: SessionUser; promise: Promise<string> } | null =
    null;
  private revoking: Promise<void> | null = null;
  private access: SessionTokenResult | null = null;
  private stopped = false;
  private ready = false;
  private storeQueue: Promise<void> = Promise.resolve();
  private logoutTarget: string | null = null;
  private logoutDurable = false;
  private restoredSession: string | null = null;
  private listeners = new Set<{
    next: (user: SessionUser | null) => void;
    error?: (error: unknown) => void;
  }>();

  constructor(dependencies: SessionAuthDependencies) {
    this.dependencies = dependencies;
  }

  get generation(): string | null {
    return this.state?.generation ?? null;
  }
  get logoutGeneration(): string | null {
    return this.logoutTarget;
  }
  get isStoppedForLogout(): boolean {
    return this.stopped;
  }
  get canReloadAfterLogout(): boolean {
    return this.stopped && this.logoutDurable;
  }
  get restoredSessionId(): string | null {
    return this.restoredSession;
  }

  async isLogoutRelevant(generation: string): Promise<boolean> {
    const state = await this.updateStore((current) => current);
    return !state.session || state.generation === generation;
  }

  async runLogoutCleanup(
    generation: string,
    cleanup: () => void,
  ): Promise<boolean> {
    let cleaned = false;
    await this.updateStore((state) => {
      if (!state.session || state.generation === generation) {
        cleanup();
        cleaned = true;
      }
      return state;
    });
    return cleaned;
  }

  authStateReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.bootstrap) {
      this.bootstrap = this.updateStore((state) => {
        if (state.initialized) return state;
        this.dependencies.initializeIdentity?.();
        return { ...state, initialized: true, revision: state.revision + 1 };
      })
        .then((state) => {
          if (this.stopped) return;
          this.ready = true;
          this.restoredSession = state.session?.uid
            ? state.session.sessionId
            : null;
          this.applyState(state, true);
          void this.flushRevocations();
        })
        .catch((error) => {
          for (const listener of this.listeners) listener.error?.(error);
          throw error;
        })
        .finally(() => {
          this.bootstrap = null;
        });
    }
    return this.bootstrap;
  }

  onAuthStateChanged(
    next: (user: SessionUser | null) => void,
    error?: (error: unknown) => void,
  ): () => void {
    const listener = { next, error };
    this.listeners.add(listener);
    if (this.ready)
      queueMicrotask(() => {
        if (this.listeners.has(listener)) next(this.currentUser);
      });
    else void this.authStateReady().catch(() => undefined);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private updateStore(
    change: (state: SessionState) => SessionState,
    retiringGeneration?: string | null,
  ): Promise<SessionState> {
    const operation = this.storeQueue.then(async () => {
      let retiredGeneration: string | null = null;
      const state = await this.dependencies.store.update((current) => {
        if (
          current.generation !== retiringGeneration &&
          this.dependencies.logoutIntents?.has(current.generation)
        ) {
          retiredGeneration = current.generation;
          this.dependencies.clearLogoutIdentity?.();
          current = this.retireState(current);
        }
        return change(current);
      });
      if (retiredGeneration)
        this.dependencies.logoutIntents?.remove(retiredGeneration);
      return state;
    });
    this.storeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private applyState(state: SessionState, initial = false): void {
    if (this.stopped) return;
    if (!state.initialized) {
      this.ready = false;
      this.restoredSession = null;
    }
    const previous = this.currentUser;
    this.state = state;
    const session = state.session;
    if (!session?.uid) this.currentUser = null;
    else if (
      !previous ||
      previous.generation !== state.generation ||
      previous.sessionId !== session.sessionId ||
      previous.uid !== session.uid
    ) {
      const user: SessionUser = {
        uid: session.uid,
        sessionId: session.sessionId,
        generation: state.generation,
        getIdToken: (forceRefresh = false) => this.getToken(user, forceRefresh),
      };
      this.currentUser = user;
    }
    if (previous !== this.currentUser) this.access = null;
    if (initial || previous !== this.currentUser) {
      for (const listener of this.listeners) listener.next(this.currentUser);
    }
  }

  async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (!this.ready) {
      await this.authStateReady();
      return;
    }
    const state = await this.updateStore((current) => current);
    this.applyState(state);
    void this.flushRevocations();
  }

  signInAnonymously(): Promise<void> {
    if (this.signingIn) return this.signingIn;
    this.signingIn = this.createAnonymous().finally(() => {
      this.signingIn = null;
    });
    return this.signingIn;
  }

  private async createAnonymous(): Promise<void> {
    await this.authStateReady();
    if (this.stopped) throw this.changed();
    const state = await this.updateStore((current) => {
      if (current.session) return current;
      this.dependencies.clearLogoutIdentity?.();
      return {
        ...current,
        session: this.dependencies.createSession(),
        revision: current.revision + 1,
      };
    });
    if (this.stopped) throw this.changed();
    this.applyState(state);
    this.dependencies.notify?.();
    const session = state.session;
    if (!session) throw this.changed();
    if (session.uid) return;
    let response: SessionTokenResult;
    try {
      response = await this.dependencies.api.create(session);
    } catch (error) {
      if (
        error instanceof SessionApiError &&
        error.code === "session-revoked"
      ) {
        await this.retireSession(state.generation, session.sessionId);
      }
      throw error;
    }
    if (this.stopped) throw this.changed();
    const committed = await this.updateStore((current) => {
      if (
        current.generation !== state.generation ||
        current.session?.sessionId !== session.sessionId
      )
        return current;
      if (current.session.uid && current.session.uid !== response.uid)
        throw new Error("session-identity-conflict");
      return {
        ...current,
        session: { ...current.session, uid: response.uid },
        revision: current.revision + 1,
      };
    });
    this.applyState(committed);
    if (
      this.stopped ||
      committed.generation !== state.generation ||
      committed.session?.sessionId !== session.sessionId
    )
      throw this.changed();
    this.access = response;
    this.dependencies.notify?.();
  }

  private changed(): AuthApiError {
    return new AuthApiError("unauthenticated", "authentication-changed");
  }

  private async retireSession(
    generation: string,
    sessionId: string,
  ): Promise<void> {
    const state = await this.updateStore((current) =>
      current.generation === generation &&
      current.session?.sessionId === sessionId
        ? {
            ...current,
            session: null,
            generation: this.dependencies.newGeneration(),
            revision: current.revision + 1,
          }
        : current,
    );
    this.applyState(state);
    this.dependencies.notify?.();
  }

  private assertUser(user: SessionUser): void {
    if (this.stopped || this.currentUser !== user) throw this.changed();
  }

  getTokenRemainingMs(token: string): number {
    if (this.stopped || !this.currentUser || this.access?.accessToken !== token)
      return 0;
    return Math.max(0, this.access.accessDeadlineMs - this.dependencies.now());
  }

  private async getToken(
    user: SessionUser,
    forceRefresh: boolean,
  ): Promise<string> {
    this.assertUser(user);
    await this.reconcile();
    this.assertUser(user);
    if (
      !forceRefresh &&
      this.access &&
      this.access.accessDeadlineMs > this.dependencies.now() + REFRESH_MARGIN_MS
    )
      return this.access.accessToken;
    if (!this.refreshing || this.refreshing.user !== user) {
      const refresh = { user, promise: Promise.resolve("") };
      refresh.promise = this.refresh(user).finally(() => {
        if (this.refreshing === refresh) this.refreshing = null;
      });
      this.refreshing = refresh;
    }
    const token = await this.refreshing.promise;
    this.assertUser(user);
    return token;
  }

  private async refresh(user: SessionUser): Promise<string> {
    this.assertUser(user);
    const session = this.state?.session;
    if (!session || session.sessionId !== user.sessionId) throw this.changed();
    try {
      const response = await this.dependencies.api.refresh(session);
      await this.reconcile();
      this.assertUser(user);
      if (response.uid !== user.uid || response.sessionId !== user.sessionId)
        throw new Error("session-identity-conflict");
      this.access = response;
      return response.accessToken;
    } catch (error) {
      if (
        error instanceof SessionApiError &&
        error.code === "session-revoked"
      ) {
        await this.retireSession(user.generation, user.sessionId);
      }
      throw error;
    }
  }

  private retireState(current: SessionState): SessionState {
    const session = current.session;
    return {
      ...current,
      session: null,
      generation: this.dependencies.newGeneration(),
      revision: current.revision + 1,
      revocations:
        session &&
        !current.revocations.some(
          (entry) => entry.sessionId === session.sessionId,
        )
          ? [
              ...current.revocations,
              {
                sessionId: session.sessionId,
                revokeSecret: session.revokeSecret,
              },
            ]
          : current.revocations,
    };
  }

  async signOut(expectedGeneration = this.generation): Promise<boolean> {
    if (
      expectedGeneration &&
      this.currentUser &&
      this.currentUser.generation !== expectedGeneration
    )
      return false;
    this.logoutDurable =
      (this.logoutTarget === expectedGeneration && this.logoutDurable) ||
      Boolean(
        expectedGeneration &&
        this.dependencies.logoutIntents?.add(expectedGeneration),
      );
    this.logoutTarget = expectedGeneration;
    this.stopped = true;
    this.currentUser = null;
    this.access = null;
    for (const listener of this.listeners) listener.next(null);
    let applied = true;
    const state = await this.updateStore((current) => {
      if (expectedGeneration && current.generation !== expectedGeneration) {
        applied = !current.session;
        return current;
      }
      return this.retireState(current);
    }, expectedGeneration);
    if (expectedGeneration)
      this.dependencies.logoutIntents?.remove(expectedGeneration);
    if (!applied) {
      this.stopped = false;
      this.applyState(state);
      return false;
    }
    this.logoutDurable = true;
    this.state = state;
    this.dependencies.notify?.();
    void this.flushRevocations();
    return true;
  }

  flushRevocations(): Promise<void> {
    if (this.revoking) return this.revoking;
    this.revoking = (async () => {
      const state = await this.updateStore((current) => current);
      for (const entry of state.revocations) {
        try {
          await this.dependencies.api.revoke(entry);
          await this.updateStore((current) => ({
            ...current,
            revocations: current.revocations.filter(
              (item) =>
                item.sessionId !== entry.sessionId ||
                item.revokeSecret !== entry.revokeSecret,
            ),
            revision: current.revision + 1,
          }));
        } catch {}
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.revoking = null;
      });
    return this.revoking;
  }
}

function secret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let channel: BroadcastChannel | null = null;

export function retireLegacySessionIdentity(): void {
  const legacy =
    storage.getLoginId("") !== "" || storage.getProfileId("") !== "";
  storage.resetSessionIdentity();
  if (legacy) localStorage.setItem(SESSION_RESET_NOTICE_KEY, "1");
}

export const sessionAuth = new SessionAuth({
  store: createIndexedDbSessionStore(),
  logoutIntents: createLocalStorageLogoutIntents(),
  api: sessionApi,
  now: () => performance.now(),
  newGeneration: () => crypto.randomUUID(),
  createSession: () => ({
    sessionId: crypto.randomUUID(),
    refreshSecret: secret(),
    revokeSecret: secret(),
    uid: null,
  }),
  initializeIdentity: () => {
    if (typeof window === "undefined") return;
    retireLegacySessionIdentity();
  },
  clearLogoutIdentity: () => storage.resetSessionIdentity(),
  notify: () => {
    channel?.postMessage("changed");
    try {
      localStorage.setItem(SESSION_SYNC_KEY, crypto.randomUUID());
    } catch {}
  },
});

export function hasPendingSessionResetNotice(): boolean {
  try {
    return localStorage.getItem(SESSION_RESET_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function consumeSessionResetNotice(): boolean {
  try {
    const pending = hasPendingSessionResetNotice();
    if (pending) localStorage.removeItem(SESSION_RESET_NOTICE_KEY);
    return pending;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  const reconcile = () => {
    void sessionAuth.reconcile().catch(() => undefined);
  };
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("mons-link-session-sync");
    channel.onmessage = reconcile;
  }
  window.addEventListener("storage", (event) => {
    if (
      event.key === SESSION_SYNC_KEY ||
      event.key?.startsWith(SESSION_LOGOUT_INTENT_PREFIX)
    )
      reconcile();
  });
  window.addEventListener("pageshow", reconcile);
  window.addEventListener("online", reconcile);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconcile();
  });
}
