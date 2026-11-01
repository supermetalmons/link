import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import {
  APPLICATION_DATA_EPOCH,
  APPLICATION_DATA_HEADER,
  APPLICATION_DATA_SOCKET_PROTOCOL,
  APPLICATION_DATA_STATUS_HEADER,
} from "@mons/shared/data-contract";

registerTypeScriptTestHooks();

const {
  ApplicationDataGate,
  ApplicationDataUnavailableError,
  applicationDataGate,
  readApplicationRelease,
  requestApplicationReloadOnce,
  startApplicationData,
} = await import("../src/session/applicationDataLifecycle.ts");
const {
  APPLICATION_RELOAD_MARKER,
  applicationStorageKey,
  resetRetiredApplicationStorage,
} = await import("../src/session/applicationDataStorage.ts");
const { fetchApplicationData, applicationSocketProtocols } =
  await import("../src/services/applicationTransport.ts");

/** @returns {Extract<import("@mons/shared/data-contract").ApplicationReleaseStatus, {state: "active"}>} */
const active = () => ({
  state: "active",
  dataEpoch: APPLICATION_DATA_EPOCH,
  generation: 1,
});
/** @param {unknown} value @param {ResponseInit} [init] */
const json = (value, init = undefined) =>
  new Response(JSON.stringify(value), init);
/** @param {Record<string, string>} [initial] @returns {Storage & {values: Map<string, string>}} */
const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (/** @type {string} */ key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
};

test("release check is uncached, unauthenticated, strict and bounded", async () => {
  assert.deepEqual(
    await readApplicationRelease(async (url, init) => {
      assert.equal(url, "https://api.mons.link/release");
      assert.equal(required(init).cache, "no-store");
      assert.equal(required(init).credentials, "omit");
      assert.equal(required(init).redirect, "error");
      assert.equal(
        new Headers(required(init).headers).get("Authorization"),
        null,
      );
      return json(active());
    }),
    active(),
  );
  for (const value of [
    null,
    {},
    { ...active(), generation: "1" },
    { ...active(), extra: true },
  ]) {
    await assert.rejects(
      readApplicationRelease(async () => json(value)),
      { code: "unavailable" },
    );
  }
  await assert.rejects(
    readApplicationRelease(async () =>
      json({ ...active(), dataEpoch: APPLICATION_DATA_EPOCH + 1 }),
    ),
    { code: "update-required" },
  );
  await assert.rejects(
    readApplicationRelease(async () => new Response(" ".repeat(1_025))),
    { code: "unavailable" },
  );
  await assert.rejects(
    readApplicationRelease(async () => json(active(), { status: 503 })),
    { code: "unavailable" },
  );
});

test("source recovery epoch zero requires an update without clearing local data", async () => {
  /** @type {Array<"logout" | "reset" | "app" | import("../src/session/applicationDataLifecycle.ts").ApplicationBlockReason>} */
  const calls = [];
  await assert.rejects(
    readApplicationRelease(async () => json({ ...active(), dataEpoch: 0 })),
    { code: "update-required" },
  );
  for (const dataEpoch of [-1, 0.5, "0"]) {
    await assert.rejects(
      readApplicationRelease(async () => json({ ...active(), dataEpoch })),
      { code: "unavailable" },
    );
  }
  await startApplicationData({
    gate: new ApplicationDataGate(),
    readRelease: () =>
      readApplicationRelease(async () => json({ ...active(), dataEpoch: 0 })),
    enforcePendingLogout: async () => {
      calls.push("logout");
    },
    resetStorage: () => calls.push("reset"),
    start: async () => {
      calls.push("app");
    },
    onBlocked: (reason) => calls.push(reason),
  });
  assert.deepEqual(calls, ["update-required"]);
});

test("startup checks release, applies logout precedence, resets old data, then starts the app", async () => {
  /** @type {Array<"release" | "logout" | "reset" | "app" | import("../src/session/applicationDataLifecycle.ts").ApplicationBlockReason>} */
  const calls = [];
  await startApplicationData({
    gate: new ApplicationDataGate(),
    readRelease: async () => {
      calls.push("release");
      return active();
    },
    enforcePendingLogout: async () => {
      calls.push("logout");
    },
    resetStorage: () => {
      calls.push("reset");
    },
    start: async () => {
      calls.push("app");
    },
    onBlocked: (reason) => calls.push(reason),
  });
  assert.deepEqual(calls, ["release", "logout", "reset", "app"]);
});

