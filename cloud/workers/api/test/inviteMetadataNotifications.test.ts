import assert from "node:assert/strict";
import test from "node:test";
import { createFirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import {
  changedInviteMetadataIds,
  notifyInviteMetadataChanged,
} from "../src/inviteMetadataNotifications.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("metadata notifications cover structural producer writes and ignore unrelated state", () => {
  assert.deepEqual(
    changedInviteMetadataIds({
      "invites/manual": { hostId: "host" },
      "invites/auto_pending": { guestId: null },
      "invites/auto_matched/guestId": "guest",
      "invites/auto_canceled/automatchStateHint": "canceled",
      "invites/auto_recovered/automatchOperationIds/host": "operation",
      "invites/event_invite": {
        eventOwned: true,
        hostId: "host",
        guestId: "guest",
      },
      "invites/rematch/hostRematches": "1",
      "invites/rematch/guestRematches": "1x",
      "invites/private/password": "changed",
      "invites/removed": null,
      "invites/wager/wagers/match/proposals": {},
      "invites/wager/matchesWagerResolutions/match": true,
      "players/host/matches/manual/fen": "next",
      "matchTimerClaims/manual": {},
      "telegramProjectionOutbox/automatch/manual": {},
    }),
    [
      "manual",
      "auto_pending",
      "auto_matched",
      "auto_canceled",
      "auto_recovered",
      "event_invite",
      "rematch",
      "private",
      "removed",
    ],
  );
  assert.deepEqual(
    changedInviteMetadataIds({ invites: { "bulk-one": {}, "bulk-two": {} } }),
    ["bulk-one", "bulk-two"],
  );
});

test("successful RTDB PATCH and conditional writes notify after commit, once per invite", async () => {
  const calls: string[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (id: string) => ({
        notifyMetadataChanged: async (incoming: string) => {
          assert.equal(incoming, id);
          calls.push(`notify:${id}`);
        },
      }),
    },
  } as unknown as Env;
  const client = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "token",
    fetcher: async (_url, init) => {
      calls.push(init?.method || "GET");
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ hostId: "host" }), {
        headers: { ETag: "etag" },
      });
    },
  });
  await client.patchRoot({
    "invites/manual/hostRematches": "1",
    "invites/manual/guestRematches": "1",
  });
  assert.deepEqual(calls, ["PATCH", "notify:manual"]);
  calls.length = 0;
  await client.transactPath("invites/manual/guestId", () => ({
    value: "guest",
    decision: "joined",
  }));
  assert.deepEqual(calls, ["GET", "PUT", "notify:manual"]);
  calls.length = 0;
  await client.transactPath("invites/manual", () => ({
    commit: false,
    decision: "replay",
  }));
  assert.deepEqual(calls, ["GET"]);
});

test("failed commits do not notify and unavailable notification delivery cannot reject committed work", async () => {
  let notices = 0;
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: async () => {
          notices++;
        },
      }),
    },
  } as unknown as Env;
  const client = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "token",
    fetcher: async () => new Response(null, { status: 503 }),
  });
  await assert.rejects(client.patchRoot({ "invites/manual/guestId": "guest" }));
  assert.equal(notices, 0);
  let failures = 0;
  const unavailable = {
    ...env,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: async () => {
          throw new Error("unavailable");
        },
      }),
    },
  } as unknown as Env;
  await notifyInviteMetadataChanged(
    unavailable,
    { "invites/manual/guestId": "guest" },
    {
      logFailure: () => {
        failures++;
      },
    },
  );
  assert.equal(failures, 1);
});

test("notification deadline prevents a stuck room from holding a committed mutation", async () => {
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: () => new Promise<void>(() => undefined),
      }),
    },
  } as unknown as Env;
  let failures = 0;
  await notifyInviteMetadataChanged(
    env,
    { "invites/manual/hostRematches": "1" },
    {
      timeoutMs: 1,
      logFailure: () => {
        failures++;
      },
    },
  );
  assert.equal(failures, 1);
});
