import { required } from "./fixtures/canonicalData.mjs";
import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
const { chromium, devices } = require(
  process.env.MONS_PLAYWRIGHT_PATH || "playwright",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const sharedManifest = JSON.parse(
  readFileSync(
    new URL("../cloud/runtime/shared/package.json", import.meta.url),
    "utf8",
  ),
);
const environmentSource = `
export const environment = {
  calls: [],
  owner: { authStatus: 'authenticated', profileId: 'profile-a', solAddress: '11111111111111111111111111111111', ethAddress: '' },
  selection: { avatarId: null, specialIds: new Set() },
  aura: 'none',
  playing: false,
  musicListeners: new Set(),
  subscriptionStarts: 0,
  subscriptionStops: 0,
  nftRequests: [],
  pendingNfts: [],
  deferNfts: false,
  prizeSubscriptions: new Set(),
};
export const snapshot = (avatarId = 9) => ({
  data: { ok: true, swagpack_avatars: [{ id: avatarId, count: 3 }], specials: [{ id: 1, count: 1 }] },
  expiresAtMs: Date.now() + 600000,
});
export const fetchNftsForIdentity = async identity => {
  environment.nftRequests.push({ ...identity });
  if (environment.deferNfts) return new Promise(resolve => environment.pendingNfts.push({ identity: { ...identity }, resolve }));
  return snapshot();
};
export const getNftIdentityKey = identity => identity?.profileId
  ? JSON.stringify([identity.profileId, identity.solAddress, identity.ethAddress]) : null;
export const storage = {
  getAuthIdentity: () => environment.owner,
  getPlayerEmojiAura: () => environment.aura,
  getPreferredAssetsSet: fallback => fallback,
  getBoardStyleSet: fallback => fallback,
  setBoardStyleSet: () => {},
  getBoardColorSetsByTheme: fallback => fallback,
  getIsExperimentingWithSprites: fallback => fallback,
  getLeaderboardType: fallback => fallback,
  setLeaderboardType: value => environment.calls.push(['leaderboard', value]),
  getUsername: () => '',
};
export const getActiveInventoryItemSelection = () => environment.selection;
export const setOwnershipVerifiedIdCardEmoji = (id, aura) => {
  environment.calls.push(['avatar', id, aura]);
  environment.selection = { ...environment.selection, avatarId: id - 1000 };
  environment.aura = aura;
};
export const setOwnershipVerifiedSpecialItem = id => {
  environment.calls.push(['special', id]);
  environment.selection = { ...environment.selection, specialIds: new Set([id]) };
};
export const showsShinyCardSomewhere = false;
export const hideShinyCard = () => environment.calls.push(['shiny-close']);
export const subscribeToProfileEventPrizes = (profileId, update) => {
  const subscription = { profileId };
  environment.prizeSubscriptions.add(subscription);
  update({});
  return () => environment.prizeSubscriptions.delete(subscription);
};
export const withdrawProfileEventPrize = async () => ({ ok: true, status: 'completed' });
export const setPlaying = playing => {
  environment.playing = playing;
  environment.musicListeners.forEach(listener => listener());
};
export const getIsMusicPlaying = () => environment.playing;
export const subscribeToMusicPlayback = listener => {
  environment.subscriptionStarts++;
  environment.musicListeners.add(listener);
  return () => { environment.subscriptionStops++; environment.musicListeners.delete(listener); };
};
export const setMusicMuted = muted => environment.calls.push(['muted', muted]);
export const startPlayingMusic = () => { environment.calls.push(['play']); setPlaying(true); };
export const stopPlayingMusic = () => { environment.calls.push(['stop']); setPlaying(false); };
export const playNextTrack = () => environment.calls.push(['next']);
export const playPreviousTrack = () => environment.calls.push(['previous']);
`;
const harnessSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import MainMenu from '/src/ui/MainMenu.tsx';
import { TopRightControls } from '/src/ui/TopRightControls.tsx';
import * as menu from '/src/ui/controls/menuPort.ts';
import * as outside from '/src/ui/controls/outsideTapState.ts';
import * as session from '/src/ui/uiSession.ts';
import { bindBottomControlsApi } from '/src/ui/controls/bottomControlsPort.ts';
import { registerProfileSignInApi } from '/src/ui/identity/profileUiPort.ts';
import { preventTouchstartIfNeeded } from '/src/runtime/touchInputGuard.ts';
import { isMobile, defaultEarlyInputEventName } from '/src/utils/misc.ts';
import { environment, setPlaying, snapshot } from 'top-right-environment';
import '/src/index.css';

bindBottomControlsApi({ closeNavigationAndAppearancePopupIfAny: () => environment.calls.push(['bottom-close']) });
registerProfileSignInApi({ close: () => environment.calls.push(['profile-close']), hasVisiblePopup: () => false });
session.registerBottomControlsTransientUiHandler(options => environment.calls.push(['bottom-transient', options]), () => environment.calls.push(['match-clear']));
session.registerProfileTransientUiHandler(() => environment.calls.push(['notification-close']), () => environment.calls.push(['profile-transient']));
session.registerBoardTransientUiHandler(fade => environment.calls.push(['board-transient', fade]));

let root;
let props = { authState: environment.owner, isMuted: false, isVisible: true, callbackVersion: 1 };
let showMainMenu = window.fixtureOptions.mainMenu;
const getState = () => ({
  visible: menu.hasMainMenuPopupsVisible(),
  activeId: document.activeElement?.id || null,
  activeLabel: document.activeElement?.getAttribute('aria-label') || null,
  expanded: [...document.querySelectorAll('.small-top-control-buttons button[aria-expanded="true"]')].map(node => node.id),
  activeMusicSubscriptions: environment.musicListeners.size,
  activePrizeSubscriptions: environment.prizeSubscriptions.size,
  outsideDismissed: !outside.didNotDismissAnythingWithOutsideTapJustNow(),
});
const render = (patch = {}) => {
  props = { ...props, ...patch };
  environment.owner = props.authState;
  const version = props.callbackVersion;
  if (!root) root = createRoot(document.getElementById('root'));
  flushSync(() => root.render(React.createElement(React.StrictMode, null,
    React.createElement('div', { className: 'top-buttons-container' },
      React.createElement(TopRightControls, {
        ...props,
        onBeforeOpen: () => {
          environment.calls.push(['before-open', version, menu.hasMainMenuPopupsVisible()]);
          menu.closeAllKindsOfPopups();
          environment.calls.push(['after-before-open', menu.hasMainMenuPopupsVisible()]);
        },
        onToggleMute: () => { environment.calls.push(['toggle-mute', version]); render({ isMuted: !props.isMuted }); },
        onOpenSettings: id => environment.calls.push(['settings', id, version, menu.hasMainMenuPopupsVisible()]),
        onRequestLogout: id => environment.calls.push(['logout', id, version, menu.hasMainMenuPopupsVisible()]),
      })),
    showMainMenu ? React.createElement(MainMenu) : null)));
};
document.getElementById('prevented').addEventListener(defaultEarlyInputEventName, event => event.preventDefault());
if (isMobile) document.addEventListener('touchstart', preventTouchstartIfNeeded, { passive: false });
window.topRightHarness = {
  required(value) { if (value === null || value === undefined) throw new Error("top-right-fixture-value-missing"); return value; },
  environment, render, getState, isMobile,
  clearCalls() { environment.calls.length = 0; },
  invoke(name) { flushSync(() => (menu[name] || session[name])()); return getState(); },
  conditionalClose(id) {
    const event = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(event, 'target', { value: document.getElementById(id) });
    flushSync(() => menu.closeMenuAndInfoIfAllowedForEvent(event));
    return getState();
  },
  setPlaying(value) { flushSync(() => setPlaying(value)); },
  setIdentity(patch) { render({ authState: { ...props.authState, ...patch } }); },
  setMainMenu(value) { showMainMenu = value; render(); },
  resolveNfts(profileId, avatarId) {
    const pending = environment.pendingNfts.filter(request => request.identity.profileId === profileId);
    environment.pendingNfts = environment.pendingNfts.filter(request => request.identity.profileId !== profileId);
    pending.forEach(request => request.resolve(snapshot(avatarId)));
  },
  unmount() { flushSync(() => root.unmount()); root = null; return getState(); },
};
render();
`;

/** @param {string} value */
const normalizedSource = (value) => value.replace(/\.(ts|tsx|js|jsx)$/, "");
const stubSources = new Map([
  ["services/nftService", environmentSource],
  ["utils/storage", environmentSource],
  ["ui/shinyCardUiPort", environmentSource],
  ["ui/profileSurfaceDataPort", environmentSource],
  ["content/music", environmentSource],
  [
    "hooks/useGameAssets",
    "export const useGameAssets = () => ({ assets: null });",
  ],
  ["hooks/useEmojis", "export const useEmojis = () => ({ emojis: null });"],
  ["hooks/useMaterialImages", "export const useMaterialImages = () => ({});"],
  [
    "ui/Leaderboard",
    "import React from 'react'; export const LEADERBOARD_TYPE_ICON_URLS = {}; export const Leaderboard = ({ show }) => React.createElement('div', { id: 'leaderboard', 'data-open': String(show) }, 'Leaderboard fixture');",
  ],
  ["ui/event/EventCreateForm", "export const EventCreateForm = () => null;"],
  [
    "ui/event/useEventCreateForm",
    "export const useEventCreateForm = () => ({ resetForOpen() {} });",
  ],
]);
const resolvedStubs = new Map(
  [...stubSources].map(([name, source]) => [
    path.join(repository, "src", name),
    source,
  ]),
);
/** @type {import("vite").ViteDevServer | undefined} */
let server;
/** @type {import("playwright").Browser | undefined} */
let browser;
/** @type {string} */
let origin;

before(async () => {
  server = await createServer({
    root: repository,
    configFile: false,
    logLevel: "error",
    cacheDir: `node_modules/.vite-top-right-controls-${process.pid}`,
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "styled-components",
        ...Object.keys(sharedManifest.exports).map(
          (subpath) => sharedManifest.name + subpath.slice(1),
        ),
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    plugins: [
      {
        name: "top-right-controls-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== "/__top-right") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><div id="outside" style="position:fixed;left:5px;bottom:80px;width:60px;height:40px">Outside</div><button id="outside-button" style="position:fixed;left:5px;bottom:130px">Other button</button><input id="outside-input" aria-label="Other input" style="position:fixed;left:5px;bottom:180px;width:80px"><button id="prevented" style="position:fixed;left:5px;bottom:230px">Prevented</button><script type="module" src="/__top-right-harness.js"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/__top-right-harness.js") return "\0top-right-harness";
          if (id === "top-right-environment") return "\0top-right-environment";
          if (importer && id.startsWith(".")) {
            const resolved = normalizedSource(
              path.resolve(path.dirname(importer), id),
            );
            const source = resolvedStubs.get(resolved);
            if (source === environmentSource) return "\0top-right-environment";
            if (source) return "\0top-right-stub:" + resolved;
          }
        },
        load(id) {
          if (id === "\0top-right-harness") return harnessSource;
          if (id === "\0top-right-environment") return environmentSource;
          if (id.startsWith("\0top-right-stub:"))
            return resolvedStubs.get(id.slice("\0top-right-stub:".length));
        },
      },
    ],
  });
  await server.listen();
  origin = browserServerOrigin(server);
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

/** @param {(page: import("playwright").Page, activate: (locator: import("playwright").Locator) => Promise<void>) => Promise<void>} run @param {{mobile?: boolean, mainMenu?: boolean}} [options] */
async function fixture(run, { mobile = false, mainMenu = false } = {}) {
  const context = await required(browser).newContext({
    ...(mobile
      ? devices["iPhone 13"]
      : { viewport: { width: 1000, height: 800 } }),
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(10000);
  await context.addInitScript(
    (options) => {
      window.fixtureOptions = options;
    },
    { mainMenu },
  );
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === "https://cdn.lil.org")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
      });
    return route.abort();
  });
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/__top-right`);
    await page.locator("#top-right-more-button").waitFor();
    assert.equal(
      await page.evaluate(() => window.topRightHarness.isMobile),
      mobile,
    );
    await run(page, async (locator) =>
      mobile ? locator.tap() : locator.click(),
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    if (errors.length) throw new AggregateError([error, ...errors]);
    throw error;
  } finally {
    await context.close();
  }
}