test("maintenance, update-required and failed logout prevent reset and all app startup", async () => {
  for (const reason of /** @type {const} */ ([
    "maintenance",
    "update-required",
    "unavailable",
  ])) {
    /** @type {Array<"logout" | "reset" | "app" | import("../src/session/applicationDataLifecycle.ts").ApplicationBlockReason>} */
    const calls = [];
    await startApplicationData({
      gate: new ApplicationDataGate(),
      readRelease: async () => {
        if (reason === "update-required")
          throw new ApplicationDataUnavailableError(reason);
        return reason === "maintenance"
          ? { ...active(), state: "maintenance", retryAfterSeconds: 60 }
          : active();
      },
      enforcePendingLogout: async () => {
        calls.push("logout");
        throw new Error("logout unavailable");
      },
      resetStorage: () => calls.push("reset"),
      start: async () => {
        calls.push("app");
      },
      onBlocked: (blocked) => calls.push(blocked),
    });
    assert.deepEqual(
      calls,
      reason === "unavailable" ? ["logout", reason] : [reason],
    );
  }
});

test("a cutover detected while startup awaits logout prevents any reset or app import", async () => {
  const gate = new ApplicationDataGate();
  /** @type {Array<"reset" | "app" | import("../src/session/applicationDataLifecycle.ts").ApplicationBlockReason>} */
  const calls = [];
  await startApplicationData({
    gate,
    readRelease: async () => active(),
    enforcePendingLogout: async () => {
      gate.block("maintenance");
    },
    resetStorage: () => calls.push("reset"),
    start: async () => {
      calls.push("app");
    },
    onBlocked: (reason) => calls.push(reason),
  });
  assert.deepEqual(calls, ["maintenance"]);
});

test("reset removes old app data while preserving session, logout fences, current and future namespaces", () => {
  const retained = {
    "__mons_link_session_logout__:generation": "1",
    __mons_link_logout_pending_wipe__: '{"id":"logout"}',
    __mons_link_logout_pending_wipe_ack__: "logout",
    __mons_link_session_revision__: "revision",
    [APPLICATION_RELOAD_MARKER]: "reload",
    [applicationStorageKey("profileId")]: '"new-profile"',
    [`mons:data:v${APPLICATION_DATA_EPOCH + 1}:profileId`]: '"future-profile"',
    "unrelated-preference": "keep",
  };
  const local = memoryStorage({
    ...retained,
    profileId: "old-profile",
    completedProblems: '["one"]',
    "firebase:auth": "old",
    "navigationGamesTopCache:v3:profile:old": "old",
  });
  const session = memoryStorage({
    ...retained,
    "mons:pending-moves:v1:old": "move",
    "mons:pending-rematch-ends:v1:old": "end",
    appleIntentByStateV1: "intent",
    xAuthUiFeedbackV1: "feedback",
  });
  resetRetiredApplicationStorage([local, session]);
  assert.deepEqual(Object.fromEntries(local.values), retained);
  assert.deepEqual(Object.fromEntries(session.values), retained);
});

test("two tabs resetting stale keys cannot erase newly written canonical state or logout markers", () => {
  const store = memoryStorage({ profileId: "old", username: "old" });
  const remove = store.removeItem;
  store.removeItem = (key) => {
    remove(key);
    store.setItem(applicationStorageKey("profileId"), '"new-profile"');
    store.setItem("__mons_link_session_logout__:new-generation", "1");
  };
  resetRetiredApplicationStorage([store]);
  store.setItem("profileId", "stale-tab-write");
  resetRetiredApplicationStorage([store]);
  assert.equal(
    store.getItem(applicationStorageKey("profileId")),
    '"new-profile"',
  );
  assert.equal(
    store.getItem("__mons_link_session_logout__:new-generation"),
    "1",
  );
  assert.equal(store.getItem("profileId"), null);
});

