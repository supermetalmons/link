import assert from "node:assert/strict";
import test from "node:test";
import {
  InviteAlarmCoordinator,
  type InviteAlarmCallbacks,
} from "../src/inviteAlarmCoordinator.ts";

function idleCallbacks(): InviteAlarmCallbacks {
  return {
    expireSessions: () => null,
    prepareInviteChannels: () => null,
    refreshMatches: async () => {},
    dispatchEffects: async () => {},
    inviteDeadline: () => null,
    matchDeadline: () => null,
    effectDeadline: () => null,
  };
}

test("a rejected schedule releases queued work and preserves the earliest alarm", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("alarm-storage-unavailable");
  const alarms: number[] = [];
  let transactions = 0;
  let alarm: number | null = null;
  const transaction = {
    getAlarm: async () => alarm,
    setAlarm: async (atMs: number) => {
      alarm = atMs;
      alarms.push(atMs);
    },
  };
  const coordinator = new InviteAlarmCoordinator(
    {
      async transaction(closure) {
        transactions++;
        if (transactions === 1) {
          started.resolve();
          await release.promise;
          throw failure;
        }
        return closure(transaction as DurableObjectTransaction);
      },
    },
    idleCallbacks(),
  );
  const rejected = assert.rejects(
    coordinator.schedule(50),
    (error) => error === failure,
  );
  await started.promise;
  const next = coordinator.schedule(200);
  const earlier = coordinator.schedule(100);
  const later = coordinator.schedule(300);
  await Promise.resolve();
  assert.equal(transactions, 1);
  release.resolve();
  await Promise.all([rejected, next, earlier, later]);
  assert.equal(transactions, 4);
  assert.deepEqual(alarms, [200, 100]);
  assert.equal(alarm, 100);
});

test("scheduling within a transaction bypasses pending ordinary scheduling", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const alarms: number[] = [];
  const transaction = {
    getAlarm: async () => null,
    setAlarm: async (atMs: number) => {
      alarms.push(atMs);
    },
  };
  let transactions = 0;
  const coordinator = new InviteAlarmCoordinator(
    {
      async transaction(closure) {
        transactions++;
        started.resolve();
        await release.promise;
        return closure(transaction as DurableObjectTransaction);
      },
    },
    idleCallbacks(),
  );
  const pending = coordinator.schedule(200);
  await started.promise;
  try {
    await coordinator.schedule(100, transaction);
    assert.equal(transactions, 1);
    assert.deepEqual(alarms, [100]);
  } finally {
    release.resolve();
    await pending;
  }
});

test("an idle run neither schedules an alarm nor reads callbacks during construction", async () => {
  let expirations = 0;
  let refreshes = 0;
  const callbacks = idleCallbacks();
  callbacks.expireSessions = () => {
    expirations++;
    return null;
  };
  callbacks.prepareInviteChannels = () => {
    refreshes++;
    return null;
  };
  callbacks.refreshMatches = async () => {
    refreshes++;
  };
  callbacks.dispatchEffects = async () => {
    refreshes++;
  };
  const coordinator = new InviteAlarmCoordinator(
    {
      transaction: async () => {
        assert.fail("idle coordinator scheduled an alarm");
      },
    },
    callbacks,
  );
  assert.equal(expirations, 0);
  assert.equal(refreshes, 0);
  await coordinator.run();
  assert.equal(expirations, 3);
  assert.equal(refreshes, 3);
});

test("settles both refreshes before effects and reports failures in lane order", async () => {
  const matchStarted = Promise.withResolvers<void>();
  const releaseWagers = Promise.withResolvers<void>();
  const wagerError = new Error("wagers-failed");
  const matchError = new Error("match-failed");
  let effects = 0;
  const callbacks = idleCallbacks();
  callbacks.prepareInviteChannels = () => ({
    schedule: async () => {},
    metadata: async () => {},
    wagers: async () => {
      await releaseWagers.promise;
      throw wagerError;
    },
  });
  callbacks.refreshMatches = () => {
    matchStarted.resolve();
    throw matchError;
  };
  callbacks.dispatchEffects = async () => {
    effects++;
  };
  const coordinator = new InviteAlarmCoordinator(
    {
      transaction: async () => {
        assert.fail("idle coordinator scheduled an alarm");
      },
    },
    callbacks,
  );
  const failed = assert.rejects(
    coordinator.run(),
    (error) => error === wagerError,
  );
  await matchStarted.promise;
  try {
    assert.equal(effects, 0);
  } finally {
    releaseWagers.resolve();
    await failed;
  }
  assert.equal(effects, 1);
});
