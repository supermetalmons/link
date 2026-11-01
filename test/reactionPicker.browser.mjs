import { required } from "./fixtures/canonicalData.mjs";
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
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=";
const environmentSource = `
export const environment = {
  now: 1000000,
  storedIdentity: null,
  cache: null,
  writes: [],
  requests: [],
  imageRequests: [],
  failingImages: new Set(),
  rejectIdentityReads: false,
};
`;
const nftSource = `
import { environment } from 'reaction-environment';
export const NFT_CACHE_TTL_MS = 300000;
export const getNftIdentityKey = ({ profileId, solAddress, ethAddress }) =>
  profileId ? JSON.stringify([profileId, solAddress || '', ethAddress || '']) : null;
export const fetchNftsForIdentity = identity => new Promise((resolve, reject) =>
  environment.requests.push({ identity, resolve, reject, settled: false }));
`;
const storageSource = `
import { environment } from 'reaction-environment';
export const storage = {
  getAuthIdentity: () => {
    if (environment.rejectIdentityReads) throw new Error('storage unavailable');
    return environment.storedIdentity;
  },
  getReactionExtraStickerCache: fallback => environment.cache || fallback,
  setReactionExtraStickerCache: cache => {
    environment.cache = cache;
    environment.writes.push(cache);
  },
};
`;
const harnessSource = `
import React, { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FIXED_STICKER_IDS } from '@mons/shared/reactions';
import { VALID_REACTION_IDS } from '@mons/shared/nfts';
import { useReactionPicker } from '/src/ui/controls/useReactionPicker.ts';
import { environment } from 'reaction-environment';
const identities = new Map();
const identity = profileId => {
  if (!identities.has(profileId)) identities.set(profileId, {
    authStatus: profileId ? 'authenticated' : 'unauthenticated',
    profileId,
    solAddress: profileId ? 'sol-' + profileId : '',
    ethAddress: '',
  });
  return identities.get(profileId);
};
environment.storedIdentity = identity('a');
Date.now = () => environment.now;
const originalFetch = window.fetch.bind(window);
window.fetch = async (url, options) => {
  if (typeof url !== 'string' || !url.startsWith('https://cdn.lil.org/mons/emojipack/swagpack/64/')) {
    return originalFetch(url, options);
  }
  const id = Number(url.split('/').pop().split('.')[0]);
  environment.imageRequests.push(id);
  if (environment.failingImages.has(id)) throw new Error('temporary image failure');
  return new Response(Uint8Array.from(atob('${pixel}'), character => character.charCodeAt(0)), {
    headers: { 'Content-Type': 'image/png' },
  });
};
const root = createRoot(document.getElementById('root'));
const commits = [];
const clicks = [];
let current;
function Probe({ profileId, isOpen }) {
  const picker = useReactionPicker({ authState: identity(profileId), isOpen });
  const state = {
    profileId,
    visibleStickerIds: [...picker.visibleStickerIds],
    hasFreshStickerEntitlement: picker.hasFreshStickerEntitlement,
    stickerUrls: picker.stickerUrls,
  };
  useLayoutEffect(() => { current = picker; commits.push(state); });
  return React.createElement(React.Fragment, null,
    React.createElement('pre', { id: 'state' }, JSON.stringify(state)),
    isOpen ? picker.visibleStickerIds.map(id => React.createElement('button', {
      key: id,
      id: 'sticker-' + id,
      onClick: () => clicks.push({ id, allowed: picker.canSendSticker(id) }),
    }, React.createElement('img', {
      alt: 'Sticker ' + id,
      src: picker.stickerUrls[id] || 'https://cdn.lil.org/mons/emojipack/swagpack/64/' + id + '.webp',
    }))) : null);
}
window.reactionPickerHarness = {
  required(value) { if (value === null || value === undefined) throw new Error("picker-fixture-value-missing"); return value; },
  environment,
  fixed: [...FIXED_STICKER_IDS],
  extra: VALID_REACTION_IDS.filter(id => !FIXED_STICKER_IDS.includes(id)),
  commits,
  clicks,
  render(profileId = 'a', isOpen = true) {
    flushSync(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(Probe, { profileId, isOpen }))));
  },
  setOwner(profileId) { environment.storedIdentity = identity(profileId); },
  seed(profileId, extraIds, expiresAtMs) {
    const { authStatus, ...owner } = identity(profileId);
    environment.cache = { ...owner, extraIds, expiresAtMs };
  },
  snapshot() { return JSON.parse(document.getElementById('state').textContent); },
  canSend(id) { return current.canSendSticker(id); },
  async resolve(index, ids = [], expiresAtMs = environment.now + 10000, ok = true) {
    const request = environment.requests[index];
    request.settled = true;
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => {
        request.resolve({ data: { ok, swagpack_reactions: ids.map(id => ({ id })) }, expiresAtMs });
      });
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  },
  dispose() { flushSync(() => root.unmount()); },
};
`;