test("automatic reload is limited to once per app epoch and disabled if the marker cannot persist", () => {
  const store = memoryStorage();
  let reloads = 0;
  assert.equal(
    requestApplicationReloadOnce(store, () => reloads++),
    true,
  );
  assert.equal(
    requestApplicationReloadOnce(store, () => reloads++),
    false,
  );
  assert.equal(reloads, 1);
  assert.equal(
    requestApplicationReloadOnce(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("denied");
        },
      },
      () => reloads++,
    ),
    false,
  );
  assert.equal(reloads, 1);
});

test("first-party transport adds the epoch, retains authentication, and rejects provider origins", async () => {
  const gate = new ApplicationDataGate();
  let calls = 0;
  /** @type {typeof fetch} */
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.mons.link/test");
    const headers = new Headers(required(init).headers);
    assert.equal(
      headers.get(APPLICATION_DATA_HEADER),
      String(APPLICATION_DATA_EPOCH),
    );
    assert.equal(headers.get("Authorization"), "Bearer token");
    assert.equal(headers.get("Content-Type"), "application/json");
    return json({ ok: true });
  };
  const response = await fetchApplicationData(
    "https://api.mons.link/test",
    {
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    },
    fetcher,
    gate,
  );
  assert.deepEqual(await response.json(), { ok: true });
  await assert.rejects(
    fetchApplicationData("https://api.ensideas.com/test", {}, fetcher, gate),
    /invalid-application-api-origin/,
  );
  assert.equal(calls, 1);
});

test("explicit cutover headers stop new and already-running responses without treating ordinary failures as maintenance", async () => {
  const gate = new ApplicationDataGate();
  /** @type {Array<import("../src/session/applicationDataLifecycle.ts").ApplicationBlockReason>} */
  const notifications = [];
  const unsubscribe = gate.subscribe((reason) => notifications.push(reason));
  const ordinary = await fetchApplicationData(
    "https://api.mons.link/test",
    {},
    async () => json({ error: "busy" }, { status: 503 }),
    gate,
  );
  assert.equal(ordinary.status, 503);
  assert.equal(gate.blocked, false);
  /** @type {((response: Response) => void) | undefined} */
  let finish;
  const pending = fetchApplicationData(
    "https://api.mons.link/test",
    {},
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    gate,
  );
  await assert.rejects(
    fetchApplicationData(
      "https://api.mons.link/test",
      {},
      async () =>
        json(
          { error: "maintenance" },
          {
            status: 503,
            headers: { [APPLICATION_DATA_STATUS_HEADER]: "maintenance" },
          },
        ),
      gate,
    ),
    { code: "maintenance" },
  );
  required(finish)(json({ ok: true }));
  await assert.rejects(pending, { code: "maintenance" });
  await assert.rejects(
    fetchApplicationData(
      "https://api.mons.link/test",
      {},
      () => {
        throw new Error("must not fetch");
      },
      gate,
    ),
    { code: "maintenance" },
  );
  assert.deepEqual(notifications, ["maintenance"]);
  unsubscribe();
});

test("socket epoch is appended once without changing channel or authentication order", () => {
  const protocols = ["channel-v1", "bearer.token"];
  assert.deepEqual(applicationSocketProtocols(protocols), [
    ...protocols,
    APPLICATION_DATA_SOCKET_PROTOCOL,
  ]);
  assert.deepEqual(
    applicationSocketProtocols([
      ...protocols,
      APPLICATION_DATA_SOCKET_PROTOCOL,
    ]),
    [...protocols, APPLICATION_DATA_SOCKET_PROTOCOL],
  );
  assert.deepEqual(protocols, ["channel-v1", "bearer.token"]);
});

