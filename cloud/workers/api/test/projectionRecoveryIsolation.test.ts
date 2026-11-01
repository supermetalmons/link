import { requiredFixture } from "./requiredFixture.ts";
import { canonicalQueuePayloadFixture } from "./canonicalQueueFixture.ts";
import {
  projectionRecoveryEntryIdentity,
  projectionRecoveryPage,
} from "./projectionRecoveryFixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createRatingRepository } from "../src/ratingRepository.ts";
import {
  sweepProfileLinkProfileGameProjections,
  sweepRatingProfileGameProjections,
} from "../src/profileGameProjection/recovery.ts";
import { sweepRatingProjections } from "../src/telegramProjection.ts";
import type { ProfileLinkCatchupJob } from "../src/profileLinkCatchupD1.ts";
import {
  invalidProfileLinkRecoveryEntry,
  invalidRatingRecoveryEntry,
  recoveryCandidates,
} from "./recoveryScanTestFixtures.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

type Lane = "profile-link" | "profile-game" | "telegram";

function recoveryHarness(
  lane: Lane,
  {
    failure = "none",
    failSend = false,
    loggerThrows = false,
    stale = false,
    claimed = true,
    failureReason,
  }: {
    failure?: "none" | "inspect" | "quarantine" | "scan";
    failSend?: boolean;
    loggerThrows?: boolean;
    stale?: boolean;
    claimed?: boolean;
    failureReason?: { value: unknown };
  } = {},
) {
  const nowMs = 600_000;
  const recoveryFailure = failureReason
    ? failureReason.value
    : new Error(`${failure}-failed`);
  const queueFailure = new Error("queue-failed");
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const sent: unknown[] = [];
  const logger = {
    error(message: string) {
      logs.push(JSON.parse(message));
      if (loggerThrows) throw new Error("logger-failed");
    },
    info() {},
  };
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
      calls.push("send");
      if (failure === "inspect" || failure === "quarantine") {
        assert.ok(logs.some((entry) => entry.phase === failure));
      }
      sent.push(
        ...Array.from(messages, ({ body }) =>
          canonicalQueuePayloadFixture(body),
        ),
      );
      if (failSend) throw queueFailure;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Queue;
  const env = {
    ...TELEGRAM_TEST_ENV,
    PROFILE_GAME_PROJECTION_QUEUE: queue,
    TELEGRAM_PROJECTION_QUEUE: queue,
  } satisfies Env;
  const scan = () => {
    calls.push("scan");
    if (failure === "scan") throw recoveryFailure;
    return failure === "inspect"
      ? [{ kind: "failure" as const, error: recoveryFailure }]
      : [];
  };
  const quarantine = (timestamp: number) => {
    assert.equal(timestamp, nowMs);
    calls.push("quarantine");
    if (failure === "quarantine") throw recoveryFailure;
    return !stale;
  };
  const claim = (timestamp: number) => {
    assert.equal(timestamp, nowMs);
    calls.push("claim");
    return claimed;
  };
  let run: () => Promise<number>;
  let expectedTask: unknown;
  if (lane === "profile-link") {
    const invalid = invalidProfileLinkRecoveryEntry();
    const job: ProfileLinkCatchupJob = {
      loginUid: "healthy-login",
      requestId: "healthy-request",
      profileId: "healthy-profile",
      cleanupProfileIds: [],
      matchCursor: "saved-cursor",
      sourceUpdatedAtMs: 1,
      lastQueuedAtMs: 1,
      revision: 1,
    };
    expectedTask = {
      kind: "profile-link-profile-game-projection",
      loginUid: job.loginUid,
      requestId: job.requestId,
    };
    run = () =>
      sweepProfileLinkProfileGameProjections(env, {
        now: () => nowMs,
        logger,
        createProfileLinkJobs: () => ({
          scanDuePage: async () =>
            projectionRecoveryPage(
              [invalid, ...scan(), ...recoveryCandidates([job])],
              projectionRecoveryEntryIdentity,
            ),
          quarantineInvalidEntry: async (entry, timestamp) => {
            assert.strictEqual(entry, invalid);
            return quarantine(timestamp)
              ? { loginUidHex: "ff", revisionHex: "31", reason: entry.reason }
              : null;
          },
          claimDispatch: async (
            loginUid,
            requestId,
            expectedLastQueuedAtMs,
            timestamp,
          ) => {
            assert.equal(loginUid, job.loginUid);
            assert.equal(requestId, job.requestId);
            assert.equal(expectedLastQueuedAtMs, job.lastQueuedAtMs);
            return claim(timestamp);
          },
        }),
      });
  } else {
    const invalid = invalidRatingRecoveryEntry(lane);
    const record = {
      operationId: "healthy-invite__healthy-match",
      inviteId: "healthy-invite",
      matchId: "healthy-match",
      revision: 1,
      version: 1,
    };
    const rating = createRatingRepository(
      env.PROFILE_DB,
      {
        readInviteMetadata: async () => null,
        readMatchRecord: async () => null,
        readMatchPair: async () => {
          throw new Error("unexpected-match-read");
        },
        readProfileOwnershipSnapshot: async () => {
          throw new Error("unexpected-profile-read");
        },
      },
      { putEventProgressOutbox: async () => assert.fail("unexpected-outbox") },
    );
    rating.quarantineRatingRecoveryEntry = async (entry, timestamp) => {
      assert.strictEqual(entry, invalid);
      return quarantine(timestamp)
        ? {
            operationIdHex: "ff",
            revisionHex: "31",
            projectionKind: lane,
            reason: entry.reason,
          }
        : null;
    };
    const scanRatings = async () => [
      invalid,
      ...scan(),
      ...recoveryCandidates([record]),
    ];
    const claimRating = async (
      operationId: string,
      revision: number,
      timestamp: number,
    ) => {
      assert.equal(operationId, record.operationId);
      assert.equal(revision, record.revision);
      return claim(timestamp);
    };
    if (lane === "profile-game") {
      rating.scanDueRatingProfileGameProjectionsPage = async () =>
        projectionRecoveryPage(
          await scanRatings(),
          projectionRecoveryEntryIdentity,
        );
      rating.claimRatingProfileGameProjection = claimRating;
      run = () =>
        sweepRatingProfileGameProjections(env, {
          createRating: () => rating,
          now: () => nowMs,
          logger,
        });
    } else {
      rating.scanDueRatingTelegramProjectionsPage = async () =>
        projectionRecoveryPage(
          await scanRatings(),
          projectionRecoveryEntryIdentity,
        );
      rating.claimRatingTelegramProjection = claimRating;
      run = () => sweepRatingProjections(env, rating, logger, nowMs);
    }
    expectedTask = {
      kind:
        lane === "profile-game"
          ? "rating-profile-game-projection"
          : "rating-telegram-projection",
      operationId: record.operationId,
    };
  }
  return {
    run,
    calls,
    logs,
    sent,
    expectedTask,
    recoveryFailure,
    queueFailure,
  };
}

