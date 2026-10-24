import assert from "node:assert/strict";
import test from "node:test";
import { createRatingRepository } from "../src/ratingRepository.ts";
import {
  automatchSweepEntries,
  sweepAutomatchProfileGameProjections,
  sweepEventProfileGameProjections,
  sweepProfileLinkProfileGameProjections,
  sweepRatingProfileGameProjections,
} from "../src/profileGameProjection/recovery.ts";
import {
  sweepAutomatchProjections,
  sweepRatingProjections,
} from "../src/telegramProjection/recovery.ts";
import { projectionRecoveryPages } from "../src/projectionRecoveryPages.ts";
import type {
  EventProjectionRecoverySnapshot,
  EventProjectionRecoveryStore,
} from "../src/eventProjectionRecoveryD1.ts";
import type { ProfileLinkCatchupJob } from "../src/profileLinkCatchupD1.ts";
import {
  projectionRecoveryEntryIdentity,
  projectionRecoveryIdentity,
  projectionRecoveryPage,
} from "./projectionRecoveryFixtures.ts";
import {
  invalidRatingRecoveryEntry,
  recoveryCandidates,
} from "./recoveryScanTestFixtures.ts";
import { recoveryRecordPageFixture } from "./recoveryScanPageFixture.ts";
import { gameplayTestPort } from "./gameSessionTestPorts.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";
import type { AutomatchOutboxClaimSnapshot } from "../src/automatchD1/types.ts";

const nowMs = 600_000;
const logger = { error() {}, info() {} };

function applyTransaction(
  current: unknown,
  updater: (value: unknown) => unknown,
) {
  const result = updater(current) as {
    commit?: false;
    decision?: string;
    value?: unknown;
  };
  return {
    committed: result.commit !== false,
    decision: result.decision,
    value: result.commit === false ? current : result.value,
  };
}

function records(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const id = `item-${String(index).padStart(2, "0")}`;
    return {
      inviteId: id,
      matchId: id,
      operationId: `${id}__${id}`,
      revision: index + 1,
      version: 1,
    };
  });
}

function ratingFixture() {
  return createRatingRepository(
    TELEGRAM_TEST_ENV.PROFILE_DB,
    {
      readInviteMetadata: async () => null,
      readMatchRecord: async () => null,
      readMatchPair: async () => assert.fail("unexpected-match-read"),
      readProfileOwnershipSnapshot: async () =>
        assert.fail("unexpected-owner-read"),
    },
    { putEventProgressOutbox: async () => assert.fail("unexpected-outbox") },
  );
}