/** @param {import("playwright").Page} page */
const state = (page) => page.evaluate(() => window.topRightHarness.getState());
/** @param {import("playwright").Page} page */
const calls = (page) =>
  page.evaluate(() => window.topRightHarness.environment.calls);
/** @param {import("playwright").Page} page @param {string} name */
const trigger = (page, name) => page.locator(`#top-right-${name}-button`);
/** @param {import("playwright").Page} page @param {string} name */
const popover = (page, name) => page.locator(`#top-right-${name}-popover`);
/** @param {import("playwright").Page} page @param {string} selector */
const focusIs = (page, selector) =>
  page.waitForFunction(
    (selector) => document.activeElement === document.querySelector(selector),
    selector,
  );
/** @param {import("playwright").Page} page */
const frames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
/** @param {import("playwright").Page} page */
const clearCalls = (page) =>
  page.evaluate(() => window.topRightHarness.clearCalls());
/** @param {import("playwright").Page} page @param {string} name */
const invoke = (page, name) =>
  page.evaluate((name) => window.topRightHarness.invoke(name), name);
/** @param {import("playwright").Page} page @param {string} name @param {(locator: import("playwright").Locator) => Promise<void>} [activate] */
const open = async (page, name, activate = (locator) => locator.click()) => {
  await activate(trigger(page, name));
  await focusIs(
    page,
    name === "music"
      ? '[aria-label="Previous track"]'
      : `#top-right-${name === "gem" ? "inventory" : name}-popover`,
  );
};

