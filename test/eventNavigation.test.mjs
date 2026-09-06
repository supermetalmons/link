import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const harnesses = new Map();
const harnessKey = Symbol.for("mons.eventNavigation.testHarnesses");
globalThis[harnessKey] = harnesses;
let nextHarnessId = 0;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL && new URL(context.parentURL);
    if (
      parent?.pathname.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      specifier += ".ts";
    }
    const result = nextResolve(specifier, context);
    const scenario = parent?.searchParams.get("eventNavigationTest");
    if (
      scenario &&
      result.url.startsWith("file:") &&
      result.url.includes("/src/")
    ) {
      const resolved = new URL(result.url);
      resolved.searchParams.set("eventNavigationTest", scenario);
      return { ...result, url: resolved.href };
    }
    return result;
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url);
    const scenario = parsed.searchParams.get("eventNavigationTest");
    if (!scenario) {
      return nextLoad(url, context);
    }
    const harness = `const harness = globalThis[Symbol.for("mons.eventNavigation.testHarnesses")].get(${JSON.stringify(scenario)});`;
    let source;
    if (parsed.pathname.endsWith("/lifecycle/lifecycleManager.ts")) {
      source = `${harness}
        export const teardownMatchScope = (target) => harness.teardowns.push(target);
        export const teardownProfileScope = () => { harness.profileTeardowns += 1; };`;
    } else if (parsed.pathname.endsWith("/game/gameController.ts")) {
      source = `${harness}
        export const go = async (target) => {
          harness.bootstraps.push({ ...target });
          await harness.onBootstrap?.(target);
        };`;
    } else if (parsed.pathname.endsWith("/game/mainGameLoadState.ts")) {
      source = `${harness}
        export const markMainGameLoaded = () => { harness.loaded += 1; };`;
    }
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});

const until = async (condition, message) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
};

const createHarness = async (t, initialPath, onBootstrap) => {
  t.mock.method(console, "log", () => {});
  const id = String(++nextHarnessId);
  const h = {
    bootstraps: [],
    teardowns: [],
    profileTeardowns: 0,
    loaded: 0,
    pushes: 0,
    replaces: 0,
    onBootstrap,
  };
  harnesses.set(id, h);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const listeners = new Map();
  const entries = [new URL(initialPath, "https://mons.link").href];
  let index = 0;
  const location = new URL(entries[index]);
  const board = {};
  const moveInHistory = (offset) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= entries.length) {
      return;
    }
    index = nextIndex;
    location.href = entries[index];
    for (const listener of listeners.get("popstate") ?? []) {
      listener({ type: "popstate" });
    }
  };
  const history = {
    pushState(_state, _unused, path) {
      h.pushes += 1;
      entries.splice(index + 1);
      entries.push(new URL(path, location).href);
      index = entries.length - 1;
      location.href = entries[index];
    },
    replaceState(_state, _unused, path) {
      h.replaces += 1;
      entries[index] = new URL(path, location).href;
      location.href = entries[index];
    },
    back: () => moveInHistory(-1),
    forward: () => moveInHistory(1),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location,
      history,
      setTimeout,
      addEventListener(type, listener) {
        if (!listeners.has(type)) {
          listeners.set(type, new Set());
        }
        listeners.get(type).add(listener);
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: (elementId) => (elementId === "monsboard" ? board : null),
    },
  });
  t.after(() => {
    for (const [key, descriptor] of [
      ["window", originalWindow],
      ["document", originalDocument],
    ]) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
    harnesses.delete(id);
  });
  const load = (path) => import(`${path}?eventNavigationTest=${id}`);
  const [manager, modal, routes, navigation, sessions] = await Promise.all([
    load("../src/session/AppSessionManager.ts"),
    load("../src/ui/event/modalState.ts"),
    load("../src/navigation/routeState.ts"),
    load("../src/navigation/appNavigation.ts"),
    load("../src/game/matchSession.ts"),
  ]);
  Object.assign(h, {
    manager,
    modal,
    routes,
    navigation,
    sessions,
    location,
    history,
    board,
    settled: () =>
      until(
        () => !manager.isTransitionInProgress(),
        "navigation did not settle",
      ),
    resources: () => ({
      sessionId: sessions.getCurrentSessionId(),
      epoch: sessions.getCurrentSessionEpoch(),
      bootstraps: h.bootstraps.length,
      teardowns: h.teardowns.length,
      profileTeardowns: h.profileTeardowns,
      loaded: h.loaded,
    }),
  });
  manager.initializeAppSessionManager();
  return h;
};