function queueFixture(onSend?: (attempt: number) => void | Promise<void>) {
  const batches: unknown[][] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    async sendBatch(messages) {
      batches.push(Array.from(messages, ({ body }) => body));
      await onSend?.(batches.length);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Queue;
  const env = {
    ...TELEGRAM_TEST_ENV,
    PROFILE_GAME_PROJECTION_QUEUE: queue,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE: queue,
    TELEGRAM_PROJECTION_QUEUE: queue,
  } satisfies Env;
  return { batches, env };
}

for (const lane of ["profile-game", "telegram"] as const) {
  test(`${lane} recovery visits at most twenty unique records with unchanged cutoffs`, async () => {
    for (const count of [0, 9, 10, 11, 20, 21]) {
      const data = records(count);
      const rating = ratingFixture();
      const { batches, env } = queueFixture();
      const claims: string[] = [];
      const scans: string[][] = [];
      const scan = async (
        cutoff: number,
        limit: number,
        excluded: readonly string[] = [],
      ) => {
        assert.equal(cutoff, nowMs);
        assert.equal(limit, 10);
        scans.push([...excluded]);
        return projectionRecoveryPage(
          recoveryCandidates(data),
          projectionRecoveryEntryIdentity,
          excluded,
          limit,
        );
      };
      const claim = async (
        id: string,
        _revision: number,
        timestamp: number,
      ) => {
        assert.equal(timestamp, nowMs);
        claims.push(id);
        return true;
      };
      rating.scanDueRatingProfileGameProjectionsPage = scan;
      rating.scanDueRatingTelegramProjectionsPage = scan;
      rating.claimRatingProfileGameProjection = claim;
      rating.claimRatingTelegramProjection = claim;
      const sent =
        lane === "profile-game"
          ? await sweepRatingProfileGameProjections(env, {
              createRating: () => rating,
              now: () => nowMs,
              logger,
            })
          : await sweepRatingProjections(env, rating, logger, nowMs);
      const expected = data.slice(0, 20).map(({ operationId }) => operationId);
      assert.equal(sent, expected.length);
      assert.deepEqual(claims, expected);
      assert.equal(scans.length, count < 10 ? 1 : 2);
      assert.deepEqual(scans[0], []);
      if (scans.length === 2) {
        assert.deepEqual(
          scans[1],
          data
            .slice(0, 10)
            .map(({ operationId }) => projectionRecoveryIdentity(operationId)),
        );
      }
      assert.deepEqual(
        batches.map((batch) => batch.length),
        expected.length === 0
          ? []
          : expected.length <= 10
            ? [expected.length]
            : [10, expected.length - 10],
      );
    }
  });
}

test("raw full pages continue after inspection drops every returned entry", async () => {
  const data = records(11);
  const visited: number[] = [];
  let scans = 0;
  for await (const { entries, itemOffset } of projectionRecoveryPages(
    async (excluded) => {
      const page = projectionRecoveryPage(
        data,
        ({ operationId }) => projectionRecoveryIdentity(operationId),
        excluded,
      );
      scans++;
      return { ...page, entries: scans === 1 ? [] : page.entries };
    },
  )) {
    visited.push(...entries.map(() => itemOffset));
  }
  assert.equal(scans, 2);
  assert.deepEqual(visited, [10]);
});

test("oversized identities stop continuation after the current page is processed", async () => {
  const data = records(10);
  let scans = 0;
  const visited: string[] = [];
  for await (const { entries } of projectionRecoveryPages(async () => {
    scans++;
    return {
      entries: data,
      scannedIdentities: data.map(({ operationId }, index) =>
        index === 0 ? null : projectionRecoveryIdentity(operationId),
      ),
    };
  })) {
    visited.push(...entries.map(({ operationId }) => operationId));
  }
  assert.equal(scans, 1);
  assert.equal(visited.length, 10);
});

test("repeated scan identities fail before a second page can repeat its work", async () => {
  const data = records(10);
  const visited: string[] = [];
  await assert.rejects(async () => {
    for await (const { entries } of projectionRecoveryPages(async () =>
      projectionRecoveryPage(data, ({ operationId }) =>
        projectionRecoveryIdentity(operationId),
      ),
    )) {
      visited.push(...entries.map(({ operationId }) => operationId));
    }
  }, /invalid-projection-recovery-page/);
  assert.equal(visited.length, 10);
});

for (const phase of ["inspect", "quarantine", "claim", "unclaimed"] as const) {
  test(`rating recovery advances past a full ${phase} page without retrying its records`, async () => {
    const data = records(21);
    const failed = new Set(
      data.slice(0, 10).map(({ operationId }) => operationId),
    );
    const failure = new Error(`${phase}-failed`);
    const rating = ratingFixture();
    const { batches, env } = queueFixture();
    let scans = 0;
    rating.scanDueRatingProfileGameProjectionsPage = async (
      _cutoff,
      limit,
      excluded = [],
    ) => {
      scans++;
      const page = projectionRecoveryPage(
        data,
        ({ operationId }) => projectionRecoveryIdentity(operationId),
        excluded,
        limit,
      );
      return {
        ...page,
        entries: page.entries.map((record) => {
          if (failed.has(record.operationId)) {
            if (phase === "inspect") return { kind: "failure", error: failure };
            if (phase === "quarantine") {
              const entry = invalidRatingRecoveryEntry("profile-game");
              entry.observation.keyBytes = Buffer.from(record.operationId);
              return entry;
            }
          }
          return { kind: "candidate", value: record };
        }),
      };
    };
    rating.quarantineRatingRecoveryEntry = async () => {
      throw failure;
    };
    const claims: string[] = [];
    rating.claimRatingProfileGameProjection = async (id) => {
      claims.push(id);
      if (!failed.has(id)) return true;
      if (phase === "unclaimed") return false;
      throw failure;
    };
    const run = sweepRatingProfileGameProjections(env, {
      createRating: () => rating,
      now: () => nowMs,
      logger,
    });
    if (phase === "unclaimed") assert.equal(await run, 10);
    else await assert.rejects(run, (error) => error === failure);
    assert.equal(scans, 2);
    assert.equal(new Set(claims).size, claims.length);
    assert.deepEqual(batches, [
      data.slice(10, 20).map(({ operationId }) => ({
        kind: "rating-profile-game-projection",
        operationId,
      })),
    ]);
  });
}

test("dispatch or scan failures stop paging and retain precedence over earlier item failures", async () => {
  for (const stop of ["first-send", "second-send", "second-scan"] as const) {
    const data = records(21);
    const itemFailure = new Error("claim-failed");
    const transportFailure = new Error(stop);
    const rating = ratingFixture();
    const claims: string[] = [];
    let scans = 0;
    const { batches, env } = queueFixture((attempt) => {
      if (
        (stop === "first-send" && attempt === 1) ||
        (stop === "second-send" && attempt === 2)
      ) {
        throw transportFailure;
      }
    });
    rating.scanDueRatingProfileGameProjectionsPage = async (
      _cutoff,
      limit,
      excluded = [],
    ) => {
      scans++;
      if (stop === "second-scan" && scans === 2) throw transportFailure;
      return projectionRecoveryPage(
        recoveryCandidates(data),
        projectionRecoveryEntryIdentity,
        excluded,
        limit,
      );
    };
    rating.claimRatingProfileGameProjection = async (id) => {
      claims.push(id);
      if (id === data[0].operationId) throw itemFailure;
      return true;
    };
    await assert.rejects(
      sweepRatingProfileGameProjections(env, {
        createRating: () => rating,
        now: () => nowMs,
        logger,
      }),
      (error) => error === transportFailure,
    );
    assert.equal(scans, stop === "first-send" ? 1 : 2);
    assert.equal(claims.length, stop === "second-send" ? 20 : 10);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      stop === "second-send" ? [9, 10] : [9],
    );
  }
});

