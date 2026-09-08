import assert from "node:assert/strict";
import test from "node:test";
import {
  FirebaseRtdbFailure,
  MAX_RTDB_BODY_BYTES,
  readPublicFirebaseMatch,
} from "../src/firebaseRtdb.ts";

const env = {
  FIREBASE_RTDB_URL: "https://mons-link-default-rtdb.firebaseio.com",
};
const target = { playerId: "player@one", matchId: "match?one" };

test("reads one exact public match without credentials or redirects", async () => {
  let reads = 0;
  const result = await readPublicFirebaseMatch(env, target, {
    fetcher: async (input, init) => {
      reads++;
      assert.equal(
        String(input),
        `${env.FIREBASE_RTDB_URL}/players/player%40one/matches/match%3Fone.json`,
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      assert.ok(init?.signal);
      return new Response(JSON.stringify({ fen: "current-fen" }));
    },
  });
  assert.deepEqual(result, { fen: "current-fen" });
  assert.equal(reads, 1);
});

test("validates public match paths, database roots, and read deadlines before fetching", async () => {
  let reads = 0;
  const fetcher: typeof fetch = async () => {
    reads++;
    return new Response("null");
  };
  for (const input of [
    { ...target, playerId: "players/other" },
    { ...target, matchId: "match/other" },
    { ...target, matchId: "match-1 " },
  ])
    await assert.rejects(
      readPublicFirebaseMatch(env, input, { fetcher }),
      TypeError,
    );
  for (const root of [
    "https://example.com",
    "http://mons-link-default-rtdb.firebaseio.com",
    `${env.FIREBASE_RTDB_URL}/players`,
    `${env.FIREBASE_RTDB_URL}?auth=credential`,
  ])
    await assert.rejects(
      readPublicFirebaseMatch({ FIREBASE_RTDB_URL: root }, target, { fetcher }),
      FirebaseRtdbFailure,
    );
  await assert.rejects(
    readPublicFirebaseMatch(env, target, { fetcher, timeoutMs: 0 }),
    TypeError,
  );
  assert.equal(reads, 0);
});

test("rejects failed, malformed, and oversized public responses", async () => {
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { Location: "https://example.com" },
    }),
    new Response("upstream unavailable", { status: 503 }),
    new Response("not-json"),
    new Response(null),
    new Response("{}", {
      headers: { "Content-Length": String(MAX_RTDB_BODY_BYTES + 1) },
    }),
    new Response(JSON.stringify("x".repeat(MAX_RTDB_BODY_BYTES + 1))),
  ])
    await assert.rejects(
      readPublicFirebaseMatch(env, target, { fetcher: async () => response }),
      FirebaseRtdbFailure,
    );
  assert.equal(
    await readPublicFirebaseMatch(env, target, {
      fetcher: async () => new Response("null"),
    }),
    null,
  );
});

test("aborts public reads on caller cancellation and refuses already cancelled work", async () => {
  const controller = new AbortController();
  let reads = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    reads++;
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      controller.abort();
    });
  };
  await assert.rejects(
    readPublicFirebaseMatch(env, target, {
      fetcher,
      signal: controller.signal,
    }),
    FirebaseRtdbFailure,
  );
  await assert.rejects(
    readPublicFirebaseMatch(env, target, {
      fetcher,
      signal: controller.signal,
    }),
    FirebaseRtdbFailure,
  );
  assert.equal(reads, 1);
});

test("applies the bounded public read timeout", async () => {
  const keepAlive = setTimeout(() => undefined, 1_000);
  try {
    await assert.rejects(
      readPublicFirebaseMatch(env, target, {
        timeoutMs: 5,
        fetcher: async (_input, init) => {
          const signal = init?.signal;
          assert.ok(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      }),
      FirebaseRtdbFailure,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
