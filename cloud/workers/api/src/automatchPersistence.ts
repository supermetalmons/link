import { AuthApiFailure } from "./authErrors.ts";
import {
  acquireAutomatchWriteAdmission,
  automatchAdmissionGuardStatements,
  createAutomatchD1Store,
  parseAutomatchPath,
  readAutomatchRuntimeControl,
  releaseAutomatchWriteAdmission,
  type AutomatchWriteAdmission,
} from "./automatchD1.ts";
import {
  createGameSessionTransitions,
  gameSessionResourceGuardStatements,
  type GameSessionLeaseProof,
} from "./gameSessionTransitions.ts";
import type { GameSessionMutationLockStore } from "./gameplayCoordinationD1.ts";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";
import type { PrepareMatchPresentations } from "./matchPresentationRegistry.ts";
import {
  acquireInviteSourceAdmission,
  createInviteSourceD1Store,
  inviteSourcePath,
  InviteSourceFailure,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
  type InviteSourceAdmission,
} from "./inviteSourceD1.ts";

export class AutomatchPersistenceFrozen extends AuthApiFailure {
  constructor() {
    super(503, "unavailable", "automatch-persistence-frozen");
  }
}

function resourceForPath(path: string): string | null {
  const owned = parseAutomatchPath(path);
  if (owned?.key) {
    return owned.root === "gameplayMutationReceipts" ||
      owned.root === "gameplayMutationReceiptExpirations"
      ? `gameplay-operation:${owned.key}`
      : owned.key;
  }
  const [root, key] = path.replace(/^\/+|\/+$/g, "").split("/");
  return root === "invites" && key ? key : null;
}

