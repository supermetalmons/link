import { AuthApiFailure } from "./authErrors.ts";
import {
  automatchAdmissionGuardStatements,
  createAutomatchD1Store,
  parseAutomatchRuntimeControlRow,
  prepareAutomatchRuntimeControlRead,
  readAutomatchRuntimeControl,
  type AutomatchRoot,
  type AutomatchWriteAdmission,
} from "./automatchD1.ts";
import {
  createGameSessionTransitions,
  assertNoGameSessionResourceTransition,
  gameSessionResourceGuardStatements,
  type GameSessionLeaseProof,
} from "./gameSessionTransitions.ts";
import type { GameSessionMutationLockStore } from "./gameplayCoordinationD1.ts";
import type {
  MatchStatePort,
  TransactionDecision,
} from "./repositoryContracts.ts";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import type { PrepareMatchPresentations } from "./matchPresentationRegistry.ts";
import {
  InviteSourceFailure,
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
  type InviteSourceAdmission,
} from "./inviteSourceD1.ts";
import {
  acquireAutomatchAdmissions,
  releaseAutomatchAdmissions,
} from "./automatchAdmissions.ts";
import {
  assertAutomatchBackend,
  readAutomatchResourceSnapshot,
} from "./automatchReadD1.ts";
import {
  isFifoAutomatchQueue,
  readAutomatchQueueHead,
} from "./automatchQueueD1.ts";
import {
  markAutomatchOutcome,
  measureAutomatchPhase,
} from "./automatchTelemetry.ts";

export class AutomatchPersistenceFrozen extends AuthApiFailure {
  constructor() {
    super(503, "unavailable", "automatch-persistence-frozen");
  }
}