test("cutover closes active channels and prevents channels created after the gate closes", async () => {
  const { SnapshotChannel } =
    await import("../src/connection/snapshotChannel.ts");
  const { InviteReactionChannel } =
    await import("../src/connection/inviteReactionChannel.ts");
  /** @typedef {import("../src/connection/snapshotChannel.ts").SnapshotChannelDependencies<Record<string, never>, {snapshot: Record<string, never>}>} SnapshotDependencies */
  /** @typedef {ReturnType<SnapshotDependencies["createSocket"]> & {protocols: string[] | undefined; closed: boolean}} TestSocket */
  /** @type {Map<ReturnType<typeof createTimerHandle>, {callback: () => void; delay: number}>} */
  const timers = new Map();
  /** @type {TestSocket[]} */
  const sockets = [];
  /** @type {Pick<SnapshotDependencies, "createSocket" | "isActive" | "isOnline" | "addWakeListener" | "setTimer" | "clearTimer" | "random" | "now" | "onError">} */
  const common = {
    createSocket: (_url, protocols) => {
      /** @type {TestSocket} */
      const socket = {
        protocols,
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        closed: false,
        close() {
          this.closed = true;
        },
        send() {},
      };
      sockets.push(socket);
      return socket;
    },
    isActive: () => true,
    isOnline: () => true,
    addWakeListener: () => () => {},
    setTimer: (callback, delay) => {
      const id = createTimerHandle();
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    random: () => 0,
    now: () => 0,
    onError: () => {},
  };
  /** @type {SnapshotDependencies} */
  const snapshotDependencies = {
    ...common,
    socketUrl: "wss://api.mons.link/invites/invite/metadata/socket",
    socketProtocol: "mons-invite-metadata-v1",
    maxMessageBytes: 4_096,
    refreshMs: 30_000,
    isVisible: () => true,
    readSnapshot: async () => ({ snapshot: {} }),
    parseMessage: () => null,
    retryAfterMs: () => 0,
    readError: (error) => error,
    channelError: () => new Error("channel"),
    onSnapshot: () => {},
    initialSnapshotAccepted: true,
  };
  const reactionDependencies = {
    ...common,
    inviteId: "invite",
    matchId: "invite",
    canConnect: () => true,
    onInitialSnapshot: () => {},
    onReaction: () => {},
  };
  const snapshot = new SnapshotChannel(snapshotDependencies);
  const reactions = new InviteReactionChannel(reactionDependencies);
  for (const [id, timer] of [...timers]) {
    if (timer.delay === 0) {
      timers.delete(id);
      timer.callback();
    }
  }
  assert.equal(sockets.length, 2);
  assert.ok(
    sockets.every((socket) =>
      required(socket.protocols).includes(APPLICATION_DATA_SOCKET_PROTOCOL),
    ),
  );
  applicationDataGate.block("maintenance");
  assert.equal(snapshot.signal.aborted, true);
  assert.equal(reactions.signal.aborted, true);
  assert.ok(sockets.every((socket) => socket.closed));
  assert.equal(timers.size, 0);
  assert.equal(new SnapshotChannel(snapshotDependencies).signal.aborted, true);
  assert.equal(
    new InviteReactionChannel(reactionDependencies).signal.aborted,
    true,
  );
  assert.equal(sockets.length, 2);
  assert.equal(timers.size, 0);
});

test("maintenance from another epoch blocks startup without resetting data or requesting an update", async () => {
  for (const dataEpoch of [0, APPLICATION_DATA_EPOCH + 1]) {
    const release = {
      state: "maintenance",
      dataEpoch,
      generation: 2,
      retryAfterSeconds: 60,
    };
    await assert.rejects(
      readApplicationRelease(async () => json(release)),
      { code: "maintenance" },
    );
    /** @type {Array<"logout" | "reset" | "app" | import("../src/session/applicationDataLifecycle.ts").ApplicationBlockReason>} */
    const calls = [];
    await startApplicationData({
      gate: new ApplicationDataGate(),
      readRelease: () => readApplicationRelease(async () => json(release)),
      enforcePendingLogout: async () => {
        calls.push("logout");
      },
      resetStorage: () => calls.push("reset"),
      start: async () => {
        calls.push("app");
      },
      onBlocked: (reason) => calls.push(reason),
    });
    assert.deepEqual(calls, ["maintenance"]);
  }
});

test("cross-epoch maintenance retains strict release validation", async () => {
  const maintenance = {
    state: "maintenance",
    dataEpoch: 0,
    generation: 2,
    retryAfterSeconds: 60,
  };
  for (const release of [
    { ...maintenance, generation: 0 },
    { ...maintenance, generation: "2" },
    { ...maintenance, retryAfterSeconds: 0 },
    { ...maintenance, retryAfterSeconds: 61 },
    { ...maintenance, retryAfterSeconds: "60" },
    { ...maintenance, extra: true },
    { state: "maintenance", dataEpoch: 0, generation: 2 },
  ])
    await assert.rejects(
      readApplicationRelease(async () => json(release)),
      { code: "unavailable" },
    );
});