test("profile-link concurrent sweeps retain the five-minute cutoff and dispatch each job once", async () => {
  const values = new Map<string, ProfileLinkCatchupJob>(
    records(21).map(({ inviteId }) => [
      inviteId,
      {
        loginUid: inviteId,
        requestId: `request-${inviteId}`,
        profileId: "profile",
        cleanupProfileIds: [],
        matchCursor: null,
        sourceUpdatedAtMs: 1,
        lastQueuedAtMs: 300_000,
        revision: 1,
      },
    ]),
  );
  const { batches, env } = queueFixture();
  const jobs = {
    async scanDuePage(
      cutoff: number,
      limit: number,
      excluded: readonly string[] = [],
    ) {
      assert.equal(cutoff, 300_000);
      assert.equal(limit, 10);
      return projectionRecoveryPage(
        recoveryCandidates(
          [...values.values()]
            .filter(({ lastQueuedAtMs }) => lastQueuedAtMs <= cutoff)
            .map((job) => structuredClone(job)),
        ),
        projectionRecoveryEntryIdentity,
        excluded,
        limit,
      );
    },
    quarantineInvalidEntry: async () => null,
    async claimDispatch(
      id: string,
      requestId: string,
      expected: number,
      timestamp: number,
    ) {
      const job = values.get(id);
      assert.equal(timestamp, nowMs);
      if (
        !job ||
        job.requestId !== requestId ||
        job.lastQueuedAtMs !== expected
      )
        return false;
      job.lastQueuedAtMs = timestamp;
      return true;
    },
  };
  await Promise.all([
    sweepProfileLinkProfileGameProjections(env, {
      createProfileLinkJobs: () => jobs,
      now: () => nowMs,
      logger,
    }),
    sweepProfileLinkProfileGameProjections(env, {
      createProfileLinkJobs: () => jobs,
      now: () => nowMs,
      logger,
    }),
  ]);
  const sent = batches.flat() as Array<{ loginUid: string }>;
  assert.equal(sent.length, 20);
  assert.equal(new Set(sent.map(({ loginUid }) => loginUid)).size, 20);
  assert.equal(
    [...values.values()].filter(
      ({ lastQueuedAtMs }) => lastQueuedAtMs === 300_000,
    ).length,
    1,
  );
});

