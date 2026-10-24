import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  notifyMatchSyncChanged,
  notifyMatchSyncInvites,
} from "../src/matchSyncNotifications.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

type DiscoveryRead = () => Promise<{
  success: true;
  results: Array<{ invite_id: string; resolution: "resolved" }>;
}>;

function environment({
  resolve = async (_playerId: string, _matchId: string) =>
    "invite-one" as string | null,
  notify = async (_inviteId: string, _matchIds?: string[]) => undefined,
  batch = (reads) => Promise.all(reads.map((read) => read())),
  session = () => undefined,
}: {
  resolve?: (playerId: string, matchId: string) => Promise<string | null>;
  notify?: (inviteId: string, matchIds?: string[]) => Promise<void>;
  batch?: (reads: readonly DiscoveryRead[]) => Promise<unknown>;
  session?: () => void;
} = {}): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    PROFILE_GAMES_DB: {
      withSession: (constraint: string) => {
        assert.equal(constraint, "first-primary");
        session();
        return {
          batch,
          prepare: (sql: string) => {
            assert.match(sql, /WHERE login_uid = \? AND match_id = \?$/);
            return {
              bind:
                (playerId: string, matchId: string): DiscoveryRead =>
                async () => {
                  const inviteId = await resolve(playerId, matchId);
                  return {
                    success: true,
                    results:
                      inviteId === null
                        ? []
                        : [{ invite_id: inviteId, resolution: "resolved" }],
                  };
                },
            };
          },
        };
      },
    },
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        notifyMatchesChanged: async (incoming: string, matchIds?: string[]) => {
          assert.equal(incoming, inviteId);
          await notify(inviteId, matchIds);
        },
      }),
    },
  } as unknown as Env;
}

test("match invalidation validates and deduplicates exact record identities", async () => {
  const targets: string[] = [];
  const env = environment({
    resolve: async (playerId, matchId) => {
      targets.push(`${playerId}/${matchId}`);
      return null;
    },
  });
  await notifyMatchSyncChanged(env, [
    { playerId: "host", matchId: "invite-one" },
    { playerId: "host", matchId: "invite-one" },
    { playerId: "guest", matchId: "invite-one" },
    { playerId: "host", matchId: "invite-one1" },
    { playerId: " bad", matchId: "invite-one" },
    { playerId: "host", matchId: " bad" },
    { playerId: "host", matchId: "invalid/key" },
  ]);
  assert.deepEqual(targets, [
    "host/invite-one",
    "guest/invite-one",
    "host/invite-one1",
  ]);
});

test("exact player and match discovery lookups deduplicate room invalidations", async () => {
  const lookups: string[] = [];
  const notices: unknown[] = [];
  const env = environment({
    resolve: async (playerId, matchId) => {
      lookups.push(`${playerId}/${matchId}`);
      return matchId === "invite-one12" ? "invite-one1" : "invite-one";
    },
    notify: async (inviteId, matchIds) => {
      notices.push([inviteId, matchIds]);
    },
  });
  await notifyMatchSyncChanged(env, [
    { playerId: "host", matchId: "invite-one1" },
    { playerId: "guest", matchId: "invite-one1" },
    { playerId: "host", matchId: "invite-one1" },
    { playerId: "host", matchId: "invite-one12" },
  ]);
  assert.deepEqual(lookups, [
    "host/invite-one1",
    "guest/invite-one1",
    "host/invite-one12",
  ]);
  assert.deepEqual(notices, [
    ["invite-one", ["invite-one1"]],
    ["invite-one1", ["invite-one12"]],
  ]);
});

test("missing discovery never guesses numeric invite suffixes and postfinalization refresh needs no lookup", async () => {
  const notices: unknown[] = [];
  const env = environment({
    resolve: async () => null,
    notify: async (inviteId, matchIds) => {
      notices.push([inviteId, matchIds]);
    },
  });
  await notifyMatchSyncChanged(env, [
    { playerId: "host", matchId: "invite123" },
  ]);
  assert.deepEqual(notices, []);
  await notifyMatchSyncInvites(env, ["invite123", "invite123", "invalid/key"]);
  assert.deepEqual(notices, [["invite123", undefined]]);
});