const assertView = (h, { mode = "invite", inviteId, eventId }) => {
  const route = h.routes.getCurrentRouteState();
  const modal = h.modal.getEventModalState();
  assert.equal(route.mode, mode);
  assert.equal(route.inviteId, inviteId ?? null);
  assert.equal(route.eventId, eventId ?? null);
  assert.equal(modal.isOpen, Boolean(eventId));
  assert.equal(modal.eventId, eventId ?? null);
};

const inviteTarget = (inviteId) => ({
  mode: "invite",
  path: inviteId,
  inviteId,
  snapshotId: null,
  eventId: null,
  autojoin: false,
});

for (const [path, expected] of [
  [
    "/ExactGameID?event=event-A",
    { inviteId: "ExactGameID", eventId: "event-A" },
  ],
  ["/ExactGameID", { inviteId: "ExactGameID" }],
  ["/event/event-A", { mode: "event", eventId: "event-A" }],
  ["/watch?event=event-A", { mode: "watch", eventId: "event-A" }],
  [
    "/snapshot/snapshot%2Fone?event=event-A",
    { mode: "snapshot", eventId: "event-A" },
  ],
]) {
  test(`restores the background and overlay directly from ${path}`, async (t) => {
    const h = await createHarness(t, path);
    await h.settled();
    assertView(h, expected);
    assert.equal(h.bootstraps.length, 1);
    assert.deepEqual(h.bootstraps[0], h.routes.getCurrentRouteState());
    assert.deepEqual(
      h.manager.getCurrentTarget(),
      h.routes.getCurrentRouteState(),
    );
    if (expected.mode === "snapshot") {
      assert.equal(h.bootstraps[0].snapshotId, "snapshot/one");
    }
    assert.equal(h.pushes, 0);
    assert.equal(h.replaces, 0);
  });
}

test("overlay navigation and browser history preserve the active game session", async (t) => {
  const h = await createHarness(t, "/ExactGameID?source=shared#round-2");
  await h.settled();
  const baseline = h.resources();
  const assertPreserved = () => {
    assert.deepEqual(h.resources(), baseline);
    assert.equal(document.getElementById("monsboard"), h.board);
    assert.equal(h.location.searchParams.get("source"), "shared");
    assert.equal(h.location.hash, "#round-2");
  };

  h.modal.openEventModal("event-A");
  assertView(h, { inviteId: "ExactGameID", eventId: "event-A" });
  await h.settled();
  assert.equal(h.pushes, 1);
  h.modal.openEventModal("event-A");
  assert.equal(h.pushes, 1);
  h.modal.openEventModal("event-B");
  assertView(h, { inviteId: "ExactGameID", eventId: "event-B" });
  await h.settled();
  assert.equal(h.pushes, 2);
  await h.modal.closeEventModal();
  assertView(h, { inviteId: "ExactGameID" });
  await h.settled();
  assert.equal(h.modal.getEventModalState().lastCloseReason, "dismiss");
  assert.equal(h.pushes, 3);
  await h.modal.closeEventModal();
  assert.equal(h.pushes, 3);
  assertPreserved();

  for (const eventId of ["event-B", "event-A", null]) {
    h.history.back();
    assertView(h, { inviteId: "ExactGameID", eventId });
    await h.settled();
    assertPreserved();
  }
  for (const eventId of ["event-A", "event-B", null]) {
    h.history.forward();
    assertView(h, { inviteId: "ExactGameID", eventId });
    await h.settled();
    assertPreserved();
  }
  assert.equal(h.pushes, 3);
  assert.equal(h.replaces, 0);
});

test("legacy lobby overlays open and dismiss without resetting the lobby", async (t) => {
  const h = await createHarness(t, "/event/event-A?source=shared#bracket");
  await h.settled();
  const baseline = h.resources();
  await h.modal.closeEventModal();
  await h.settled();
  assertView(h, { mode: "home" });
  assert.equal(h.location.pathname, "/");
  assert.equal(h.location.searchParams.get("source"), "shared");
  assert.equal(h.location.hash, "#bracket");
  h.history.back();
  await h.settled();
  assertView(h, { mode: "event", eventId: "event-A" });
  h.modal.openEventModal("event-B");
  await h.settled();
  assert.equal(h.location.pathname, "/event/event-B");
  assert.deepEqual(h.resources(), baseline);
});