/** @param {(page: import("playwright").Page) => Promise<void>} run */
async function fixture(run) {
  const virtualModules = new Map([
    ["reaction-environment", environmentSource],
    ["reaction-nfts", nftSource],
    ["reaction-storage", storageSource],
    ["reaction-harness", harnessSource],
  ]);
  const server = await createServer({
    root: repository,
    cacheDir: `node_modules/.vite-reaction-picker-${process.pid}`,
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
        name: "reaction-browser-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__reaction") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/__reaction-harness.js"></script>',
            );
          });
        },
        resolveId(id) {
          if (id === "/__reaction-harness.js") return "\0reaction-harness";
          if (virtualModules.has(id)) return "\0" + id;
          if (/\/services\/nftService(?:\.ts)?$/.test(id))
            return "\0reaction-nfts";
          if (/\/utils\/storage(?:\.ts)?$/.test(id))
            return "\0reaction-storage";
        },
        load(id) {
          return id.startsWith("\0")
            ? virtualModules.get(id.slice(1))
            : undefined;
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
    const context = await browser.newContext();
    context.setDefaultTimeout(15000);
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      if (url.startsWith("https://cdn.lil.org/mons/emojipack/swagpack/64/"))
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(pixel, "base64"),
        });
      return route.abort();
    });
    const page = await context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/__reaction`);
    await page.waitForFunction(() => !!window.reactionPickerHarness);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

test(
  "fixed stickers remain usable when stored identity cannot be read",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const fixedId = await page.evaluate(() => {
        const h = window.reactionPickerHarness;
        h.environment.rejectIdentityReads = true;
        h.render("", true);
        return h.required(h.fixed[0]);
      });
      await page.locator(`#sticker-${fixedId}`).click();
      assert.deepEqual(
        await page.evaluate(() => window.reactionPickerHarness.clicks),
        [{ id: fixedId, allowed: true }],
      );
    });
  },
);

test(
  "expired extra stickers are rejected without reading unavailable storage",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const extraId = await page.evaluate(() => {
        const h = window.reactionPickerHarness;
        h.seed("a", [h.required(h.extra[0])], h.environment.now + 100);
        h.render();
        return h.required(h.extra[0]);
      });
      await page.locator(`#sticker-${extraId}`).click();
      await page.evaluate(() => {
        const h = window.reactionPickerHarness;
        h.environment.now += 100;
        h.environment.rejectIdentityReads = true;
      });
      await page.locator(`#sticker-${extraId}`).click();
      assert.deepEqual(
        await page.evaluate(() => window.reactionPickerHarness.clicks),
        [
          { id: extraId, allowed: true },
          { id: extraId, allowed: false },
        ],
      );
    });
  },
);

