import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isAutoInviteId } from "../cloud/runtime/shared/ids.js";
import { createEventPrizeSelectionCoordinator } from "../src/ui/event/prizeSelectionCoordinator.ts";

const readSource = (path) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

const connectionSource = readSource("../src/connection/connection.ts");
const connectionClass = connectionSource.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
assert.ok(connectionClass);
const modalSource = readSource("../src/ui/event/EventModalView.tsx");

function evaluate(source, result, dependencies) {
  const { outputText } = ts.transpileModule(
    source.replaceAll("import.meta.env.DEV", "false"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  return new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn ${result};`,
  )(...Object.values(dependencies));
}

function createConnection(methodNames, dependencies) {
  const methods = methodNames.map((name) => {
    const method = connectionClass.members.find(
      (node) => node.name?.getText() === name,
    );
    assert.ok(method, `missing Connection method ${name}`);
    return method.getText();
  });
  const Connection = evaluate(
    `class Connection { ${methods.join("\n")} }`,
    "Connection",
    dependencies,
  );
  return new Connection();
}

function createModalAction(name, dependencies) {
  let callback;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name) {
      assert.ok(ts.isCallExpression(node.initializer));
      callback = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(modalSource);
  assert.ok(callback, `missing modal action ${name}`);
  return evaluate(
    `const action = ${callback.getText()};`,
    "action",
    dependencies,
  );
}

function createModalEffect(marker, dependencies) {
  let callback;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "useEffect" &&
      node.arguments[0].getText().includes(marker)
    ) {
      assert.equal(callback, undefined, `ambiguous modal effect ${marker}`);
      callback = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(modalSource);
  assert.ok(callback, `missing modal effect ${marker}`);
  return evaluate(
    `const effect = ${callback.getText()};`,
    "effect",
    dependencies,
  );
}

function evaluateModalValue(name, dependencies) {
  let initializer;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(modalSource);
  assert.ok(initializer, `missing modal value ${name}`);
  return evaluate(
    `const value = ${initializer.getText()};`,
    "value",
    dependencies,
  );
}

test("canonical profile ID resolution authenticates and discards stale auth replies", async () => {
  const calls = [];
  let authenticated = false;
  let currentUser = true;
  let resolve;
  const response = new Promise((yes) => (resolve = yes));
  const tokenProvider = Object.assign(async () => "session-token", {
    assertCurrentUser: () => {
      if (!currentUser) throw new Error("authentication-changed");
    },
  });
  const instance = createConnection(["resolveProfileId"], {
    resolveProfileIdViaApi: (id, provider) => {
      assert.equal(authenticated, true);
      assert.equal(provider, tokenProvider);
      calls.push(id);
      return response;
    },
  });
  Object.assign(instance, {
    ensureAuthenticated: async () => (authenticated = true),
    getUserBoundAuthTokenProvider: () => tokenProvider,
  });
  assert.equal(await instance.resolveProfileId("  "), null);
  assert.equal(authenticated, false);
  const pending = instance.resolveProfileId(" retired-profile ");
  await Promise.resolve();
  assert.deepEqual(calls, ["retired-profile"]);
  currentUser = false;
  resolve("canonical-profile");
  await assert.rejects(pending, /authentication-changed/);
});

function eventProfileIdsHarness() {
  const stateSource = readSource("../src/ui/event/eventState.ts");
  const hookSource = readSource("../src/ui/event/useEventProfileIds.ts");
  const declarations = stateSource.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const helpers = ["getEventParticipant", "getEventProfileIdsToResolve"].map(
    (name) =>
      `const ${declarations.find((node) => node.name.getText() === name).getText()};`,
  );
  const hook = hookSource.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText().replace(/^export /, ""))
    .join("\n");
  const states = [];
  const memos = [];
  const effects = [];
  const timers = new Map();
  let stateIndex = 0;
  let memoIndex = 0;
  let effectIndex = 0;
  let clock = 0;
  let nextTimerId = 0;
  const changed = (previous, next) =>
    !previous || next.some((value, index) => value !== previous[index]);
  const setTimeout = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, at: clock + delay });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const calls = [];
  const { useEventProfileIds, getEventParticipant } = evaluate(
    [...helpers, hook].join("\n"),
    "({ useEventProfileIds, getEventParticipant })",
    {
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) {
          states[index] = typeof initial === "function" ? initial() : initial;
        }
        return [
          states[index],
          (value) => {
            states[index] =
              typeof value === "function" ? value(states[index]) : value;
          },
        ];
      },
      useMemo: (factory, dependencies) => {
        const index = memoIndex++;
        if (changed(memos[index]?.dependencies, dependencies)) {
          memos[index] = { dependencies, value: factory() };
        }
        return memos[index].value;
      },
      useEffect: (effect, nextDependencies) => {
        const index = effectIndex++;
        if (changed(effects[index]?.dependencies, nextDependencies)) {
          effects[index] = {
            ...effects[index],
            dependencies: nextDependencies,
            scheduled: effect,
          };
        }
      },
      setTimeout,
      clearTimeout,
      window: { setTimeout, clearTimeout },
      connection: {
        resolveProfileId: (id) =>
          new Promise((resolve, reject) => {
            calls.push({ id, resolve, reject });
          }),
      },
    },
  );
  return {
    calls,
    timers,
    getEventParticipant,
    render: (...args) => {
      stateIndex = 0;
      memoIndex = 0;
      effectIndex = 0;
      const value = useEventProfileIds(...args);
      for (const effect of effects) {
        if (effect.scheduled) {
          effect.cleanup?.();
          effect.cleanup = effect.scheduled();
          effect.scheduled = undefined;
        }
      }
      return value;
    },
    advance: (ms) => {
      clock += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    unmount: () => {
      for (const effect of effects) effect.cleanup?.();
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

const mergedEvent = () => ({
  eventId: "event-1",
  createdByProfileId: "creator-profile",
  participants: {
    "retired-profile": {
      profileId: "retired-profile",
      loginUid: "original-login",
    },
  },
});

test("canonical membership survives creator lookup failures and unchanged event polling", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = { eventId: event.eventId, isOpen: true };
  const render = (value = event) =>
    h.render(value, "canonical-profile", "alternate-login", modal);
  assert.equal(render().pending, true);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    ["creator-profile", "retired-profile"],
  );
  h.calls[0].reject(new Error("Temporary lookup failure"));
  h.calls[1].resolve("canonical-profile");
  await h.settle();
  const resolved = render({ ...structuredClone(event), updatedAtMs: 2 });
  assert.equal(resolved.pending, true);
  assert.equal(resolved.profileIds["retired-profile"], "canonical-profile");
  assert.equal(h.calls.length, 2);
  assert.equal(
    render({ ...structuredClone(event), updatedAtMs: 3 }).pending,
    true,
  );
  assert.equal(h.calls.length, 2);
  h.advance(2000);
  assert.equal(render().pending, true);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    ["creator-profile", "retired-profile", "creator-profile"],
  );
  h.calls[2].resolve("creator-profile");
  await h.settle();
  assert.equal(render().pending, false);
  assert.equal(h.timers.size, 0);
});

test("canonical membership recovers after a transient lookup failure", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = { eventId: event.eventId, isOpen: true };
  const render = () =>
    h.render(event, "canonical-profile", "alternate-login", modal);
  render();
  h.calls[0].resolve("creator-profile");
  h.calls[1].reject(new Error("Temporary lookup failure"));
  await h.settle();
  const incomplete = render();
  assert.equal(incomplete.pending, true);
  assert.equal(Object.hasOwn(incomplete.profileIds, "retired-profile"), false);
  assert.equal(
    h.getEventParticipant(
      event,
      "canonical-profile",
      "alternate-login",
      incomplete.profileIds,
    ),
    null,
  );
  h.advance(1999);
  assert.equal(h.calls.length, 2);
  h.advance(1);
  assert.equal(render().pending, true);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    ["creator-profile", "retired-profile", "retired-profile"],
  );
  h.calls[2].resolve("canonical-profile");
  await h.settle();
  const resolved = render();
  assert.equal(resolved.pending, false);
  assert.equal(
    h.getEventParticipant(
      event,
      "canonical-profile",
      "alternate-login",
      resolved.profileIds,
    ),
    event.participants["retired-profile"],
  );
  assert.equal(h.timers.size, 0);
});

test("unchanged creator lookups survive unrelated joins in flight and after resolution", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = { eventId: event.eventId, isOpen: true };
  const render = (value) =>
    h.render(value, "retired-profile", "original-login", modal);
  assert.equal(render(event).pending, true);
  const joined = {
    ...event,
    participants: {
      ...event.participants,
      "unrelated-profile": {
        profileId: "unrelated-profile",
        loginUid: "unrelated-login",
      },
    },
  };
  assert.equal(render(joined).pending, true);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    ["creator-profile"],
  );
  h.calls[0].resolve("creator-profile");
  await h.settle();
  assert.deepEqual(render(joined), {
    pending: false,
    profileIds: { "creator-profile": "creator-profile" },
  });
  assert.equal(render(event).pending, false);
  assert.equal(h.calls.length, 1);
});

test("resolved merged membership stays available while a new participant lookup is pending", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = { eventId: event.eventId, isOpen: true };
  const render = (value) =>
    h.render(value, "canonical-profile", "alternate-login", modal);
  render(event);
  h.calls[0].resolve("creator-profile");
  h.calls[1].resolve("canonical-profile");
  await h.settle();
  assert.equal(render(event).pending, false);
  const joined = {
    ...event,
    participants: {
      ...event.participants,
      "unrelated-profile": {
        profileId: "unrelated-profile",
        loginUid: "unrelated-login",
      },
    },
  };
  const current = render(joined);
  assert.equal(current.pending, false);
  assert.equal(current.profileIds["retired-profile"], "canonical-profile");
  assert.deepEqual(
    h.calls.map((call) => call.id),
    ["creator-profile", "retired-profile", "unrelated-profile"],
  );
});

test("canonical membership resolves independently of slow or failed unrelated lookups", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  event.participants["slow-profile"] = {
    profileId: "slow-profile",
    loginUid: "slow-login",
  };
  const modal = { eventId: event.eventId, isOpen: true };
  const render = (value = event) =>
    h.render(value, "canonical-profile", "alternate-login", modal);
  render();
  h.calls[0].resolve("creator-profile");
  await h.settle();
  assert.deepEqual(render(), {
    pending: true,
    profileIds: { "creator-profile": "creator-profile" },
  });
  h.calls[1].resolve("canonical-profile");
  await h.settle();
  assert.equal(render().pending, false);
  let currentEvent = event;
  for (const id of ["new-profile-1", "new-profile-2"]) {
    currentEvent = {
      ...currentEvent,
      participants: {
        ...currentEvent.participants,
        [id]: { profileId: id, loginUid: `${id}-login` },
      },
    };
    const current = render(currentEvent);
    assert.equal(current.pending, false);
    assert.equal(
      h.getEventParticipant(
        currentEvent,
        "canonical-profile",
        "alternate-login",
        current.profileIds,
      ),
      event.participants["retired-profile"],
    );
  }
  assert.deepEqual(
    h.calls.map((call) => call.id),
    [
      "creator-profile",
      "retired-profile",
      "slow-profile",
      "new-profile-1",
      "new-profile-2",
    ],
  );
  h.calls[3].reject(new Error("Temporary unrelated lookup failure"));
  await h.settle();
  assert.equal(render(currentEvent).pending, false);
  h.advance(2000);
  assert.equal(render(currentEvent).pending, false);
  assert.equal(h.calls.length, 6);
  assert.equal(h.calls[5].id, "new-profile-1");
  h.unmount();
});

test("nonmembers wait for every canonical participant lookup", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = { eventId: event.eventId, isOpen: true };
  const render = () =>
    h.render(event, "nonparticipant-profile", "nonparticipant-login", modal);
  render();
  h.calls[0].resolve("creator-profile");
  await h.settle();
  assert.equal(render().pending, true);
  h.calls[1].resolve(null);
  await h.settle();
  const current = render();
  assert.equal(current.pending, false);
  assert.equal(current.profileIds["retired-profile"], "");
  assert.equal(h.timers.size, 0);
});

test("canonical profile lookup discards replies after auth or modal changes", async () => {
  for (const changed of ["profile", "login", "modal"]) {
    const h = eventProfileIdsHarness();
    const event = mergedEvent();
    const modal = { eventId: event.eventId, isOpen: true };
    h.render(event, "canonical-profile", "alternate-login", modal);
    const nextModal = changed === "modal" ? { ...modal } : modal;
    const nextProfile =
      changed === "profile" ? "other-profile" : "canonical-profile";
    const nextLogin = changed === "login" ? "other-login" : "alternate-login";
    const render = () => h.render(event, nextProfile, nextLogin, nextModal);
    assert.equal(render().pending, true);
    h.calls[0].resolve("creator-profile");
    h.calls[1].resolve("canonical-profile");
    await h.settle();
    assert.deepEqual(render(), { profileIds: {}, pending: true });
    for (const call of h.calls.slice(2)) call.resolve(call.id);
    await h.settle();
    const current = render();
    assert.equal(current.pending, false);
    assert.notEqual(current.profileIds["retired-profile"], "canonical-profile");
  }
});

test("removed participants cannot reappear through stale lookup replies", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = { eventId: event.eventId, isOpen: true };
  h.render(event, "canonical-profile", "alternate-login", modal);
  const updated = { ...event, participants: {} };
  const render = () =>
    h.render(updated, "canonical-profile", "alternate-login", modal);
  render();
  h.calls[0].resolve("creator-profile");
  h.calls[1].resolve("canonical-profile");
  await h.settle();
  const current = render();
  assert.equal(current.pending, false);
  assert.equal(Object.hasOwn(current.profileIds, "retired-profile"), false);
  assert.equal(h.calls.length, 2);
});

test("canonical lookup retries stop after auth changes, modal closure, or unmount", async () => {
  for (const changed of ["profile", "login", "modal", "unmount"]) {
    const h = eventProfileIdsHarness();
    const event = mergedEvent();
    const modal = { eventId: event.eventId, isOpen: true };
    h.render(event, "canonical-profile", "alternate-login", modal);
    h.calls[0].resolve("creator-profile");
    h.calls[1].reject(new Error("Temporary lookup failure"));
    await h.settle();
    assert.equal(h.timers.size, 1);
    if (changed === "unmount") {
      h.unmount();
    } else {
      h.render(
        event,
        changed === "profile" ? "other-profile" : "canonical-profile",
        changed === "login" ? "other-login" : "alternate-login",
        changed === "modal" ? { ...modal, isOpen: false } : modal,
      );
    }
    assert.equal(h.timers.size, 0);
    const calls = h.calls.length;
    h.advance(2000);
    await h.settle();
    assert.equal(h.calls.length, calls);
  }
});

function leaveHarness(overrides = {}) {
  const modalState = { eventId: "event-1", isOpen: true };
  let currentModal = modalState;
  let profileId = "profile-2";
  let loginUid = "login-2";
  let nowMs = 999;
  let resolve;
  let reject;
  const response = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const calls = [];
  const alerts = [];
  const pendingStates = [];
  const activeLeaveRequestRef = { current: null };
  const action = createModalAction("handleLeaveClick", {
    modalState,
    eventRecord: { eventId: "event-1", startAtMs: 1000 },
    getEventModalState: () => currentModal,
    devStubRecord: null,
    isEventFresh: true,
    eventProfileIds: {},
    isResolvingEventProfileIds: false,
    isLoading: false,
    activeJoinRequestRef: { current: null },
    activeLeaveRequestRef,
    isPrizeSelectionPending: () => false,
    storage: {
      getProfileId: () => profileId,
      getLoginId: () => loginUid,
    },
    Date: { now: () => nowMs },
    canLeaveEvent: (event, _profileId, now) => now < event.startAtMs,
    setIsLeaving: (value) => pendingStates.push(value),
    connection: {
      leaveEvent: (eventId) => {
        calls.push(eventId);
        return response;
      },
    },
    window: { alert: (message) => alerts.push(message) },
    ...overrides,
  });
  return {
    action,
    calls,
    alerts,
    pendingStates,
    activeLeaveRequestRef,
    resolve,
    reject,
    changeModal: () => (currentModal = { ...modalState, eventId: "event-2" }),
    changeAuth: () => {
      profileId = "profile-3";
      loginUid = "login-3";
    },
    setNow: (value) => (nowMs = value),
  };
}

test("leaving is one click and suppresses duplicate pending requests", async () => {
  const h = leaveHarness();
  const pending = h.action();
  await h.action();
  assert.deepEqual(h.calls, ["event-1"]);
  assert.deepEqual(h.pendingStates, [true]);
  h.resolve({ ok: true });
  await pending;
  assert.deepEqual(h.pendingStates, [true, false]);
  assert.deepEqual(h.alerts, []);
});

test("leaving rechecks the start boundary and blocks stale or simulated events", async () => {
  for (const overrides of [
    { isEventFresh: false },
    { isLoading: true },
    { isResolvingEventProfileIds: true },
    { activeJoinRequestRef: { current: {} } },
    { isPrizeSelectionPending: () => true },
    { devStubRecord: {} },
    { eventRecord: { eventId: "old-event", startAtMs: 1000 } },
    { canLeaveEvent: () => false },
  ]) {
    const h = leaveHarness(overrides);
    await h.action();
    assert.deepEqual(h.calls, []);
  }
  const h = leaveHarness();
  h.setNow(1000);
  await h.action();
  assert.deepEqual(h.calls, []);
});

test("leaving waits for queued prize mutations and then blocks new prize actions", async () => {
  const mutations = [];
  const coordinator = createEventPrizeSelectionCoordinator({
    profileId: "profile-2",
    mutate: (prizeId) =>
      new Promise((resolve) => mutations.push({ prizeId, resolve })),
    onPendingChange: () => {},
    onSelectionsChange: () => {},
  });
  const h = leaveHarness({ isPrizeSelectionPending: coordinator.isPending });
  coordinator.toggle("1092");
  coordinator.toggle("1111");
  await h.action();
  assert.deepEqual(h.calls, []);
  mutations[0].resolve("1092");
  await Promise.resolve();
  await h.action();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(
    mutations.map(({ prizeId }) => prizeId),
    ["1092", "1111"],
  );
  mutations[1].resolve("1111");
  await Promise.resolve();
  const pending = h.action();
  assert.deepEqual(h.calls, ["event-1"]);
  const selectPrize = createModalAction("handlePrizeSelectionClick", {
    devStubRecord: null,
    eventPrizeConfig: {},
    isEventFresh: true,
    isLoading: false,
    activeJoinRequestRef: { current: null },
    activeLeaveRequestRef: h.activeLeaveRequestRef,
    isEventPrizeSelectionAvailable: () => true,
    eventRecord: {},
    currentProfileId: "profile-2",
    togglePrizeSelection: coordinator.toggle,
  });
  selectPrize("1514");
  assert.equal(mutations.length, 2);
  h.resolve({ ok: true });
  await pending;
  coordinator.dispose();
});

test("joining is blocked while leaving or saving prize selections", () => {
  for (const leaving of [true, false]) {
    const modalState = { eventId: "event-1", isOpen: true };
    const join = createModalAction("handleJoinClick", {
      modalState,
      eventRecord: { eventId: "event-1" },
      getEventModalState: () => modalState,
      activeJoinRequestRef: { current: null },
      activeLeaveRequestRef: { current: leaving ? {} : null },
      isPrizeSelectionPending: () => !leaving,
      storage: {
        getProfileId: () => assert.fail("Join must wait for active mutations."),
      },
    });
    join();
  }
});

function joinHarness(profileId = "profile-2") {
  let modalState;
  let currentModal;
  let eventRecord = null;
  let isLoading = false;
  let isJoining = false;
  let isEventFresh = false;
  let pendingJoinEventId = null;
  let pendingJoinRequestedAtMs = 0;
  let loadingCleanup;
  let pendingCleanup;
  let nextTimerId = 0;
  let onModalChange;
  const calls = [];
  const responses = [];
  const popups = [];
  const subscriptions = new Map();
  const timers = new Map();
  const activeJoinRequestRef = { current: null };
  const activeLeaveRequestRef = { current: null };
  const participantLookupModalStateRef = { current: null };
  const dependencies = () => {
    const values = {
      modalState,
      eventRecord,
      isLoading,
      isJoining,
      isEventFresh,
      isResolvingEventProfileIds: true,
      isLeaving: false,
      isUpdatingPrizeSelection: false,
      pendingJoinEventId,
      pendingJoinRequestedAtMs,
      getEventModalState: () => currentModal,
      activeJoinRequestRef,
      activeLeaveRequestRef,
      participantLookupModalStateRef,
      invalidateParticipantLookups: () => {},
      setModalState: (value) => (modalState = value),
      subscribeToEventModalState: (callback) => {
        onModalChange = callback;
        return () => {};
      },
      isPrizeSelectionPending: () => false,
      loadTimingRef: { current: null },
      storage: { getProfileId: () => profileId },
      setIsLoading: (value) => (isLoading = value),
      setIsJoining: (value) => (isJoining = value),
      setIsLeaving: () => {},
      setIsEventFresh: (value) => (isEventFresh = value),
      setEventRecord: (value) => (eventRecord = value),
      setPendingJoinEventId: (value) => (pendingJoinEventId = value),
      setPendingJoinRequestedAtMs: (value) =>
        (pendingJoinRequestedAtMs = value),
      openProfileSignInPopupForEvent: () => popups.push(modalState.eventId),
      Date: { now: () => 1000 },
      PENDING_JOIN_POLL_TIMEOUT_MS: 60_000,
      PENDING_JOIN_POLL_INTERVAL_MS: 100,
      performance: {
        now: () => 0,
        clearMarks: () => {},
        clearMeasures: () => {},
        mark: () => {},
      },
      connection: {
        subscribeToEventFreshness: (_eventId, update) => {
          update(false);
          return () => {};
        },
        subscribeToEvent: (eventId, update, fail) => {
          subscriptions.set(eventId, { update, fail });
          return () => subscriptions.delete(eventId);
        },
        joinEvent: (eventId) => {
          calls.push(eventId);
          return new Promise((resolve, reject) => {
            responses.push({ resolve, reject });
          });
        },
      },
      window: {
        setInterval: (callback) => {
          const id = ++nextTimerId;
          timers.set(id, callback);
          return id;
        },
        clearInterval: (id) => timers.delete(id),
      },
    };
    return { ...values, submitJoin: createModalAction("submitJoin", values) };
  };
  createModalEffect("subscribeToEventModalState(", dependencies())();
  return {
    calls,
    responses,
    popups,
    timers,
    open(eventId) {
      loadingCleanup?.();
      currentModal = { eventId, isOpen: true };
      onModalChange(currentModal);
      loadingCleanup = createModalEffect(
        "connection.subscribeToEvent(",
        dependencies(),
      )();
    },
    receive: (eventId) =>
      subscriptions.get(eventId).update({
        eventId,
        status: "scheduled",
        startAtMs: 2000,
      }),
    fail: (eventId) => subscriptions.get(eventId).fail(),
    render: () => ({
      eventRecord,
      isLoading,
      disabled: evaluateModalValue("isJoinPending", dependencies()),
      join: createModalAction("handleJoinClick", dependencies()),
    }),
    runPendingEffect() {
      pendingCleanup?.();
      pendingCleanup = createModalEffect(
        "PENDING_JOIN_POLL_TIMEOUT_MS",
        dependencies(),
      )();
    },
    signIn: () => (profileId = "profile-2"),
    changeCurrentModal: (next) => (currentModal = next),
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("joining remains blocked when another event fails to replace displayed content", () => {
  for (const profileId of ["profile-2", ""]) {
    const h = joinHarness(profileId);
    h.open("event-a");
    h.receive("event-a");
    assert.equal(h.render().disabled, false);
    h.open("event-b");
    h.fail("event-b");
    const view = h.render();
    assert.equal(view.eventRecord.eventId, "event-a");
    assert.equal(view.isLoading, false);
    assert.equal(view.disabled, true);
    view.join();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.popups, []);
  }
});

test("joining the displayed event stays enabled during freshness and profile refresh", () => {
  const h = joinHarness();
  h.open("event-a");
  h.receive("event-a");
  const view = h.render();
  assert.equal(view.disabled, false);
  view.join();
  assert.deepEqual(h.calls, ["event-a"]);
  assert.equal(h.render().disabled, true);
});

test("join callbacks from a previous or closed modal cannot submit", () => {
  for (const nextModal of [
    { eventId: "event-b", isOpen: true },
    { eventId: "event-a", isOpen: false },
  ]) {
    const h = joinHarness();
    h.open("event-a");
    h.receive("event-a");
    const { join } = h.render();
    h.changeCurrentModal(nextModal);
    join();
    assert.deepEqual(h.calls, []);
  }
});

test("joining after sign-in waits for matching event content", () => {
  const h = joinHarness("");
  h.open("event-a");
  h.receive("event-a");
  h.render().join();
  assert.deepEqual(h.popups, ["event-a"]);
  h.open("event-b");
  h.receive("event-b");
  h.open("event-a");
  h.fail("event-a");
  h.signIn();
  h.runPendingEffect();
  assert.equal(h.render().eventRecord.eventId, "event-b");
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls, []);
  h.receive("event-a");
  h.runPendingEffect();
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0]();
  assert.deepEqual(h.calls, ["event-a"]);
});

test("a pending sign-in join cannot submit after the modal changes", () => {
  const h = joinHarness("");
  h.open("event-a");
  h.receive("event-a");
  h.render().join();
  h.runPendingEffect();
  assert.equal(h.timers.size, 1);
  h.changeCurrentModal({ eventId: "event-b", isOpen: true });
  h.signIn();
  [...h.timers.values()][0]();
  assert.deepEqual(h.calls, []);
});

test("pending joins survive background refreshes and prevent repeat submissions", async () => {
  for (const profileId of ["profile-2", ""]) {
    for (const refresh of ["receive", "fail"]) {
      for (const outcome of ["resolve", "reject"]) {
        const h = joinHarness(profileId);
        h.open("event-a");
        h.receive("event-a");
        const { join } = h.render();
        join();
        if (!profileId) {
          h.signIn();
          h.runPendingEffect();
          [...h.timers.values()][0]();
        }
        assert.equal(h.render().disabled, true);
        h[refresh]("event-a");
        assert.equal(h.render().isLoading, false);
        assert.equal(h.render().disabled, true);
        join();
        h.render().join();
        assert.deepEqual(h.calls, ["event-a"]);
        h.responses[0][outcome](new Error("Join failed."));
        await h.settle();
        assert.equal(h.render().disabled, false);
        h.render().join();
        assert.deepEqual(h.calls, ["event-a", "event-a"]);
      }
    }
  }
});

test("late join completions cannot release a newer modal's pending join", async () => {
  for (const outcome of ["resolve", "reject"]) {
    const h = joinHarness();
    h.open("event-a");
    h.receive("event-a");
    h.render().join();
    h.open("event-b");
    h.receive("event-b");
    assert.equal(h.render().disabled, false);
    h.render().join();
    h.responses[0][outcome](new Error("Old join failed."));
    await h.settle();
    assert.equal(h.render().disabled, true);
    h.render().join();
    assert.deepEqual(h.calls, ["event-a", "event-b"]);
    h.responses[1].resolve();
    await h.settle();
    assert.equal(h.render().disabled, false);
  }
});

test("prize actions require a fresh idle event", () => {
  for (const overrides of [
    { isLoading: true },
    { isEventFresh: false },
    { activeJoinRequestRef: { current: {} } },
  ]) {
    const selectPrize = createModalAction("handlePrizeSelectionClick", {
      devStubRecord: null,
      eventPrizeConfig: {},
      isEventFresh: true,
      isLoading: false,
      activeJoinRequestRef: { current: null },
      activeLeaveRequestRef: { current: null },
      eventRecord: {},
      currentProfileId: "profile-2",
      isEventPrizeSelectionAvailable: () =>
        assert.fail("Prize eligibility must wait for a fresh idle event."),
      ...overrides,
    });
    selectPrize("1092");
  }
});

test("leaving checks the resolved canonical participant map", async () => {
  const profileIds = { "retired-profile": "profile-2" };
  let checked = false;
  const h = leaveHarness({
    eventProfileIds: profileIds,
    canLeaveEvent: (_event, profileId, nowMs, loginUid, resolved) => {
      checked = true;
      assert.equal(profileId, "profile-2");
      assert.equal(loginUid, "login-2");
      assert.equal(nowMs, 999);
      assert.equal(resolved, profileIds);
      return true;
    },
  });
  const pending = h.action();
  assert.equal(checked, true);
  assert.deepEqual(h.calls, ["event-1"]);
  h.resolve({ ok: true });
  await pending;
});

test("leave failures report errors and release the pending action", async () => {
  const h = leaveHarness();
  const pending = h.action();
  h.reject(new Error("Event has already started."));
  await pending;
  assert.deepEqual(h.alerts, ["Event has already started."]);
  assert.deepEqual(h.pendingStates, [true, false]);
  assert.equal(h.activeLeaveRequestRef.current, null);
});

test("late leave responses cannot update another modal or a newer request", async () => {
  for (const outcome of ["resolve", "reject"]) {
    const h = leaveHarness();
    const pending = h.action();
    h.changeModal();
    h[outcome](new Error("Old request failed."));
    await pending;
    assert.deepEqual(h.alerts, []);
    assert.deepEqual(h.pendingStates, [true]);
  }
  const h = leaveHarness();
  const pending = h.action();
  const newRequest = {};
  h.activeLeaveRequestRef.current = newRequest;
  h.reject(new Error("Old request failed."));
  await pending;
  assert.deepEqual(h.alerts, []);
  assert.deepEqual(h.pendingStates, [true]);
  assert.equal(h.activeLeaveRequestRef.current, newRequest);
});

test("leave errors are suppressed after an authentication change", async () => {
  for (const sameLogin of [false, true]) {
    const h = leaveHarness();
    const pending = h.action();
    if (!sameLogin) h.changeAuth();
    h.reject(
      new Error(sameLogin ? "authentication-changed" : "Old request failed."),
    );
    await pending;
    assert.deepEqual(h.alerts, []);
  }
});

function leaveConnectionHarness() {
  let generation = 0;
  let currentUser = true;
  let resolve;
  let reject;
  const response = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const refreshed = [];
  let navigationRefreshes = 0;
  const instance = createConnection(["leaveEvent"], {
    leaveEventViaApi: () => response,
    console: { error: () => {} },
  });
  Object.assign(instance, {
    ensureAuthenticated: async () => {},
    serializeEventMutation: (_eventId, mutation) => mutation(),
    synchronizeEventAuthOwner: () => {},
    getUserBoundAuthTokenProvider: () => ({
      assertCurrentUser: () => {
        if (!currentUser) throw new Error("authentication-changed");
      },
    }),
    eventPollingRegistry: {
      getGeneration: () => generation,
      invalidateEvent: (eventId) => refreshed.push(eventId),
    },
    notifyNavigationGamesChanged: () => navigationRefreshes++,
  });
  return {
    run: () => instance.leaveEvent("event-1"),
    resolve,
    reject,
    refreshed,
    navigationRefreshes: () => navigationRefreshes,
    changeAuth: () => {
      currentUser = false;
      generation++;
    },
    resetGeneration: () => generation++,
  };
}

test("leave success and failure refresh the event and navigation", async () => {
  const response = {
    ok: true,
    eventId: "event-1",
    removedProfileId: "profile-2",
  };
  for (const succeeds of [true, false]) {
    const h = leaveConnectionHarness();
    const pending = h.run();
    await Promise.resolve();
    if (succeeds) {
      h.resolve(response);
      assert.deepEqual(await pending, response);
    } else {
      const error = new Error("event-started");
      h.reject(error);
      await assert.rejects(pending, (actual) => actual === error);
    }
    assert.deepEqual(h.refreshed, ["event-1"]);
    assert.equal(h.navigationRefreshes(), 1);
  }
});

test("old leave completions cannot refresh the next authentication generation", async () => {
  for (const change of ["changeAuth", "resetGeneration"]) {
    const h = leaveConnectionHarness();
    const pending = h.run();
    await Promise.resolve();
    h[change]();
    h.resolve({ ok: true, eventId: "event-1", removedProfileId: "profile-2" });
    if (change === "changeAuth") {
      await assert.rejects(pending, /authentication-changed/);
    } else {
      await pending;
    }
    assert.deepEqual(h.refreshed, []);
    assert.equal(h.navigationRefreshes(), 0);
  }
});

function eventMutationConnectionHarness() {
  let generation = 0;
  const calls = [];
  const events = new Map();
  const event = (eventId) => {
    if (!events.has(eventId)) {
      events.set(eventId, { member: true, selectedPrizeId: null });
    }
    return events.get(eventId);
  };
  const transport = (operation, request) =>
    new Promise((resolve, reject) => {
      calls.push({
        operation,
        ...request,
        reject,
        resolve: () => {
          const state = event(request.eventId);
          const response = { ok: true, eventId: request.eventId };
          if (operation === "prize") {
            if (!state.member) {
              reject(new Error("participant-not-found"));
              return;
            }
            state.selectedPrizeId =
              state.selectedPrizeId === request.prizeId
                ? null
                : request.prizeId;
            response.selectedPrizeId = state.selectedPrizeId;
          } else if (operation === "leave") {
            state.member = false;
            state.selectedPrizeId = null;
            response.removedProfileId = "profile-2";
          } else {
            state.member = true;
          }
          resolve(response);
        },
      });
    });
  const instance = createConnection(
    [
      "eventMutationTails",
      "serializeEventMutation",
      "joinEvent",
      "leaveEvent",
      "toggleEventPrizeSelection",
    ],
    {
      joinEventViaApi: (request) => transport("join", request),
      leaveEventViaApi: (request) => transport("leave", request),
      toggleEventPrizeSelectionViaApi: (request) => transport("prize", request),
      isToggleEventPrizeSelectionRequest: () => true,
      storage: { getProfileId: () => "profile-2" },
      console: { error: () => {} },
    },
  );
  Object.assign(instance, {
    ensureAuthenticated: async () => {},
    normalizeString: (value) => value,
    synchronizeEventAuthOwner: () => {},
    getUserBoundAuthTokenProvider: () => {
      const captured = generation;
      return {
        assertCurrentUser: () => {
          if (captured !== generation)
            throw new Error("authentication-changed");
        },
      };
    },
    eventPollingRegistry: {
      getGeneration: () => generation,
      invalidateEvent: () => {},
    },
    notifyNavigationGamesChanged: () => {},
  });
  return {
    instance,
    calls,
    event,
    changeAuth: () => generation++,
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("closing and reopening an event cannot let an old prize write overtake leaving", async () => {
  const h = eventMutationConnectionHarness();
  const createCoordinator = () =>
    createEventPrizeSelectionCoordinator({
      profileId: "profile-2",
      mutate: (prizeId) =>
        h.instance.toggleEventPrizeSelection("event-1", prizeId),
      onPendingChange: () => {},
      onSelectionsChange: () => {},
    });
  const oldCoordinator = createCoordinator();
  oldCoordinator.toggle("1092");
  oldCoordinator.toggle("1111");
  await h.settle();
  assert.equal(h.calls.length, 1);
  oldCoordinator.dispose();
  const reopenedCoordinator = createCoordinator();
  assert.equal(reopenedCoordinator.isPending(), false);
  const leaving = h.instance.leaveEvent("event-1");
  await h.settle();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve();
  await h.settle();
  assert.deepEqual(
    h.calls.map(({ operation }) => operation),
    ["prize", "leave"],
  );
  h.calls[1].resolve();
  await leaving;
  assert.deepEqual(h.event("event-1"), {
    member: false,
    selectedPrizeId: null,
  });
  const joining = h.instance.joinEvent("event-1");
  await h.settle();
  h.calls[2].resolve();
  await joining;
  assert.deepEqual(
    h.calls.map(({ operation }) => operation),
    ["prize", "leave", "join"],
  );
  assert.deepEqual(h.event("event-1"), {
    member: true,
    selectedPrizeId: null,
  });
  assert.equal(h.instance.eventMutationTails.size, 0);
  reopenedCoordinator.dispose();
});

test("failed event mutations release their queue without blocking other events", async () => {
  const h = eventMutationConnectionHarness();
  const failedPrize = assert.rejects(
    h.instance.toggleEventPrizeSelection("event-1", "1092"),
    /transport-failed/,
  );
  await h.settle();
  const leaving = h.instance.leaveEvent("event-1");
  const joiningOther = h.instance.joinEvent("event-2");
  await h.settle();
  assert.deepEqual(
    h.calls.map(({ operation, eventId }) => [operation, eventId]),
    [
      ["prize", "event-1"],
      ["join", "event-2"],
    ],
  );
  h.calls[0].reject(new Error("transport-failed"));
  await failedPrize;
  await h.settle();
  assert.equal(h.calls[2].operation, "leave");
  h.calls[2].resolve();
  await leaving;
  h.calls[1].resolve();
  await joiningOther;
  assert.equal(h.instance.eventMutationTails.size, 0);
});

test("queued event mutations reject stale authentication before dispatch", async () => {
  const h = eventMutationConnectionHarness();
  const firstPrize = assert.rejects(
    h.instance.toggleEventPrizeSelection("event-1", "1092"),
    /authentication-changed/,
  );
  await h.settle();
  const queued = [
    h.instance.leaveEvent("event-1"),
    h.instance.joinEvent("event-1"),
    h.instance.toggleEventPrizeSelection("event-1", "1111"),
  ].map((mutation) => assert.rejects(mutation, /authentication-changed/));
  await h.settle();
  h.changeAuth();
  h.calls[0].resolve();
  await firstPrize;
  await Promise.all(queued);
  assert.equal(h.calls.length, 1);
  assert.equal(h.instance.eventMutationTails.size, 0);
});

const inviteRoute = (eventId = "event-first", inviteId = "auto_match") => ({
  mode: "invite",
  path: inviteId,
  inviteId,
  snapshotId: null,
  eventId,
  autojoin: isAutoInviteId(inviteId),
});

function authHarness() {
  let route = inviteRoute();
  let resolveRole;
  const roleRead = new Promise((resolve) => {
    resolveRole = resolve;
  });
  const transitions = [];
  const instance = createConnection(
    ["seeIfFreshlySignedInProfileIsOneOfThePlayers"],
    {
      getRouteStateSnapshot: () => route,
      readInviteRoleViaApi: () => roleRead,
      isAutoInviteId,
      transition: async (...args) => transitions.push(args),
    },
  );
  Object.assign(instance, {
    latestInvite: {},
    activeContext: { canWrite: false },
    inviteId: route.inviteId,
    createSessionGuard: () => () => true,
    getUserBoundAuthTokenProvider: () => ({ assertCurrentUser: () => {} }),
  });
  return {
    transitions,
    run: () => instance.seeIfFreshlySignedInProfileIsOneOfThePlayers(),
    setRoute: (next) => (route = next),
    resolveRole: (role = "host") =>
      resolveRole({ inviteId: "auto_match", role }),
  };
}

for (const eventId of [null, "event-second"]) {
  test(`delayed sign-in restores the latest overlay ${eventId ?? "dismissal"}`, async () => {
    const state = authHarness();
    const pending = state.run();
    const latestRoute = inviteRoute(eventId);
    state.setRoute(latestRoute);
    state.resolveRole();
    await pending;
    assert.deepEqual(state.transitions, [[latestRoute, { force: true }]]);
  });
}

test("delayed sign-in does not return to an invite after navigation", async () => {
  const state = authHarness();
  const pending = state.run();
  state.setRoute(inviteRoute("event-second", "other-match"));
  state.resolveRole();
  await pending;
  assert.deepEqual(state.transitions, []);
});

test("sign-in reads overlay changes after role resolution and before rebootstrap", async () => {
  const state = authHarness();
  const pending = state.run();
  state.resolveRole();
  await Promise.resolve();
  const latestRoute = inviteRoute("last-event");
  state.setRoute(latestRoute);
  await pending;
  assert.deepEqual(state.transitions, [[latestRoute, { force: true }]]);
});

test("a signed-in spectator preserves the current session", async () => {
  const state = authHarness();
  const pending = state.run();
  state.resolveRole("watch");
  await pending;
  assert.deepEqual(state.transitions, []);
});

function shareHarness() {
  const viewUrl = "https://mons.link/exact-match?event=event-first";
  let currentViewUrl = viewUrl;
  const copied = [];
  const shared = [];
  const legacyCopied = [];
  const navigator = {
    clipboard: { writeText: async (link) => copied.push(link) },
    share: async (data) => shared.push(data),
  };
  const window = {
    location: { origin: "https://mons.link" },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  let builderCalls = 0;
  const getCurrentViewUrl = () => {
    builderCalls += 1;
    return currentViewUrl;
  };
  const connection = createConnection(
    ["writeEventLinkToClipboard", "writeLinkToClipboard"],
    { getCurrentViewUrl, window, navigator },
  );
  connection.writeInviteLinkWithLegacyClipboardApi = (link) => {
    legacyCopied.push(link);
    return true;
  };
  const dependencies = {
    connection,
    getCurrentViewUrl,
    window,
    navigator,
    modalState: { eventId: "event-first" },
    setCopyState: () => {},
    copyResetTimeoutRef: { current: null },
  };
  const copy = createModalAction("copyEventLinkToClipboard", dependencies);
  const share = createModalAction("handleShareClick", {
    ...dependencies,
    copyEventLinkToClipboard: copy,
  });
  return {
    viewUrl,
    copied,
    shared,
    legacyCopied,
    navigator,
    connection,
    copy,
    share,
    setViewUrl: (value) => (currentViewUrl = value),
    builderCalls: () => builderCalls,
  };
}

test("event Share and Copy use the same current game and overlay URL", async () => {
  const state = shareHarness();
  state.copy();
  await state.share();
  assert.deepEqual(state.copied, [state.viewUrl]);
  assert.deepEqual(state.shared, [{ url: state.viewUrl, title: "Play Mons" }]);
  assert.equal(state.builderCalls(), 2);
  state.connection.writeEventLinkToClipboard("");
  assert.equal(state.builderCalls(), 2);
});

for (const fallback of ["unavailable", "unsupported", "rejected"]) {
  test(`event Share falls back to the same view URL when ${fallback}`, async () => {
    const state = shareHarness();
    if (fallback === "unavailable") delete state.navigator.share;
    if (fallback === "unsupported") state.navigator.canShare = () => false;
    if (fallback === "rejected") {
      state.navigator.share = async () => {
        throw new Error("share-failed");
      };
    }
    await state.share();
    assert.deepEqual(state.copied, [state.viewUrl]);
  });
}

test("clipboard rejection preserves the view URL in the legacy fallback", async () => {
  const state = shareHarness();
  state.navigator.clipboard.writeText = async () => {
    throw new Error("clipboard-denied");
  };
  state.copy();
  await Promise.resolve();
  assert.deepEqual(state.legacyCopied, [state.viewUrl]);
});

test("a delayed Share rejection copies its original view after navigation", async () => {
  const state = shareHarness();
  let rejectShare;
  state.navigator.share = () =>
    new Promise((_, reject) => {
      rejectShare = reject;
    });
  const pending = state.share();
  state.setViewUrl("https://mons.link/another-match?event=another-event");
  rejectShare(new Error("share-failed"));
  await pending;
  assert.deepEqual(state.copied, [state.viewUrl]);
  assert.equal(state.builderCalls(), 1);
});

test("canceling native Share does not copy an event URL", async () => {
  const state = shareHarness();
  state.navigator.share = async () => {
    throw Object.assign(new Error("canceled"), { name: "AbortError" });
  };
  await state.share();
  assert.deepEqual(state.copied, []);
});

test("opening the match already underneath uses the latest route and only dismisses", async () => {
  let route = inviteRoute("event-first", "previous-match");
  const actions = [];
  const openMatch = createModalAction("openMatch", {
    currentRoute: route,
    getCurrentRouteState: () => route,
    closeEventModal: async (options) => actions.push(["close", options]),
    prepareEventModalGameLaunch: (id) => actions.push(["prepare", id]),
    connection: { connectToInvite: (id) => actions.push(["connect", id]) },
  });
  route = inviteRoute("event-second", "selected-match");
  await openMatch("selected-match");
  assert.deepEqual(actions, [["close", { reason: "launch_game" }]]);
});

test("opening a different match prepares one navigation without an intermediate close", async () => {
  const route = inviteRoute();
  const actions = [];
  const openMatch = createModalAction("openMatch", {
    currentRoute: route,
    getCurrentRouteState: () => route,
    closeEventModal: async (options) => actions.push(["close", options]),
    prepareEventModalGameLaunch: (id) => actions.push(["prepare", id]),
    connection: { connectToInvite: (id) => actions.push(["connect", id]) },
  });
  await openMatch("different-match");
  assert.deepEqual(actions, [
    ["prepare", "different-match"],
    ["connect", "different-match"],
  ]);
});
