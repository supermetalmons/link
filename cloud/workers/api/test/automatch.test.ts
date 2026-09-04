import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelQueuedAutomatch as cancelQueuedAutomatchImpl,
  emptyAutomatchProfile,
  findOwnedQueuedAutomatch,
  getFirstQueuedAutomatch,
  startAutomatch as startAutomatchImpl,
  type AutomatchDependencies,
} from "../src/automatch.ts";
import { AuthApiFailure } from "../src/authErrors.ts";
import { GameSessionMutationLeaseReleaseFailure } from "../src/gameSessionMutations.ts";
import { GameSessionMutationLockFailure } from "../src/gameplayCoordinationD1.ts";
import { cancelAutomatch as cancelAutomatchImpl } from "../src/gameplayRoute.ts";
import type { RequestIdentity } from "../src/requestIdentity.ts";
import {
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  firebaseRtdbIncrement,
} from "../src/firebaseRtdb.ts";
import type {
  GameplayProfile,
  GameplayRepository,
} from "../src/gameplayRepository.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";
import { createMemoryGameplayCoordinationStores } from "./gameplayCoordinationTestUtils.ts";

const identity: RequestIdentity = {
  uid: "guest-uid",
};
const AUTOMATCH_OPERATION_ID = "00000000-0000-4000-8000-000000000001";

const coordinationByRepository = new WeakMap<
  GameplayRepository,
  ReturnType<typeof createMemoryGameplayCoordinationStores>
>();

function coordinationFor(repository: GameplayRepository) {
  let coordination = coordinationByRepository.get(repository);
  if (!coordination) {
    coordination = createMemoryGameplayCoordinationStores();
    coordinationByRepository.set(repository, coordination);
  }
  return coordination;
}

function automatchDependencies(
  repository: GameplayRepository,
  dependencies: Partial<AutomatchDependencies> = {},
): AutomatchDependencies {
  return {
    mutationLocks: coordinationFor(repository).mutationLocks,
    ...dependencies,
  };
}

function startAutomatch(
  identity: Parameters<typeof startAutomatchImpl>[0],
  request: Parameters<typeof startAutomatchImpl>[1],
  repository: GameplayRepository,
  dependencies: Partial<AutomatchDependencies> = {},
) {
  return startAutomatchImpl(
    identity,
    request,
    repository,
    automatchDependencies(repository, dependencies),
  );
}

function cancelQueuedAutomatch(
  queued: Parameters<typeof cancelQueuedAutomatchImpl>[0],
  repository: GameplayRepository,
  dependencies: Partial<AutomatchDependencies> = {},
  signal?: AbortSignal,
) {
  return cancelQueuedAutomatchImpl(
    queued,
    repository,
    automatchDependencies(repository, dependencies),
    signal,
  );
}

function cancelAutomatch(
  identity: Parameters<typeof cancelAutomatchImpl>[0],
  repository: GameplayRepository,
  dependencies: Partial<AutomatchDependencies> = {},
) {
  return cancelAutomatchImpl(
    identity,
    repository,
    automatchDependencies(repository, dependencies),
  );
}