export function createAutomatchPersistence(
  db: D1Database,
  raw: FirebaseRtdbClient,
  {
    now = Date.now,
    onCommitted,
    prepareMatchPresentations,
  }: {
    now?: () => number;
    onCommitted?: (inviteId: string) => Promise<void>;
    prepareMatchPresentations?: PrepareMatchPresentations;
  } = {},
) {
  const held = new Map<string, GameSessionLeaseProof>();
  const store = createAutomatchD1Store(db, { now });
  const inviteStore = createInviteSourceD1Store(db, { now });
  const reader = createGameSessionTransitions({
    db,
    rtdb: raw,
    store,
    now,
    onCommitted,
    prepareMatchPresentations,
  });

  const control = async () => {
    const value = await readAutomatchRuntimeControl(db);
    if (value.backend !== "d1") {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "automatch-persistence-backend-retired",
      );
    }
    return value;
  };

  const write = async <T>(
    kind: string,
    work: (
      admission: AutomatchWriteAdmission,
      inviteAdmission: InviteSourceAdmission,
    ) => Promise<T>,
  ): Promise<T> => {
    if ((await control()).state === "frozen") {
      throw new AutomatchPersistenceFrozen();
    }
    const admission = await acquireAutomatchWriteAdmission(db, kind, {
      now,
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "automatch-writes-frozen"
      ) {
        throw new AutomatchPersistenceFrozen();
      }
      throw error;
    });
    let inviteAdmission: InviteSourceAdmission | undefined;
    try {
      inviteAdmission = await acquireInviteSourceAdmission(db, kind, { now });
      if (inviteAdmission.backend !== "d1") {
        throw new InviteSourceFailure("invite-source-backend-retired");
      }
      return await work(admission, inviteAdmission);
    } finally {
      try {
        if (inviteAdmission) {
          await releaseInviteSourceAdmission(db, inviteAdmission);
        }
      } finally {
        await releaseAutomatchWriteAdmission(db, admission);
      }
    }
  };

  const recoverResources = async (
    keys: readonly string[],
    signal?: AbortSignal,
  ) => {
    await control();
    signal?.throwIfAborted();
    const pending = await db
      .withSession("first-primary")
      .prepare(
        `SELECT MIN(resource_key) AS resource_key
        FROM game_session_transition_resources
        WHERE resource_key IN (SELECT value FROM json_each(?))
        GROUP BY transition_id`,
      )
      .bind(JSON.stringify([...new Set(keys)]))
      .all<{ resource_key: string }>();
    if (!pending.results.length) return false;
    return write(
      "session-transition-recovery",
      async (admission, inviteAdmission) => {
        const transitions = createGameSessionTransitions({
          db,
          rtdb: raw,
          store,
          now,
          onCommitted,
          prepareMatchPresentations,
          writeGuards: () => automatchAdmissionGuardStatements(db, admission),
          inviteAdmission,
        });
        for (const { resource_key } of pending.results) {
          await transitions.recoverResource(resource_key, signal);
        }
        return true;
      },
    );
  };
  const recover = (key: string, signal?: AbortSignal) =>
    recoverResources([key], signal);

  const client: FirebaseRtdbClient = {
    ...raw,
    async getPath(path, query, signal) {
      const owned = parseAutomatchPath(path);
      const invite = inviteSourcePath(path);
      const resource = resourceForPath(path);
      if (!owned && !resource) return raw.getPath(path, query, signal);
      const mode = await control();
      const inviteControl = invite ? await readInviteSourceControl(db) : null;
      if (inviteControl && inviteControl.backend !== "d1") {
        throw new InviteSourceFailure("invite-source-backend-retired");
      }
      if (resource) {
        if (
          mode.state === "active" &&
          owned?.root === "gameplayMutationReceipts"
        ) {
          await recover(resource, signal);
        }
        await reader.assertResourceAvailable(resource);
      }
      const value = owned
        ? await store.getPath(path, query, signal)
        : await inviteStore.getPath(path, query, signal);
      if (resource) await reader.assertResourceAvailable(resource);
      return value;
    },
    async patchRoot(updates, signal) {
      const paths = Object.keys(updates);
      const owned = paths.filter((path) => parseAutomatchPath(path));
      const invitePaths = paths.filter((path) => inviteSourcePath(path));
      if (!owned.length && !invitePaths.length)
        return raw.patchRoot(updates, signal);
      return write(
        "automatch-persistence-patch",
        async (admission, inviteAdmission) => {
          if (!owned.length) {
            throw new InviteSourceFailure("invite-source-transition-required");
          }
          const guards = () => automatchAdmissionGuardStatements(db, admission);
          if (owned.length !== paths.length) {
            const transitions = createGameSessionTransitions({
              db,
              rtdb: raw,
              store,
              now,
              onCommitted,
              prepareMatchPresentations,
              writeGuards: guards,
              inviteAdmission,
            });
            return transitions.commit(updates, [...held.values()], signal);
          }
          const resources = owned.flatMap((path) => {
            const resource = resourceForPath(path);
            return resource ? [resource] : [];
          });
          const guarded = createAutomatchD1Store(db, {
            now,
            writeGuards: () => [
              ...guards(),
              ...gameSessionResourceGuardStatements(db, resources),
            ],
          });
          await guarded.patchRoot(updates, signal);
        },
      );
    },
    async transactPath(path, updater, signal) {
      if (inviteSourcePath(path)) {
        throw new InviteSourceFailure("invite-source-transition-required");
      }
      if (!parseAutomatchPath(path)) {
        return raw.transactPath(path, updater, signal);
      }
      return write("automatch-persistence-transaction", async (admission) => {
        const resource = resourceForPath(path);
        const guarded = createAutomatchD1Store(db, {
          now,
          writeGuards: () => [
            ...automatchAdmissionGuardStatements(db, admission),
            ...gameSessionResourceGuardStatements(
              db,
              resource ? [resource] : [],
            ),
          ],
        });
        return guarded.transactPath(path, updater, signal);
      });
    },
  };

  return {
    client,
    async recoverLogins(loginUids: readonly string[], signal?: AbortSignal) {
      await recoverResources(
        loginUids.map((uid) => `automatch-login:${uid}`),
        signal,
      );
    },
    async writesEnabled() {
      const inviteControl = await readInviteSourceControl(db);
      if (inviteControl.backend !== "d1") {
        throw new InviteSourceFailure("invite-source-backend-retired");
      }
      return (
        (await control()).state === "active" && inviteControl.state === "active"
      );
    },
    async readQueuedByLogins(
      loginUids: readonly string[],
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      await control();
      const rows = await store.listEntriesByLogins(loginUids, 2, signal);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
    async expireReceipts(cutoffMs: number, limit: number): Promise<number> {
      const mode = await control();
      if (mode.state === "frozen") return 0;
      return write("session-receipt-expiry", (admission) =>
        createAutomatchD1Store(db, {
          now,
          writeGuards: () => automatchAdmissionGuardStatements(db, admission),
        }).expireReceipts(cutoffMs, limit),
      );
    },
    async sweep(limit = 10) {
      const mode = await control();
      if (mode.state === "frozen") {
        return { recovered: 0, failed: 0 };
      }
      return write("session-transition-sweep", (admission, inviteAdmission) =>
        createGameSessionTransitions({
          db,
          rtdb: raw,
          store,
          now,
          onCommitted,
          prepareMatchPresentations,
          writeGuards: () => automatchAdmissionGuardStatements(db, admission),
          inviteAdmission,
        }).sweep(limit),
      );
    },
    decorateLocks(
      base: GameSessionMutationLockStore,
    ): GameSessionMutationLockStore {
      return {
        async acquire(lock, ownerId, nowMs) {
          await recover(lock.lockId);
          await base.acquire(lock, ownerId, nowMs);
          held.set(lock.lockId, { ...lock, ownerId });
        },
        refresh: (lock, ownerId, nowMs) => base.refresh(lock, ownerId, nowMs),
        async release(lock, ownerId) {
          try {
            await base.release(lock, ownerId);
          } finally {
            if (held.get(lock.lockId)?.ownerId === ownerId)
              held.delete(lock.lockId);
          }
        },
        deleteExpired: (nowMs) => base.deleteExpired(nowMs),
      };
    },
  };
}

export type AutomatchPersistence = ReturnType<
  typeof createAutomatchPersistence
>;