test("event pages release admissions and retain repair-before-first-claim error ordering", async () => {
  for (const failRepair of [false, true]) {
    const data: EventProjectionRecoverySnapshot[] = records(21).map(
      ({ inviteId }, index) => {
        const record =
          failRepair && index === 10
            ? { status: "bad" }
            : {
                schemaVersion: 1,
                status: "pending",
                requestId: `request-${inviteId}`,
                lastQueuedAtMs: 1,
                cleanupOwnerProfileIds: {},
              };
        return {
          kind: "profile-game",
          eventId: inviteId,
          record,
          recordJson: JSON.stringify(record),
        };
      },
    );
    const firstClaimFailure = new Error("first-claim");
    const secondClaimFailure = new Error("second-claim");
    const repairFailure = new Error("second-page-repair");
    let admissions = 0;
    let releases = 0;
    let active = 0;
    const { batches, env } = queueFixture(() => assert.equal(active, 1));
    const recovery: EventProjectionRecoveryStore = {
      listDue: async () => assert.fail("unexpected-legacy-scan"),
      async listDuePage(cutoff, limit, excluded = []) {
        assert.equal(cutoff, 300_000);
        assert.equal(active, 0);
        return projectionRecoveryPage(
          data,
          ({ eventId }) => projectionRecoveryIdentity(eventId),
          excluded,
          limit,
        );
      },
      async withAdmission(work) {
        admissions++;
        active++;
        try {
          return await work({
            async claim(snapshot, _requestId, expected, timestamp) {
              assert.equal(expected, 1);
              assert.equal(timestamp, nowMs);
              if (snapshot.eventId === data[0].eventId) throw firstClaimFailure;
              if (snapshot.eventId === data[11].eventId)
                throw secondClaimFailure;
              return true;
            },
            transact: async () => {
              throw repairFailure;
            },
          });
        } finally {
          active--;
          releases++;
        }
      },
    };
    await assert.rejects(
      sweepEventProfileGameProjections(env, {
        createEventRecovery: () => recovery,
        now: () => nowMs,
        logger,
      }),
      (error) => {
        if (!failRepair) return error === firstClaimFailure;
        assert(error instanceof AggregateError);
        assert.deepEqual(error.errors, [repairFailure, firstClaimFailure]);
        return true;
      },
    );
    assert.equal(admissions, 2);
    assert.equal(releases, 2);
    assert.equal(active, 0);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      failRepair ? [9, 8] : [9, 9],
    );
  }
});

test("automatch due and malformed pages retain independent caps and repair-before-send behavior", async () => {
  const healthy = records(21).map(
    ({ inviteId }) =>
      [
        `due-${inviteId}`,
        {
          schemaVersion: 1,
          status: "pending",
          requestId: `request-${inviteId}`,
          lastQueuedAtMs: 1,
          sourceUpdatedAtMs: 1,
        },
      ] as const,
  );
  const malformed = records(21).map(
    ({ inviteId }) =>
      [
        `bad-${inviteId}`,
        {
          schemaVersion: 1,
          status: "broken",
          requestId: `request-${inviteId}`,
          lastQueuedAtMs: "invalid",
          sourceUpdatedAtMs: 1,
        },
      ] as const,
  );
  const values = new Map<string, unknown>([...healthy, ...malformed]);
  const state = gameplayTestPort({
    getPath: async () => null,
    patchRoot: async () => assert.fail("unexpected-patch"),
    transactPath: async (path, updater) => {
      const id = path.split("/").at(-1)!;
      const current = values.get(id) ?? null;
      const result = applyTransaction(current, updater);
      if (result.committed) values.set(id, result.value);
      return result;
    },
  });
  let dueScans = 0;
  let malformedScans = 0;
  state.projectionRecovery.listDueAutomatchProfileOutboxesPage = async (
    cutoff,
    limit,
    excluded = [],
  ) => {
    assert.equal(cutoff, 300_000);
    dueScans++;
    return recoveryRecordPageFixture(
      Object.fromEntries(healthy),
      limit,
      excluded,
    );
  };
  state.projectionRecovery.listMalformedAutomatchProfileOutboxesPage = async (
    limit,
    excluded = [],
  ) => {
    malformedScans++;
    return recoveryRecordPageFixture(
      Object.fromEntries(malformed),
      limit,
      excluded,
    );
  };
  const { batches, env } = queueFixture();
  const count = await sweepAutomatchProfileGameProjections(env, {
    createStateRepository: () => state,
    now: () => nowMs,
    createRequestId: () => "repaired",
    logger,
  });
  assert.equal(count, 40);
  assert.equal(dueScans, 2);
  assert.equal(malformedScans, 2);
  for (const batch of batches) {
    const tasks = batch as Array<{ inviteId: string; requestId: string }>;
    assert.equal(tasks.length, 20);
    assert(
      tasks
        .slice(0, 10)
        .every(
          ({ inviteId, requestId }) =>
            inviteId.startsWith("bad-") && requestId === "repaired",
        ),
    );
    assert(
      tasks.slice(10).every(({ inviteId }) => inviteId.startsWith("due-")),
    );
  }
});