export function createAutomatchPersistence(
  db: D1Database,
  raw: MatchStatePort,
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
  const pendingNotifications = new Set<string>();
  const flushNotifications = async (): Promise<void> => {
    if (held.size || !pendingNotifications.size) return;
    const inviteIds = [...pendingNotifications];
    pendingNotifications.clear();
    await Promise.all(
      inviteIds.map(async (inviteId) => {
        try {
          await onCommitted?.(inviteId);
        } catch {}
      }),
    );
  };
  const notifyCommitted = async (inviteId: string): Promise<void> => {
    if (!onCommitted) return;
    pendingNotifications.add(inviteId);
    await flushNotifications();
  };
  const store = createAutomatchD1Store(db, { now });
  const control = async () => {
    const value = await readAutomatchRuntimeControl(db);
    assertAutomatchBackend(value);
    return value;
  };

  const write = async <T>(
    kind: string,
    work: (
      admission: AutomatchWriteAdmission,
      inviteAdmission: InviteSourceAdmission,
    ) => Promise<T>,
  ): Promise<T> => {
    const admissions = await acquireAutomatchAdmissions(db, kind, now).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          error.message === "automatch-writes-frozen"
        ) {
          throw new AutomatchPersistenceFrozen();
        }
        throw error;
      },
    );
    try {
      return await work(admissions.automatch, admissions.invite);
    } finally {
      await releaseAutomatchAdmissions(db, admissions);
    }
  };

  const recoverResources = async (
    keys: readonly string[],
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const session = db.withSession("first-primary");
    const [modeRows, pending] = await session.batch<{ resource_key: string }>([
      prepareAutomatchRuntimeControlRead(session),
      session
        .prepare(
          `SELECT MIN(resource_key) AS resource_key
        FROM game_session_transition_resources
        WHERE resource_key IN (SELECT value FROM json_each(?))
        GROUP BY transition_id`,
        )
        .bind(JSON.stringify([...new Set(keys)])),
    ]);
    assertAutomatchBackend(
      parseAutomatchRuntimeControlRow(modeRows.results[0]),
    );
    signal?.throwIfAborted();
    if (!pending.results.length) return false;
    markAutomatchOutcome("recovery");
    return write(
      "session-transition-recovery",
      async (admission, inviteAdmission) => {
        const transitions = createGameSessionTransitions({
          db,
          state: raw,
          store,
          now,
          onCommitted: notifyCommitted,
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

  const readResource = async (
    key: string,
    root: AutomatchRoot | "invite",
    recordKey: string,
    signal?: AbortSignal,
    receipt = false,
  ): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await readAutomatchResourceSnapshot(
        db,
        key,
        root,
        recordKey,
        signal,
      );
      if (
        snapshot.pending &&
        receipt &&
        snapshot.mode.state === "active" &&
        attempt < 2
      ) {
        await measureAutomatchPhase("recovery", () => recover(key, signal));
        continue;
      }
      assertNoGameSessionResourceTransition(snapshot.pending);
      return snapshot.value;
    }
  };
  const transactProjection = (
    method:
      | "transactAutomatchTelegramSource"
      | "transactAutomatchTelegramOutbox"
      | "transactAutomatchProfileOutbox",
    inviteId: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ) =>
    write("automatch-persistence-transaction", async (admission) => {
      const guarded = createAutomatchD1Store(db, {
        now,
        writeGuards: () => [
          ...automatchAdmissionGuardStatements(db, admission),
          ...gameSessionResourceGuardStatements(db, [inviteId]),
        ],
      });
      return guarded[method](inviteId, update, signal);
    });
  const client: GameSessionPort = {
    readInviteMetadata: async (inviteId, signal) =>
      (await readResource(inviteId, "invite", inviteId, signal)) as Record<
        string,
        unknown
      > | null,
    readAutomatchEntry: (inviteId, signal) =>
      readResource(inviteId, "automatch", inviteId, signal),
    listAutomatchEntriesByLogin: async (uid, limit, signal) => {
      await control();
      return store.listAutomatchEntriesByLogin(uid, limit, signal);
    },
    readFirstAutomatchEntry: async (signal) => {
      if (!isFifoAutomatchQueue(await control()))
        return store.readFirstAutomatchEntry(signal);
      while (true) {
        signal?.throwIfAborted();
        const head = await readAutomatchQueueHead(db, signal);
        if (!head) return null;
        if (head.kind === "ready") return { [head.inviteId]: head.value };
        await measureAutomatchPhase("recovery", () =>
          recover(head.inviteId, signal),
        );
      }
    },
    readMutationReceipt: (operationId, signal) =>
      readResource(
        `gameplay-operation:${operationId}`,
        "gameplayMutationReceipts",
        operationId,
        signal,
        true,
      ),
    readAutomatchTelegramSource: (inviteId, signal) =>
      readResource(inviteId, "telegramAutomatches", inviteId, signal),
    readAutomatchTelegramOutbox: (inviteId, signal) =>
      readResource(
        inviteId,
        "telegramProjectionOutbox/automatch",
        inviteId,
        signal,
      ),
    readAutomatchProfileOutbox: (inviteId, signal) =>
      readResource(
        inviteId,
        "profileGameProjectionOutbox/automatch",
        inviteId,
        signal,
      ),
    transactAutomatchTelegramSource: (inviteId, update, signal) =>
      transactProjection(
        "transactAutomatchTelegramSource",
        inviteId,
        update,
        signal,
      ),
    transactAutomatchTelegramOutbox: (inviteId, update, signal) =>
      transactProjection(
        "transactAutomatchTelegramOutbox",
        inviteId,
        update,
        signal,
      ),
    transactAutomatchProfileOutbox: (inviteId, update, signal) =>
      transactProjection(
        "transactAutomatchProfileOutbox",
        inviteId,
        update,
        signal,
      ),
    listDueAutomatchTelegramOutboxes: async (atMs, limit, signal) => {
      await control();
      return store.listDueAutomatchTelegramOutboxes(atMs, limit, signal);
    },
    listDueAutomatchProfileOutboxes: async (atMs, limit, signal) => {
      await control();
      return store.listDueAutomatchProfileOutboxes(atMs, limit, signal);
    },
    listMalformedAutomatchProfileOutboxes: async (limit, signal) => {
      await control();
      return store.listMalformedAutomatchProfileOutboxes(limit, signal);
    },
    commitSessionChanges: (changes, signal) =>
      write(
        "automatch-persistence-patch",
        async (admission, inviteAdmission) => {
          const guards = () => automatchAdmissionGuardStatements(db, admission);
          if (
            changes.some((change) => change.kind.startsWith("invite-")) &&
            !changes.some(
              (change) =>
                !change.kind.startsWith("invite-") &&
                change.kind !== "match-create",
            )
          )
            throw new InviteSourceFailure("invite-source-transition-required");
          if (
            changes.some(
              (change) =>
                change.kind.startsWith("invite-") ||
                change.kind === "match-create",
            )
          ) {
            return createGameSessionTransitions({
              db,
              state: raw,
              store,
              now,
              onCommitted: notifyCommitted,
              prepareMatchPresentations,
              writeGuards: guards,
              inviteAdmission,
            }).commit(changes, [...held.values()], signal);
          }
          const resources = changes.map((change) =>
            change.kind === "mutation-receipt"
              ? `gameplay-operation:${change.operationId}`
              : "inviteId" in change
                ? change.inviteId
                : "",
          );
          const guarded = createAutomatchD1Store(db, {
            now,
            writeGuards: () => [
              ...guards(),
              ...gameSessionResourceGuardStatements(db, resources),
            ],
          });
          const nowMs = now();
          for (let attempt = 0; attempt < 25; attempt++) {
            if (
              await guarded.commit(
                await guarded.prepareChanges(changes, nowMs, signal),
                signal,
              )
            )
              return;
          }
          throw new Error("automatch-patch-contention");
        },
      ),
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
      const session = db.withSession("first-primary");
      const [modeRows, inviteRows] = await session.batch([
        prepareAutomatchRuntimeControlRead(session),
        prepareInviteSourceControlRead(session),
      ]);
      const mode = parseAutomatchRuntimeControlRow(modeRows.results[0]);
      assertAutomatchBackend(mode);
      const inviteControl = parseInviteSourceControlRow(inviteRows.results[0]);
      if (inviteControl.backend !== "d1") {
        throw new InviteSourceFailure("invite-source-backend-retired");
      }
      return mode.state === "active" && inviteControl.state === "active";
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
          state: raw,
          store,
          now,
          onCommitted: notifyCommitted,
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
            await flushNotifications();
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
