import { isSessionId, isSessionSecret } from "@mons/shared/session-auth";

export const SESSION_DATABASE_NAME = "mons-link-sessions-v1";
export const SESSION_LOGOUT_INTENT_PREFIX = "__mons_link_session_logout__:";

export type SessionLogoutIntents = {
  has: (generation: string) => boolean;
  add: (generation: string) => boolean;
  remove: (generation: string) => void;
};

export function createLocalStorageLogoutIntents(): SessionLogoutIntents {
  return {
    has: (generation) =>
      localStorage.getItem(SESSION_LOGOUT_INTENT_PREFIX + generation) === "1",
    add: (generation) => {
      try {
        localStorage.setItem(SESSION_LOGOUT_INTENT_PREFIX + generation, "1");
        return true;
      } catch {
        return false;
      }
    },
    remove: (generation) => {
      try {
        localStorage.removeItem(SESSION_LOGOUT_INTENT_PREFIX + generation);
      } catch {}
    },
  };
}

export type StoredSession = {
  sessionId: string;
  refreshSecret: string;
  revokeSecret: string;
  uid: string | null;
};

export type SessionRevocation = Pick<
  StoredSession,
  "sessionId" | "revokeSecret"
>;

export type SessionState = {
  generation: string;
  revision: number;
  initialized: boolean;
  session: StoredSession | null;
  revocations: SessionRevocation[];
};

export type SessionStore = {
  update: (
    change: (state: SessionState) => SessionState,
  ) => Promise<SessionState>;
};

export function createEmptySessionState(): SessionState {
  return {
    generation: crypto.randomUUID(),
    revision: 0,
    initialized: false,
    session: null,
    revocations: [],
  };
}

export class SessionStorageError extends Error {
  constructor() {
    super("Session storage is unavailable. Allow site storage and try again.");
    this.name = "SessionStorageError";
  }
}

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object") return false;
  const state = value as SessionState;
  return (
    isSessionId(state.generation) &&
    Number.isSafeInteger(state.revision) &&
    state.revision >= 0 &&
    typeof state.initialized === "boolean" &&
    (state.session === null ||
      (typeof state.session === "object" &&
        isSessionId(state.session.sessionId) &&
        isSessionSecret(state.session.refreshSecret) &&
        isSessionSecret(state.session.revokeSecret) &&
        (state.session.uid === null ||
          (typeof state.session.uid === "string" &&
            /^[A-Za-z0-9]{28}$/.test(state.session.uid))))) &&
    Array.isArray(state.revocations) &&
    state.revocations.every(
      (entry) =>
        entry &&
        isSessionId(entry.sessionId) &&
        isSessionSecret(entry.revokeSecret),
    )
  );
}

export function createIndexedDbSessionStore(
  getFactory: () => IDBFactory = () => indexedDB,
): SessionStore {
  return {
    update: (change) =>
      new Promise<SessionState>((resolve, reject) => {
        let finished = false;
        let database: IDBDatabase | null = null;
        let transaction: IDBTransaction | null = null;
        const finish = (state?: SessionState) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (!state) {
            try {
              transaction?.abort();
            } catch {}
          }
          database?.close();
          if (state) resolve(state);
          else reject(new SessionStorageError());
        };
        const timer = setTimeout(() => finish(), 10_000);
        try {
          const open = getFactory().open(SESSION_DATABASE_NAME, 1);
          open.onupgradeneeded = () => open.result.createObjectStore("state");
          open.onerror = () => finish();
          open.onblocked = () => finish();
          open.onsuccess = () => {
            database = open.result;
            if (finished) {
              database.close();
              return;
            }
            database.onversionchange = () => {
              database?.close();
              finish();
            };
            try {
              transaction = database.transaction("state", "readwrite");
              const objectStore = transaction.objectStore("state");
              const request = objectStore.get("current");
              let result: SessionState;
              request.onsuccess = () => {
                try {
                  const current: unknown =
                    request.result ?? createEmptySessionState();
                  if (!isSessionState(current)) throw new SessionStorageError();
                  result = change(current);
                  if (!isSessionState(result)) throw new SessionStorageError();
                  objectStore.put(result, "current");
                } catch {
                  finish();
                }
              };
              transaction.oncomplete = () => finish(result);
              transaction.onabort = () => finish();
              transaction.onerror = () => finish();
            } catch {
              finish();
            }
          };
        } catch {
          finish();
        }
      }),
  };
}
