import assert from "node:assert/strict";
import test from "node:test";
import {
  changedMatchSyncTargets,
  notifyMatchSyncChanged,
  notifyMatchSyncInvites,
} from "../src/matchSyncNotifications.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function environment({
  resolve = async (_playerId: string, _matchId: string) =>
    "invite-one" as string | null,
  notify = async (_inviteId: string, _matchIds?: string[]) => undefined,
}: {
  resolve?: (playerId: string, matchId: string) => Promise<string | null>;
  notify?: (inviteId: string, matchIds?: string[]) => Promise<void>;
} = {}): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    PROFILE_GAMES_DB: {
      withSession: (constraint: string) => {
        assert.equal(constraint, "first-primary");
        return {
          prepare: (sql: string) => {
            assert.match(sql, /WHERE login_uid = \? AND match_id = \?$/);
            return {
              bind: (playerId: string, matchId: string) => ({
                first: async () => {
                  const inviteId = await resolve(playerId, matchId);
                  return inviteId === null
                    ? null
                    : { invite_id: inviteId, resolution: "resolved" };
                },
              }),
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

test("match invalidation extracts exact record and descendant targets without guessing ancestors", () => {
  assert.deepEqual(
    changedMatchSyncTargets({
      "players/host/matches/invite-one": {},
      "players/host/matches/invite-one/fen": "next",
      "/players/guest/matches/invite-one/timer/": "gg",
      "players/host/matches/invite-one1/status": "surrendered",
      "players/host/matches": {},
      "players/host/profile": {},
      "players/ bad/matches/invite-one": {},
      "players/host/matches/ bad": {},
      "players/host/matches/invite-one/invalid.key": {},
      "invites/invite-one": {},
      "matchTimerClaims/invite-one": {},
      "eventTransitionReceipts/receipt": {},
    }),
    [
      { playerId: "host", matchId: "invite-one" },
      { playerId: "guest", matchId: "invite-one" },
      { playerId: "host", matchId: "invite-one1" },
    ],
  );
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
  await notifyMatchSyncChanged(env, {
    "players/host/matches/invite-one1/fen": "next",
    "players/guest/matches/invite-one1/timer": "timer",
    "players/host/matches/invite-one1/flatMovesString": "history",
    "players/host/matches/invite-one12": {},
  });
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
  await notifyMatchSyncChanged(env, { "players/host/matches/invite123": {} });
  assert.deepEqual(notices, []);
  await notifyMatchSyncInvites(env, ["invite123", "invite123", "invalid/key"]);
  assert.deepEqual(notices, [["invite123", undefined]]);
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
    { "players/host/matches/invite-one": {} },
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
      { "players/host/matches/invite-one": {} },
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