for (const lane of ["profile-link", "profile-game", "telegram"] as const) {
  for (const failure of ["none", "inspect", "quarantine"] as const) {
    test(`${lane} isolates ${failure} failures, sends healthy work, and preserves Queue precedence`, async () => {
      for (const loggerThrows of [false, true]) {
        for (const failSend of [false, true]) {
          const harness = recoveryHarness(lane, {
            failure,
            failSend,
            loggerThrows,
          });
          if (failSend || failure !== "none") {
            await assert.rejects(
              harness.run(),
              (error) =>
                error ===
                (failSend ? harness.queueFailure : harness.recoveryFailure),
            );
          } else {
            assert.equal(await harness.run(), 1);
          }
          assert.deepEqual(harness.sent, [harness.expectedTask]);
          assert.equal(
            harness.calls.filter((call) => call === "quarantine").length,
            1,
          );
          assert.equal(
            harness.calls.filter((call) => call === "claim").length,
            1,
          );
          const quarantined = harness.logs.filter((entry) =>
            String(entry.event).endsWith("_quarantined"),
          );
          assert.equal(quarantined.length, failure === "quarantine" ? 0 : 1);
          if (quarantined.length) {
            assert.equal(requiredFixture(quarantined[0]).revisionHex, "31");
            assert.equal(
              requiredFixture(quarantined[0])[
                lane === "profile-link" ? "loginUidHex" : "operationIdHex"
              ],
              "ff",
            );
          }
          const serializedLogs = JSON.stringify(harness.logs);
          for (const privateField of [
            "fields",
            "keyBytes",
            "realValue",
            "private",
          ]) {
            assert.equal(serializedLogs.includes(privateField), false);
          }
        }
      }
    });
  }

  test(`${lane} skips stale quarantine logs while healthy work continues`, async () => {
    const harness = recoveryHarness(lane, { stale: true });
    assert.equal(await harness.run(), 1);
    assert.deepEqual(harness.sent, [harness.expectedTask]);
    assert.deepEqual(harness.logs, []);
  });

  test(`${lane} skips unclaimed candidates without sending empty batches`, async () => {
    const harness = recoveryHarness(lane, { claimed: false });
    assert.equal(await harness.run(), 0);
    assert.deepEqual(harness.sent, []);
    assert.equal(harness.calls.includes("send"), false);
    assert.equal(harness.calls.filter((call) => call === "claim").length, 1);
  });

  test(`${lane} preserves its non-Error failure policy after healthy dispatch`, async () => {
    for (const value of [undefined, null, 0, false, ""]) {
      const harness = recoveryHarness(lane, {
        failure: "inspect",
        failureReason: { value },
        loggerThrows: true,
      });
      await assert.rejects(harness.run(), (error) => {
        if (lane === "profile-game") return error === value;
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          lane === "profile-link"
            ? "profile-game-projection-claim-failed"
            : "projection-claim-failed",
        );
        return true;
      });
      assert.deepEqual(harness.sent, [harness.expectedTask]);
    }
  });

  test(`${lane} preserves scan transport failures without quarantining or claiming`, async () => {
    const harness = recoveryHarness(lane, { failure: "scan" });
    await assert.rejects(
      harness.run(),
      (error) => error === harness.recoveryFailure,
    );
    assert.deepEqual(harness.calls, ["scan"]);
    assert.deepEqual(harness.sent, []);
    assert.equal(
      harness.logs.some((entry) =>
        String(entry.event).endsWith("_quarantined"),
      ),
      false,
    );
  });
}