test(
  "top-right controls preserve IDs, ARIA, toggle semantics, and current callback ordering",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const [name, label, controlled] of /** @type {const} */ ([
        ["more", "More", "more"],
        ["music", "Music", "music"],
        ["gem", "Collectibles", "inventory"],
      ])) {
        assert.equal(
          await trigger(page, name).getAttribute("aria-label"),
          label,
        );
        assert.equal(
          await trigger(page, name).getAttribute("aria-haspopup"),
          "dialog",
        );
        assert.equal(
          await trigger(page, name).getAttribute("aria-controls"),
          `top-right-${controlled}-popover`,
        );
        assert.equal(
          await trigger(page, name).getAttribute("aria-expanded"),
          "false",
        );
        assert.equal(
          await trigger(page, name).getAttribute("class"),
          `${name}-button`,
        );
      }
      await clearCalls(page);
      await open(page, "more");
      assert.deepEqual(await calls(page), [
        ["before-open", 1, false],
        ["profile-close"],
        ["bottom-close"],
        ["after-before-open", false],
      ]);
      assert.equal((await state(page)).visible, true);
      await trigger(page, "more").click();
      assert.equal((await state(page)).visible, false);
      assert.equal(
        (await calls(page)).filter((call) => call[0] === "before-open").length,
        1,
      );
      await open(page, "more");
      await open(page, "music");
      assert.deepEqual((await state(page)).expanded, [
        "top-right-music-button",
      ]);
      await page.evaluate(() =>
        window.topRightHarness.render({ callbackVersion: 2 }),
      );
      await open(page, "more");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      assert.deepEqual((await calls(page)).at(-1), [
        "settings",
        "top-right-more-button",
        2,
        false,
      ]);
      await open(page, "more");
      await page.getByRole("button", { name: "Log Out", exact: true }).click();
      assert.deepEqual((await calls(page)).at(-1), [
        "logout",
        "top-right-more-button",
        2,
        false,
      ]);
    });
  },
);