for (const [path, expected] of [
  [
    "/match/?event=A&source=hello%20world#x",
    { inviteId: "match", eventId: "A" },
  ],
  ["/?event=A", { mode: "home", eventId: "A" }],
]) {
  test(`reopening the current overlay preserves the shared URL ${path}`, async (t) => {
    const h = await createHarness(t, path);
    await h.settled();
    const baseline = h.resources();
    const originalUrl = h.location.href;
    const originalState = h.modal.getEventModalState();
    const changes = [];
    const unsubscribe = h.modal.subscribeToEventModalState((state) =>
      changes.push(state),
    );
    t.after(unsubscribe);

    h.modal.openEventModal("A");
    h.modal.openEventModal(" A ");
    await h.settled();

    assertView(h, expected);
    assert.equal(h.location.href, originalUrl);
    assert.equal(h.pushes, 0);
    assert.equal(h.replaces, 0);
    assert.equal(h.modal.getEventModalState(), originalState);
    assert.deepEqual(changes, [originalState]);
    assert.deepEqual(h.resources(), baseline);
  });
}

test("dismissal and pending creation preserve an overlay-free shared URL exactly", async (t) => {
  const h = await createHarness(t, "/match/?source=hello%20world#x");
  await h.settled();
  const baseline = h.resources();
  const originalUrl = h.location.href;
  const assertUnchangedNavigation = () => {
    assert.equal(h.location.href, originalUrl);
    assert.equal(h.pushes, 0);
    assert.equal(h.replaces, 0);
    assert.deepEqual(h.resources(), baseline);
  };

  await h.modal.closeEventModal();
  await h.modal.closeEventModal();
  assertView(h, { inviteId: "match" });
  assertUnchangedNavigation();

  h.modal.openEventModalPendingCreate();
  assert.equal(h.modal.getEventModalState().isOpen, true);
  assert.equal(h.modal.getEventModalState().isPendingCreate, true);
  assert.equal(h.modal.getEventModalState().eventId, null);
  assertUnchangedNavigation();

  await h.modal.closeEventModal();
  await h.settled();
  assertView(h, { inviteId: "match" });
  assert.equal(h.modal.getEventModalState().lastCloseReason, "dismiss");
  assertUnchangedNavigation();
});

test("event creation stays transient until an event ID is available", async (t) => {
  const h = await createHarness(t, "/ExactGameID");
  await h.settled();
  const baseline = h.resources();
  h.modal.openEventModalPendingCreate();
  assert.equal(h.modal.getEventModalState().isPendingCreate, true);
  assert.equal(h.location.href, "https://mons.link/ExactGameID");
  assert.equal(h.pushes, 0);
  h.modal.setEventModalPendingCreateError("Creation failed");
  assert.equal(
    h.modal.getEventModalState().pendingCreateError,
    "Creation failed",
  );
  h.modal.openEventModal("created-event");
  await h.settled();
  assertView(h, { inviteId: "ExactGameID", eventId: "created-event" });
  assert.equal(h.modal.getEventModalState().isPendingCreate, false);
  assert.equal(h.modal.getEventModalState().pendingCreateError, null);
  assert.equal(h.pushes, 1);
  assert.deepEqual(h.resources(), baseline);
});

test("launching the same game only closes its overlay and a different game transitions once", async (t) => {
  const h = await createHarness(t, "/ExactGameID?event=event-A");
  await h.settled();
  const baseline = h.resources();
  const closeReasons = [];
  const unsubscribe = h.modal.subscribeToEventModalState((state) => {
    if (!state.isOpen) {
      closeReasons.push(state.lastCloseReason);
    }
  });
  t.after(unsubscribe);

  h.modal.prepareEventModalGameLaunch("ExactGameID");
  await h.manager.transition(inviteTarget("ExactGameID"));
  assertView(h, { inviteId: "ExactGameID" });
  assert.deepEqual(closeReasons, ["launch_game"]);
  assert.equal(h.pushes, 1);
  assert.deepEqual(h.resources(), baseline);

  h.modal.openEventModal("event-A");
  await h.settled();
  const pushesBeforeLaunch = h.pushes;
  h.modal.prepareEventModalGameLaunch("DifferentGameID");
  await h.manager.transition(inviteTarget("DifferentGameID"));
  assertView(h, { inviteId: "DifferentGameID" });
  assert.deepEqual(closeReasons, ["launch_game", "launch_game"]);
  assert.equal(h.pushes, pushesBeforeLaunch + 1);
  assert.equal(h.bootstraps.length, baseline.bootstraps + 1);
  assert.equal(h.teardowns.length, baseline.teardowns + 1);
  assert.equal(h.bootstraps.at(-1).inviteId, "DifferentGameID");
  assert.equal(h.bootstraps.at(-1).eventId, null);
});