test("profile-link recovery keeps claims sequential and retains scanned task identifiers", async () => {
  const nowMs = 600_000;
  const jobs: ProfileLinkCatchupJob[] = ["first", "second", "third"].map(
    (id, index) => ({
      loginUid: `${id}-login`,
      requestId: `${id}-request`,
      profileId: `${id}-profile`,
      cleanupProfileIds: [],
      matchCursor: `${id}-saved-cursor`,
      sourceUpdatedAtMs: index + 1,
      lastQueuedAtMs: index + 1,
      revision: index + 1,
    }),
  );
  const claims: string[] = [];
  const sent: unknown[] = [];
  let active = 0;
  let maximum = 0;
  const count = await sweepProfileLinkProfileGameProjections(
    {
      ...TELEGRAM_TEST_ENV,
      PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
        async sendBatch(messages) {
          assert.equal(active, 0);
          sent.push(
            ...Array.from(messages, ({ body }) =>
              canonicalQueuePayloadFixture(body),
            ),
          );
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
    },
    {
      now: () => nowMs,
      createProfileLinkJobs: () => ({
        async scanDuePage(dueBeforeMs, limit) {
          assert.equal(dueBeforeMs, 300_000);
          assert.equal(limit, 10);
          return projectionRecoveryPage(
            recoveryCandidates(jobs),
            projectionRecoveryEntryIdentity,
          );
        },
        quarantineInvalidEntry: async () =>
          assert.fail("unexpected-quarantine"),
        async claimDispatch(loginUid, requestId, lastQueuedAtMs, timestamp) {
          const job = requiredFixture(jobs[claims.length]);
          assert.equal(loginUid, job.loginUid);
          assert.equal(requestId, job.requestId);
          assert.equal(lastQueuedAtMs, job.lastQueuedAtMs);
          assert.equal(timestamp, nowMs);
          claims.push(loginUid);
          active++;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active--;
          return true;
        },
      }),
    },
  );
  assert.equal(count, 3);
  assert.equal(maximum, 1);
  assert.deepEqual(
    claims,
    jobs.map(({ loginUid }) => loginUid),
  );
  assert.deepEqual(
    sent,
    jobs.map(({ loginUid, requestId }) => ({
      kind: "profile-link-profile-game-projection",
      loginUid,
      requestId,
    })),
  );
});