test(
  "opening and Escape focus each dialog and its matching trigger",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const name of /** @type {const} */ (["more", "music", "gem"])) {
        await open(page, name);
        await page.keyboard.press("Escape");
        await focusIs(page, `#top-right-${name}-button`);
        assert.equal((await state(page)).visible, false);
      }
      await page.evaluate(() =>
        window.topRightHarness.setIdentity({ authStatus: "unauthenticated" }),
      );
      assert.equal(
        await trigger(page, "info").getAttribute("aria-label"),
        "Info",
      );
      assert.equal(
        await trigger(page, "info").getAttribute("aria-controls"),
        "top-right-info-popover",
      );
      await trigger(page, "info").focus();
      await page.keyboard.press("Enter");
      await focusIs(page, "#top-right-info-popover");
      await page.keyboard.press("Escape");
      await focusIs(page, "#top-right-info-button");
      assert.equal((await state(page)).visible, false);
    });
  },
);

test(
  "outside input restores abandoned focus without stealing focus claimed elsewhere",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await open(page, "more");
      await page.locator("#outside").click();
      await focusIs(page, "#top-right-more-button");
      assert.equal((await state(page)).outsideDismissed, true);
      for (const id of /** @type {const} */ ([
        "outside-button",
        "outside-input",
      ])) {
        await open(page, "music");
        await page.locator(`#${id}`).click();
        await frames(page);
        await focusIs(page, `#${id}`);
        assert.equal((await state(page)).visible, false);
      }
      await open(page, "more");
      await page.locator("#prevented").click();
      await focusIs(page, "#top-right-more-button");
      await open(page, "more");
      await page.locator("#outside-input").focus();
      const outsideBox = required(await page.locator("#outside").boundingBox());
      await page.mouse.move(outsideBox.x + 5, outsideBox.y + 5);
      await page.mouse.down();
      await page.mouse.up();
      await frames(page);
      assert.notEqual((await state(page)).activeId, "top-right-more-button");
      await open(page, "music");
      await page.locator("#outside-button").focus();
      await invoke(page, "closeMenuAndInfoIfAny");
      await frames(page);
      await focusIs(page, "#outside-button");
      await open(page, "more");
      await page.evaluate(() => {
        window.topRightHarness
          .required(document.getElementById("outside"))
          .addEventListener(
            "mousedown",
            () => window.topRightHarness.unmount(),
            {
              once: true,
            },
          );
      });
      await page.locator("#outside").click();
      await frames(page);
      assert.equal((await state(page)).visible, false);
      assert.equal(await trigger(page, "more").count(), 0);
    });
  },
);

