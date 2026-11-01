import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const sharedManifest = JSON.parse(
  readFileSync(
    new URL("../cloud/runtime/shared/package.json", import.meta.url),
    "utf8",
  ),
);
const sharedImports = Object.keys(sharedManifest.exports).map(
  (subpath) => sharedManifest.name + subpath.slice(1),
);
const harnessSource = `import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useNavigationGames } from '/src/ui/controls/useNavigationGames.ts';
import NavigationPicker from '/src/ui/NavigationPicker.tsx';
import { problems, completedProblemIds } from '/__navigation-problems';
import { resolveNavigationGamesCacheScope, writeNavigationGamesRuntimeCache } from '/src/services/navigationGamesCache.ts';
const subscriptions = [];
const pages = [];
const commits = [];
let epoch = 0;
let current;
const root = createRoot(document.getElementById('root'));
const client = {
  createSessionGuard() { const start = epoch; return () => start === epoch; },
  subscribeProfileGames(limit, update, error, meta) {
    const entry = { limit, update, error, meta, active: true };
    subscriptions.push(entry);
    return () => { entry.active = false; };
  },
  getProfileGamesPage(limit, cursor) {
    return new Promise((resolve, reject) => pages.push({limit, cursor, resolve, reject}));
  },
  removeWaitingNavigationGame() { return Promise.resolve({ok: true}); },
};
const game = (id, n = 1) => ({ id, entityType: 'game', inviteId: id, kind: 'direct', status: 'waiting', sortBucket: 30, listSortAtMs: n });
const event = (profile) => ({ id: 'event_e', entityType: 'event', eventId: 'e', status: 'active', sortBucket: 10, listSortAtMs: 1, startAtMs: 1, updatedAtMs: 1, endedAtMs: null, participantCount: 1, participantPreview: [{profileId: profile, displayName: profile, emojiId: 1, aura: null}], winnerDisplayName: null });
function Probe({profileId, isOpen, showPicker}) {
  const nav = useNavigationGames({profileId, authStatus: profileId ? 'authenticated' : 'unauthenticated', isOpen, client});
  const [avatars, setAvatars] = useState([]);
  const eventRef = useRef(null);
  useEffect(() => { eventRef.current = null; setAvatars([]); }, [profileId]);
  useEffect(() => {
    if (eventRef.current === 'e') return;
    eventRef.current = 'e';
    setAvatars(nav.getEventParticipantPreview('e').slice(0, 4));
  }, [nav.getEventParticipantPreview]);
  const shownAvatars = useMemo(() => avatars.length ? avatars : nav.getEventParticipantPreview('e').slice(0,4), [avatars, nav.getEventParticipantPreview]);
  const state = {profileId, snapshotProfile: nav.profileId, top: nav.topGames.map(x=>x.id), paged: nav.pagedGames.map(x=>x.id), loading:nav.isLoading, loadingMore:nav.isLoadingMore, hasMore:nav.hasMore, avatars:shownAvatars.map(x=>x.profileId)};
  useLayoutEffect(() => { current = nav; commits.push(state); });
  return React.createElement(React.Fragment, null,
    React.createElement('pre', {id:'state'}, JSON.stringify(state)),
    showPicker && isOpen ? React.createElement(NavigationPicker, {showsHomeNavigation:false, topGames:nav.topGames, pagedGames:nav.pagedGames, isGamesLoading:nav.isLoading, isLoadingMoreGames:nav.isLoadingMore, hasMoreGames:nav.hasMore, onSelectProblem:()=>{}, onLoadMoreGames:nav.loadMore}) : null);
}
function render(profileId='a', isOpen=true, showPicker=false) {
  flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe, {profileId,isOpen,showPicker}))));
}
const cursor = n => ({sortBucket:30,listSortAtMs:n,id:'cursor_'+n});
const interactions = { selections: [], removals: [], problems: [], home: 0, loads: 0 };
const pickerCallbacks = {
  onSelectGame: (item, options) => interactions.selections.push({id:item.id, options}),
  onRemoveGame: id => interactions.removals.push(id),
  onSelectProblem: id => interactions.problems.push(id),
  navigateHome: () => interactions.home++,
  onLoadMoreGames: () => interactions.loads++,
};
let pickerProps;
function drawPicker() {
  flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(NavigationPicker, pickerProps))));
}
window.navigationHarness = {
  required(value) { if (value === null || value === undefined) throw new Error("picker-fixture-value-missing"); return value; },
  render, game, event, cursor, commits, subscriptions, pages, interactions,
  renderPicker(props = {}) { pickerProps = {showsHomeNavigation:false, ...pickerCallbacks, ...props}; drawPicker(); },
  updatePicker(props) { pickerProps = {...pickerProps, ...props}; drawPicker(); },
  closePicker() { flushSync(() => root.render(null)); },
  setProblems(items, completed = []) { problems.splice(0, problems.length, ...items); completedProblemIds.clear(); completed.forEach(id => completedProblemIds.add(id)); },
  scrollable() { return Array.from(document.querySelectorAll('div')).find(element => getComputedStyle(element).overflowY === 'auto'); },
  seed(profile, top, paged=[]) { writeNavigationGamesRuntimeCache(resolveNavigationGamesCacheScope(profile), top, paged); },
  snapshot() { return JSON.parse(document.getElementById('state').textContent); },
  update(items, meta) {const sub=subscriptions.findLast(x=>x.active); flushSync(()=>{sub.update(items); if(meta)sub.meta(meta);});},
  deliverItems(subscription, items) { flushSync(() => subscription.update(items)); },
  guard() { return current.createProfileRequestGuard(); },
  setOptimistic(item) {flushSync(()=>current.setOptimisticPendingAutomatch(item));},
  async resolvePage(index, result) {pages[index].resolve(result); await new Promise(r=>setTimeout(r,0));},
  dispose() {flushSync(()=>root.unmount());},
};
`;