test("covering notifications suppress only exact resolved rooms within the current operation", async () => {
  const lookups: string[] = [];
  const notices: unknown[] = [];
  const env = environment({
    resolve: async (playerId, matchId) => {
      lookups.push(`${playerId}/${matchId}`);
      if (matchId === "missing") return null;
      return matchId === "invite-one12" ? "invite-one1" : "invite-one";
    },
    notify: async (inviteId, matchIds) => {
      notices.push([inviteId, matchIds]);
    },
  });
  await notifyMatchSyncChanged(
    env,
    [
      { playerId: "host", matchId: "invite-one1" },
      { playerId: "guest", matchId: "invite-one1" },
      { playerId: "host", matchId: "invite-one12" },
      { playerId: "host", matchId: "invite-one12" },
      { playerId: "guest", matchId: "invite-one12" },
      { playerId: "host", matchId: "missing" },
    ],
    {
      coveredInviteIds: [
        "invite-one",
        "invite-one",
        " invite-one1 ",
        "invalid/key",
      ],
    },
  );
  assert.deepEqual(lookups, [
    "host/invite-one1",
    "guest/invite-one1",
    "host/invite-one12",
    "guest/invite-one12",
    "host/missing",
  ]);
  assert.deepEqual(notices, [["invite-one1", ["invite-one12"]]]);

  await notifyMatchSyncChanged(env, [
    { playerId: "host", matchId: "invite-one1" },
  ]);
  assert.deepEqual(notices, [
    ["invite-one1", ["invite-one12"]],
    ["invite-one", ["invite-one1"]],
  ]);
});

test("the notification deadline includes discovery and prevents late RPC dispatch", async () => {
  let resolveLookup: (value: string) => void = () => undefined;
  const lookup = new Promise<string>((resolve) => {
    resolveLookup = resolve;
  });
  let notices = 0;
  let failures = 0;
  const env = environment({
    notify: async () => {
      notices++;
    },
  });
  await notifyMatchSyncChanged(
    env,
    [{ playerId: "host", matchId: "invite-one" }],
    {
      timeoutMs: 1,
      resolveInvite: () => lookup,
      logFailure: () => {
        failures++;
      },
    },
  );
  resolveLookup("invite-one");
  await lookup;
  await Promise.resolve();
  assert.equal(notices, 0);
  assert.equal(failures, 1);
});

test("failed and stuck room RPCs stay bounded without rejecting committed work", async () => {
  for (const notify of [
    async () => {
      throw new Error("room-unavailable");
    },
    () => new Promise<void>(() => undefined),
  ]) {
    let failures = 0;
    await notifyMatchSyncChanged(
      environment({ notify }),
      [{ playerId: "host", matchId: "invite-one" }],
      {
        timeoutMs: 1,
        logFailure: () => {
          failures++;
        },
      },
    );
    assert.equal(failures, 1);
  }
});

function notificationTargets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: "host",
    matchId: `match-${index}`,
  }));
}

test("forty-one targets use two primary batches before any room notification", async () => {
  const sizes: number[] = [];
  const notices: unknown[] = [];
  let sessions = 0;
  let completed = 0;
  const targets = notificationTargets(41);
  const env = environment({
    session: () => {
      sessions++;
    },
    batch: async (reads) => {
      assert.equal(sessions, sizes.length + 1);
      assert.equal(completed, sizes.length);
      sizes.push(reads.length);
      const results = await Promise.all(reads.map((read) => read()));
      completed++;
      return results;
    },
    notify: async (inviteId, matchIds) => {
      assert.equal(completed, 2);
      notices.push([inviteId, matchIds]);
    },
  });
  await notifyMatchSyncChanged(env, [...targets, targets[0]]);
  assert.equal(sessions, 2);
  assert.deepEqual(sizes, [40, 1]);
  assert.deepEqual(notices, [
    ["invite-one", targets.map(({ matchId }) => matchId)],
  ]);
});

test("failed or malformed later batches suppress all notifications", async () => {
  const failures = [
    async () => {
      throw new Error("discovery-unavailable");
    },
    async () => [],
    async () => [{ success: false, results: [] }],
    async () => [{ success: true, results: null }],
    async () => [
      {
        success: true,
        results: [{ invite_id: null, resolution: "resolved" }],
      },
    ],
  ];
  for (const failBatch of failures) {
    let batches = 0;
    let notices = 0;
    let logged = 0;
    const env = environment({
      batch: async (reads) => {
        batches++;
        if (batches === 2) return failBatch();
        return Promise.all(reads.map((read) => read()));
      },
      notify: async () => {
        notices++;
      },
    });
    await notifyMatchSyncChanged(env, notificationTargets(81), {
      logFailure: () => {
        logged++;
      },
    });
    assert.equal(batches, 2);
    assert.equal(notices, 0);
    assert.equal(logged, 1);
  }
});

test("a timed-out batch cannot start another batch or notify after it resolves", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let batches = 0;
  let sessions = 0;
  let notices = 0;
  let logged = 0;
  const env = environment({
    session: () => {
      sessions++;
    },
    batch: async (reads) => {
      batches++;
      await gate;
      return Promise.all(reads.map((read) => read()));
    },
    notify: async () => {
      notices++;
    },
  });
  try {
    await notifyMatchSyncChanged(env, notificationTargets(41), {
      timeoutMs: 1,
      logFailure: () => {
        logged++;
      },
    });
    assert.equal(batches, 1);
    assert.equal(logged, 1);
  } finally {
    release();
    await setImmediate();
  }
  assert.equal(sessions, 1);
  assert.equal(batches, 1);
  assert.equal(notices, 0);
  assert.equal(logged, 1);
});