test("Telegram automatch paging never reclaims the first page at the same timestamp", async () => {
  const values = new Map(
    records(21).map(({ inviteId }) => [
      inviteId,
      {
        schemaVersion: 1,
        status: "pending",
        requestId: `request-${inviteId}`,
        updatedAtMs: nowMs,
      },
    ]),
  );
  const state = gameplayTestPort({
    getPath: async () => null,
    patchRoot: async () => assert.fail("unexpected-patch"),
    transactPath: async (path, updater) => {
      const id = path.split("/").at(-1)!;
      const current = values.get(id) ?? null;
      return applyTransaction(current, updater);
    },
  });
  state.projectionRecovery.listDueAutomatchTelegramOutboxesPage = async (
    cutoff,
    limit,
    excluded = [],
  ) => {
    assert.equal(cutoff, nowMs);
    return recoveryRecordPageFixture(
      Object.fromEntries(values),
      limit,
      excluded,
    );
  };
  const { batches, env } = queueFixture();
  assert.equal(await sweepAutomatchProjections(env, state, logger, nowMs), 20);
  const tasks = batches.flat() as Array<{ inviteId: string }>;
  assert.equal(new Set(tasks.map(({ inviteId }) => inviteId)).size, 20);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [10, 10],
  );
});

for (const lane of ["profile-game", "telegram"] as const) {
  test(`${lane} recovery keeps scanned snapshots local and supports unseeded candidates`, async () => {
    const root =
      lane === "profile-game"
        ? "profileGameProjectionOutbox/automatch"
        : "telegramProjectionOutbox/automatch";
    const recordsById = new Map(
      records(21).map(({ inviteId }) => [
        inviteId,
        {
          schemaVersion: 1,
          status: "pending",
          requestId: `request-${inviteId}`,
          lastQueuedAtMs: 1,
          sourceUpdatedAtMs: 1,
          updatedAtMs: 1,
          future: { keep: true },
        },
      ]),
    );
    const snapshots = new Map<string, AutomatchOutboxClaimSnapshot>(
      [...recordsById].flatMap(([key, value], index) =>
        index % 2 === 0
          ? [[key, { root, key, value, revision: index + 1 }] as const]
          : [],
      ),
    );
    const state = gameplayTestPort({
      getPath: async () => assert.fail("unexpected-read"),
      patchRoot: async () => assert.fail("unexpected-patch"),
      transactPath: async () => assert.fail("unexpected-repair"),
    });
    const claims: string[] = [];
    const claim: typeof state.claimAutomatchProfileOutbox = async (
      inviteId,
      requestId,
      expected,
      atMs,
      signal,
      snapshot,
    ) => {
      assert.equal(requestId, `request-${inviteId}`);
      assert.equal(expected, 1);
      assert.equal(atMs, nowMs);
      assert.equal(signal, undefined);
      assert.equal(snapshot, snapshots.get(inviteId));
      claims.push(inviteId);
      return true;
    };
    const readPage = async (
      cutoff: number,
      limit: number,
      excluded: readonly string[] = [],
    ) => {
      assert.equal(cutoff, lane === "profile-game" ? 300_000 : nowMs);
      const page = recoveryRecordPageFixture(
        Object.fromEntries(recordsById),
        limit,
        excluded,
      );
      return { ...page, snapshots };
    };
    const { batches, env } = queueFixture();
    let count: number;
    if (lane === "profile-game") {
      state.claimAutomatchProfileOutbox = claim;
      state.projectionRecovery.listDueAutomatchProfileOutboxesPage = readPage;
      state.projectionRecovery.listMalformedAutomatchProfileOutboxesPage =
        async () => ({ entries: null, scannedIdentities: [] });
      count = await sweepAutomatchProfileGameProjections(env, {
        createStateRepository: () => state,
        now: () => nowMs,
        logger,
      });
    } else {
      state.claimAutomatchTelegramOutbox = claim;
      state.projectionRecovery.listDueAutomatchTelegramOutboxesPage = readPage;
      count = await sweepAutomatchProjections(env, state, logger, nowMs);
    }
    const expectedIds = [...recordsById.keys()].slice(0, 20);
    assert.equal(count, 20);
    assert.deepEqual(claims, expectedIds);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [10, 10],
    );
    assert.deepEqual(
      batches.flat(),
      expectedIds.map((inviteId) => ({
        kind:
          lane === "profile-game"
            ? "automatch-profile-game-projection"
            : "automatch-telegram-projection",
        inviteId,
        requestId: `request-${inviteId}`,
      })),
    );
  });
}

test("malformed profile outboxes never become seeded claim candidates", () => {
  const value = { status: "broken", lastQueuedAtMs: 1 };
  const snapshot: AutomatchOutboxClaimSnapshot = {
    root: "profileGameProjectionOutbox/automatch",
    key: "invalid",
    value,
    revision: 2,
  };
  assert.deepEqual(
    automatchSweepEntries({ invalid: value }, new Map([["invalid", snapshot]])),
    [{ kind: "invalid", inviteId: "invalid" }],
  );
});