test(
  "reaction picker ignores delayed NFT responses after close, identity changes, and unmount",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const h = window.reactionPickerHarness;
        h.render();
        const mountRequests = h.environment.requests.length;
        h.render("a", false);
        for (let index = 0; index < mountRequests; index += 1)
          await h.resolve(index, [h.required(h.extra[0])]);
        const writesAfterClose = h.environment.writes.length;
        h.render();
        await h.resolve(h.environment.requests.length - 1, [
          h.required(h.extra[0]),
        ]);
        const reopened = h.snapshot();
        const ownedAllowed = h.canSend(h.required(h.extra[0]));
        h.render("a", false);
        h.render();
        const oldOwnerRequest = h.environment.requests.length - 1;
        h.setOwner("b");
        h.render("b");
        await h.resolve(oldOwnerRequest, [h.required(h.extra[0])]);
        const switched = h.snapshot();
        const writesAfterOldOwner = h.environment.writes.length;
        await h.resolve(h.environment.requests.length - 1, [
          h.required(h.extra[1]),
        ]);
        const currentOwner = h.snapshot();
        h.render("b", false);
        h.render("b");
        const unmountRequest = h.environment.requests.length - 1;
        h.dispose();
        await h.resolve(unmountRequest, [h.required(h.extra[2])]);
        return {
          fixed: h.fixed,
          extra: h.extra,
          mountRequests,
          writesAfterClose,
          reopened,
          ownedAllowed,
          switched,
          writesAfterOldOwner,
          currentOwner,
          writesAfterUnmount: h.environment.writes.length,
          leakingCommits: h.commits.filter(
            (state) =>
              state.profileId === "b" &&
              state.visibleStickerIds.includes(h.required(h.extra[0])),
          ),
        };
      });
      assert.equal(result.mountRequests, 2);
      assert.equal(result.writesAfterClose, 0);
      assert.deepEqual(result.reopened.visibleStickerIds, [
        ...result.fixed,
        result.extra[0],
      ]);
      assert.equal(result.reopened.hasFreshStickerEntitlement, true);
      assert.equal(result.ownedAllowed, true);
      assert.deepEqual(result.switched.visibleStickerIds, result.fixed);
      assert.equal(result.writesAfterOldOwner, 1);
      assert.deepEqual(result.currentOwner.visibleStickerIds, [
        ...result.fixed,
        result.extra[1],
      ]);
      assert.equal(result.writesAfterUnmount, 2);
      assert.deepEqual(result.leakingCommits, []);
    });
  },
);

test(
  "reaction picker keeps same-owner stale extras while enforcing current expiry and stored identity on clicks",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const h = window.reactionPickerHarness;
        h.seed("a", [h.required(h.extra[0])], h.environment.now + 100);
        h.render();
      });
      const ids = await page.evaluate(() => ({
        fixed: window.reactionPickerHarness.required(
          window.reactionPickerHarness.fixed[0],
        ),
        extra: window.reactionPickerHarness.required(
          window.reactionPickerHarness.extra[0],
        ),
      }));
      await page.locator(`#sticker-${ids.fixed}`).click();
      await page.locator(`#sticker-${ids.extra}`).click();
      await page.evaluate(() => {
        window.reactionPickerHarness.environment.now += 100;
      });
      await page.locator(`#sticker-${ids.extra}`).click();
      const stale = await page.evaluate(async () => {
        const h = window.reactionPickerHarness;
        h.render("a", false);
        h.render();
        for (let index = 0; index < h.environment.requests.length; index += 1)
          await h.resolve(index, [], 0, false);
        return {
          snapshot: h.snapshot(),
          clicks: [...h.clicks],
          writes: h.environment.writes.length,
        };
      });
      assert.deepEqual(stale.clicks, [
        { id: ids.fixed, allowed: true },
        { id: ids.extra, allowed: true },
        { id: ids.extra, allowed: false },
      ]);
      assert.equal(stale.snapshot.visibleStickerIds.includes(ids.extra), true);
      assert.equal(stale.snapshot.hasFreshStickerEntitlement, false);
      assert.equal(stale.writes, 0);
      await page.evaluate(() => {
        const h = window.reactionPickerHarness;
        h.seed("a", [h.required(h.extra[0])], h.environment.now + 1000);
        h.render("a", false);
        h.render();
      });
      await page.locator(`#sticker-${ids.extra}`).click();
      await page.evaluate(() => window.reactionPickerHarness.setOwner("b"));
      await page.locator(`#sticker-${ids.extra}`).click();
      await page.locator(`#sticker-${ids.fixed}`).click();
      assert.deepEqual(
        await page.evaluate(() =>
          window.reactionPickerHarness.clicks.slice(-3),
        ),
        [
          { id: ids.extra, allowed: true },
          { id: ids.extra, allowed: false },
          { id: ids.fixed, allowed: true },
        ],
      );
    });
  },
);

