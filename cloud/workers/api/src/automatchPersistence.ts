import { AuthApiFailure } from "./authErrors.ts";
import { createAutomatchAdmissionAudit } from "./automatchAdmissionAudit.ts";
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
  }: {
    now?: () => number;
    onCommitted?: (inviteId: string) => Promise<void>;
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
  });

  const control = async () => {
    const value = await readAutomatchRuntimeControl(db);
    return value;
  };

  const write = async <T>(
    kind: string,
    work: (
      admission: AutomatchWriteAdmission,
      audit: ReturnType<typeof createAutomatchAdmissionAudit>,
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
    const audit = createAutomatchAdmissionAudit(db, admission, { now });
    let inviteAdmission: InviteSourceAdmission | undefined;
    try {
      inviteAdmission = await acquireInviteSourceAdmission(db, kind, { now });
      const result = await work(admission, audit, inviteAdmission);
      if (admission.backend === "rtdb") await audit.markCompleted();
      return result;
    } catch (error) {
      if (admission.backend === "rtdb") {
        try {
          await audit.markUncertain();
        } catch {}
      }
      throw error;
    } finally {
      try {
        if (inviteAdmission) {
          await releaseInviteSourceAdmission(db, inviteAdmission);
        }
      } finally {
        if (admission.backend === "d1") {
          await releaseAutomatchWriteAdmission(db, admission);
        } else {
          await audit.releaseIfSafe();
        }
      }
    }
  };

  const recoverResources = async (
    keys: readonly string[],
    signal?: AbortSignal,
  ) => {
    if ((await control()).backend !== "d1") return false;
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
      async (admission, _audit, inviteAdmission) => {
        const transitions = createGameSessionTransitions({
          db,
          rtdb: raw,
          store,
          now,
          onCommitted,
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
    async getPath(path, query, signal) {
      const owned = parseAutomatchPath(path);
      const invite = inviteSourcePath(path);
      const resource = resourceForPath(path);
      if (!owned && !resource) return raw.getPath(path, query, signal);
      const mode = await control();
      const inviteControl = invite ? await readInviteSourceControl(db) : null;
      if (mode.backend === "rtdb") {
        if (inviteControl?.backend === "d1")
          throw new InviteSourceFailure(
            "invite-source-session-backend-conflict",
          );
        return raw.getPath(path, query, signal);
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
        : inviteControl?.backend === "d1"
          ? await inviteStore.getPath(path, query, signal)
          : await raw.getPath(path, query, signal);
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
        async (admission, audit, inviteAdmission) => {
          if (!owned.length) {
            if (inviteAdmission.backend === "d1")
              throw new InviteSourceFailure(
                "invite-source-transition-required",
              );
            return raw.patchRoot(updates, signal);
          }
          if (admission.backend === "rtdb") {
            if (inviteAdmission.backend === "d1")
              throw new InviteSourceFailure(
                "invite-source-session-backend-conflict",
              );
            await audit.preparePatch(updates);
            await audit.markDispatching();
            return raw.patchRoot(updates, signal);
          }
          const guards = () => automatchAdmissionGuardStatements(db, admission);
          if (owned.length !== paths.length) {
            const transitions = createGameSessionTransitions({
              db,
              rtdb: raw,
              store,
              now,
              onCommitted,
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
        return write(
          "invite-source-transaction",
          async (_admission, _audit, inviteAdmission) => {
            if (inviteAdmission.backend === "d1")
              throw new InviteSourceFailure(
                "invite-source-transition-required",
              );
            return raw.transactPath(path, updater, signal);
          },
        );
      }
      if (!parseAutomatchPath(path)) {
        return raw.transactPath(path, updater, signal);
      }
      return write(
        "automatch-persistence-transaction",
        async (admission, audit) => {
          if (admission.backend === "rtdb") {
            await audit.prepareTransaction(path);
            await audit.markDispatching();
            return raw.transactPath(
              path,
              updater,
              signal,
              audit.recordTransactionAttempt,
            );
          }
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
        },
      );
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
      return (
        (await control()).state === "active" &&
        (await readInviteSourceControl(db)).state === "active"
      );
    },
    async readQueuedByLogins(
      loginUids: readonly string[],
      signal?: AbortSignal,
    ): Promise<Record<string, unknown> | null> {
      if ((await control()).backend !== "d1") return null;
      const rows = await store.listEntriesByLogins(loginUids, 2, signal);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
    async expireReceipts(
      cutoffMs: number,
      limit: number,
    ): Promise<number | null> {
      const mode = await control();
      if (mode.state === "frozen") return 0;
      if (mode.backend !== "d1") return null;
      return write("session-receipt-expiry", (admission) =>
        createAutomatchD1Store(db, {
          now,
          writeGuards: () => automatchAdmissionGuardStatements(db, admission),
        }).expireReceipts(cutoffMs, limit),
      );
    },
    async sweep(limit = 10) {
      const mode = await control();
      if (mode.backend !== "d1" || mode.state === "frozen") {
        return { recovered: 0, failed: 0 };
      }
      return write(
        "session-transition-sweep",
        (admission, _audit, inviteAdmission) =>
          createGameSessionTransitions({
            db,
            rtdb: raw,
            store,
            now,
            onCommitted,
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
          const mode = await control();
          if (mode.backend === "d1") {
            await recover(lock.lockId);
          }
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