for (const mobile of /** @type {const} */ ([false, true])) {
  test(
    `inventory portal keeps its parent open and supports two-stage Escape (${mobile ? "touch" : "mouse"})`,
    { timeout: 60000 },
    async () => {
      await fixture(
        async (page, activate) => {
          await open(page, "gem", activate);
          const tile = page.getByRole("button", {
            name: "View avatar 1009",
            exact: true,
          });
          await activate(tile);
          const preview = page.getByRole("dialog", {
            name: "Avatar 1009",
            exact: true,
          });
          await preview.waitFor();
          await focusIs(page, '[role="dialog"][aria-label="Avatar 1009"]');
          assert.equal(await popover(page, "inventory").isVisible(), true);
          await activate(
            page.getByRole("button", { name: "Set avatar", exact: true }),
          );
          assert.equal((await state(page)).visible, true);
          assert.deepEqual(
            (await calls(page)).find((call) => call[0] === "avatar"),
            ["avatar", 1009, "rainbow"],
          );
          await page.keyboard.press("Escape");
          await preview.waitFor({ state: "hidden" });
          await focusIs(page, '[aria-label="View avatar 1009, current"]');
          assert.equal((await state(page)).visible, true);
          await page.keyboard.press("Escape");
          await focusIs(page, "#top-right-gem-button");
          assert.equal((await state(page)).visible, false);
          await open(page, "gem", activate);
          await page.keyboard.press("Enter");
          await focusIs(page, "#top-right-gem-button");
          assert.equal((await state(page)).visible, false);
          assert.equal((await state(page)).outsideDismissed, true);
        },
        { mobile },
      );
    },
  );
}

test(
  "inventory preview outside dismissal restores its tile and preserves the parent",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await open(page, "gem");
      await page
        .getByRole("button", { name: "View collectible 1", exact: true })
        .click();
      const preview = page.getByRole("dialog", {
        name: "Collectible 1",
        exact: true,
      });
      await preview.waitFor();
      await preview.locator("img").click({ force: true });
      await preview.waitFor({ state: "hidden" });
      await focusIs(page, '[aria-label="View collectible 1"]');
      assert.equal((await state(page)).visible, true);
      assert.equal((await state(page)).outsideDismissed, true);
    });
  },
);

