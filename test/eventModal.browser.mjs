import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createBrowserViteServer } from "./browserViteServer.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const environmentPath = fileURLToPath(
  new URL("./fixtures/eventModalEnvironment.ts", import.meta.url),
);
let server;
let browser;
let origin;

before(async () => {
  server = await createBrowserViteServer({
    root,
    cacheDir: `node_modules/.vite-event-modal-${process.pid}`,
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    resolve: {
      alias: [
        { find: /^.*\/connection\/connection$/, replacement: environmentPath },
        { find: /^.*\/identity\/profileUiPort$/, replacement: environmentPath },
        { find: /^.*\/shinyCardUiPort$/, replacement: environmentPath },
        { find: /^.*\/utils\/playerMetadata$/, replacement: environmentPath },
      ],
    },
    logLevel: "error",
    plugins: [
      {
        name: "event-modal-browser-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__event-modal") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/test/fixtures/eventModalHarness.tsx"></script>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MONS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
      : { channel: "chrome" }),
  });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const call = (page, method, ...args) =>
  page.evaluate(({ method, args }) => window.eventHarness[method](...args), {
    method,
    args,
  });
const snapshot = (page) => call(page, "snapshot");
const calls = async (page, kind) =>
  (await snapshot(page)).requests
    .filter((request) => request.kind === kind)
    .map((request) => request.args);
async function fixture(run) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/__event-modal`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.eventHarness);
  try {
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}
const mounted = (name, run) =>
  test(name, { timeout: 60000 }, () => fixture(run));
const mountActions = (page, overrides = {}, options = {}) =>
  call(page, "mount", { mode: "actions", overrides, ...options });
async function openEvent(page, id = "event-a", patch = {}) {
  await call(page, "open", id);
  await call(page, "receive", id, patch);
}

mounted(
  "leaving is one click and suppresses duplicate pending requests",
  async (page) => {
    await mountActions(page);
    await call(page, "invoke", "leave");
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), [["event-a"]]);
    assert.equal((await snapshot(page)).isLeaving, true);
    await call(page, "complete", "leave");
    assert.equal((await snapshot(page)).isLeaving, false);
    assert.deepEqual((await snapshot(page)).alerts, []);
  },
);

mounted(
  "leaving rechecks the start boundary and blocks stale or simulated events",
  async (page) => {
    for (const overrides of [
      { isEventFresh: false },
      { isLoading: true },
      { isResolvingEventProfileIds: true },
      { devStubRecord: {} },
      { eventRecord: { eventId: "old-event", startAtMs: 1_100_000 } },
    ]) {
      await mountActions(page, overrides);
      await call(page, "invoke", "leave");
      assert.deepEqual(await calls(page, "leave"), []);
    }
    await mountActions(page);
    await call(page, "invoke", "join");
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), []);
    await mountActions(page, {}, { profileId: "p1", loginUid: "p1-login" });
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), []);
    await mountActions(page);
    await call(page, "setNow", 1_100_000);
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), []);
  },
);

mounted(
  "leaving waits for queued prize mutations and then blocks new prize actions",
  async (page) => {
    const id = await page.evaluate(() => window.eventHarness.prizeEventId);
    await call(page, "mount", { eventId: id });
    await call(page, "receive", id);
    await call(page, "invoke", "selectPrize", "1092");
    await call(page, "invoke", "selectPrize", "1111");
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), []);
    await call(page, "complete", "prize", 0, "resolve", "1092");
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), []);
    assert.deepEqual(await calls(page, "prize"), [
      [id, "1092"],
      [id, "1111"],
    ]);
    await call(page, "complete", "prize", 1, "resolve", "1111");
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), [[id]]);
    await call(page, "invoke", "selectPrize", "1514");
    assert.equal((await calls(page, "prize")).length, 2);
    await call(page, "complete", "leave");
  },
);

mounted(
  "joining is blocked while leaving or saving prize selections",
  async (page) => {
    await mountActions(page);
    await call(page, "invoke", "leave");
    await call(page, "invoke", "join");
    assert.deepEqual(await calls(page, "join"), []);
    const id = await page.evaluate(() => window.eventHarness.prizeEventId);
    await call(page, "mount", { eventId: id });
    await call(page, "receive", id);
    await call(page, "invoke", "selectPrize", "1092");
    await call(page, "invoke", "join");
    assert.deepEqual(await calls(page, "join"), []);
  },
);

mounted(
  "joining remains blocked when another event fails to replace displayed content",
  async (page) => {
    for (const profileId of ["p2", ""]) {
      await call(page, "mount", { profileId });
      await call(page, "receive", "event-a");
      assert.equal((await snapshot(page)).joinDisabled, false);
      await call(page, "open", "event-b");
      await call(page, "fail", "event-b");
      const state = await snapshot(page);
      assert.equal(state.session.eventRecord.eventId, "event-a");
      assert.equal(state.session.isLoading, false);
      assert.equal(state.joinDisabled, true);
      await call(page, "invoke", "join");
      assert.deepEqual(await calls(page, "join"), []);
      assert.deepEqual((await snapshot(page)).popups, []);
    }
  },
);

mounted(
  "joining the displayed event stays enabled during freshness and profile refresh",
  async (page) => {
    await call(page, "mount", { fresh: false, deferredCanonicalIds: true });
    await call(page, "receive", "event-a");
    assert.equal((await snapshot(page)).resolvingProfiles, true);
    assert.equal((await snapshot(page)).joinDisabled, false);
    await call(page, "invoke", "join");
    assert.deepEqual(await calls(page, "join"), [["event-a"]]);
    assert.equal((await snapshot(page)).joinDisabled, true);
  },
);

mounted(
  "join callbacks from a previous or closed modal cannot submit",
  async (page) => {
    for (const next of ["open", "close"]) {
      await call(page, "mount");
      await call(page, "receive", "event-a");
      await call(page, "capture", "join");
      await call(page, next, "event-b");
      await call(page, "invokeSaved", "join");
      assert.deepEqual(await calls(page, "join"), []);
    }
  },
);

mounted(
  "joining after sign-in waits for matching event content",
  async (page) => {
    await call(page, "mount", { profileId: "" });
    await call(page, "receive", "event-a");
    await call(page, "invoke", "join");
    assert.deepEqual((await snapshot(page)).popups, ["signin"]);
    await openEvent(page, "event-b");
    await call(page, "open", "event-a");
    await call(page, "fail", "event-a");
    await call(page, "auth", "p2");
    assert.equal((await snapshot(page)).session.eventRecord.eventId, "event-b");
    assert.equal((await snapshot(page)).intervals, 0);
    assert.deepEqual(await calls(page, "join"), []);
    await call(page, "receive", "event-a");
    assert.equal((await snapshot(page)).intervals, 1);
    await call(page, "advance", 350);
    assert.deepEqual(await calls(page, "join"), [["event-a"]]);
  },
);

mounted(
  "a pending sign-in join cannot submit after the modal changes",
  async (page) => {
    await call(page, "mount", { profileId: "" });
    await call(page, "receive", "event-a");
    await call(page, "invoke", "join");
    assert.equal((await snapshot(page)).intervals, 1);
    await call(page, "open", "event-b");
    await call(page, "auth", "p2");
    await call(page, "advance", 350);
    assert.deepEqual(await calls(page, "join"), []);
  },
);

mounted(
  "pending joins survive background refreshes and prevent repeat submissions",
  async (page) => {
    for (const profileId of ["p2", ""])
      for (const refresh of ["receive", "fail"])
        for (const outcome of ["resolve", "reject"]) {
          await call(page, "mount", { profileId });
          await call(page, "receive", "event-a");
          await call(page, "capture", "join");
          await call(page, "invoke", "join");
          if (!profileId) {
            await call(page, "auth", "p2");
            await call(page, "advance", 350);
          }
          assert.equal((await snapshot(page)).joinDisabled, true);
          await call(page, refresh, "event-a");
          assert.equal((await snapshot(page)).session.isLoading, false);
          assert.equal((await snapshot(page)).joinDisabled, true);
          await call(page, "invokeSaved", "join");
          await call(page, "invoke", "join");
          assert.deepEqual(await calls(page, "join"), [["event-a"]]);
          await call(page, "complete", "join", 0, outcome);
          assert.equal((await snapshot(page)).joinDisabled, false);
          await call(page, "invoke", "join");
          assert.deepEqual(await calls(page, "join"), [
            ["event-a"],
            ["event-a"],
          ]);
        }
  },
);

mounted(
  "late join completions cannot release a newer modal's pending join",
  async (page) => {
    for (const outcome of ["resolve", "reject"]) {
      await call(page, "mount");
      await call(page, "receive", "event-a");
      await call(page, "invoke", "join");
      await openEvent(page, "event-b");
      assert.equal((await snapshot(page)).joinDisabled, false);
      await call(page, "invoke", "join");
      await call(page, "complete", "join", 0, outcome);
      assert.equal((await snapshot(page)).joinDisabled, true);
      await call(page, "invoke", "join");
      assert.deepEqual(await calls(page, "join"), [["event-a"], ["event-b"]]);
      await call(page, "complete", "join", 1);
      assert.equal((await snapshot(page)).joinDisabled, false);
    }
  },
);

mounted("prize actions require a fresh idle event", async (page) => {
  for (const overrides of [{ isLoading: true }, { isEventFresh: false }]) {
    await mountActions(page, overrides);
    await call(page, "invoke", "selectPrize", "1092");
    assert.deepEqual(await calls(page, "prize"), []);
  }
  await mountActions(page);
  await call(page, "invoke", "join");
  await call(page, "invoke", "selectPrize", "1092");
  assert.deepEqual(await calls(page, "prize"), []);
});

mounted(
  "leaving checks the resolved canonical participant map",
  async (page) => {
    await mountActions(
      page,
      { eventProfileIds: { "retired-profile": "p2" } },
      { loginUid: "another-login" },
    );
    await page.evaluate(async () => {
      const h = window.eventHarness;
      await h.override({
        eventRecord: {
          schemaVersion: 2,
          eventId: "event-a",
          status: "scheduled",
          startAtMs: 1_100_000,
          createdByProfileId: "p1",
          createdByLoginUid: "p1-login",
          participants: { "retired-profile": h.participant("retired-profile") },
          rounds: {},
        },
      });
    });
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), [["event-a"]]);
    await call(page, "complete", "leave");
  },
);

mounted(
  "leave failures report errors and release the pending action",
  async (page) => {
    await mountActions(page);
    await call(page, "invoke", "leave");
    await call(
      page,
      "complete",
      "leave",
      0,
      "reject",
      "Event has already started.",
    );
    assert.deepEqual((await snapshot(page)).alerts, [
      "Event has already started.",
    ]);
    assert.equal((await snapshot(page)).isLeaving, false);
    await call(page, "invoke", "leave");
    assert.equal((await calls(page, "leave")).length, 2);
  },
);

mounted(
  "late leave responses cannot update another modal or a newer request",
  async (page) => {
    for (const outcome of ["resolve", "reject"]) {
      await mountActions(page);
      await call(page, "invoke", "leave");
      await call(page, "open", "event-b");
      await call(page, "complete", "leave", 0, outcome);
      assert.deepEqual((await snapshot(page)).alerts, []);
      assert.equal((await snapshot(page)).isLeaving, true);
    }
    await call(page, "mount");
    await call(page, "receive", "event-a");
    await call(page, "invoke", "leave");
    await openEvent(page, "event-b");
    await call(page, "invoke", "leave");
    await call(page, "complete", "leave", 0, "reject", "Old request failed.");
    assert.deepEqual((await snapshot(page)).alerts, []);
    assert.equal((await snapshot(page)).isLeaving, true);
    await call(page, "invoke", "leave");
    assert.deepEqual(await calls(page, "leave"), [["event-a"], ["event-b"]]);
  },
);

mounted(
  "leave errors are suppressed after an authentication change",
  async (page) => {
    for (const sameLogin of [false, true]) {
      await mountActions(page);
      await call(page, "invoke", "leave");
      if (!sameLogin) await call(page, "auth", "p3");
      await call(
        page,
        "complete",
        "leave",
        0,
        "reject",
        sameLogin ? "authentication-changed" : "Old request failed.",
      );
      assert.deepEqual((await snapshot(page)).alerts, []);
    }
  },
);

mounted(
  "event Share and Copy use the same current game and overlay URL",
  async (page) => {
    await mountActions(page);
    await call(page, "setRoute", "/exact-match?event=event-a");
    await call(page, "configureShare", "success");
    await call(page, "invoke", "copy");
    await call(page, "invoke", "share");
    const state = await snapshot(page);
    assert.deepEqual(state.copies, [`${origin}/exact-match?event=event-a`]);
    assert.deepEqual(state.shared, [
      { url: state.copies[0], title: "Play Mons" },
    ]);
    assert.equal(state.copyState, "copied");
    await call(page, "advance", 1200);
    assert.equal((await snapshot(page)).copyState, "idle");
  },
);
for (const behavior of ["unavailable", "unsupported", "rejected"])
  mounted(
    `event Share falls back to the same view URL when ${behavior}`,
    async (page) => {
      await mountActions(page);
      await call(page, "setRoute", "/exact-match?event=event-a");
      await call(page, "configureShare", behavior);
      await call(page, "invoke", "share");
      assert.deepEqual((await snapshot(page)).copies, [
        `${origin}/exact-match?event=event-a`,
      ]);
    },
  );
mounted(
  "a delayed Share rejection copies its original view after navigation",
  async (page) => {
    await mountActions(page);
    await call(page, "setRoute", "/exact-match?event=event-a");
    await call(page, "configureShare", "delayed");
    await call(page, "invoke", "share");
    await call(page, "setRoute", "/another-match?event=event-b");
    await call(page, "rejectShare");
    assert.deepEqual((await snapshot(page)).copies, [
      `${origin}/exact-match?event=event-a`,
    ]);
  },
);
mounted("canceling native Share does not copy an event URL", async (page) => {
  await mountActions(page);
  await call(page, "configureShare", "aborted");
  await call(page, "invoke", "share");
  assert.deepEqual((await snapshot(page)).copies, []);
});
mounted(
  "opening the match already underneath uses the latest route and only dismisses",
  async (page) => {
    await mountActions(page);
    await call(page, "capture", "openMatch");
    await call(page, "setRoute", "/selected-match?event=event-a");
    await call(page, "invokeSaved", "openMatch", "selected-match");
    const state = await snapshot(page);
    assert.deepEqual(state.connections, []);
    assert.equal(state.modalState.isOpen, false);
    assert.equal(state.modalState.lastCloseReason, "launch_game");
  },
);
mounted(
  "opening a different match prepares one navigation without an intermediate close",
  async (page) => {
    await mountActions(page);
    await call(page, "setRoute", "/selected-match?event=event-a");
    await call(page, "invoke", "openMatch", "different-match");
    assert.deepEqual((await snapshot(page)).connections, ["different-match"]);
    assert.equal((await snapshot(page)).modalState.isOpen, true);
    await call(page, "setRoute", "/different-match");
    await call(page, "syncRoute");
    assert.equal(
      (await snapshot(page)).modalState.lastCloseReason,
      "launch_game",
    );
  },
);

mounted(
  "mounted lifecycle balances subscriptions, marks first content and cleans up on close and unmount",
  async (page) => {
    await call(page, "mount", { strict: true, fresh: false });
    let state = await snapshot(page);
    assert.deepEqual(state.activeEvents, ["event-a"]);
    assert.deepEqual(state.activeFreshness, ["event-a"]);
    await call(page, "receive", "event-a");
    assert.ok(
      (await snapshot(page)).performanceMarks.includes("event:first-content"),
    );
    await call(page, "fresh", "event-a", true);
    assert.ok(
      (await snapshot(page)).performanceMarks.includes(
        "event:first-fresh-content",
      ),
    );
    await openEvent(page, "event-b");
    assert.deepEqual((await snapshot(page)).activeEvents, ["event-b"]);
    await call(page, "close");
    state = await snapshot(page);
    assert.deepEqual(state.activeEvents, []);
    assert.deepEqual(state.activeFreshness, []);
    assert.equal(state.session.eventRecord, null);
    assert.equal(state.session.isEventFresh, false);
    await call(page, "open", "event-c");
    await call(page, "unmount");
    state = await snapshot(page);
    assert.deepEqual(state.activeEvents, []);
    assert.deepEqual(state.timers, []);
  },
);

mounted(
  "sign-in polling expires and the event clock refreshes at boundaries and focus",
  async (page) => {
    await call(page, "mount", { profileId: "" });
    await call(page, "receive", "event-a", { startAtMs: 1_061_000 });
    assert.ok(
      (await snapshot(page)).timers.some((timer) => timer.delay === 1050),
    );
    await call(page, "invoke", "join");
    await call(page, "advance", 60_200);
    assert.equal((await snapshot(page)).intervals, 0);
    await call(page, "auth", "p2");
    await call(page, "advance", 350);
    assert.deepEqual(await calls(page, "join"), []);
    await call(page, "setNow", 1_070_000);
    await call(page, "focus");
    assert.equal((await snapshot(page)).session.nowMs, 1_070_000);
  },
);

mounted(
  "event recovery retains freshness, creator, delay, attempt limits and dev suppression",
  async (page) => {
    await call(page, "mount", {
      profileId: "p1",
      loginUid: "p1-login",
      fresh: false,
    });
    await call(page, "receive", "event-a", { startAtMs: 999_000 });
    await call(page, "advance", 1000);
    assert.deepEqual(await calls(page, "sync"), []);
    await call(page, "fresh", "event-a", true);
    await call(page, "advance", 999);
    assert.deepEqual(await calls(page, "sync"), []);
    await call(page, "advance", 1);
    assert.deepEqual(await calls(page, "sync"), [["event-a"]]);
    await call(page, "complete", "sync");
    await call(page, "advance", 3000);
    assert.equal((await calls(page, "sync")).length, 1);
    await call(page, "advance", 6000);
    assert.equal((await calls(page, "sync")).length, 2);
    await call(page, "complete", "sync", 1);
    await call(page, "advance", 10000);
    assert.equal((await calls(page, "sync")).length, 2);
    await call(page, "mount", { profileId: "p1", loginUid: "p1-login" });
    await call(page, "receive", "event-a", { startAtMs: 999_000 });
    await call(page, "dev", true);
    await call(page, "advance", 1000);
    assert.deepEqual(await calls(page, "sync"), []);
    await call(page, "mount");
    await call(page, "receive", "event-a", { startAtMs: 999_000 });
    await call(page, "advance", 1000);
    assert.deepEqual(await calls(page, "sync"), []);
  },
);

mounted(
  "participant cards use stashed profiles, modal cache, TTL and login fallback",
  async (page) => {
    await call(page, "mount");
    const participant = await call(page, "participant", "p3");
    await call(page, "stash", "p3-login", { id: "p3", username: "cached" });
    await call(page, "invoke", "participant", participant);
    assert.deepEqual(await calls(page, "profile"), []);
    assert.equal((await snapshot(page)).cards[0].profile.id, "p3");
    await call(page, "stash", "p3-login", null);
    await call(page, "invoke", "participant", participant);
    assert.deepEqual(await calls(page, "profile"), []);
    await call(page, "advance", 30_001);
    await call(page, "invoke", "participant", participant);
    assert.deepEqual(await calls(page, "profile"), [["p3"]]);
    await call(page, "complete", "profile", 0, "reject", "temporary");
    assert.deepEqual(await calls(page, "login"), [["p3-login"]]);
    await call(page, "complete", "login", 0, "resolve", { id: "p3" });
    assert.equal((await snapshot(page)).cards.length, 3);
    await openEvent(page, "event-b");
    await call(page, "invoke", "participant", participant);
    assert.equal((await calls(page, "profile")).length, 2);
  },
);

mounted(
  "participant lookups retain same-group clicks and suppress superseded, closed and unmounted results",
  async (page) => {
    await call(page, "mount");
    const p3 = await call(page, "participant", "p3");
    const p4 = await call(page, "participant", "p4");
    await call(page, "invoke", "participant", p3);
    await call(page, "invoke", "participant", {
      ...p3,
      displayName: "Latest name",
    });
    await call(page, "complete", "profile", 1, "resolve", { id: "p3" });
    await call(page, "complete", "profile", 0, "resolve", { id: "p3" });
    assert.deepEqual((await snapshot(page)).cards, [
      { profile: { id: "p3" }, name: "Latest name" },
    ]);
    await call(page, "mount");
    await call(page, "invoke", "participant", p3);
    await call(page, "invoke", "participant", p4);
    await call(page, "complete", "profile", 0, "resolve", { id: "p3" });
    assert.deepEqual((await snapshot(page)).cards, []);
    await call(page, "complete", "profile", 1, "resolve", { id: "p4" });
    assert.equal((await snapshot(page)).cards[0].profile.id, "p4");
    for (const close of ["close", "unmount"]) {
      await call(page, "mount");
      await call(page, "invoke", "participant", p3);
      await call(page, close);
      await call(page, "complete", "profile", 0, "resolve", { id: "p3" });
      assert.deepEqual((await snapshot(page)).cards, []);
    }
  },
);

mounted(
  "admin actions preserve prompts, duplicate suppression and reported errors",
  async (page) => {
    await mountActions(page, {}, { profileId: "p1", loginUid: "p1-login" });
    await call(page, "responses", ["7", "10"], [true]);
    await call(page, "invoke", "postpone");
    assert.deepEqual((await snapshot(page)).alerts, [
      "Please enter 5, 10, or 15.",
    ]);
    await call(page, "invoke", "postpone");
    await call(page, "invoke", "postpone");
    assert.deepEqual(await calls(page, "postpone"), [["event-a", 10]]);
    assert.equal((await snapshot(page)).isPostponing, true);
    await call(page, "complete", "postpone", 0, "reject", "Postpone failed");
    assert.equal((await snapshot(page)).isPostponing, false);
    assert.equal((await snapshot(page)).alerts.at(-1), "Postpone failed");
    await call(page, "responses", ["1"], [true]);
    await call(page, "invoke", "removeParticipant");
    assert.deepEqual(await calls(page, "remove"), [["event-a", "p2"]]);
    await call(page, "complete", "remove");
    assert.equal((await snapshot(page)).isRemovingParticipant, false);
  },
);

mounted(
  "disqualification keeps match selection, confirmation and pending behavior",
  async (page) => {
    await mountActions(page);
    await page.evaluate(async () => {
      await window.eventHarness.override({
        eventRecord: {
          eventId: "event-a",
          status: "active",
          participants: {},
          rounds: {
            0: {
              roundIndex: 0,
              matches: {
                "0_0": {
                  matchKey: "0_0",
                  status: "pending",
                  inviteId: "selected-match",
                  winnerDisqualified: false,
                  hostDisplayName: "Host",
                  guestDisplayName: "Guest",
                },
              },
            },
          },
        },
      });
    });
    await call(page, "responses", ["1"], [true]);
    await call(page, "invoke", "disqualify");
    await call(page, "invoke", "disqualify");
    assert.deepEqual(await calls(page, "disqualify"), [["event-a", "0_0"]]);
    assert.deepEqual((await snapshot(page)).confirmations, [
      "disqualify Host and Guest?",
    ]);
    assert.equal((await snapshot(page)).isDisqualifying, true);
    await call(
      page,
      "complete",
      "disqualify",
      0,
      "reject",
      "Disqualification failed",
    );
    assert.equal((await snapshot(page)).isDisqualifying, false);
    assert.deepEqual((await snapshot(page)).alerts, [
      "Disqualification failed",
    ]);
  },
);