/** @param {(page: import("playwright").Page) => Promise<void>} run */
async function fixture(run) {
  const server = await createServer({
    root: repository,
    configFile: false,
    logLevel: "error",
    optimizeDeps: { include: sharedImports },
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    plugins: [
      {
        name: "navigation-browser-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__navigation") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/__navigation-harness.js"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/__navigation-harness.js") return "\0navigation-harness";
          if (id === "/__navigation-problems") return "\0navigation-problems";
          if (
            importer?.endsWith("/NavigationPicker.tsx") &&
            id === "../content/problems"
          )
            return "\0navigation-problems";
          if (
            importer?.endsWith("/NavigationPicker.tsx") &&
            id === "../hooks/useGameAssets"
          )
            return "\0navigation-assets";
        },
        load(id) {
          if (id === "\0navigation-harness") return harnessSource;
          if (id === "\0navigation-problems")
            return "export const problems=[]; export const completedProblemIds=new Set(); export const getCompletedProblemIds=()=>completedProblemIds;";
          if (id === "\0navigation-assets")
            return "export const useGameAssets=()=>({assets:null,isLoading:false});";
        },
      },
    ],
  });
  /** @type {import("playwright").Browser | undefined} */
  let browser;
  try {
    await server.listen();
    const origin = browserServerOrigin(server);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
    });
    context.setDefaultTimeout(15000);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/__navigation`);
    await page.waitForFunction(() => !!window.navigationHarness);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

test(
  "navigation hook survives StrictMode replay and isolates profile rows, guards, and avatar consumers",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const result = await page.evaluate(() => {
        const h = window.navigationHarness;
        h.seed("a", [h.event("a"), h.game("a-game")]);
        h.seed("b", [h.event("b"), h.game("b-game")]);
        h.render("a", true);
        const initial = h.snapshot();
        const activeAfterMount = h.subscriptions.filter(
          (subscription) => subscription.active,
        ).length;
        const mountStarts = h.subscriptions.length;
        const guard = h.guard();
        const oldSubscription = h.subscriptions.find(
          (subscription) => subscription.active,
        );
        h.render("b", true);
        const profileB = h.snapshot();
        const guardAfterSwitch = guard();
        h.deliverItems(h.required(oldSubscription), [h.game("stale-a")]);
        const afterStale = h.snapshot();
        h.render("a", true);
        const guardAfterRoundTrip = guard();
        const closingGuard = h.guard();
        h.render("a", false);
        const closed = h.snapshot();
        const guardAfterClose = closingGuard();
        const activeClosed = h.subscriptions.filter(
          (subscription) => subscription.active,
        ).length;
        h.render("a", true);
        const reopened = h.snapshot();
        const leakingCommits = h.commits.filter(
          (commit) => commit.profileId === "b" && commit.top.includes("a-game"),
        );
        h.render("", false);
        h.setOptimistic({
          ...h.game("anonymous-pending"),
          status: "pending",
          kind: "auto",
          isOptimistic: true,
        });
        const anonymous = h.snapshot();
        const unmountGuard = h.guard();
        h.dispose();
        return {
          initial,
          activeAfterMount,
          mountStarts,
          profileB,
          afterStale,
          guardAfterSwitch,
          guardAfterRoundTrip,
          closed,
          guardAfterClose,
          activeClosed,
          reopened,
          leakingCommits,
          anonymous,
          guardAfterUnmount: unmountGuard(),
        };
      });
      assert.equal(result.activeAfterMount, 1);
      assert.equal(result.mountStarts, 2);
      assert.deepEqual(result.initial.avatars, ["a"]);
      assert.deepEqual(result.profileB.avatars, ["b"]);
      assert.equal(result.guardAfterSwitch, false);
      assert.equal(result.guardAfterRoundTrip, false);
      assert.equal(result.guardAfterClose, true);
      assert.equal(result.activeClosed, 0);
      assert.equal(result.closed.loading, false);
      assert.equal(result.reopened.loading, true);
      assert.equal(result.guardAfterUnmount, false);
      assert.deepEqual(result.leakingCommits, []);
      assert.deepEqual(result.anonymous.top, ["anonymous-pending"]);
      assert.equal(result.afterStale.top.includes("stale-a"), false);
    });
  },
);

test(
  "navigation picker can load the next page after scrolling during a warm cache refresh",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const h = window.navigationHarness;
        const top = Array.from({ length: 35 }, (_, index) =>
          h.game(`top_${index}`, index),
        );
        const paged = Array.from({ length: 10 }, (_, index) =>
          h.game(`page_${index}`, 100 + index),
        );
        h.seed("a", top, paged);
        h.render("a", true, true);
        h.update(top, { items: top, hasMore: true, nextCursor: h.cursor(1) });
      });
      const scrollToBottom = () =>
        page.evaluate(() => {
          const scrollable = Array.from(document.querySelectorAll("div")).find(
            (element) => getComputedStyle(element).overflowY === "auto",
          );
          if (!scrollable) throw new Error("navigation-scrollable-missing");
          scrollable.scrollTop = scrollable.scrollHeight;
          scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
          return {
            pageRequests: window.navigationHarness.pages.length,
            isScrollable: scrollable.scrollHeight > scrollable.clientHeight,
          };
        });
      assert.deepEqual(await scrollToBottom(), {
        pageRequests: 1,
        isScrollable: true,
      });
      await page.evaluate(async () => {
        const h = window.navigationHarness;
        await h.resolvePage(0, {
          items: Array.from({ length: 10 }, (_, index) =>
            h.game(`page_${index}`, 200 + index),
          ),
          hasMore: true,
          nextCursor: h.cursor(2),
        });
      });
      await scrollToBottom();
      await page.waitForFunction(
        () => window.navigationHarness.pages.length === 2,
      );
      const nextPage = await page.evaluate(() => ({
        request: window.navigationHarness.required(
          window.navigationHarness.pages[1],
        ).cursor,
        expected: window.navigationHarness.cursor(2),
        snapshot: window.navigationHarness.snapshot(),
      }));
      assert.deepEqual(nextPage.request, nextPage.expected);
      assert.equal(nextPage.snapshot.loadingMore, true);
    });
  },
);

/** @param {import("playwright").Page} page */
const settleScroll = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

/** @param {import("playwright").Page} page @param {number | "bottom"} [top] */
const dispatchScroll = (page, top = "bottom") =>
  page.evaluate((position) => {
    const h = window.navigationHarness;
    const list = h.required(h.scrollable());
    list.scrollTop = position === "bottom" ? list.scrollHeight : position;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    return h.interactions.loads;
  }, top);

test(
  "navigation rows preserve grouping, selection, and action payloads",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const initial = await page.evaluate(() => {
        const h = window.navigationHarness;
        h.setProblems(
          [
            { id: "learn-a", icon: "mana", label: "Learn A" },
            { id: "learn-b", icon: "mana", label: "Learn B" },
          ],
          ["learn-a"],
        );
        h.renderPicker({
          showsHomeNavigation: true,
          selectedNavigationItemId: "active",
          selectedProblemId: "learn-a",
          topGames: [
            {
              ...h.game("active"),
              status: /** @type {const} */ ("active"),
              opponentName: "Top active",
            },
            h.game("waiting-top"),
            { ...h.event("a"), status: "waiting" },
            { ...h.game("pending"), status: "pending" },
            { ...h.event("a"), id: "event-dismissed", status: "dismissed" },
          ],
          pagedGames: [
            h.game("waiting-page"),
            {
              ...h.game("ended"),
              status: "ended",
              opponentName: "Paged ended",
            },
          ],
        });
        const list = h.required(h.scrollable());
        const rows = [
          ...list.querySelectorAll(
            'button:not([aria-label="Remove waiting game"])',
          ),
        ].map((row) => {
          if (!(row instanceof HTMLButtonElement))
            throw new Error("navigation-button-missing");
          return row;
        });
        return {
          labels: rows.map((row) => row.textContent),
          selected: rows
            .filter((row) => row.dataset.navigationSelected === "true")
            .map((row) => row.textContent),
          primary: rows
            .filter((row) => row.dataset.navigationSelectedPrimary === "true")
            .map((row) => row.textContent),
          completionIconsDiffer:
            h.required(h.required(rows[5]).querySelector("svg")).innerHTML !==
            h.required(h.required(rows[6]).querySelector("svg")).innerHTML,
        };
      });
      assert.deepEqual(initial.labels, [
        "Waiting for opponent",
        "Waiting for opponent",
        "Top active",
        "SOON",
        "AutomatchingNOW",
        "Learn A",
        "Learn B",
        "Paged endedlong ago",
      ]);
      assert.deepEqual(initial.selected, ["Top active", "Learn A"]);
      assert.deepEqual(initial.primary, ["Top active"]);
      assert.equal(initial.completionIconsDiffer, true);

      await page
        .getByRole("button", { name: "Top active", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Automatching NOW", exact: true })
        .click();
      await page.getByRole("button", { name: "SOON", exact: true }).click();
      await page.getByRole("button", { name: "Learn B", exact: true }).click();
      await page
        .getByRole("button", { name: "Home Board →", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Remove waiting game", exact: true })
        .first()
        .click();
      const actions = await page.evaluate(
        () => window.navigationHarness.interactions,
      );
      assert.deepEqual(actions.selections, [
        { id: "active", options: { status: "active" } },
        { id: "pending", options: { status: "pending" } },
        { id: "event_e", options: undefined },
      ]);
      assert.deepEqual(actions.removals, ["waiting-top"]);
      assert.deepEqual(actions.problems, ["learn-b"]);
      assert.equal(actions.home, 1);

      const selectedEvent = await page.evaluate(() => {
        const h = window.navigationHarness;
        h.updatePicker({
          selectedNavigationItemId: "event_e",
          removingGameInviteIds: new Set(["waiting-top"]),
        });
        const active = h.required(
          h
            .required(h.scrollable())
            .querySelector('[data-navigation-active="true"]'),
        );
        if (!(active instanceof HTMLElement))
          throw new Error("navigation-active-missing");
        return {
          text: active.textContent,
          selected: active.dataset.navigationSelected ?? null,
          background: getComputedStyle(active).backgroundColor,
        };
      });
      assert.deepEqual(selectedEvent, {
        text: "SOON",
        selected: null,
        background: "rgba(0, 0, 0, 0)",
      });
      assert.equal(
        await page
          .getByRole("button", { name: "Remove waiting game", exact: true })
          .first()
          .isDisabled(),
        true,
      );
    });
  },
);

test(
  "navigation event rows retain avatar limits, overflow, and the waiting slot",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const previews = await page.evaluate(() => {
        const h = window.navigationHarness;
        /** @param {string} id @param {number} count @param {unknown[]} ids @param {ReturnType<typeof h.event>["status"]} [status] @returns {ReturnType<typeof h.event>} */
        const makeEvent = (id, count, ids, status = "waiting") => ({
          ...h.event("a"),
          id,
          participantCount: count,
          status,
          participantPreview: ids.map((emojiId) => ({ emojiId })),
        });
        h.renderPicker({
          topGames: [
            makeEvent("one", 1, [1]),
            makeEvent("six", 6, [1, 2, 3, 4, 5, 6]),
            makeEvent("seven", 7, [1, 2, 3, 4, 5, 6, 7]),
            makeEvent("invalid", 7, [null, -2, "bad", 3.9, "4", 5, 6, 7, 8]),
          ],
        });
        return [...h.required(h.scrollable()).querySelectorAll("button")].map(
          (row) => ({
            images: row.querySelectorAll("img").length,
            hasWaitingSlot: !!row.querySelector('svg[stroke="currentColor"]'),
            text: row.textContent,
          }),
        );
      });
      assert.deepEqual(previews, [
        { images: 1, hasWaitingSlot: true, text: "SOON" },
        { images: 6, hasWaitingSlot: false, text: "SOON" },
        { images: 5, hasWaitingSlot: false, text: "+2SOON" },
        { images: 5, hasWaitingSlot: false, text: "+2SOON" },
      ]);
    });
  },
);

test(
  "navigation initial scrolling prioritizes selection and ignores later changes",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const initial = await page.evaluate(() => {
        const h = window.navigationHarness;
        const games = Array.from({ length: 45 }, (_, index) => ({
          ...h.game(`game-${index}`),
          status: /** @type {const} */ ("active"),
          opponentName: `Game ${index}`,
        }));
        h.setProblems([{ id: "learn", icon: "mana", label: "Learn" }]);
        h.renderPicker({
          topGames: games,
          selectedNavigationItemId: "game-40",
          selectedProblemId: "learn",
          hasMoreGames: true,
        });
        const list = h.required(h.scrollable());
        const row = h.required(
          list.querySelector('[data-navigation-selected-primary="true"]'),
        );
        return {
          scroll: list.scrollTop,
          rowBottom: row.getBoundingClientRect().bottom,
          bottom: list.getBoundingClientRect().bottom,
          rowText: row.textContent,
        };
      });
      assert.ok(initial.scroll > 0);
      assert.equal(initial.rowText, "Game 40");
      assert.ok(initial.rowBottom <= initial.bottom - 7);
      await settleScroll(page);
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        0,
      );
      const later = await page.evaluate(() => {
        const h = window.navigationHarness;
        const previous = h.required(h.scrollable()).scrollTop;
        h.updatePicker({ selectedNavigationItemId: "game-0" });
        return { previous, next: h.required(h.scrollable()).scrollTop };
      });
      assert.equal(later.next, later.previous);

      const reopened = await page.evaluate(() => {
        const h = window.navigationHarness;
        h.closePicker();
        h.updatePicker({ selectedNavigationItemId: "game-0" });
        return h.required(h.scrollable()).scrollTop;
      });
      assert.equal(reopened, 0);
      await settleScroll(page);
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        0,
      );
    });
  },
);

test(
  "navigation initial scrolling uses active events and does not chase async rows",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const result = await page.evaluate(() => {
        const h = window.navigationHarness;
        const games = Array.from({ length: 40 }, (_, index) => ({
          ...h.game(`game-${index}`),
          status: /** @type {const} */ ("active"),
          opponentName: `Game ${index}`,
        }));
        const activeEvent = { ...h.event("a"), id: "selected-event" };
        h.renderPicker({
          topGames: [...games, activeEvent],
          selectedNavigationItemId: "selected-event",
        });
        const eventScroll = h.required(h.scrollable()).scrollTop;
        h.closePicker();
        h.renderPicker({ selectedNavigationItemId: "game-39" });
        h.updatePicker({ topGames: games });
        return {
          eventScroll,
          asyncScroll: h.required(h.scrollable()).scrollTop,
        };
      });
      assert.ok(result.eventScroll > 0);
      assert.equal(result.asyncScroll, 0);
    });
  },
);

test(
  "navigation paging requires scrolling, respects loading, and allows one follow-up",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const h = window.navigationHarness;
        h.renderPicker({
          topGames: Array.from({ length: 45 }, (_, index) =>
            h.game(`game-${index}`),
          ),
          hasMoreGames: true,
        });
      });
      await settleScroll(page);
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        0,
      );
      assert.equal(await dispatchScroll(page, 1), 0);
      assert.equal(await dispatchScroll(page), 1);
      assert.equal(await dispatchScroll(page), 1);
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isLoadingMoreGames: true }),
      );
      assert.equal(await dispatchScroll(page), 1);
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isLoadingMoreGames: false }),
      );
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        2,
      );
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isLoadingMoreGames: true }),
      );
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isLoadingMoreGames: false }),
      );
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        2,
      );
      assert.equal(await dispatchScroll(page), 3);
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({
          isLoadingMoreGames: true,
          hasMoreGames: false,
        }),
      );
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isLoadingMoreGames: false }),
      );
      assert.equal(await dispatchScroll(page), 3);
    });
  },
);

test(
  "navigation fills short lists after loading and resets paging gates when reopened",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() =>
        window.navigationHarness.renderPicker({
          hasMoreGames: true,
          isGamesLoading: true,
        }),
      );
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        0,
      );
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isGamesLoading: false }),
      );
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        1,
      );
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isLoadingMoreGames: true }),
      );
      await page.evaluate(() =>
        window.navigationHarness.updatePicker({ isLoadingMoreGames: false }),
      );
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        2,
      );
      await page.evaluate(() => {
        const h = window.navigationHarness;
        h.closePicker();
        h.renderPicker({
          topGames: Array.from({ length: 45 }, (_, index) =>
            h.game(`game-${index}`),
          ),
          hasMoreGames: true,
        });
      });
      await settleScroll(page);
      assert.equal(
        await page.evaluate(() => window.navigationHarness.interactions.loads),
        2,
      );
      assert.equal(await dispatchScroll(page), 3);
    });
  },
);