test(
  "reaction picker prefers a newer persisted entitlement and retries failed images on reopen",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const ids = await page.evaluate(() => {
        const h = window.reactionPickerHarness;
        h.environment.failingImages.add(h.required(h.fixed[0]));
        h.seed("a", [h.required(h.extra[0])], h.environment.now + 100);
        h.render();
        return { fixed: h.required(h.fixed[0]), extra: h.extra };
      });
      await page.waitForFunction(
        (id) =>
          window.reactionPickerHarness.snapshot().stickerUrls[id] === null,
        ids.fixed,
      );
      await page.waitForFunction((id) => {
        const image = document.querySelector(`#sticker-${id} img`);
        if (!(image instanceof HTMLImageElement)) return false;
        return image.complete && image.naturalWidth === 1;
      }, ids.fixed);
      const beforeReopen = await page.evaluate(async () => {
        const h = window.reactionPickerHarness;
        h.seed("a", [h.required(h.extra[1])], h.environment.now + 200);
        await h.resolve(
          h.environment.requests.length - 1,
          [h.required(h.extra[2])],
          h.environment.now + 150,
        );
        const snapshot = h.snapshot();
        await h.resolve(0, [h.required(h.extra[2])], h.environment.now + 250);
        return {
          snapshot,
          afterStrictModeResponse: h.snapshot(),
          writes: h.environment.writes.length,
        };
      });
      assert.equal(
        beforeReopen.snapshot.visibleStickerIds.includes(
          required(ids.extra[1]),
        ),
        true,
      );
      assert.equal(
        beforeReopen.snapshot.visibleStickerIds.includes(
          required(ids.extra[2]),
        ),
        false,
      );
      assert.deepEqual(
        beforeReopen.afterStrictModeResponse.visibleStickerIds,
        beforeReopen.snapshot.visibleStickerIds,
      );
      assert.equal(beforeReopen.writes, 0);
      const attemptsBeforeReopen = await page.evaluate((id) => {
        const h = window.reactionPickerHarness;
        const attempts = h.environment.imageRequests.filter(
          (requested) => requested === id,
        ).length;
        h.environment.failingImages.delete(id);
        h.render("a", false);
        h.render();
        return attempts;
      }, ids.fixed);
      await page.waitForFunction(
        (id) =>
          window.reactionPickerHarness
            .snapshot()
            .stickerUrls[id]?.startsWith("blob:"),
        ids.fixed,
      );
      await page.waitForFunction((id) => {
        const image = document.querySelector(`#sticker-${id} img`);
        if (!(image instanceof HTMLImageElement)) return false;
        return (
          image.src.startsWith("blob:") &&
          image.complete &&
          image.naturalWidth === 1
        );
      }, ids.fixed);
      assert.equal(
        await page.evaluate(
          (id) =>
            window.reactionPickerHarness.environment.imageRequests.filter(
              (requested) => requested === id,
            ).length,
          ids.fixed,
        ),
        attemptsBeforeReopen + 1,
      );
    });
  },
);