test(
  "auth and visibility changes invalidate only the currently incompatible popover",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await open(page, "more");
      await page.evaluate(() =>
        window.topRightHarness.setIdentity({ authStatus: "unauthenticated" }),
      );
      assert.equal((await state(page)).visible, false);
      await open(page, "info");
      await page.evaluate(() =>
        window.topRightHarness.setIdentity({ authStatus: "authenticated" }),
      );
      assert.equal((await state(page)).visible, false);
      await open(page, "music");
      await page.evaluate(() =>
        window.topRightHarness.setIdentity({ authStatus: "unauthenticated" }),
      );
      assert.deepEqual((await state(page)).expanded, [
        "top-right-music-button",
      ]);
      await page.evaluate(() =>
        window.topRightHarness.render({ isVisible: false }),
      );
      assert.equal((await state(page)).visible, false);
      assert.equal(await page.locator(".small-top-control-buttons").count(), 0);
      await page.evaluate(() =>
        window.topRightHarness.render({ isVisible: true }),
      );
      assert.equal((await state(page)).visible, false);
      await open(page, "gem");
      await page.evaluate(() =>
        window.topRightHarness.setIdentity({ authStatus: "authenticated" }),
      );
      assert.deepEqual((await state(page)).expanded, ["top-right-gem-button"]);
      await page.evaluate(() =>
        window.topRightHarness.render({ isVisible: false }),
      );
      assert.equal(await popover(page, "inventory").count(), 0);
      await page.evaluate(() =>
        window.topRightHarness.render({ isVisible: true }),
      );
      assert.equal((await state(page)).visible, false);
    });
  },
);

test(
  "the parent preserves inventory on rerender and resets it for each identity key field",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await open(page, "gem");
      const preview = page.getByRole("dialog", {
        name: "Avatar 1009",
        exact: true,
      });
      const openPreview = async () => {
        await page
          .getByRole("button", { name: "View avatar 1009", exact: true })
          .click();
        await preview.waitFor();
      };
      await openPreview();
      await page.evaluate(() =>
        window.topRightHarness.render({ callbackVersion: 2 }),
      );
      assert.equal(await preview.isVisible(), true);
      for (const patch of /** @type {const} */ ([
        { profileId: "profile-b" },
        { solAddress: "22222222222222222222222222222222" },
        { ethAddress: "0x1234" },
        { authStatus: "unauthenticated" },
      ])) {
        await page.evaluate(
          (patch) => window.topRightHarness.setIdentity(patch),
          patch,
        );
        await preview.waitFor({ state: "hidden" });
        assert.equal((await state(page)).visible, true);
        assert.equal(await popover(page, "inventory").isVisible(), true);
        await openPreview();
      }
    });
  },
);

test(
  "a parent identity replacement ignores late inventory data from the previous identity",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        window.topRightHarness.environment.deferNfts = true;
      });
      await open(page, "gem");
      await page.waitForFunction(() =>
        window.topRightHarness.environment.pendingNfts.some(
          (request) => request.identity.profileId === "profile-a",
        ),
      );
      await page.evaluate(() =>
        window.topRightHarness.setIdentity({ profileId: "profile-b" }),
      );
      await page.waitForFunction(() =>
        window.topRightHarness.environment.pendingNfts.some(
          (request) => request.identity.profileId === "profile-b",
        ),
      );
      await page.evaluate(() =>
        window.topRightHarness.resolveNfts("profile-b", 11),
      );
      await page
        .getByRole("button", { name: "View avatar 1011", exact: true })
        .waitFor();
      await page.evaluate(() =>
        window.topRightHarness.resolveNfts("profile-a", 9),
      );
      await frames(page);
      assert.equal(
        await page
          .getByRole("button", { name: "View avatar 1009", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "View avatar 1011", exact: true })
          .count(),
        1,
      );
    });
  },
);