test("rapid overlay changes during initial loading keep the latest history state", async (t) => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const h = await createHarness(
    t,
    "/ExactGameID?event=event-A",
    () => gate.promise,
  );
  await until(
    () => h.bootstraps.length === 1,
    "initial game did not start loading",
  );
  assertView(h, { inviteId: "ExactGameID", eventId: "event-A" });
  const sessionId = h.sessions.getCurrentSessionId();
  const epoch = h.sessions.getCurrentSessionEpoch();

  h.modal.openEventModal("event-B");
  await h.modal.closeEventModal();
  h.history.back();
  assertView(h, { inviteId: "ExactGameID", eventId: "event-B" });
  h.history.forward();
  assertView(h, { inviteId: "ExactGameID" });
  gate.resolve();
  await h.settled();
  assertView(h, { inviteId: "ExactGameID" });
  assert.deepEqual(
    h.manager.getCurrentTarget(),
    h.routes.getCurrentRouteState(),
  );
  assert.equal(h.bootstraps.length, 1);
  assert.equal(h.teardowns.length, 1);
  assert.equal(h.sessions.getCurrentSessionId(), sessionId);
  assert.equal(h.sessions.getCurrentSessionEpoch(), epoch);
  assert.equal(h.pushes, 2);
});

test("a forced same-game refresh cannot restore a dismissed or switched overlay", async (t) => {
  const h = await createHarness(t, "/ExactGameID?event=event-A");
  await h.settled();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  h.onBootstrap = () => gate.promise;
  const refreshing = h.manager.transition(h.routes.getCurrentRouteState(), {
    force: true,
    skipNavigation: true,
  });
  await until(
    () => h.bootstraps.length === 2,
    "same-game refresh did not start",
  );
  const sessionId = h.sessions.getCurrentSessionId();
  const epoch = h.sessions.getCurrentSessionEpoch();
  h.modal.openEventModal("event-B");
  await h.modal.closeEventModal();
  h.history.back();
  assertView(h, { inviteId: "ExactGameID", eventId: "event-B" });
  gate.resolve();
  await refreshing;
  await h.settled();
  assertView(h, { inviteId: "ExactGameID", eventId: "event-B" });
  assert.deepEqual(
    h.manager.getCurrentTarget(),
    h.routes.getCurrentRouteState(),
  );
  assert.equal(h.bootstraps.length, 2);
  assert.equal(h.teardowns.length, 2);
  assert.equal(h.sessions.getCurrentSessionId(), sessionId);
  assert.equal(h.sessions.getCurrentSessionEpoch(), epoch);
  assert.equal(h.pushes, 2);
});

test("queued game navigation uses the latest overlay without extra game bootstraps", async (t) => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const h = await createHarness(
    t,
    "/FirstGameID?event=event-A",
    () => gate.promise,
  );
  await until(
    () => h.bootstraps.length === 1,
    "initial game did not start loading",
  );
  h.navigation.pushRoutePath("/SecondGameID?event=event-B");
  h.modal.openEventModal("event-C");
  await h.modal.closeEventModal();
  assertView(h, { inviteId: "SecondGameID" });
  gate.resolve();
  await h.settled();
  assertView(h, { inviteId: "SecondGameID" });
  assert.deepEqual(
    h.manager.getCurrentTarget(),
    h.routes.getCurrentRouteState(),
  );
  assert.deepEqual(
    h.bootstraps.map(({ inviteId }) => inviteId),
    ["FirstGameID", "SecondGameID"],
  );
  assert.equal(h.bootstraps.at(-1).eventId, null);
  assert.equal(h.teardowns.length, 2);
  assert.equal(h.pushes, 3);
});
