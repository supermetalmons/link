import {
  required,
  canonicalEvent,
  canonicalParticipant,
} from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isAutoInviteId } from "../cloud/runtime/shared/ids.js";

const readSource = (/** @type {string | URL} */ path) =>
  ts.createSourceFile(
    path.toString(),
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

const connectionSource = readSource("../src/connection/connection.ts");
const connectionClass = connectionSource.statements
  .filter(ts.isClassDeclaration)
  .find((node) => node.name?.text === "Connection");
assert.ok(connectionClass && ts.isClassDeclaration(connectionClass));

/** @template T @param {string} source @param {string} result @param {Record<string, unknown>} dependencies @returns {T} */
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

/**
 * @typedef {Omit<typeof import("../src/connection/connection.ts").connection, never> & {writeLinkToClipboard: (link: string, warningLabel: string) => void}} ExtractedConnection
 */
/**
 * @template {keyof ExtractedConnection} K
 * @param {K[]} methodNames
 * @param {Record<string, unknown>} dependencies
 * @returns {Pick<ExtractedConnection, K> & {profileClient?: Pick<ExtractedConnection, "resolveProfileId">, writeInviteLinkWithLegacyClipboardApi?: (link: string) => boolean}}
 */
function createConnection(methodNames, dependencies) {
  const methods = methodNames.map((name) => {
    const method = required(connectionClass).members.find(
      (node) => node.name?.getText() === name,
    );
    assert.ok(method, `missing Connection method ${name}`);
    return method.getText();
  });
  /** @type {new () => Pick<ExtractedConnection, K> & {profileClient?: Pick<ExtractedConnection, "resolveProfileId">, writeInviteLinkWithLegacyClipboardApi?: (link: string) => boolean}} */
  const Connection = evaluate(
    `class Connection { ${methods.join("\n")} }`,
    "Connection",
    dependencies,
  );
  return new Connection();
}

test("canonical profile ID resolution delegates to the profile client", async () => {
  /** @type {string[]} */
  const calls = [];
  const response = Promise.resolve("canonical-profile");
  const instance = createConnection(["resolveProfileId"], {});
  instance.profileClient = {
    resolveProfileId: (id) => {
      calls.push(id);
      return response;
    },
  };
  const pending = instance.resolveProfileId(" retired-profile ");
  assert.equal(pending, response);
  assert.deepEqual(calls, [" retired-profile "]);
  assert.equal(await pending, "canonical-profile");
});

function eventProfileIdsHarness() {
  const stateSource = readSource("../src/ui/event/eventState.ts");
  const hookSource = readSource("../src/ui/event/useEventProfileIds.ts");
  const declarations = stateSource.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const helpers = ["getEventParticipant", "getEventProfileIdsToResolve"].map(
    (name) =>
      `const ${required(declarations.find((node) => node.name.getText() === name)).getText()};`,
  );
  const hook = hookSource.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText().replace(/^export /, ""))
    .join("\n");
  /** @type {number[]} */
  const states = [];
  /** @type {{dependencies: readonly unknown[], value: unknown}[]} */
  const memos = [];
  /** @typedef {() => void | (() => void)} Effect */
  /** @type {{dependencies: readonly unknown[], scheduled: Effect | undefined, cleanup: (() => void) | undefined}[]} */
  const effects = [];
  /** @type {Map<number, {callback: () => void, at: number}>} */
  const timers = new Map();
  let stateIndex = 0;
  let memoIndex = 0;
  let effectIndex = 0;
  let clock = 0;
  let nextTimerId = 0;
  /** @param {readonly unknown[] | undefined} previous @param {readonly unknown[]} next */
  const changed = (previous, next) =>
    !previous || next.some((value, index) => value !== previous[index]);
  /** @param {() => void} callback @param {number} delay */
  const setTimeout = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, at: clock + delay });
    return id;
  };
  /** @param {number} id */
  const clearTimeout = (id) => timers.delete(id);
  /** @type {{id: string, resolve: (value: string | null) => void, reject: (reason: unknown) => void}[]} */
  const calls = [];
  /** @type {Pick<typeof import("../src/ui/event/useEventProfileIds.ts"), "useEventProfileIds"> & Pick<typeof import("../src/ui/event/eventState.ts"), "getEventParticipant">} */
  const { useEventProfileIds, getEventParticipant } = evaluate(
    [...helpers, hook].join("\n"),
    "({ useEventProfileIds, getEventParticipant })",
    {
      /** @param {number | (() => number)} initial @returns {[number, (value: number | ((previous: number) => number)) => void]} */
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) {
          states[index] = typeof initial === "function" ? initial() : initial;
        }
        return [
          required(states[index]),
          (value) => {
            states[index] =
              typeof value === "function"
                ? value(required(states[index]))
                : value;
          },
        ];
      },
      /** @template T @param {() => T} factory @param {readonly unknown[]} dependencies @returns {T} */
      useMemo: (factory, dependencies) => {
        const index = memoIndex++;
        if (changed(memos[index]?.dependencies, dependencies)) {
          memos[index] = { dependencies, value: factory() };
        }
        return /** @type {T} */ (required(memos[index]).value);
      },
      /** @param {Effect} effect @param {readonly unknown[]} nextDependencies */
      useEffect: (effect, nextDependencies) => {
        const index = effectIndex++;
        if (changed(effects[index]?.dependencies, nextDependencies)) {
          effects[index] = {
            cleanup: effects[index]?.cleanup,
            dependencies: nextDependencies,
            scheduled: effect,
          };
        }
      },
      setTimeout,
      clearTimeout,
      window: { setTimeout, clearTimeout },
      connection: {
        resolveProfileId: (/** @type {string} */ id) =>
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
    /** @param {Parameters<typeof useEventProfileIds>} args */
    render: (...args) => {
      stateIndex = 0;
      memoIndex = 0;
      effectIndex = 0;
      const value = useEventProfileIds(...args);
      for (const effect of effects) {
        if (effect.scheduled) {
          effect.cleanup?.();
          effect.cleanup = effect.scheduled() || undefined;
          effect.scheduled = undefined;
        }
      }
      return value;
    },
    advance: (/** @type {number} */ ms) => {
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

/** @param {Parameters<typeof canonicalParticipant>[0]} fields */
const activeParticipant = (fields) => ({
  ...canonicalParticipant(fields),
  state: /** @type {const} */ ("active"),
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});

const mergedEvent = () =>
  canonicalEvent({
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
  const modal = {
    eventId: event.eventId,
    isOpen: true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  const render = (value = event) =>
    h.render(value, "canonical-profile", "alternate-login", modal);
  assert.equal(render().pending, true);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    ["creator-profile", "retired-profile"],
  );
  required(h.calls[0]).reject(new Error("Temporary lookup failure"));
  required(h.calls[1]).resolve("canonical-profile");
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
  required(h.calls[2]).resolve("creator-profile");
  await h.settle();
  assert.equal(render().pending, false);
  assert.equal(h.timers.size, 0);
});

test("canonical membership recovers after a transient lookup failure", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = {
    eventId: event.eventId,
    isOpen: true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  const render = () =>
    h.render(event, "canonical-profile", "alternate-login", modal);
  render();
  required(h.calls[0]).resolve("creator-profile");
  required(h.calls[1]).reject(new Error("Temporary lookup failure"));
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
  required(h.calls[2]).resolve("canonical-profile");
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
  const modal = {
    eventId: event.eventId,
    isOpen: true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  const render = (/** @type {ReturnType<typeof mergedEvent>} */ value) =>
    h.render(value, "retired-profile", "original-login", modal);
  assert.equal(render(event).pending, true);
  const joined = {
    ...event,
    participants: {
      ...event.participants,
      "unrelated-profile": activeParticipant({
        profileId: "unrelated-profile",
        loginUid: "unrelated-login",
      }),
    },
  };
  assert.equal(render(joined).pending, true);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    ["creator-profile"],
  );
  required(h.calls[0]).resolve("creator-profile");
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
  const modal = {
    eventId: event.eventId,
    isOpen: true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  const render = (/** @type {ReturnType<typeof mergedEvent>} */ value) =>
    h.render(value, "canonical-profile", "alternate-login", modal);
  render(event);
  required(h.calls[0]).resolve("creator-profile");
  required(h.calls[1]).resolve("canonical-profile");
  await h.settle();
  assert.equal(render(event).pending, false);
  const joined = {
    ...event,
    participants: {
      ...event.participants,
      "unrelated-profile": activeParticipant({
        profileId: "unrelated-profile",
        loginUid: "unrelated-login",
      }),
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
  event.participants["slow-profile"] = activeParticipant({
    profileId: "slow-profile",
    loginUid: "slow-login",
  });
  const modal = {
    eventId: event.eventId,
    isOpen: true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  const render = (value = event) =>
    h.render(value, "canonical-profile", "alternate-login", modal);
  render();
  required(h.calls[0]).resolve("creator-profile");
  await h.settle();
  assert.deepEqual(render(), {
    pending: true,
    profileIds: { "creator-profile": "creator-profile" },
  });
  required(h.calls[1]).resolve("canonical-profile");
  await h.settle();
  assert.equal(render().pending, false);
  let currentEvent = event;
  for (const id of ["new-profile-1", "new-profile-2"]) {
    currentEvent = {
      ...currentEvent,
      participants: {
        ...currentEvent.participants,
        [id]: activeParticipant({ profileId: id, loginUid: `${id}-login` }),
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
  required(h.calls[3]).reject(new Error("Temporary unrelated lookup failure"));
  await h.settle();
  assert.equal(render(currentEvent).pending, false);
  h.advance(2000);
  assert.equal(render(currentEvent).pending, false);
  assert.equal(h.calls.length, 6);
  assert.equal(required(h.calls[5]).id, "new-profile-1");
  h.unmount();
});

test("nonmembers wait for every canonical participant lookup", async () => {
  const h = eventProfileIdsHarness();
  const event = mergedEvent();
  const modal = {
    eventId: event.eventId,
    isOpen: true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  const render = () =>
    h.render(event, "nonparticipant-profile", "nonparticipant-login", modal);
  render();
  required(h.calls[0]).resolve("creator-profile");
  await h.settle();
  assert.equal(render().pending, true);
  required(h.calls[1]).resolve(null);
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
    const modal = {
      eventId: event.eventId,
      isOpen: true,
      lastCloseReason: null,
      isPendingCreate: false,
      pendingCreateError: null,
    };
    h.render(event, "canonical-profile", "alternate-login", modal);
    const nextModal = changed === "modal" ? { ...modal } : modal;
    const nextProfile =
      changed === "profile" ? "other-profile" : "canonical-profile";
    const nextLogin = changed === "login" ? "other-login" : "alternate-login";
    const render = () => h.render(event, nextProfile, nextLogin, nextModal);
    assert.equal(render().pending, true);
    required(h.calls[0]).resolve("creator-profile");
    required(h.calls[1]).resolve("canonical-profile");
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
  const modal = {
    eventId: event.eventId,
    isOpen: true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  h.render(event, "canonical-profile", "alternate-login", modal);
  const updated = { ...event, participants: {} };
  const render = () =>
    h.render(updated, "canonical-profile", "alternate-login", modal);
  render();
  required(h.calls[0]).resolve("creator-profile");
  required(h.calls[1]).resolve("canonical-profile");
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
    const modal = {
      eventId: event.eventId,
      isOpen: true,
      lastCloseReason: null,
      isPendingCreate: false,
      pendingCreateError: null,
    };
    h.render(event, "canonical-profile", "alternate-login", modal);
    required(h.calls[0]).resolve("creator-profile");
    required(h.calls[1]).reject(new Error("Temporary lookup failure"));
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

/** @param {string | null} [eventId] @param {string} [inviteId] @returns {import("../src/navigation/routeState.ts").RouteState} */
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
  /** @type {PromiseWithResolvers<{inviteId: string, role: "host" | "watch"}>} */
  const roleRead = Promise.withResolvers();
  /** @type {Parameters<typeof import("../src/session/sessionTransitionPort.ts").transition>[]} */
  const transitions = [];
  const instance = createConnection(
    ["seeIfFreshlySignedInProfileIsOneOfThePlayers"],
    {
      getRouteStateSnapshot: () => route,
      readInviteRoleViaApi: () => roleRead.promise,
      isAutoInviteId,
      transition: async (
        /** @type {Parameters<typeof import("../src/session/sessionTransitionPort.ts").transition>} */ ...args
      ) => transitions.push(args),
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
    setRoute: (/** @type {ReturnType<typeof inviteRoute>} */ next) =>
      (route = next),
    resolveRole: (/** @type {"host" | "watch"} */ role = "host") =>
      roleRead.resolve({ inviteId: "auto_match", role }),
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

function clipboardHarness() {
  const viewUrl = "https://mons.link/exact-match?event=event-first";
  /** @type {string[]} */
  const copied = [];
  /** @type {string[]} */
  const legacyCopied = [];
  const navigator = {
    clipboard: {
      writeText: async (/** @type {string} */ link) => copied.push(link),
    },
  };
  let builderCalls = 0;
  const connection = createConnection(
    ["writeEventLinkToClipboard", "writeLinkToClipboard"],
    {
      getCurrentViewUrl: () => {
        builderCalls += 1;
        return viewUrl;
      },
      navigator,
      window: { location: { origin: "https://mons.link" } },
    },
  );
  connection.writeInviteLinkWithLegacyClipboardApi = (link) => {
    legacyCopied.push(link);
    return true;
  };
  return {
    viewUrl,
    copied,
    legacyCopied,
    navigator,
    connection,
    builderCalls: () => builderCalls,
  };
}

test("event clipboard writes preserve the view URL and skip empty event IDs", () => {
  const state = clipboardHarness();
  state.connection.writeEventLinkToClipboard("event-first");
  assert.deepEqual(state.copied, [state.viewUrl]);
  assert.equal(state.builderCalls(), 1);
  state.connection.writeEventLinkToClipboard("");
  assert.equal(state.builderCalls(), 1);
  state.connection.writeEventLinkToClipboard(
    "event-first",
    "https://mons.link/captured?event=event-first",
  );
  assert.equal(
    state.copied.at(-1),
    "https://mons.link/captured?event=event-first",
  );
  assert.equal(state.builderCalls(), 1);
});

test("clipboard rejection preserves the view URL in the legacy fallback", async () => {
  const state = clipboardHarness();
  state.navigator.clipboard.writeText = async () => {
    throw new Error("clipboard-denied");
  };
  state.connection.writeEventLinkToClipboard("event-first");
  await Promise.resolve();
  assert.deepEqual(state.legacyCopied, [state.viewUrl]);
});
