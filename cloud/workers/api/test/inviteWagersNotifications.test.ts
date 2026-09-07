import assert from "node:assert/strict";
import test from "node:test";
import { createFirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import {
  changedInviteWagersIds,
  notifyInviteWagersChanged,
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

test("wager invalidation covers source and access changes without unrelated state", () => {
  assert.deepEqual(
    changedInviteWagersIds({
      "invites/proposal/wagers/match/proposals/host": { count: 2 },
      "invites/proposal/wagers/match/proposals/guest": null,
      "invites/agreement/wagers/match/agreed": {},
      "invites/settlement/wagers/match/settlement": {},
      "invites/resolved/wagers/match/resolved": {},
      "invites/replaced": {},
      "invites/deleted": null,
      "invites/private/password": true,
      "invites/paired/guestId": "guest",
      "invites/owner/hostId": "host",
      "invites/unrelated/hostRematches": "1",
      "invites/unrelated/matchesWagerResolutions/match": true,
      "players/host/matches/match": {},
      "matchTimerClaims/match": {},
    }),
    [
      "proposal",
      "agreement",
      "settlement",
      "resolved",
      "replaced",
      "deleted",
      "private",
      "paired",
      "owner",
    ],
  );
  assert.deepEqual(
    changedInviteWagersIds({
      invites: { first: {}, second: null, "invalid/key": {} },
    }),
    ["first", "second"],
  );
});

test("confirmed PATCH and CAS invalidation happens after the attempted write", async () => {
  const calls: string[] = [];
  const env = environment(async (id) => {
    calls.push(`notify:${id}`);
  });
  const client = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "token",
    fetcher: async (_url, init) => {
      calls.push(init?.method || "GET");
      return init?.method === "PATCH"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ proposedBy: { host: true } }), {
            headers: { ETag: "etag" },
          });
    },
  });
  await client.patchRoot({
    "invites/invite/wagers/match/proposals/host": {},
    "invites/invite/wagers/match/proposedBy/host": true,
  });
  assert.deepEqual(calls, ["PATCH", "notify:invite"]);
  calls.length = 0;
  await client.transactPath("invites/invite/wagers/match", () => ({
    value: {},
    decision: "accepted",
  }));
  assert.deepEqual(calls, ["GET", "PUT", "notify:invite"]);
  calls.length = 0;
  await client.transactPath("invites/invite/wagers/match", () => ({
    commit: false,
    decision: "noop",
  }));
  assert.deepEqual(calls, ["GET"]);
});

test("confirmed metadata and wager changes share one invalidation per invite while ambiguous writes still notify wagers", async () => {
  const calls: string[] = [];
  let ambiguous = false;
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
  const client = createFirebaseRtdbClient(env, {
    getAccessToken: async () => "token",
    fetcher: async (_url, init) => {
      if (!init?.method || init.method === "GET")
        return new Response("{}", { headers: { ETag: "etag" } });
      if (ambiguous) throw new Error("lost-response");
      return init.method === "PATCH"
        ? new Response(null, { status: 204 })
        : new Response("{}");
    },
  });
  await client.patchRoot({
    "invites/combined/guestId": "guest",
    "invites/combined/wagers/match": {},
    "invites/wager-only/wagers/match": {},
  });
  assert.deepEqual(calls, ["metadata:combined", "wagers:wager-only"]);
  calls.length = 0;
  await client.transactPath("invites/combined", () => ({
    value: {},
    decision: "replace",
  }));
  assert.deepEqual(calls, ["metadata:combined"]);
  calls.length = 0;
  ambiguous = true;
  await assert.rejects(client.patchRoot({ "invites/combined": {} }));
  assert.deepEqual(calls, ["wagers:combined"]);
});

test("ambiguous writes invalidate without changing the original error result", async () => {
  for (const method of ["PATCH", "PUT"]) {
    for (const failure of ["network", "response", "http"]) {
      const calls: string[] = [];
      const client = createFirebaseRtdbClient(
        environment(async (id) => {
          calls.push(`notify:${id}`);
        }),
        {
          getAccessToken: async () => "token",
          fetcher: async (_url, init) => {
            calls.push(init?.method || "GET");
            if (init?.method === "GET" || !init?.method) {
              return new Response("{}", { headers: { ETag: "etag" } });
            }
            if (failure === "network")
              throw new Error("response-lost-after-commit");
            if (failure === "http") return new Response(null, { status: 503 });
            return new Response("invalid-json", { status: 200 });
          },
        },
      );
      const action =
        method === "PATCH"
          ? client.patchRoot({ "invites/invite/wagers/match": {} })
          : client.transactPath("invites/invite/wagers/match", () => ({
              value: {},
              decision: "write",
            }));
      if (method === "PATCH" && failure === "response") await action;
      else await assert.rejects(action);
      assert.equal(calls.at(-1), "notify:invite");
      assert.equal(
        calls.filter((call) => call.startsWith("notify:")).length,
        1,
      );
    }
  }
});

test("read failures and known conditional conflicts do not invalidate uncommitted state", async () => {
  let notices = 0;
  for (const failRead of [true, false]) {
    const client = createFirebaseRtdbClient(
      environment(async () => {
        notices++;
      }),
      {
        getAccessToken: async () => "token",
        maxTransactionAttempts: 1,
        fetcher: async (_url, init) => {
          if (failRead) throw new Error("read-failed");
          return init?.method === "PUT"
            ? new Response(null, { status: 412 })
            : new Response("{}", { headers: { ETag: "etag" } });
        },
      },
    );
    await assert.rejects(
      client.transactPath("invites/invite/wagers/match", () => ({
        value: {},
        decision: "write",
      })),
    );
  }
  assert.equal(notices, 0);
});

test("failed or stuck room notifications are bounded and cannot reject committed work", async () => {
  for (const notify of [
    async () => {
      throw new Error("unavailable");
    },
    () => new Promise<void>(() => undefined),
  ]) {
    let failures = 0;
    await notifyInviteWagersChanged(
      environment(notify),
      { "invites/invite/wagers/match": {} },
      {
        timeoutMs: 1,
        logFailure: () => {
          failures++;
        },
      },
    );
    assert.equal(failures, 1);
  }
  const client = createFirebaseRtdbClient(
    environment(async () => {
      throw new Error("unavailable");
    }),
    {
      getAccessToken: async () => "token",
      fetcher: async () => new Response(null, { status: 204 }),
    },
  );
  await client.patchRoot({ "invites/invite/wagers/match": {} });
});