async function automatchOwnerLockId(owner: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(owner),
  );
  return `automatch-owner-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}
function request(emojiId = 1, aura = "", operationId = AUTOMATCH_OPERATION_ID) {
  return { operationId, emojiId, aura };
}

function receiptFromUpdates(
  updates: Record<string, unknown>,
  operationId = AUTOMATCH_OPERATION_ID,
): unknown {
  return {
    ...(updates[`gameplayMutationReceipts/${operationId}`] as Record<
      string,
      unknown
    >),
    completedAtMs: 1,
  };
}

function storedAutomatchReceipt(
  inviteId: string,
  mode: "matched" | "pending" = "pending",
  operationId = AUTOMATCH_OPERATION_ID,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aura: "",
    completedAtMs: 1,
    emojiId: 1,
    inviteId,
    kind: "automatch-start",
    operationId,
    profileProjectionRequestId: null,
    requesterUid: identity.uid,
    response: {
      ok: true,
      inviteId,
      mode,
      matchedImmediately: mode === "matched",
    },
    telegramProjection: false,
  };
}

function assertPendingReceiptUpdates(
  updates: Record<string, unknown>,
  inviteId: string,
  operationId = AUTOMATCH_OPERATION_ID,
  requesterUid = identity.uid,
): void {
  assert.deepEqual(updates[`gameplayMutationReceipts/${operationId}`], {
    schemaVersion: 1,
    aura: "",
    completedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    emojiId: 1,
    inviteId,
    kind: "automatch-start",
    operationId,
    profileProjectionRequestId: null,
    requesterUid,
    response: {
      ok: true,
      inviteId,
      mode: "pending",
      matchedImmediately: false,
    },
    telegramProjection: false,
  });
  assert.deepEqual(
    updates[`gameplayMutationReceiptExpirations/${operationId}`],
    { completedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP },
  );
  assert.equal(
    updates[`invites/${inviteId}/automatchOperationIds/${requesterUid}`],
    operationId,
  );
}

const profile: GameplayProfile = {
  aura: "rainbow",
  emoji: 9,
  eth: "0xabcdef",
  profileId: "guest-profile",
  rating: 1512,
  sol: "guest-sol",
  username: "Alice",
};

type OwnershipState = Readonly<{
  aliasesByProfileId?: Readonly<Record<string, readonly string[]>>;
  ownerByUid?: Readonly<Record<string, string | null>>;
  profilesById?: Readonly<Record<string, GameplayProfile>>;
}>;

function ownershipSnapshot(
  query: ProfileOwnershipQuery,
  state: OwnershipState = {},
): ProfileOwnershipSnapshot {
  const ownerByUid = new Map(
    query.loginUids.map((uid) => {
      const configured = state.ownerByUid?.[uid];
      const profileId =
        configured === undefined
          ? uid === identity.uid
            ? profile.profileId
            : `${uid}-profile`
          : configured;
      return [uid, profileId ? { profileId, revision: 1 } : null] as const;
    }),
  );
  const canonicalByProfileId = new Map(
    query.profileIds.map((profileId) => [profileId, profileId] as const),
  );
  const canonicalProfileIds = new Set([
    ...[...ownerByUid.values()].flatMap((owner) =>
      owner ? [owner.profileId] : [],
    ),
    ...canonicalByProfileId.values(),
  ]);
  return {
    canonicalProfileIdByProfileId: canonicalByProfileId,
    loginOwnerByUid: ownerByUid,
    loginUidsByProfileId: new Map(
      [...canonicalProfileIds].map((profileId) => [
        profileId,
        state.aliasesByProfileId?.[profileId] ||
          [...ownerByUid]
            .filter(([, owner]) => owner?.profileId === profileId)
            .map(([uid]) => uid),
      ]),
    ),
    profileById: new Map(
      [...canonicalProfileIds].map((profileId) => [
        profileId,
        {
          profile:
            state.profilesById?.[profileId] ||
            (profileId === profile.profileId
              ? profile
              : { ...emptyAutomatchProfile(), profileId }),
          revision: 1,
        },
      ]),
    ),
  };
}

function repository(
  overrides: Partial<GameplayRepository> = {},
  readReceipt: (() => unknown) | null = null,
): GameplayRepository {
  const transactionValues = new Map<string, unknown>();
  const receiptValues = new Map<string, unknown>();
  const getRtdbPath = overrides.getRtdbPath;
  const patchRtdbRoot = overrides.patchRtdbRoot;
  const {
    getRtdbPath: _ignoredGet,
    patchRtdbRoot: _ignoredPatch,
    ...remainingOverrides
  } = overrides;
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 10,
      slime: 10,
      gum: 10,
      metal: 10,
      ice: 10,
    }),
    getMiningSnapshot: async () => null,
    getRtdbPath: async (path, query, signal) =>
      path.startsWith("gameplayMutationReceipts/")
        ? readReceipt
          ? readReceipt()
          : (receiptValues.get(path) ?? null)
        : (getRtdbPath?.(path, query, signal) ?? null),
    patchRtdbRoot: async (updates, signal) => {
      for (const [path, value] of Object.entries(updates)) {
        if (path.startsWith("gameplayMutationReceipts/")) {
          receiptValues.set(path, {
            ...(value as Record<string, unknown>),
            completedAtMs: 1,
          });
        }
      }
      await patchRtdbRoot?.(updates, signal);
    },
    transactRtdbPath: async (path, updater) => {
      const decision = updater(transactionValues.get(path) ?? null) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: transactionValues.get(path) ?? null,
        };
      }
      transactionValues.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
    ...remainingOverrides,
  };
}

test("normalizes the first bounded queue result", () => {
  assert.deepEqual(getFirstQueuedAutomatch({ auto_one: { uid: "host" } }), {
    inviteId: "auto_one",
    data: { uid: "host" },
  });
  assert.equal(getFirstQueuedAutomatch(null), null);
  assert.equal(getFirstQueuedAutomatch({}), null);
  assert.deepEqual(emptyAutomatchProfile(), {
    aura: "",
    emoji: "",
    eth: "",
    profileId: "",
    rating: 0,
    sol: "",
    username: "",
  });
});

test("creates a pending automatch with profile metadata and exact roots", async () => {
  let updates: Record<string, unknown> | null = null;
  const projectionTasks: unknown[] = [];
  const profileProjectionTasks: unknown[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path, query) => {
        if (path === `gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`) {
          return null;
        }
        assert.equal(path, "automatch");
        if (query?.orderBy === "uid") {
          assert.deepEqual(query, {
            orderBy: "uid",
            equalTo: identity.uid,
            limitToFirst: 2,
          });
          return null;
        }
        assert.deepEqual(query, { orderBy: "$key", limitToFirst: 1 });
        return null;
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
    {
      createProjectionRequestId: () => "request-1",
      enqueueTelegramProjection: async (task) => {
        projectionTasks.push(task);
      },
      enqueueProfileGameProjection: async (task) => {
        profileProjectionTasks.push(task);
      },
      random: () => 0,
    },
  );
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_aaaaaaaaaaa",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.deepEqual(projectionTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_aaaaaaaaaaa",
      requestId: "request-1",
    },
  ]);
  assert.deepEqual(profileProjectionTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_aaaaaaaaaaa",
      requestId: "request-1",
    },
  ]);
  assert.ok(updates);
  assert.deepEqual(Object.keys(updates).sort(), [
    "automatch/auto_aaaaaaaaaaa",
    `gameplayMutationReceiptExpirations/${AUTOMATCH_OPERATION_ID}`,
    `gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`,
    "invites/auto_aaaaaaaaaaa",
    "players/guest-uid/matches/auto_aaaaaaaaaaa",
    "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa",
    "telegramAutomatches/auto_aaaaaaaaaaa",
    "telegramProjectionOutbox/automatch/auto_aaaaaaaaaaa",
  ]);
  const receipt = updates[
    `gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`
  ] as Record<string, unknown>;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, "automatch-start");
  assert.equal(receipt.operationId, AUTOMATCH_OPERATION_ID);
  assert.equal(receipt.requesterUid, identity.uid);
  assert.equal(receipt.emojiId, 1);
  assert.equal(receipt.aura, "");
  assert.equal(receipt.inviteId, "auto_aaaaaaaaaaa");
  assert.equal(receipt.profileProjectionRequestId, "request-1");
  assert.equal(receipt.telegramProjection, true);
  assert.deepEqual(receipt.response, result);
  assert.deepEqual(
    updates[`gameplayMutationReceiptExpirations/${AUTOMATCH_OPERATION_ID}`],
    { completedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP },
  );
  const queue = updates["automatch/auto_aaaaaaaaaaa"] as Record<
    string,
    unknown
  >;
  const match = updates["players/guest-uid/matches/auto_aaaaaaaaaaa"] as Record<
    string,
    unknown
  >;
  const invite = updates["invites/auto_aaaaaaaaaaa"] as Record<string, unknown>;
  const telegram = updates["telegramAutomatches/auto_aaaaaaaaaaa"] as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    updates["profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa"],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      reason: "automatch-queue",
      sourceUpdatedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
      lastQueuedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    },
  );
  assert.deepEqual(
    updates["telegramProjectionOutbox/automatch/auto_aaaaaaaaaaa"],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    },
  );
  assert.equal(queue.emojiId, 9);
  assert.equal(queue.profileId, "guest-profile");
  assert.equal(queue.password, "aaaaaaaaaaaaaaa");
  assert.deepEqual(queue.timestamp, FIREBASE_RTDB_SERVER_TIMESTAMP);
  assert.equal(match.emojiId, 9);
  assert.equal(match.aura, "rainbow");
  assert.equal(match.color, "white");
  assert.equal(match.gameVariant, queue.gameVariant);
  assert.equal(typeof match.fen, "string");
  assert.deepEqual(invite, {
    version: 2,
    hostId: "guest-uid",
    hostColor: "white",
    guestId: null,
    password: "aaaaaaaaaaaaaaa",
    automatchStateHint: "pending",
    automatchCanceledAt: null,
    automatchOperationIds: {
      [identity.uid]: AUTOMATCH_OPERATION_ID,
    },
    telegramDeliveryVersion: 2,
  });
  assert.equal(telegram.lifecycle, "pending");
  assert.equal(telegram.generation, 1);
  assert.match(
    String(telegram.waitingText),
    /Alice \(1512\).*looking for a match/,
  );
});

test("returns a committed pending automatch despite release failure", async () => {
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];
  let committed = false;
  const value = repository({
    getRtdbPath: async (path) => {
      if (!committed) return null;
      if (path === "automatch/auto_aaaaaaaaaaa") {
        return { uid: identity.uid };
      }
      if (path === "invites/auto_aaaaaaaaaaa") {
        return {
          hostId: identity.uid,
          guestId: null,
          automatchStateHint: "pending",
        };
      }
      if (
        path ===
        "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa/requestId"
      ) {
        return "pending-release";
      }
      return null;
    },
    patchRtdbRoot: async () => {
      committed = true;
      throw new Error("response-lost-after-commit");
    },
  });
  const stores = coordinationFor(value);
  const release = stores.mutationLocks.release;
  stores.mutationLocks.release = async (lock, ownerId) => {
    if (lock.lockId === "auto_aaaaaaaaaaa") {
      throw new GameSessionMutationLockFailure("release");
    }
    await release(lock, ownerId);
  };

  const result = await startAutomatch(identity, request(), value, {
    createProjectionRequestId: () => "pending-release",
    enqueueProfileGameProjection: async (task) => {
      profileTasks.push(task);
    },
    enqueueTelegramProjection: async (task) => {
      telegramTasks.push(task);
    },
    random: () => 0,
  });
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_aaaaaaaaaaa",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_aaaaaaaaaaa",
      requestId: "pending-release",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_aaaaaaaaaaa",
      requestId: "pending-release",
    },
  ]);
});

test("uses client metadata without canonical ownership for an unlinked login", async () => {
  const logs: string[] = [];
  let updates: Record<string, unknown> = {};
  const result = await startAutomatch(
    identity,
    request(3, "rainbow"),
    repository({
      readProfileOwnershipSnapshot: async (query) =>
        ownershipSnapshot(query, {
          ownerByUid: { [identity.uid]: null },
        }),
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
    {
      createProjectionRequestId: () => "request-1",
      logProfileFailure: () => logs.push("failed"),
      random: () => 0,
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(logs, []);
  const queue = updates["automatch/auto_aaaaaaaaaaa"] as Record<
    string,
    unknown
  >;
  const match = updates["players/guest-uid/matches/auto_aaaaaaaaaaa"] as Record<
    string,
    unknown
  >;
  assert.equal(queue.profileId, "");
  assert.equal(queue.rating, 0);
  assert.equal(queue.emojiId, 3);
  assert.equal(match.emojiId, 3);
  assert.equal(match.aura, "rainbow");
});

test("automatch queue failures preserve the committed response and outboxes", async () => {
  let updates: Record<string, unknown> = {};
  const failures: string[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async () => null,
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
    {
      createProjectionRequestId: () => "request-1",
      enqueueTelegramProjection: async () => {
        throw new Error("queue-unavailable");
      },
      enqueueProfileGameProjection: async () => {
        throw new Error("profile-queue-unavailable");
      },
      logProjectionFailure: (task) =>
        failures.push(`telegram:${task.inviteId}`),
      logProfileGameProjectionFailure: (task) =>
        failures.push(`profile:${task.inviteId}`),
      random: () => 0,
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(failures, [
    "telegram:auto_aaaaaaaaaaa",
    "profile:auto_aaaaaaaaaaa",
  ]);
  assert.deepEqual(
    updates["profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa"],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      reason: "automatch-queue",
      sourceUpdatedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
      lastQueuedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    },
  );
  assert.deepEqual(
    updates["telegramProjectionOutbox/automatch/auto_aaaaaaaaaaa"],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    },
  );
});

test("fails closed before reading a queue when ownership is unavailable", async () => {
  let queueReads = 0;
  let writes = 0;
  await assert.rejects(
    () =>
      startAutomatch(
        identity,
        request(),
        repository({
          readProfileOwnershipSnapshot: async () => {
            throw new Error("profile-unavailable");
          },
          getRtdbPath: async () => {
            queueReads++;
            return { auto_existing: { uid: identity.uid } };
          },
          patchRtdbRoot: async () => {
            writes++;
          },
        }),
        { logProfileFailure: () => undefined },
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
  assert.equal(queueReads, 0);
  assert.equal(writes, 0);
});

test("returns pending automatches for the same login or profile", async (t) => {
  for (const [name, queuedProfile, queuedUid] of [
    ["login", "other-profile", "guest-uid"],
    ["profile", "stale-profile", "other-uid"],
  ] as const) {
    await t.test(name, async () => {
      let updates: Record<string, unknown> = {};
      const result = await startAutomatch(
        identity,
        request(),
        repository({
          readProfileOwnershipSnapshot: async (query) =>
            ownershipSnapshot(query, {
              ownerByUid: {
                [identity.uid]: profile.profileId,
                "other-uid": profile.profileId,
              },
              aliasesByProfileId: {
                [profile.profileId]: [identity.uid, "other-uid"],
              },
            }),
          getRtdbPath: async (path) => {
            const queue = {
              profileId: queuedProfile,
              uid: queuedUid,
            };
            if (path === "automatch") return { auto_existing: queue };
            if (path === "automatch/auto_existing") return queue;
            if (path === "invites/auto_existing") {
              return {
                hostId: queuedUid,
                guestId: null,
                automatchStateHint: "pending",
              };
            }
            assert.fail(`unexpected path ${path}`);
          },
          patchRtdbRoot: async (value) => {
            updates = value;
          },
        }),
      );
      assert.deepEqual(result, {
        ok: true,
        inviteId: "auto_existing",
        mode: "pending",
        matchedImmediately: false,
      });
      assertPendingReceiptUpdates(updates, "auto_existing");
    });
  }
});

test("receipts a same-login queue that appears after owner convergence", async () => {
  let updates: Record<string, unknown> = {};
  let uidReads = 0;
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path, query) => {
        if (path === "automatch/auto_late") {
          return { uid: identity.uid };
        }
        if (path === "invites/auto_late") {
          return {
            hostId: identity.uid,
            guestId: null,
            automatchStateHint: "pending",
          };
        }
        assert.equal(path, "automatch");
        if (query?.orderBy === "uid") {
          uidReads++;
          return null;
        }
        assert.deepEqual(query, { orderBy: "$key", limitToFirst: 1 });
        return { auto_late: { uid: identity.uid } };
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_late",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.equal(uidReads, 1);
  assertPendingReceiptUpdates(updates, "auto_late");
});

test("finds another owned login queue before scanning for a match", async () => {
  let updates: Record<string, unknown> = {};
  const queriedUids: unknown[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      readProfileOwnershipSnapshot: async (query) =>
        ownershipSnapshot(query, {
          ownerByUid: {
            [identity.uid]: profile.profileId,
            "alternate-uid": profile.profileId,
          },
          aliasesByProfileId: {
            [profile.profileId]: ["alternate-uid", identity.uid],
          },
        }),
      getRtdbPath: async (path, query) => {
        if (path === "automatch/auto_owned") {
          return {
            uid: "alternate-uid",
            profileId: profile.profileId,
            timestamp: 1,
          };
        }
        if (path === "invites/auto_owned") {
          return {
            hostId: "alternate-uid",
            guestId: null,
            automatchStateHint: "pending",
          };
        }
        assert.equal(path, "automatch");
        assert.equal(query?.orderBy, "uid");
        queriedUids.push(query?.equalTo);
        return query?.equalTo === "alternate-uid"
          ? {
              auto_owned: {
                uid: "alternate-uid",
                profileId: profile.profileId,
                timestamp: 1,
              },
            }
          : null;
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_owned",
    mode: "pending",
    matchedImmediately: false,
  });
  assertPendingReceiptUpdates(updates, "auto_owned");
  assert.deepEqual(queriedUids, ["alternate-uid", identity.uid]);
});

test("receipts a pending shortcut as matched when the guest wins the invite race", async () => {
  let updates: Record<string, unknown> = {};
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          return { auto_race: { uid: identity.uid } };
        }
        if (path === "automatch/auto_race") return null;
        if (path === "invites/auto_race") {
          return {
            hostId: identity.uid,
            guestId: "matched-guest",
            automatchStateHint: "matched",
          };
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_race",
    mode: "matched",
    matchedImmediately: true,
  });
  const receipt = updates[
    `gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`
  ] as Record<string, unknown>;
  assert.equal(receipt.inviteId, "auto_race");
  assert.equal(receipt.profileProjectionRequestId, null);
  assert.deepEqual(receipt.response, result);
  assert.equal(
    updates[`invites/auto_race/automatchOperationIds/${identity.uid}`],
    AUTOMATCH_OPERATION_ID,
  );
});

test("does not receipt a canceled pending shortcut", async () => {
  let updates: Record<string, unknown> = {};
  let ownerQueueReads = 0;
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          if (query?.orderBy === "uid" && ownerQueueReads++ === 0) {
            return { auto_canceled: { uid: identity.uid } };
          }
          return null;
        }
        if (path === "automatch/auto_canceled") return null;
        if (path === "invites/auto_canceled") {
          return {
            hostId: identity.uid,
            guestId: null,
            automatchStateHint: "canceled",
          };
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
    { random: () => 0 },
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_aaaaaaaaaaa",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.equal(
    updates[`invites/auto_canceled/automatchOperationIds/${identity.uid}`],
    undefined,
  );
  assert.equal(
    (
      updates[`gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`] as Record<
        string,
        unknown
      >
    ).inviteId,
    "auto_aaaaaaaaaaa",
  );
});

test("uses the supplied ownership snapshot without revalidation", async () => {
  let ownershipReads = 0;
  const result = await findOwnedQueuedAutomatch(
    [identity.uid, "former-alias"],
    repository({
      readProfileOwnershipSnapshot: async () => {
        ownershipReads++;
        throw new Error("ownership must not be re-read");
      },
      getRtdbPath: async (_path, query) =>
        query?.equalTo === "former-alias"
          ? {
              auto_foreign: {
                uid: "former-alias",
                profileId: profile.profileId,
                timestamp: 1,
              },
            }
          : null,
    }),
  );

  assert.equal(result?.inviteId, "auto_foreign");
  assert.equal(ownershipReads, 0);
});

test("selects the newest queue across owned logins", async () => {
  const result = await findOwnedQueuedAutomatch(
    [identity.uid, "first-alias", "second-alias"],
    repository({
      getRtdbPath: async (_path, query) => {
        if (query?.equalTo === "first-alias") {
          return {
            auto_older: { uid: "first-alias", timestamp: 1 },
          };
        }
        if (query?.equalTo === "second-alias") {
          return {
            auto_newer: { uid: "second-alias", timestamp: 2 },
          };
        }
        return null;
      },
    }),
  );

  assert.equal(result?.inviteId, "auto_newer");
});

test("breaks equal queue timestamps deterministically per login", async () => {
  const result = await findOwnedQueuedAutomatch(
    [identity.uid],
    repository({
      getRtdbPath: async () => ({
        auto_z: { uid: identity.uid, timestamp: 2 },
        auto_a: { uid: identity.uid, timestamp: 2 },
        auto_old: { uid: identity.uid, timestamp: 1 },
      }),
    }),
  );

  assert.equal(result?.inviteId, "auto_a");
});

test("reads every bounded owner alias and selects the newest queue", async () => {
  const loginUids = [
    identity.uid,
    ...Array.from(
      { length: 511 },
      (_, index) => `bulk-alias-${String(index).padStart(3, "0")}`,
    ),
  ];
  let aliasReads = 0;
  const result = await findOwnedQueuedAutomatch(
    loginUids,
    repository({
      getRtdbPath: async (_path, query) => {
        const loginUid = String(query?.equalTo || "");
        if (loginUid === identity.uid) return null;
        aliasReads += 1;
        const index = loginUids.indexOf(loginUid);
        return {
          [`auto_${String(index).padStart(3, "0")}`]: {
            uid: loginUid,
            timestamp: index,
          },
        };
      },
    }),
  );

  assert.equal(result?.inviteId, "auto_511");
  assert.equal(aliasReads, 511);
});

test("bounds automatch alias lookups", async () => {
  let aliasReads = 0;
  await assert.rejects(
    startAutomatch(
      identity,
      request(),
      repository({
        readProfileOwnershipSnapshot: async (query) =>
          ownershipSnapshot(query, {
            aliasesByProfileId: {
              [profile.profileId]: [
                identity.uid,
                ...Array.from({ length: 512 }, (_, index) => `alias-${index}`),
              ],
            },
          }),
        getRtdbPath: async (_path, query) => {
          if (query?.equalTo !== identity.uid) aliasReads++;
          return null;
        },
      }),
      { logProfileFailure: () => undefined },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.message === "profile-ownership-unavailable",
  );
  assert.equal(aliasReads, 0);
});

test("serializes concurrent starts for logins on the same profile", async () => {
  const queued = new Map<string, Record<string, unknown>>();
  const invites = new Map<string, Record<string, unknown>>();
  let queueWrites = 0;
  const shared = repository({
    readProfileOwnershipSnapshot: async (query) =>
      ownershipSnapshot(query, {
        ownerByUid: {
          "first-uid": profile.profileId,
          "second-uid": profile.profileId,
        },
        aliasesByProfileId: {
          [profile.profileId]: ["second-uid", "first-uid"],
        },
      }),
    getRtdbPath: async (path, query) => {
      const queueMatch = /^automatch\/([^/]+)$/.exec(path);
      if (queueMatch) return queued.get(queueMatch[1]) || null;
      const inviteMatch = /^invites\/([^/]+)$/.exec(path);
      if (inviteMatch) return invites.get(inviteMatch[1]) || null;
      if (path !== "automatch") return null;
      const entries = Array.from(queued.entries()).filter(([, value]) =>
        query?.orderBy === "uid" ? value.uid === query.equalTo : true,
      );
      return entries.length > 0 ? Object.fromEntries(entries) : null;
    },
    patchRtdbRoot: async (updates) => {
      await new Promise((resolve) => setTimeout(resolve, 125));
      for (const [path, value] of Object.entries(updates)) {
        const queueMatch = /^automatch\/([^/]+)$/.exec(path);
        if (queueMatch && value && typeof value === "object") {
          queued.set(queueMatch[1], value as Record<string, unknown>);
          queueWrites++;
        }
        const inviteMatch = /^invites\/([^/]+)$/.exec(path);
        if (inviteMatch && value && typeof value === "object") {
          invites.set(inviteMatch[1], value as Record<string, unknown>);
        }
        const operationMatch =
          /^invites\/([^/]+)\/automatchOperationIds\/([^/]+)$/.exec(path);
        if (operationMatch) {
          const invite = invites.get(operationMatch[1]) || {};
          invites.set(operationMatch[1], {
            ...invite,
            automatchOperationIds: {
              ...((invite.automatchOperationIds as Record<string, unknown>) ||
                {}),
              [operationMatch[2]]: value,
            },
          });
        }
      }
    },
  });
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  const results = await Promise.all([
    startAutomatch({ uid: "first-uid" }, request(), shared, {
      random: () => 0,
      wait,
    }),
    startAutomatch(
      { uid: "second-uid" },
      request(1, "", "00000000-0000-4000-8000-000000000002"),
      shared,
      {
        random: () => 0.5,
        wait,
      },
    ),
  ]);

  assert.equal(queueWrites, 1);
  assert.equal(queued.size, 1);
  if (!results[0].ok || !results[1].ok) {
    assert.fail("concurrent starts must both resolve to the owned queue");
  }
  assert.equal(results[0].inviteId, results[1].inviteId);
  assert.equal(results[0].mode, "pending");
  assert.equal(results[1].mode, "pending");
});

test("serializes one operation while canonical ownership changes", async () => {
  let linked = false;
  let ownershipReads = 0;
  let sourceWrites = 0;
  let committedReceipt: unknown = null;
  let releasePatch: () => void = () => undefined;
  let markPatchEntered: () => void = () => undefined;
  const patchEntered = new Promise<void>((resolve) => {
    markPatchEntered = resolve;
  });
  const patchBlocked = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  const value = repository(
    {
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads++;
        return ownershipSnapshot(query, {
          ownerByUid: { [identity.uid]: linked ? profile.profileId : null },
          aliasesByProfileId: linked
            ? { [profile.profileId]: [identity.uid] }
            : {},
        });
      },
      getRtdbPath: async (path) => {
        if (path === "automatch") return null;
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        sourceWrites++;
        markPatchEntered();
        await patchBlocked;
        committedReceipt = receiptFromUpdates(updates);
      },
    },
    () => committedReceipt,
  );
  const first = startAutomatch(identity, request(), value, { random: () => 0 });
  await patchEntered;
  linked = true;

  await assert.rejects(
    startAutomatch(identity, request(), value, { random: () => 0.5 }),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.message === "invite-busy",
  );
  releasePatch();
  const firstResult = await first;
  const replayedResult = await startAutomatch(identity, request(), value, {
    random: () => 0.5,
  });

  assert.deepEqual(replayedResult, firstResult);
  assert.equal(sourceWrites, 1);
  assert.equal(ownershipReads, 1);
  assert.equal(
    (committedReceipt as Record<string, unknown>).inviteId,
    "auto_aaaaaaaaaaa",
  );
});

test("converges pending queues after their owners merge", async () => {
  const queues = new Map<string, Record<string, unknown>>([
    [
      "auto_older",
      {
        uid: "first-uid",
        timestamp: 1,
        telegramDeliveryVersion: 2,
      },
    ],
    [
      "auto_newer",
      {
        uid: "second-uid",
        timestamp: 2,
        telegramDeliveryVersion: 2,
      },
    ],
  ]);
  const invites = new Map<string, Record<string, unknown>>([
    ["auto_older", { hostId: "first-uid", guestId: null }],
    ["auto_newer", { hostId: "second-uid", guestId: null }],
  ]);
  const patches: Array<Record<string, unknown>> = [];
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];
  let ownershipReads = 0;
  const result = await startAutomatch(
    { uid: "first-uid" },
    request(),
    repository({
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads++;
        return ownershipSnapshot(query, {
          ownerByUid: { "first-uid": "merged-profile" },
          aliasesByProfileId: {
            "merged-profile": ["first-uid", "second-uid"],
          },
        });
      },
      getRtdbPath: async (path, query) => {
        if (path === "automatch" && query?.orderBy === "uid") {
          const matches = [...queues]
            .filter(([, value]) => value.uid === query.equalTo)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, query.limitToFirst || 1);
          return matches.length ? Object.fromEntries(matches) : null;
        }
        const queueMatch = /^automatch\/(.+)$/.exec(path);
        if (queueMatch) return queues.get(queueMatch[1]) || null;
        const inviteRootMatch = /^invites\/([^/]+)$/.exec(path);
        if (inviteRootMatch) return invites.get(inviteRootMatch[1]) || null;
        const inviteMatch =
          /^invites\/(.+)\/(guestId|hostId|automatchOperationIds)$/.exec(path);
        if (inviteMatch) {
          return invites.get(inviteMatch[1])?.[inviteMatch[2]] ?? null;
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
        for (const [path, value] of Object.entries(updates)) {
          const queueMatch = /^automatch\/(.+)$/.exec(path);
          if (queueMatch && value === null) queues.delete(queueMatch[1]);
          const inviteMatch = /^invites\/(.+)\/(.+)$/.exec(path);
          if (inviteMatch) {
            invites.set(inviteMatch[1], {
              ...(invites.get(inviteMatch[1]) || {}),
              [inviteMatch[2]]: value,
            });
          }
        }
      },
    }),
    {
      createProjectionRequestId: () => "converge-request",
      enqueueProfileGameProjection: async (task) => {
        profileTasks.push(task);
      },
      enqueueTelegramProjection: async (task) => {
        telegramTasks.push(task);
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_newer",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.equal(ownershipReads, 1);
  assert.deepEqual([...queues.keys()], ["auto_newer"]);
  assert.equal(invites.get("auto_older")?.automatchStateHint, "canceled");
  assert.equal(patches.length, 2);
  assert.equal(patches[0]["automatch/auto_older"], null);
  assertPendingReceiptUpdates(
    patches[1],
    "auto_newer",
    AUTOMATCH_OPERATION_ID,
    "first-uid",
  );
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_older",
      requestId: "converge-request",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_older",
      requestId: "converge-request",
    },
  ]);
});

test("repeatedly converges same-UID queues hidden behind the bounded query", async () => {
  const queues = new Map<string, Record<string, unknown>>([
    ["auto_a", { uid: identity.uid, timestamp: 1, telegramDeliveryVersion: 2 }],
    ["auto_b", { uid: identity.uid, timestamp: 3, telegramDeliveryVersion: 2 }],
    ["auto_c", { uid: identity.uid, timestamp: 2, telegramDeliveryVersion: 2 }],
  ]);
  const invites = new Map<string, Record<string, unknown>>(
    [...queues].map(([inviteId]) => [
      inviteId,
      { hostId: identity.uid, guestId: null },
    ]),
  );
  const canceledInviteIds: string[] = [];
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];
  let receiptUpdates: Record<string, unknown> = {};
  let requestId = 0;
  let uidQueries = 0;

  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          assert.deepEqual(query, {
            orderBy: "uid",
            equalTo: identity.uid,
            limitToFirst: 2,
          });
          uidQueries += 1;
          const visible = [...queues]
            .filter(([, value]) => value.uid === query.equalTo)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, Number(query.limitToFirst));
          return visible.length ? Object.fromEntries(visible) : null;
        }
        const queueMatch = /^automatch\/(.+)$/.exec(path);
        if (queueMatch) return queues.get(queueMatch[1]) || null;
        const inviteRootMatch = /^invites\/([^/]+)$/.exec(path);
        if (inviteRootMatch) return invites.get(inviteRootMatch[1]) || null;
        const inviteMatch =
          /^invites\/(.+)\/(guestId|hostId|automatchOperationIds)$/.exec(path);
        if (inviteMatch) {
          return invites.get(inviteMatch[1])?.[inviteMatch[2]] ?? null;
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        if (
          Object.hasOwn(
            updates,
            `gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`,
          )
        ) {
          receiptUpdates = updates;
        }
        for (const [path, value] of Object.entries(updates)) {
          const queueMatch = /^automatch\/(.+)$/.exec(path);
          if (queueMatch && value === null) {
            queues.delete(queueMatch[1]);
            canceledInviteIds.push(queueMatch[1]);
          }
          const inviteMatch = /^invites\/(.+)\/(.+)$/.exec(path);
          if (inviteMatch) {
            invites.set(inviteMatch[1], {
              ...(invites.get(inviteMatch[1]) || {}),
              [inviteMatch[2]]: value,
            });
          }
        }
      },
    }),
    {
      createProjectionRequestId: () => `same-uid-${++requestId}`,
      enqueueProfileGameProjection: async (task) => {
        profileTasks.push(task);
      },
      enqueueTelegramProjection: async (task) => {
        telegramTasks.push(task);
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_b",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.deepEqual([...queues.keys()], ["auto_b"]);
  assert.deepEqual(canceledInviteIds, ["auto_a", "auto_c"]);
  assert.equal(uidQueries, 3);
  assertPendingReceiptUpdates(receiptUpdates, "auto_b");
  assert.deepEqual(
    profileTasks.map((task) => (task as { inviteId: string }).inviteId),
    ["auto_a", "auto_c"],
  );
  assert.deepEqual(
    telegramTasks.map((task) => (task as { inviteId: string }).inviteId),
    ["auto_a", "auto_c"],
  );
});

test("shared cancellation reconciles an ambiguous committed patch", async () => {
  const queued = {
    inviteId: "auto_ambiguous",
    data: { uid: identity.uid, timestamp: 1, telegramDeliveryVersion: 2 },
  };
  let queue: unknown = queued.data;
  let invite: Record<string, unknown> = {
    hostId: identity.uid,
    guestId: null,
    automatchStateHint: "pending",
    automatchCanceledAt: null,
  };
  let outboxRequestId: string | null = null;
  let patches = 0;
  const waits: number[] = [];
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];
  const canceled = await cancelQueuedAutomatch(
    queued,
    repository({
      getRtdbPath: async (path) => {
        if (path === `automatch/${queued.inviteId}`) return queue;
        if (path === `invites/${queued.inviteId}`) return invite;
        if (path === `invites/${queued.inviteId}/guestId`) {
          return invite.guestId;
        }
        if (path === `invites/${queued.inviteId}/hostId`) {
          return invite.hostId;
        }
        if (
          path ===
          `profileGameProjectionOutbox/automatch/${queued.inviteId}/requestId`
        ) {
          return outboxRequestId;
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async () => {
        patches += 1;
        throw new Error("response-lost-after-commit");
      },
    }),
    {
      createProjectionRequestId: () => "ambiguous-cancel",
      enqueueProfileGameProjection: async (task) => {
        profileTasks.push(task);
      },
      enqueueTelegramProjection: async (task) => {
        telegramTasks.push(task);
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length < 18) return;
        queue = null;
        invite = {
          ...invite,
          automatchStateHint: "canceled",
          automatchCanceledAt: 2,
        };
        outboxRequestId = "ambiguous-cancel";
      },
    },
  );

  assert.equal(canceled, true);
  assert.equal(patches, 1);
  assert.deepEqual(
    waits,
    Array.from({ length: 18 }, () => 50),
  );
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: queued.inviteId,
      requestId: "ambiguous-cancel",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: queued.inviteId,
      requestId: "ambiguous-cancel",
    },
  ]);
});

test("requires commit proof after a lock release failure", async () => {
  const queued = {
    inviteId: "auto_release_failure",
    data: { uid: identity.uid, timestamp: 1, telegramDeliveryVersion: 2 },
  };
  let patches = 0;
  let proofReads = 0;
  const value = repository({
    getRtdbPath: async (path) => {
      if (path === `automatch/${queued.inviteId}`) return queued.data;
      if (path === `invites/${queued.inviteId}/guestId`) return null;
      if (path === `invites/${queued.inviteId}/hostId`) return identity.uid;
      if (path === `invites/${queued.inviteId}`) {
        proofReads++;
        return null;
      }
      if (
        path ===
        `profileGameProjectionOutbox/automatch/${queued.inviteId}/requestId`
      ) {
        return null;
      }
      assert.fail(`unexpected path ${path}`);
    },
    patchRtdbRoot: async () => {
      patches++;
      throw new Error("response-lost-without-commit");
    },
  });
  coordinationFor(value).mutationLocks.release = async () => {
    throw new GameSessionMutationLockFailure("release");
  };

  await assert.rejects(
    () =>
      cancelQueuedAutomatch(queued, value, {
        wait: async () => undefined,
      }),
    (error: unknown) =>
      error instanceof GameSessionMutationLeaseReleaseFailure &&
      error.operation === "release",
  );
  assert.equal(patches, 1);
  assert.ok(proofReads > 0);
});

test("returns successful cancellation after proving a committed release failure", async () => {
  const queued = {
    inviteId: "auto_dual_failure",
    data: { uid: identity.uid, timestamp: 1, telegramDeliveryVersion: 2 },
  };
  let queue: unknown = queued.data;
  let invite: Record<string, unknown> = {
    hostId: identity.uid,
    guestId: null,
    automatchStateHint: "pending",
    automatchCanceledAt: null,
  };
  let outboxRequestId: string | null = null;
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];
  const value = repository({
    getRtdbPath: async (path) => {
      if (path === `automatch/${queued.inviteId}`) return queue;
      if (path === `invites/${queued.inviteId}`) return invite;
      if (path === `invites/${queued.inviteId}/guestId`) return invite.guestId;
      if (path === `invites/${queued.inviteId}/hostId`) return invite.hostId;
      if (
        path ===
        `profileGameProjectionOutbox/automatch/${queued.inviteId}/requestId`
      ) {
        return outboxRequestId;
      }
      assert.fail(`unexpected path ${path}`);
    },
    patchRtdbRoot: async () => {
      queue = null;
      invite = {
        ...invite,
        automatchStateHint: "canceled",
        automatchCanceledAt: 2,
      };
      outboxRequestId = "dual-failure";
      throw new Error("response-lost-after-commit");
    },
  });
  coordinationFor(value).mutationLocks.release = async () => {
    throw new GameSessionMutationLockFailure("release");
  };

  const canceled = await cancelQueuedAutomatch(queued, value, {
    createProjectionRequestId: () => "dual-failure",
    enqueueProfileGameProjection: async (task) => {
      profileTasks.push(task);
    },
    enqueueTelegramProjection: async (task) => {
      telegramTasks.push(task);
    },
  });
  assert.equal(canceled, true);
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: queued.inviteId,
      requestId: "dual-failure",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: queued.inviteId,
      requestId: "dual-failure",
    },
  ]);
});

test("uses a final fresh proof read after cancellation polling stops", async () => {
  const queued = {
    inviteId: "auto_final_reconciliation",
    data: { uid: identity.uid, timestamp: 1, telegramDeliveryVersion: 2 },
  };
  const operation = new AbortController();
  let pollingSignal: AbortSignal | undefined;
  let finalSignal: AbortSignal | undefined;
  let committed = false;
  let waits = 0;
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];

  const canceled = await cancelQueuedAutomatch(
    queued,
    repository({
      getRtdbPath: async (path, _query, signal) => {
        assert.ok(signal);
        if (signal !== operation.signal) {
          if (!pollingSignal) {
            pollingSignal = signal;
          } else if (signal !== pollingSignal) {
            finalSignal = signal;
            committed = true;
          }
        }
        if (path === `automatch/${queued.inviteId}`) {
          return committed ? null : queued.data;
        }
        if (path === `invites/${queued.inviteId}/guestId`) return null;
        if (path === `invites/${queued.inviteId}/hostId`) return identity.uid;
        if (path === `invites/${queued.inviteId}`) {
          return committed
            ? {
                hostId: identity.uid,
                guestId: null,
                automatchStateHint: "canceled",
                automatchCanceledAt: 2,
              }
            : {
                hostId: identity.uid,
                guestId: null,
                automatchStateHint: "pending",
                automatchCanceledAt: null,
              };
        }
        if (
          path ===
          `profileGameProjectionOutbox/automatch/${queued.inviteId}/requestId`
        ) {
          return committed ? "final-reconciliation" : null;
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (_updates, signal) => {
        assert.equal(signal, operation.signal);
        throw new Error("response-lost-before-visible");
      },
    }),
    {
      createProjectionRequestId: () => "final-reconciliation",
      enqueueProfileGameProjection: async (task) => {
        profileTasks.push(task);
      },
      enqueueTelegramProjection: async (task) => {
        telegramTasks.push(task);
      },
      wait: async (milliseconds, signal) => {
        assert.equal(milliseconds, 50);
        assert.equal(signal, pollingSignal);
        waits += 1;
        if (waits === 20) throw new Error("polling-window-ended");
      },
    },
    operation.signal,
  );

  assert.equal(canceled, true);
  assert.equal(waits, 20);
  assert.ok(pollingSignal);
  assert.ok(finalSignal);
  assert.notEqual(finalSignal, pollingSignal);
  assert.equal(finalSignal.aborted, false);
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: queued.inviteId,
      requestId: "final-reconciliation",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: queued.inviteId,
      requestId: "final-reconciliation",
    },
  ]);
});

test("reconciles a committed cancellation after the operation signal aborts", async () => {
  const queued = {
    inviteId: "auto_aborted_commit",
    data: { uid: identity.uid, timestamp: 1, telegramDeliveryVersion: 2 },
  };
  const operation = new AbortController();
  let queue: unknown = queued.data;
  let invite: Record<string, unknown> = {
    hostId: identity.uid,
    guestId: null,
    automatchStateHint: "pending",
    automatchCanceledAt: null,
  };
  let outboxRequestId: string | null = null;
  const reconciliationSignals: AbortSignal[] = [];
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];

  const canceled = await cancelQueuedAutomatch(
    queued,
    repository({
      getRtdbPath: async (path, _query, signal) => {
        assert.ok(signal);
        if (path === `automatch/${queued.inviteId}`) {
          if (queue === null) reconciliationSignals.push(signal);
          else assert.equal(signal, operation.signal);
          return queue;
        }
        if (path === `invites/${queued.inviteId}/guestId`) {
          assert.equal(signal, operation.signal);
          return invite.guestId;
        }
        if (path === `invites/${queued.inviteId}/hostId`) {
          assert.equal(signal, operation.signal);
          return invite.hostId;
        }
        if (path === `invites/${queued.inviteId}`) {
          reconciliationSignals.push(signal);
          return invite;
        }
        if (
          path ===
          `profileGameProjectionOutbox/automatch/${queued.inviteId}/requestId`
        ) {
          reconciliationSignals.push(signal);
          return outboxRequestId;
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (_updates, signal) => {
        assert.equal(signal, operation.signal);
        queue = null;
        invite = {
          ...invite,
          automatchStateHint: "canceled",
          automatchCanceledAt: 2,
        };
        outboxRequestId = "aborted-commit";
        operation.abort();
        throw new Error("response-lost-after-commit");
      },
    }),
    {
      createProjectionRequestId: () => "aborted-commit",
      enqueueProfileGameProjection: async (task) => {
        profileTasks.push(task);
      },
      enqueueTelegramProjection: async (task) => {
        telegramTasks.push(task);
      },
      wait: async () => assert.fail("unexpected reconciliation wait"),
    },
    operation.signal,
  );

  assert.equal(canceled, true);
  assert.equal(operation.signal.aborted, true);
  assert.equal(reconciliationSignals.length, 3);
  assert.equal(new Set(reconciliationSignals).size, 1);
  assert.notEqual(reconciliationSignals[0], operation.signal);
  assert.equal(reconciliationSignals[0]?.aborted, false);
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: queued.inviteId,
      requestId: "aborted-commit",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: queued.inviteId,
      requestId: "aborted-commit",
    },
  ]);
});

test("public cancellation succeeds when its only queue committed before abort", async () => {
  const inviteId = "auto_public_aborted_commit";
  const operation = new AbortController();
  let queue: Record<string, Record<string, unknown>> | null = {
    [inviteId]: {
      uid: identity.uid,
      timestamp: 1,
      telegramDeliveryVersion: 2,
    },
  };
  let invite: Record<string, unknown> = {
    hostId: identity.uid,
    guestId: null,
    automatchStateHint: "pending",
    automatchCanceledAt: null,
  };
  let outboxRequestId: string | null = null;
  let queueQueries = 0;
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];

  const result = await cancelAutomatch(
    identity,
    repository({
      getRtdbPath: async (path, _query, signal) => {
        signal?.throwIfAborted();
        if (path === "automatch") {
          queueQueries += 1;
          return queue;
        }
        if (path === `automatch/${inviteId}`) {
          return queue?.[inviteId] || null;
        }
        if (path === `invites/${inviteId}/guestId`) return invite.guestId;
        if (path === `invites/${inviteId}/hostId`) return invite.hostId;
        if (path === `invites/${inviteId}`) return invite;
        if (
          path === `profileGameProjectionOutbox/automatch/${inviteId}/requestId`
        ) {
          return outboxRequestId;
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (updates, signal) => {
        assert.equal(signal, operation.signal);
        queue = null;
        invite = {
          ...invite,
          automatchStateHint: "canceled",
          automatchCanceledAt: 2,
        };
        outboxRequestId = (
          updates[`profileGameProjectionOutbox/automatch/${inviteId}`] as {
            requestId: string;
          }
        ).requestId;
        operation.abort();
        throw new Error("response-lost-after-commit");
      },
    }),
    {
      createProjectionRequestId: () => "public-aborted-commit",
      enqueueProfileGameProjection: async (task) => {
        profileTasks.push(task);
      },
      enqueueTelegramProjection: async (task) => {
        telegramTasks.push(task);
      },
      signal: operation.signal,
      wait: async () => assert.fail("unexpected reconciliation wait"),
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(queueQueries, 2);
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId,
      requestId: "public-aborted-commit",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId,
      requestId: "public-aborted-commit",
    },
  ]);
});

test("public cancellation succeeds when the last of two queues commits before abort", async () => {
  const inviteIds = ["auto_public_first", "auto_public_last"];
  const operation = new AbortController();
  let queue: Record<string, Record<string, unknown>> | null =
    Object.fromEntries(
      inviteIds.map((inviteId, index) => [
        inviteId,
        {
          uid: identity.uid,
          timestamp: index + 1,
          telegramDeliveryVersion: 2,
        },
      ]),
    );
  const invites: Record<
    string,
    {
      automatchCanceledAt: number | null;
      automatchStateHint: string;
      guestId: string | null;
      hostId: string;
    }
  > = Object.fromEntries(
    inviteIds.map((inviteId) => [
      inviteId,
      {
        hostId: identity.uid,
        guestId: null,
        automatchStateHint: "pending",
        automatchCanceledAt: null,
      },
    ]),
  );
  const outboxRequestIds = new Map<string, string>();
  let patches = 0;
  let queueQueries = 0;

  const result = await cancelAutomatch(
    identity,
    repository({
      getRtdbPath: async (path, _query, signal) => {
        signal?.throwIfAborted();
        if (path === "automatch") {
          queueQueries += 1;
          if (signal !== operation.signal) {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
            signal?.throwIfAborted();
          }
          return queue;
        }
        for (const inviteId of inviteIds) {
          if (path === `automatch/${inviteId}`) {
            return queue?.[inviteId] || null;
          }
          if (path === `invites/${inviteId}/guestId`) {
            return invites[inviteId].guestId;
          }
          if (path === `invites/${inviteId}/hostId`) {
            return invites[inviteId].hostId;
          }
          if (path === `invites/${inviteId}`) return invites[inviteId];
          if (
            path ===
            `profileGameProjectionOutbox/automatch/${inviteId}/requestId`
          ) {
            return outboxRequestIds.get(inviteId) || null;
          }
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (updates, signal) => {
        assert.equal(signal, operation.signal);
        const inviteId = inviteIds.find(
          (candidate) => updates[`automatch/${candidate}`] === null,
        );
        assert.ok(inviteId);
        if (queue) {
          delete queue[inviteId];
          if (Object.keys(queue).length === 0) queue = null;
        }
        invites[inviteId] = {
          ...invites[inviteId],
          automatchStateHint: "canceled",
          automatchCanceledAt: 2,
        };
        outboxRequestIds.set(
          inviteId,
          (
            updates[`profileGameProjectionOutbox/automatch/${inviteId}`] as {
              requestId: string;
            }
          ).requestId,
        );
        patches += 1;
        if (patches === inviteIds.length) {
          operation.abort();
          throw new Error("response-lost-after-commit");
        }
      },
    }),
    {
      createProjectionRequestId: (() => {
        let requestId = 0;
        return () => `public-two-${++requestId}`;
      })(),
      signal: operation.signal,
      wait: async () => assert.fail("unexpected reconciliation wait"),
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(queue, null);
  assert.equal(patches, 2);
  assert.equal(queueQueries, 3);
});

test("public cancellation does not hide a third queued match after abort", async () => {
  const inviteIds = ["auto_hidden_a", "auto_hidden_b", "auto_hidden_c"];
  const operation = new AbortController();
  const queues = new Map(
    inviteIds.map((inviteId, index) => [
      inviteId,
      { uid: identity.uid, timestamp: index + 1 },
    ]),
  );
  const invites: Record<
    string,
    {
      automatchCanceledAt: number | null;
      automatchStateHint: string;
      guestId: string | null;
      hostId: string;
    }
  > = Object.fromEntries(
    inviteIds.map((inviteId) => [
      inviteId,
      {
        hostId: identity.uid,
        guestId: null,
        automatchStateHint: "pending",
        automatchCanceledAt: null,
      },
    ]),
  );
  const outboxRequestIds = new Map<string, string>();
  let patches = 0;

  await assert.rejects(
    cancelAutomatch(
      identity,
      repository({
        getRtdbPath: async (path, query, signal) => {
          signal?.throwIfAborted();
          if (path === "automatch") {
            return Object.fromEntries(
              [...queues]
                .filter(([, value]) => value.uid === query?.equalTo)
                .sort(([left], [right]) => left.localeCompare(right))
                .slice(0, Number(query?.limitToFirst)),
            );
          }
          for (const inviteId of inviteIds) {
            if (path === `automatch/${inviteId}`) {
              return queues.get(inviteId) || null;
            }
            if (path === `invites/${inviteId}/guestId`) {
              return invites[inviteId].guestId;
            }
            if (path === `invites/${inviteId}/hostId`) {
              return invites[inviteId].hostId;
            }
            if (path === `invites/${inviteId}`) return invites[inviteId];
            if (
              path ===
              `profileGameProjectionOutbox/automatch/${inviteId}/requestId`
            ) {
              return outboxRequestIds.get(inviteId) || null;
            }
          }
          assert.fail(`unexpected path ${path}`);
        },
        patchRtdbRoot: async (updates) => {
          const inviteId = inviteIds.find(
            (candidate) => updates[`automatch/${candidate}`] === null,
          );
          assert.ok(inviteId);
          queues.delete(inviteId);
          invites[inviteId] = {
            ...invites[inviteId],
            automatchStateHint: "canceled",
            automatchCanceledAt: 2,
          };
          outboxRequestIds.set(
            inviteId,
            (
              updates[`profileGameProjectionOutbox/automatch/${inviteId}`] as {
                requestId: string;
              }
            ).requestId,
          );
          patches += 1;
          if (patches === 2) {
            operation.abort();
            throw new Error("response-lost-after-commit");
          }
        },
      }),
      {
        createProjectionRequestId: (() => {
          let requestId = 0;
          return () => `public-hidden-${++requestId}`;
        })(),
        signal: operation.signal,
        wait: async () => assert.fail("unexpected reconciliation wait"),
      },
    ),
    (error) => error === operation.signal.reason,
  );

  assert.equal(patches, 2);
  assert.deepEqual([...queues.keys()], ["auto_hidden_c"]);
});

test("ambiguous cancellation rejects a competing match", async () => {
  const queued = {
    inviteId: "auto_competing_match",
    data: { uid: identity.uid, timestamp: 1, telegramDeliveryVersion: 2 },
  };
  let queue: unknown = queued.data;
  let invite: Record<string, unknown> = {
    hostId: identity.uid,
    guestId: null,
    automatchStateHint: "pending",
    automatchCanceledAt: null,
  };
  let outboxRequestId: string | null = null;
  const patchError = new Error("cancel-patch-failed");
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];

  await assert.rejects(
    cancelQueuedAutomatch(
      queued,
      repository({
        getRtdbPath: async (path) => {
          if (path === `automatch/${queued.inviteId}`) return queue;
          if (path === `invites/${queued.inviteId}`) return invite;
          if (path === `invites/${queued.inviteId}/guestId`) {
            return invite.guestId;
          }
          if (path === `invites/${queued.inviteId}/hostId`) {
            return invite.hostId;
          }
          if (
            path ===
            `profileGameProjectionOutbox/automatch/${queued.inviteId}/requestId`
          ) {
            return outboxRequestId;
          }
          assert.fail(`unexpected path ${path}`);
        },
        patchRtdbRoot: async () => {
          queue = null;
          invite = {
            ...invite,
            guestId: "different-player",
            automatchStateHint: "matched",
          };
          outboxRequestId = "competing-match";
          throw patchError;
        },
      }),
      {
        createProjectionRequestId: () => "ambiguous-cancel",
        enqueueProfileGameProjection: async (task) => {
          profileTasks.push(task);
        },
        enqueueTelegramProjection: async (task) => {
          telegramTasks.push(task);
        },
        wait: async () => undefined,
      },
    ),
    (error) => error === patchError,
  );

  assert.deepEqual(profileTasks, []);
  assert.deepEqual(telegramTasks, []);
});

test("bounds repeated duplicate convergence to 512 cancellation attempts", async () => {
  let cancellationReads = 0;
  let patches = 0;
  await assert.rejects(
    startAutomatch(
      identity,
      request(),
      repository({
        getRtdbPath: async (path) => {
          if (path === "automatch") {
            return {
              auto_keep: { uid: identity.uid, timestamp: 2 },
              auto_stale: { uid: identity.uid, timestamp: 1 },
            };
          }
          if (path === "automatch/auto_stale") {
            cancellationReads += 1;
            return { uid: identity.uid, timestamp: 3 };
          }
          if (path === "invites/auto_stale/guestId") return null;
          if (path === "invites/auto_stale/hostId") return identity.uid;
          assert.fail(`unexpected path ${path}`);
        },
        patchRtdbRoot: async () => {
          patches += 1;
        },
      }),
      { createProjectionRequestId: () => "bounded-cancel" },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.message === "profile-ownership-unavailable",
  );

  assert.equal(cancellationReads, 512);
  assert.equal(patches, 0);
});

test("converges a candidate owner before consuming its surviving queue", async () => {
  const queues = new Map<string, Record<string, unknown>>([
    [
      "auto_older",
      {
        uid: "first-host",
        timestamp: 1,
        hostColor: "white",
        password: "older-password",
        gameVariant: "Classic",
        telegramDeliveryVersion: 2,
      },
    ],
    [
      "auto_newer",
      {
        uid: "second-host",
        timestamp: 2,
        hostColor: "black",
        password: "newer-password",
        gameVariant: "Classic",
        telegramDeliveryVersion: 2,
      },
    ],
  ]);
  const invites = new Map<string, Record<string, unknown>>([
    ["auto_older", { hostId: "first-host", guestId: null }],
    ["auto_newer", { hostId: "second-host", guestId: null }],
  ]);
  const patches: Array<Record<string, unknown>> = [];
  let ownershipReads = 0;
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads++;
        return ownershipSnapshot(query, {
          ownerByUid: {
            [identity.uid]: profile.profileId,
            "first-host": "merged-host-profile",
            "second-host": "merged-host-profile",
          },
          aliasesByProfileId: {
            [profile.profileId]: [identity.uid],
            "merged-host-profile": ["first-host", "second-host"],
          },
        });
      },
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          const matches = [...queues]
            .filter(([, value]) =>
              query?.orderBy === "uid" ? value.uid === query.equalTo : true,
            )
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, query?.limitToFirst || 1);
          return matches.length ? Object.fromEntries(matches) : null;
        }
        const queueMatch = /^automatch\/(.+)$/.exec(path);
        if (queueMatch) return queues.get(queueMatch[1]) || null;
        const inviteRootMatch = /^invites\/([^/]+)$/.exec(path);
        if (inviteRootMatch) return invites.get(inviteRootMatch[1]) || null;
        const inviteMatch =
          /^invites\/(.+)\/(guestId|hostId|automatchOperationIds)$/.exec(path);
        if (inviteMatch) {
          return invites.get(inviteMatch[1])?.[inviteMatch[2]] ?? null;
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
        for (const [path, value] of Object.entries(updates)) {
          const queueMatch = /^automatch\/(.+)$/.exec(path);
          if (queueMatch && value === null) queues.delete(queueMatch[1]);
          const inviteRootMatch = /^invites\/([^/]+)$/.exec(path);
          if (inviteRootMatch && value && typeof value === "object") {
            invites.set(inviteRootMatch[1], value as Record<string, unknown>);
          }
          const inviteFieldMatch = /^invites\/([^/]+)\/([^/]+)$/.exec(path);
          if (inviteFieldMatch) {
            invites.set(inviteFieldMatch[1], {
              ...(invites.get(inviteFieldMatch[1]) || {}),
              [inviteFieldMatch[2]]: value,
            });
          }
        }
      },
    }),
    { createProjectionRequestId: () => "candidate-convergence" },
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_newer",
    mode: "matched",
    matchedImmediately: true,
  });
  assert.equal(ownershipReads, 2);
  assert.deepEqual([...queues.keys()], []);
  assert.equal(invites.get("auto_older")?.automatchStateHint, "canceled");
  assert.equal(invites.get("auto_newer")?.guestId, identity.uid);
  assert.deepEqual(invites.get("auto_newer")?.automatchOperationIds, {
    [identity.uid]: AUTOMATCH_OPERATION_ID,
  });
  assert.equal(patches.length, 2);
  assert.equal(patches[0]["automatch/auto_older"], null);
  assert.equal(patches[1]["automatch/auto_newer"], null);
});

test("backs off boundedly while the profile queue lock is busy", async () => {
  let nowMs = 0;
  const delays: number[] = [];
  const value = repository({ getRtdbPath: async () => null });
  coordinationFor(value).lockRows.set(
    await automatchOwnerLockId(`profile:${profile.profileId}`),
    {
      expiresAtMs: 60_000,
      operationId: "existing-operation",
      ownerId: "existing-owner",
    },
  );
  await assert.rejects(
    startAutomatch(identity, request(), value, {
      now: () => nowMs,
      wait: async (milliseconds) => {
        delays.push(milliseconds);
        nowMs += milliseconds;
      },
    }),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.message === "invite-busy",
  );

  assert.ok(delays.length < 30);
  assert.ok(delays[0] >= 25);
  assert.ok(delays.at(-1)! >= 1_000);
  assert.ok(delays.every((delay) => delay <= 1_250));
});

test("replays a null-projection receipt before an ownership outage", async () => {
  let profileReads = 0;
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository(
      {
        readProfileOwnershipSnapshot: async () => {
          profileReads++;
          throw new Error("D1 unavailable");
        },
      },
      () => storedAutomatchReceipt("zzz_owned"),
    ),
    {
      enqueueProfileGameProjection: async (task) => {
        profileTasks.push(task);
      },
      enqueueTelegramProjection: async (task) => {
        telegramTasks.push(task);
      },
      logProfileFailure: () => undefined,
    },
  );
  assert.deepEqual(result, {
    ok: true,
    inviteId: "zzz_owned",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.equal(profileReads, 0);
  assert.deepEqual(profileTasks, []);
  assert.deepEqual(telegramTasks, []);
});

test("returns pending when one pair snapshot has the same canonical owner", async () => {
  let ownershipReads = 0;
  let updates: Record<string, unknown> = {};
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads++;
        return ownershipSnapshot(query, {
          ownerByUid:
            ownershipReads === 1
              ? { [identity.uid]: profile.profileId }
              : {
                  [identity.uid]: "merged-profile",
                  "host-uid": "merged-profile",
                },
          aliasesByProfileId:
            ownershipReads === 1
              ? { [profile.profileId]: [identity.uid] }
              : { "merged-profile": [identity.uid, "host-uid"] },
        });
      },
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          return {
            auto_existing: {
              uid: "host-uid",
              profileId: "host-profile",
              hostColor: "black",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_existing") {
          return { uid: "host-uid", profileId: "host-profile" };
        }
        if (path === "invites/auto_existing") {
          return {
            hostId: "host-uid",
            guestId: null,
            automatchStateHint: "pending",
          };
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_existing",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.equal(ownershipReads, 2);
  assertPendingReceiptUpdates(updates, "auto_existing");
});

test("uses one pair snapshot through the RTDB match write", async () => {
  let committed = false;
  let ownershipChanged = false;
  let ownershipReads = 0;
  let writes = 0;
  let matchedUpdates: Record<string, unknown> = {};
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads++;
        assert.deepEqual(query.loginUids, [
          identity.uid,
          ...(ownershipReads === 2 ? ["host-uid"] : []),
        ]);
        if (ownershipChanged) {
          throw new Error("ownership must not be revalidated");
        }
        return ownershipSnapshot(query, {
          ownerByUid: {
            [identity.uid]: profile.profileId,
            "host-uid": "host-profile",
          },
        });
      },
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          return {
            auto_snapshot: {
              uid: "host-uid",
              profileId: "host-profile",
              hostColor: "black",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_snapshot") {
          ownershipChanged = true;
          return { uid: "host-uid", profileId: "host-profile" };
        }
        if (path === "invites/auto_snapshot") {
          return {
            hostId: "host-uid",
            guestId: committed ? identity.uid : null,
            automatchOperationIds: { "host-uid": "host-operation" },
          };
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        writes++;
        matchedUpdates = updates;
        committed = true;
      },
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_snapshot",
    mode: "matched",
    matchedImmediately: true,
  });
  assert.equal(ownershipReads, 2);
  assert.equal(writes, 1);
  assert.deepEqual(
    (matchedUpdates["invites/auto_snapshot"] as Record<string, unknown>)
      .automatchOperationIds,
    {
      "host-uid": "host-operation",
      [identity.uid]: AUTOMATCH_OPERATION_ID,
    },
  );
});

test("fails before the match patch when the pair snapshot is unavailable", async () => {
  let ownershipReads = 0;
  let writes = 0;
  await assert.rejects(
    startAutomatch(
      identity,
      request(),
      repository({
        readProfileOwnershipSnapshot: async (query) => {
          ownershipReads++;
          if (ownershipReads === 1) {
            return ownershipSnapshot(query);
          }
          throw new Error("D1 unavailable");
        },
        getRtdbPath: async (path) => {
          if (path === "automatch") {
            return {
              auto_existing: {
                uid: "host-uid",
                profileId: "host-profile",
                hostColor: "black",
                password: "password",
                gameVariant: "Classic",
              },
            };
          }
          if (path === "automatch/auto_existing") {
            return { uid: "host-uid", profileId: "host-profile" };
          }
          if (path === "invites/auto_existing/guestId") return null;
          assert.fail(`unexpected path ${path}`);
        },
        patchRtdbRoot: async () => {
          writes++;
        },
      }),
    ),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.message === "profile-ownership-unavailable",
  );
  assert.equal(ownershipReads, 2);
  assert.equal(writes, 0);
});

test("matches a different v2 candidate without rereading a known commit", async () => {
  let updates: Record<string, unknown> = {};
  let guestReads = 0;
  const profileProjectionTasks: unknown[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          return {
            auto_existing: {
              uid: "host-uid",
              profileId: "host-profile",
              username: "Bob",
              rating: 1400,
              hostColor: "black",
              password: "password",
              emojiId: 2,
              gameVariant: "Classic",
              telegramDeliveryVersion: 2,
            },
          };
        }
        if (path === "automatch/auto_existing") {
          return {
            uid: "host-uid",
            profileId: "host-profile",
          };
        }
        if (path === "invites/auto_existing") {
          guestReads++;
          return {
            hostId: "host-uid",
            guestId: guestReads === 1 ? null : identity.uid,
            automatchOperationIds: { "host-uid": "host-operation" },
          };
        }
        assert.fail(`unexpected path ${path}`);
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
    {
      createProjectionRequestId: () => "request-1",
      enqueueProfileGameProjection: async (task) => {
        profileProjectionTasks.push(task);
      },
    },
  );
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_existing",
    mode: "matched",
    matchedImmediately: true,
  });
  assert.equal(guestReads, 1);
  assert.deepEqual(profileProjectionTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_existing",
      requestId: "request-1",
    },
  ]);
  assert.deepEqual(updates["invites/auto_existing"], {
    version: 2,
    hostId: "host-uid",
    hostColor: "black",
    guestId: "guest-uid",
    password: "password",
    automatchStateHint: "matched",
    automatchCanceledAt: null,
    automatchOperationIds: {
      "host-uid": "host-operation",
      [identity.uid]: AUTOMATCH_OPERATION_ID,
    },
    telegramDeliveryVersion: 2,
  });
  const match = updates["players/guest-uid/matches/auto_existing"] as Record<
    string,
    unknown
  >;
  assert.equal(match.color, "white");
  assert.equal(match.gameVariant, "Classic");
  assert.equal(updates["automatch/auto_existing"], null);
  assert.equal(
    updates["telegramAutomatches/auto_existing/lifecycle"],
    "matched",
  );
  assert.deepEqual(
    updates["telegramAutomatches/auto_existing/generation"],
    firebaseRtdbIncrement(1),
  );
  assert.match(
    String(updates["telegramAutomatches/auto_existing/matchedText"]),
    /Bob \(1400\).*Alice \(1512\)/,
  );
  assert.deepEqual(
    updates["telegramProjectionOutbox/automatch/auto_existing"],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      updatedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    },
  );
  assert.deepEqual(
    updates["profileGameProjectionOutbox/automatch/auto_existing"],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request-1",
      reason: "automatch-queue",
      sourceUpdatedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
      lastQueuedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    },
  );
});

test("keeps legacy matches free of Telegram v2 updates", async () => {
  let updates: Record<string, unknown> = {};
  let committed = false;
  const profileProjectionTasks: unknown[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          return {
            auto_legacy: {
              uid: "host-uid",
              hostColor: "white",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_legacy") {
          return { uid: "host-uid" };
        }
        if (path === "invites/auto_legacy") {
          return {
            hostId: "host-uid",
            guestId: committed ? identity.uid : null,
          };
        }
        return null;
      },
      patchRtdbRoot: async (value) => {
        updates = value;
        committed = true;
      },
    }),
    {
      createProjectionRequestId: () => "legacy-request",
      enqueueProfileGameProjection: async (task) => {
        profileProjectionTasks.push(task);
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(updates).sort(), [
    "automatch/auto_legacy",
    `gameplayMutationReceiptExpirations/${AUTOMATCH_OPERATION_ID}`,
    `gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`,
    "invites/auto_legacy",
    "players/guest-uid/matches/auto_legacy",
    "profileGameProjectionOutbox/automatch/auto_legacy",
  ]);
  assert.equal(
    (
      updates[`gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`] as Record<
        string,
        unknown
      >
    ).telegramProjection,
    false,
  );
  assert.deepEqual(
    updates["profileGameProjectionOutbox/automatch/auto_legacy"],
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "legacy-request",
      reason: "automatch-queue",
      sourceUpdatedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
      lastQueuedAtMs: FIREBASE_RTDB_SERVER_TIMESTAMP,
    },
  );
  assert.deepEqual(profileProjectionTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_legacy",
      requestId: "legacy-request",
    },
  ]);
  assert.equal(
    Object.hasOwn(
      updates["invites/auto_legacy"] as Record<string, unknown>,
      "telegramDeliveryVersion",
    ),
    false,
  );
  assert.deepEqual(
    (updates["invites/auto_legacy"] as Record<string, unknown>)
      .automatchOperationIds,
    { [identity.uid]: AUTOMATCH_OPERATION_ID },
  );
});

test("bounds failed guest verification to four total attempts", async () => {
  let queueReads = 0;
  const writes: Record<string, unknown>[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          queueReads++;
          return {
            auto_race: {
              uid: "host-uid",
              hostColor: "white",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_race") {
          return { uid: "host-uid" };
        }
        if (path === "invites/auto_race") {
          return { hostId: "host-uid", guestId: "other-guest" };
        }
        return null;
      },
      patchRtdbRoot: async (updates) => {
        writes.push(updates);
      },
    }),
  );
  assert.deepEqual(result, { ok: false });
  assert.equal(queueReads, 9);
  assert.equal(writes.length, 0);
});

test("reconciles a committed match after an ambiguous patch failure", async () => {
  let writes = 0;
  let committed = false;
  const requestId = "ambiguous-match";
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          return {
            auto_committed: {
              uid: "host-uid",
              hostColor: "white",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_committed") {
          return { uid: "host-uid" };
        }
        if (path === "invites/auto_committed") {
          return {
            hostId: "host-uid",
            guestId: committed ? identity.uid : null,
          };
        }
        if (
          path ===
          "profileGameProjectionOutbox/automatch/auto_committed/requestId"
        ) {
          return committed ? requestId : null;
        }
        return committed ? "guest-uid" : null;
      },
      patchRtdbRoot: async () => {
        writes++;
        committed = true;
        throw new Error("response-lost-after-commit");
      },
    }),
    { createProjectionRequestId: () => requestId },
  );
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_committed",
    mode: "matched",
    matchedImmediately: true,
  });
  assert.equal(writes, 1);
});

test("returns a proven match after the original signal aborts", async () => {
  const controller = new AbortController();
  const requestId = "aborted-match";
  let committed = false;
  const projectionTasks: unknown[] = [];
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path, _query, signal) => {
        if (signal?.aborted) {
          throw new Error("stale-signal-read");
        }
        if (path === "automatch") {
          return {
            auto_aborted_commit: {
              uid: "host-uid",
              hostColor: "white",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_aborted_commit") {
          return { uid: "host-uid" };
        }
        if (path === "invites/auto_aborted_commit") {
          return {
            hostId: "host-uid",
            guestId: committed ? identity.uid : null,
          };
        }
        if (
          path ===
          "profileGameProjectionOutbox/automatch/auto_aborted_commit/requestId"
        ) {
          return committed ? requestId : null;
        }
        return committed ? identity.uid : null;
      },
      patchRtdbRoot: async () => {
        committed = true;
        controller.abort();
        throw new Error("response-lost-after-commit");
      },
    }),
    {
      createProjectionRequestId: () => requestId,
      enqueueProfileGameProjection: async (task) => {
        projectionTasks.push(task);
      },
      signal: controller.signal,
    },
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_aborted_commit",
    mode: "matched",
    matchedImmediately: true,
  });
  assert.deepEqual(projectionTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_aborted_commit",
      requestId,
    },
  ]);
});

test("returns a resolved match without rereading through an aborted signal", async () => {
  const controller = new AbortController();
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path, _query, signal) => {
        if (signal?.aborted) throw new Error("stale-signal-read");
        if (path === "automatch") {
          return {
            auto_resolved_commit: {
              uid: "host-uid",
              hostColor: "white",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_resolved_commit") {
          return { uid: "host-uid" };
        }
        if (path === "invites/auto_resolved_commit") {
          return { hostId: "host-uid", guestId: null };
        }
        return null;
      },
      patchRtdbRoot: async () => {
        controller.abort();
      },
    }),
    { signal: controller.signal },
  );

  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_resolved_commit",
    mode: "matched",
    matchedImmediately: true,
  });
});

test("rejects a committed match with a conflicting receipt", async () => {
  let committed = false;
  let receipt: unknown = null;
  const value = repository(
    {
      getRtdbPath: async (path) => {
        if (path === "automatch") {
          return {
            auto_unproven_release: {
              uid: "host-uid",
              hostColor: "white",
              password: "password",
              gameVariant: "Classic",
            },
          };
        }
        if (path === "automatch/auto_unproven_release") {
          return { uid: "host-uid" };
        }
        if (path === "invites/auto_unproven_release") {
          return {
            hostId: "host-uid",
            guestId: committed ? identity.uid : null,
          };
        }
        return null;
      },
      patchRtdbRoot: async (updates) => {
        receipt = {
          ...(receiptFromUpdates(updates) as Record<string, unknown>),
          aura: "different",
        };
        committed = true;
        throw new Error("response-lost-after-commit");
      },
    },
    () => receipt,
  );
  const release = coordinationFor(value).mutationLocks.release;
  coordinationFor(value).mutationLocks.release = async (lock, ownerId) => {
    if (lock.lockId === "auto_unproven_release") {
      throw new GameSessionMutationLockFailure("release");
    }
    await release(lock, ownerId);
  };

  await assert.rejects(
    () =>
      startAutomatch(identity, request(), value, {
        createProjectionRequestId: () => "expected-request",
      }),
    (error: unknown) =>
      error instanceof GameSessionMutationLeaseReleaseFailure &&
      error.operation === "release" &&
      !error.workCompleted,
  );
});

test("returns a committed match despite release failure", async () => {
  let committed = false;
  let writes = 0;
  const profileTasks: unknown[] = [];
  const telegramTasks: unknown[] = [];
  const value = repository({
    getRtdbPath: async (path) => {
      if (path === "automatch") {
        return {
          auto_release_committed: {
            uid: "host-uid",
            hostColor: "white",
            password: "password",
            gameVariant: "Classic",
            telegramDeliveryVersion: 2,
          },
        };
      }
      if (path === "automatch/auto_release_committed") {
        return { uid: "host-uid" };
      }
      if (path === "invites/auto_release_committed") {
        return {
          hostId: "host-uid",
          guestId: committed ? identity.uid : null,
        };
      }
      return null;
    },
    patchRtdbRoot: async () => {
      writes++;
      committed = true;
    },
  });
  const stores = coordinationFor(value);
  const release = stores.mutationLocks.release;
  stores.mutationLocks.release = async (lock, ownerId) => {
    if (lock.lockId === "auto_release_committed") {
      throw new GameSessionMutationLockFailure("release");
    }
    await release(lock, ownerId);
  };

  const result = await startAutomatch(identity, request(), value, {
    createProjectionRequestId: () => "release-committed",
    enqueueProfileGameProjection: async (task) => {
      profileTasks.push(task);
    },
    enqueueTelegramProjection: async (task) => {
      telegramTasks.push(task);
    },
  });
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_release_committed",
    mode: "matched",
    matchedImmediately: true,
  });
  assert.equal(writes, 1);
  assert.deepEqual(profileTasks, [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_release_committed",
      requestId: "release-committed",
    },
  ]);
  assert.deepEqual(telegramTasks, [
    {
      kind: "automatch-telegram-projection",
      inviteId: "auto_release_committed",
      requestId: "release-committed",
    },
  ]);
});

test("returns one committed match when the owner lock release fails", async () => {
  let committed = false;
  let writes = 0;
  const value = repository({
    getRtdbPath: async (path) => {
      if (path === "automatch") {
        return {
          auto_owner_release: {
            uid: "host-uid",
            hostColor: "white",
            password: "password",
            gameVariant: "Classic",
          },
        };
      }
      if (path === "automatch/auto_owner_release") {
        return { uid: "host-uid" };
      }
      if (path === "invites/auto_owner_release") {
        return {
          hostId: "host-uid",
          guestId: committed ? identity.uid : null,
        };
      }
      return null;
    },
    patchRtdbRoot: async () => {
      writes++;
      committed = true;
    },
  });
  const ownerLockId = await automatchOwnerLockId(
    `profile:${profile.profileId}`,
  );
  const stores = coordinationFor(value);
  const release = stores.mutationLocks.release;
  stores.mutationLocks.release = async (lock, ownerId) => {
    if (lock.lockId === ownerLockId) {
      throw new GameSessionMutationLockFailure("release");
    }
    await release(lock, ownerId);
  };

  const result = await startAutomatch(identity, request(), value);
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_owner_release",
    mode: "matched",
    matchedImmediately: true,
  });
  assert.equal(writes, 1);
});

test("replays a committed result when the operation lock release is ambiguous", async () => {
  let writes = 0;
  const value = repository({
    getRtdbPath: async (path) => {
      if (path === "automatch") return null;
      assert.fail(`unexpected path ${path}`);
    },
    patchRtdbRoot: async () => {
      writes++;
    },
  });
  const stores = coordinationFor(value);
  const release = stores.mutationLocks.release;
  stores.mutationLocks.release = async (lock, ownerId) => {
    if (lock.lockId === `automatch-operation-${AUTOMATCH_OPERATION_ID}`) {
      throw new GameSessionMutationLockFailure("release");
    }
    await release(lock, ownerId);
  };

  const first = await startAutomatch(identity, request(), value, {
    random: () => 0,
  });
  const replay = await startAutomatch(identity, request(), value, {
    random: () => 0.5,
  });

  assert.deepEqual(first, {
    ok: true,
    inviteId: "auto_aaaaaaaaaaa",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.deepEqual(replay, first);
  assert.equal(writes, 1);
});

test("does not retry an unconfirmed patch failure", async () => {
  let queueReads = 0;
  let writes = 0;
  await assert.rejects(
    () =>
      startAutomatch(
        identity,
        request(),
        repository(
          {
            getRtdbPath: async (path) => {
              if (path === "automatch") {
                queueReads++;
                return {
                  auto_unconfirmed: {
                    uid: "host-uid",
                    hostColor: "white",
                    password: "password",
                    gameVariant: "Classic",
                  },
                };
              }
              if (path === "automatch/auto_unconfirmed") {
                return { uid: "host-uid" };
              }
              if (path === "invites/auto_unconfirmed") {
                return { hostId: "host-uid", guestId: null };
              }
              return null;
            },
            patchRtdbRoot: async () => {
              writes++;
              throw new Error("unconfirmed-patch");
            },
          },
          () => null,
        ),
      ),
    /unconfirmed-patch/,
  );
  assert.equal(queueReads, 3);
  assert.equal(writes, 1);
});

test("replays an ambiguously committed match before creating another queue", async () => {
  let committed = false;
  let receipt: unknown = null;
  let failReceiptProof = false;
  let writes = 0;
  const value = repository(
    {
      getRtdbPath: async (path, query) => {
        if (path === "automatch") {
          if (query?.orderBy === "uid" && query.equalTo === identity.uid) {
            return null;
          }
          if (committed) return null;
          return {
            auto_receipt_replay: {
              uid: "host-uid",
              hostColor: "white",
              password: "password",
              gameVariant: "Classic",
              telegramDeliveryVersion: 2,
            },
          };
        }
        if (path === "automatch/auto_receipt_replay") {
          return committed ? null : { uid: "host-uid" };
        }
        if (path === "invites/auto_receipt_replay") {
          return committed
            ? { hostId: "host-uid", guestId: identity.uid }
            : { hostId: "host-uid", guestId: null };
        }
        if (
          path === "invites/auto_receipt_replay/guestId" ||
          path ===
            "profileGameProjectionOutbox/automatch/auto_receipt_replay/requestId"
        ) {
          if (committed) throw new Error("proof-unavailable");
          return null;
        }
        return null;
      },
      patchRtdbRoot: async (updates) => {
        writes++;
        receipt = {
          ...(updates[
            `gameplayMutationReceipts/${AUTOMATCH_OPERATION_ID}`
          ] as Record<string, unknown>),
          completedAtMs: 1,
        };
        committed = true;
        failReceiptProof = true;
        throw new Error("response-lost-after-commit");
      },
    },
    () => {
      if (failReceiptProof) {
        failReceiptProof = false;
        throw new Error("proof-unavailable");
      }
      return receipt;
    },
  );
  const automatchRequest = request();

  await assert.rejects(
    () => startAutomatch(identity, automatchRequest, value),
    /response-lost-after-commit/,
  );
  assert.deepEqual(await startAutomatch(identity, automatchRequest, value), {
    ok: true,
    inviteId: "auto_receipt_replay",
    mode: "matched",
    matchedImmediately: true,
  });
  await assert.rejects(
    () => startAutomatch(identity, request(2), value),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.message === "operation-conflict",
  );
  assert.equal(writes, 1);
});

test("does no work with an expired server signal", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async () => {
        reads++;
        return null;
      },
    }),
    { signal: controller.signal },
  );
  assert.deepEqual(result, { ok: false });
  assert.equal(reads, 0);
});
