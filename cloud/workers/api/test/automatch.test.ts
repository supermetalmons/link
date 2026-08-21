import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyAutomatchProfile,
  getFirstQueuedAutomatch,
  startAutomatch,
} from "../src/automatch.ts";
import type { FirebaseIdentity } from "../src/firebaseAuth.ts";
import {
  FIREBASE_RTDB_SERVER_TIMESTAMP,
  firebaseRtdbIncrement,
} from "../src/firebaseRtdb.ts";
import type {
  AutomatchProfile,
  GameplayRepository,
} from "../src/gameplayRepository.ts";

const identity: FirebaseIdentity = {
  idToken: "firebase-token",
  profileId: "profile-claim",
  uid: "guest-uid",
};
function request(emojiId = 1, aura = "") {
  return { emojiId, aura };
}

const profile: AutomatchProfile = {
  aura: "rainbow",
  emoji: 9,
  eth: "0xabcdef",
  profileId: "guest-profile",
  rating: 1512,
  sol: "guest-sol",
  username: "Alice",
};

function repository(
  overrides: Partial<GameplayRepository> = {},
): GameplayRepository {
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => null,
    getAutomatchProfile: async () => profile,
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 10,
      slime: 10,
      gum: 10,
      metal: 10,
      ice: 10,
    }),
    getMiningSnapshot: async () => null,
    getRtdbPath: async () => null,
    patchRtdbRoot: async () => undefined,
    transactRtdbPath: async () => ({ committed: false, value: null }),
    ...overrides,
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
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path, query) => {
        assert.equal(path, "automatch");
        assert.deepEqual(query, { orderBy: "$key", limitToFirst: 1 });
        return null;
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
  assert.ok(updates);
  assert.deepEqual(Object.keys(updates).sort(), [
    "automatch/auto_aaaaaaaaaaa",
    "invites/auto_aaaaaaaaaaa",
    "players/guest-uid/matches/auto_aaaaaaaaaaa",
    "telegramAutomatches/auto_aaaaaaaaaaa",
  ]);
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
    telegramDeliveryVersion: 2,
  });
  assert.equal(telegram.lifecycle, "pending");
  assert.equal(telegram.generation, 1);
  assert.match(
    String(telegram.waitingText),
    /Alice \(1512\).*looking for a match/,
  );
});

test("uses client metadata when profile lookup fails", async () => {
  const logs: string[] = [];
  let updates: Record<string, unknown> = {};
  const result = await startAutomatch(
    identity,
    request(3, "rainbow"),
    repository({
      getAutomatchProfile: async () => {
        throw new Error("private-profile-error");
      },
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
    { logProfileFailure: () => logs.push("failed"), random: () => 0 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(logs, ["failed"]);
  const queue = updates["automatch/auto_aaaaaaaaaaa"] as Record<
    string,
    unknown
  >;
  const match = updates["players/guest-uid/matches/auto_aaaaaaaaaaa"] as Record<
    string,
    unknown
  >;
  assert.equal(queue.profileId, "profile-claim");
  assert.equal(queue.rating, 0);
  assert.equal(queue.emojiId, 3);
  assert.equal(match.emojiId, 3);
  assert.equal(match.aura, "rainbow");
});

test("uses the verified profile claim when profile lookup fails", async () => {
  let writes = 0;
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getAutomatchProfile: async () => {
        throw new Error("profile-unavailable");
      },
      getRtdbPath: async () => ({
        auto_existing: {
          profileId: "profile-claim",
          uid: "other-login",
        },
      }),
      patchRtdbRoot: async () => {
        writes++;
      },
    }),
    { logProfileFailure: () => undefined },
  );
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_existing",
    mode: "pending",
    matchedImmediately: false,
  });
  assert.equal(writes, 0);
});

test("returns pending automatches for the same login or profile", async (t) => {
  for (const [name, queuedProfile, queuedUid] of [
    ["login", "other-profile", "guest-uid"],
    ["profile", "guest-profile", "other-uid"],
  ] as const) {
    await t.test(name, async () => {
      let writes = 0;
      const result = await startAutomatch(
        identity,
        request(),
        repository({
          getRtdbPath: async () => ({
            auto_existing: {
              profileId: queuedProfile,
              uid: queuedUid,
            },
          }),
          patchRtdbRoot: async () => {
            writes++;
          },
        }),
      );
      assert.deepEqual(result, {
        ok: true,
        inviteId: "auto_existing",
        mode: "pending",
        matchedImmediately: false,
      });
      assert.equal(writes, 0);
    });
  }
});

test("matches a different v2 candidate and verifies the persisted guest", async () => {
  let updates: Record<string, unknown> = {};
  let guestReads = 0;
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
        if (path === "invites/auto_existing/guestId") {
          guestReads++;
          return "guest-uid";
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
    mode: "matched",
    matchedImmediately: true,
  });
  assert.equal(guestReads, 1);
  assert.deepEqual(updates["invites/auto_existing"], {
    version: 2,
    hostId: "host-uid",
    hostColor: "black",
    guestId: "guest-uid",
    password: "password",
    automatchStateHint: "matched",
    automatchCanceledAt: null,
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
});

test("keeps legacy matches free of Telegram v2 updates", async () => {
  let updates: Record<string, unknown> = {};
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path) =>
        path === "automatch"
          ? {
              auto_legacy: {
                uid: "host-uid",
                hostColor: "white",
                password: "password",
                gameVariant: "Classic",
              },
            }
          : "guest-uid",
      patchRtdbRoot: async (value) => {
        updates = value;
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(updates).sort(), [
    "automatch/auto_legacy",
    "invites/auto_legacy",
    "players/guest-uid/matches/auto_legacy",
  ]);
  assert.equal(
    Object.hasOwn(
      updates["invites/auto_legacy"] as Record<string, unknown>,
      "telegramDeliveryVersion",
    ),
    false,
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
        return "other-guest";
      },
      patchRtdbRoot: async (updates) => {
        writes.push(updates);
      },
    }),
  );
  assert.deepEqual(result, { ok: false });
  assert.equal(queueReads, 4);
  assert.equal(writes.length, 4);
});

test("reconciles a committed match after an ambiguous patch failure", async () => {
  let writes = 0;
  const result = await startAutomatch(
    identity,
    request(),
    repository({
      getRtdbPath: async (path) =>
        path === "automatch"
          ? {
              auto_committed: {
                uid: "host-uid",
                hostColor: "white",
                password: "password",
                gameVariant: "Classic",
              },
            }
          : "guest-uid",
      patchRtdbRoot: async () => {
        writes++;
        throw new Error("response-lost-after-commit");
      },
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    inviteId: "auto_committed",
    mode: "matched",
    matchedImmediately: true,
  });
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
        repository({
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
            return null;
          },
          patchRtdbRoot: async () => {
            writes++;
            throw new Error("unconfirmed-patch");
          },
        }),
      ),
    /unconfirmed-patch/,
  );
  assert.equal(queueReads, 1);
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