test(
  "music follows external playback, mute props, and StrictMode subscription cleanup",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      assert.equal((await state(page)).activeMusicSubscriptions, 1);
      const initialCounts = await page.evaluate(
        () =>
          /** @type {const} */ ([
            window.topRightHarness.environment.subscriptionStarts,
            window.topRightHarness.environment.subscriptionStops,
          ]),
      );
      assert.ok(initialCounts[0] >= 2);
      assert.equal(initialCounts[0] - initialCounts[1], 1);
      await open(page, "music");
      await clearCalls(page);
      await page
        .getByRole("button", { name: "Previous track", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Next track", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Play music", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Stop music", exact: true })
        .click();
      assert.deepEqual(await calls(page), [
        ["previous"],
        ["next"],
        ["play"],
        ["stop"],
      ]);
      await page.evaluate(() => window.topRightHarness.setPlaying(true));
      await page
        .getByRole("button", { name: "Stop music", exact: true })
        .waitFor();
      await page.evaluate(() => window.topRightHarness.setPlaying(false));
      await page
        .getByRole("button", { name: "Play music", exact: true })
        .waitFor();
      await clearCalls(page);
      await page
        .getByRole("button", { name: "Mute all audio", exact: true })
        .click();
      assert.deepEqual(await calls(page), [
        ["toggle-mute", 1],
        ["muted", true],
      ]);
      assert.equal(
        await page
          .getByRole("button", { name: "Unmute all audio", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.evaluate(() =>
        window.topRightHarness.render({ isMuted: false, callbackVersion: 3 }),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Mute all audio", exact: true })
          .getAttribute("aria-pressed"),
        "false",
      );
      await page.evaluate(() => window.topRightHarness.unmount());
      assert.equal((await state(page)).activeMusicSubscriptions, 0);
      assert.equal((await state(page)).visible, false);
      await page.evaluate(() => {
        window.topRightHarness.setPlaying(true);
        window.topRightHarness.render();
      });
      assert.equal((await state(page)).activeMusicSubscriptions, 1);
      assert.equal((await state(page)).visible, false);
      await open(page, "music");
      await page
        .getByRole("button", { name: "Stop music", exact: true })
        .waitFor();
    });
  },
);

test(
  "menu commands, conditional closing, and transient reset retain live bindings through remounts",
  { timeout: 60000 },
  async () => {
    await fixture(
      async (page) => {
        for (const command of /** @type {const} */ ([
          "closeMenuAndInfoIfAny",
          "closeAllKindsOfPopups",
          "closeTransientUi",
        ])) {
          await open(page, "music");
          await clearCalls(page);
          const result = await invoke(page, command);
          assert.equal(result.visible, false);
          if (command === "closeAllKindsOfPopups")
            assert.deepEqual(await calls(page), [
              ["profile-close"],
              ["bottom-close"],
            ]);
          if (command === "closeTransientUi")
            assert.deepEqual(await calls(page), [
              ["bottom-transient", { preserveNavigationSelection: true }],
              ["match-clear"],
              ["profile-transient"],
              ["notification-close"],
              ["shiny-close"],
              ["board-transient", false],
            ]);
        }
        await open(page, "more");
        const unchanged = await page.evaluate(() =>
          window.topRightHarness.conditionalClose("outside"),
        );
        assert.equal(unchanged.visible, true);
        const rock = page
          .locator("button")
          .filter({ has: page.locator('img[alt=""]') });
        await rock.hover();
        await page.waitForFunction(
          () => document.getElementById("leaderboard")?.dataset.open === "true",
        );
        assert.deepEqual((await state(page)).expanded, []);
        assert.equal((await state(page)).visible, true);
        await page.evaluate(() =>
          window.topRightHarness.conditionalClose("leaderboard"),
        );
        assert.equal((await state(page)).visible, true);
        await page.evaluate(() =>
          window.topRightHarness.conditionalClose("outside"),
        );
        assert.equal((await state(page)).visible, false);
        await open(page, "gem");
        await page.evaluate(() => window.topRightHarness.unmount());
        assert.equal((await state(page)).visible, false);
        assert.equal((await state(page)).activePrizeSubscriptions, 0);
        for (const command of /** @type {const} */ ([
          "closeMenuAndInfoIfAny",
          "closeAllKindsOfPopups",
          "closeTransientUi",
        ]))
          await invoke(page, command);
        await page.evaluate(() => window.topRightHarness.render());
        assert.equal((await state(page)).visible, false);
        await open(page, "more");
        await invoke(page, "closeTransientUi");
        assert.equal((await state(page)).visible, false);
        await open(page, "music");
        await page.evaluate(() => window.topRightHarness.setMainMenu(false));
        assert.equal((await state(page)).visible, true);
        await invoke(page, "closeMenuAndInfoIfAny");
        assert.equal((await state(page)).visible, false);
      },
      { mainMenu: true },
    );
  },
);
