import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyInviteWagersChanged,
  notifyInviteSourceChanged,
  notifyInviteSessionCommitted,
} from "../src/inviteWagersNotifications.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function environment(notify: (inviteId: string) => Promise<void>): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        notifyWagersChanged: async (incoming: string) => {
          assert.equal(incoming, inviteId);
          await notify(inviteId);
        },
        notifyMetadataChanged: async () => undefined,
      }),
    },
  } as unknown as Env;
}

test("wager invalidation validates and deduplicates explicit invite identities", async () => {
  const calls: string[] = [];
  await notifyInviteWagersChanged(
    environment(async (id) => {
      calls.push(id);
    }),
    [
      "proposal",
      "agreement",
      "settlement",
      "proposal",
      "",
      "invalid/key",
      " padded ",
    ],
  );
  assert.deepEqual(calls, ["proposal", "agreement", "settlement"]);
});

test("confirmed source changes deduplicate metadata and wager invalidations", async () => {
  const calls: string[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        notifyMetadataChanged: async () => {
          calls.push(`metadata:${inviteId}`);
        },
        notifyWagersChanged: async () => {
          calls.push(`wagers:${inviteId}`);
        },
      }),
    },
  } as unknown as Env;
  await notifyInviteSourceChanged(env, {
    metadataInviteIds: ["combined"],
    wagerInviteIds: ["combined", "wager-only"],
  });
  assert.deepEqual(calls, ["metadata:combined", "wagers:wager-only"]);
  calls.length = 0;
  await notifyInviteSourceChanged(env, {
    metadataInviteIds: ["combined"],
    wagerInviteIds: ["combined"],
  });
  assert.deepEqual(calls, ["metadata:combined"]);
});

test("ambiguous source changes invalidate wagers without claiming metadata committed", async () => {
  const notices: string[] = [];
  await notifyInviteSourceChanged(
    environment(async (id) => {
      notices.push(id);
    }),
    {
      metadataInviteIds: [],
      wagerInviteIds: ["combined", "wager-only", "wager-only"],
    },
  );
  assert.deepEqual(notices, ["combined", "wager-only"]);
});

test("failed or stuck room notifications are bounded and cannot reject committed work", async () => {
  for (const notify of [
    async () => {
      throw new Error("unavailable");
    },
    () => new Promise<void>(() => undefined),
  ]) {
    let failures = 0;
    await notifyInviteWagersChanged(environment(notify), ["invite"], {
      timeoutMs: 1,
      logFailure: () => {
        failures++;
      },
    });
    assert.equal(failures, 1);
  }
  await notifyInviteSourceChanged(
    environment(async () => {
      throw new Error("unavailable");
    }),
    { metadataInviteIds: [], wagerInviteIds: ["invite"] },
  );
});

test("session commits send one bounded notification per valid room", async () => {
  const calls: string[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        notifySessionCommitted: async (incoming: string) => {
          assert.equal(incoming, inviteId);
          calls.push(inviteId);
        },
      }),
    },
  } as unknown as Env;
  await notifyInviteSessionCommitted(env, [
    "invite",
    "invite",
    "second",
    "invalid/key",
    " padded ",
  ]);
  assert.deepEqual(calls, ["invite", "second"]);
  for (const notify of [
    async () => {
      throw new Error("unavailable");
    },
    () => new Promise<void>(() => undefined),
  ]) {
    let failures = 0;
    const unavailable = {
      ...env,
      INVITE_REACTIONS: {
        getByName: () => ({ notifySessionCommitted: notify }),
      },
    } as unknown as Env;
    await notifyInviteSessionCommitted(unavailable, ["invite"], {
      timeoutMs: 1,
      logFailure: () => failures++,
    });
    assert.equal(failures, 1);
  }
});
