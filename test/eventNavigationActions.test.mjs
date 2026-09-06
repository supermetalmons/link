import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isAutoInviteId } from "../cloud/functions/shared/ids.js";

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
