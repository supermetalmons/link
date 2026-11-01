import { isStickerSlot, isStickerMap } from "@mons/shared/appearance";
import { required } from "./fixtures/canonicalData.mjs";
import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const environmentPath = path.join(
  repository,
  "test/fixtures/shinyCardEnvironment.ts",
);
const imageResponse = {
  contentType: "image/svg+xml",
  headers: { "Access-Control-Allow-Origin": "*" },
  body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
};

function trackCardResources() {
  const owned = () =>
    /\/src\/ui\/(?:ShinyCard|shinyCard)/.test(new Error().stack ?? "");
  /** @type {Set<number | undefined>} */
  const timeouts = new Set();
  /** @type {Set<number>} */
  const rafs = new Set();
  /** @type {{target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, capture: boolean}[]} */
  const listeners = [];
  /** @type {Map<ResizeObserver, Set<Element>>} */
  const observers = new Map();
  const setTimeoutNative = window.setTimeout.bind(window);
  const clearTimeoutNative = window.clearTimeout.bind(window);
  const rafNative = window.requestAnimationFrame.bind(window);
  const cancelRafNative = window.cancelAnimationFrame.bind(window);
  /** @param {(...args: unknown[]) => void} callback @param {number} [delay] @param {unknown[]} args */
  const trackingTimeout = (callback, delay, ...args) => {
    const tracked = owned();
    const id = setTimeoutNative(() => {
      timeouts.delete(id);
      callback(...args);
    }, delay);
    if (tracked) timeouts.add(id);
    return id;
  };
  Reflect.set(window, "setTimeout", trackingTimeout);
  window.clearTimeout = (id) => {
    if (typeof id === "number") timeouts.delete(id);
    clearTimeoutNative(id);
  };
  window.requestAnimationFrame = (callback) => {
    const tracked = owned();
    const id = rafNative((time) => {
      rafs.delete(id);
      callback(time);
    });
    if (tracked) rafs.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    rafs.delete(id);
    cancelRafNative(id);
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  /** @param {boolean | AddEventListenerOptions | EventListenerOptions | undefined} options */
  const capture = (options) =>
    typeof options === "boolean" ? options : !!options?.capture;
  /** @type {EventTarget["addEventListener"]} @this {EventTarget} */
  const trackingAddEventListener = function (type, callback, options) {
    const signal = typeof options === "object" ? options.signal : undefined;
    if (owned() && !signal?.aborted) {
      const record = {
        target: this,
        type,
        callback,
        capture: capture(options),
      };
      if (
        !listeners.some(
          (item) =>
            item.target === this &&
            item.type === type &&
            item.callback === callback &&
            item.capture === record.capture,
        )
      ) {
        listeners.push(record);
        if (signal)
          add.call(
            signal,
            "abort",
            () => {
              const index = listeners.indexOf(record);
              if (index !== -1) listeners.splice(index, 1);
            },
            { once: true },
          );
      }
    }
    return add.call(this, type, callback, options);
  };
  EventTarget.prototype.addEventListener = trackingAddEventListener;
  /** @type {EventTarget["removeEventListener"]} @this {EventTarget} */
  const trackingRemoveEventListener = function (type, callback, options) {
    const index = listeners.findIndex(
      (item) =>
        item.target === this &&
        item.type === type &&
        item.callback === callback &&
        item.capture === capture(options),
    );
    if (index !== -1) listeners.splice(index, 1);
    return remove.call(this, type, callback, options);
  };
  EventTarget.prototype.removeEventListener = trackingRemoveEventListener;
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    /** @param {ResizeObserverCallback} callback */
    constructor(callback) {
      super(callback);
      if (owned()) observers.set(this, new Set());
    }
    /** @param {Element} target @param {ResizeObserverOptions} [options] */
    observe(target, options) {
      observers.get(this)?.add(target);
      super.observe(target, options);
    }
    /** @param {Element} target */
    unobserve(target) {
      observers.get(this)?.delete(target);
      super.unobserve(target);
    }
    disconnect() {
      observers.get(this)?.clear();
      super.disconnect();
    }
  };
  window.cardResources = () => ({
    timeouts: timeouts.size,
    rafs: rafs.size,
    listeners: listeners.filter(
      (item) => item.target === window || item.target === document,
    ).length,
    elements: listeners.filter((item) => item.target instanceof Element).length,
    detachedElements: listeners.filter(
      (item) => item.target instanceof Element && !item.target.isConnected,
    ).length,
    observed: [...observers.values()].reduce(
      (count, targets) => count + targets.size,
      0,
    ),
  });
}

/**
 * @param {import("node:test").TestContext} t
 * @param {(context: {page: import("playwright").Page, heldImages: import("playwright").Route[], imageStarted: Promise<void>, releaseImages: () => Promise<void>}) => Promise<void>} run
 * @param {{deferredSprites?: boolean, deferredImages?: boolean, mobile?: boolean}} [options]
 */
async function fixture(
  t,
  run,
  { deferredSprites = false, deferredImages = false, mobile = false } = {},
) {
  const server = await createServer({
    root: repository,
    configFile: false,
    cacheDir: `node_modules/.vite-shiny-card-${process.pid}`,
    logLevel: "error",
    optimizeDeps: {
      include: [
        "@mons/shared/appearance",
        "@mons/shared/profiles",
        "@mons/shared/ids",
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
        name: "shiny-card-browser-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__shiny-card") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><script type="module" src="/test/fixtures/shinyCardHarness.ts"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (!importer || !id.startsWith(".")) return;
          const resolved = path
            .resolve(path.dirname(importer), id)
            .replace(/\.(?:ts|tsx)$/, "");
          if (resolved === path.join(repository, "src/utils/storage"))
            return environmentPath;
          if (resolved === path.join(repository, "src/assets/monsSprites"))
            return "\0card-sprites";
          if (
            resolved ===
            path.join(repository, "src/connection/deferredProfilePresentation")
          )
            return "\0card-presentation";
          if (resolved === path.join(repository, "src/content/boardStyles"))
            return "\0card-colors";
        },
        load(id) {
          if (id === "\0card-sprites")
            return `import { environment, spritesReady, spriteForKey } from ${JSON.stringify(environmentPath)};
await spritesReady;
export const getSpriteByKey = key => { environment.spriteRequests.push(key); return spriteForKey(key); };`;
          if (id === "\0card-presentation")
            return "export const flushDeferredProfilePresentation = () => {};";
          if (id === "\0card-colors")
            return "export const colors = { rainbow: { 1: 'red', 2: 'orange', 3: 'yellow', 4: 'green', 5: 'blue', 6: 'purple', 7: 'pink' } };";
        },
      },
    ],
  });
  /** @type {import("playwright").Browser | undefined} */
  let browser;
  /** @type {Promise<void> | undefined} */
  let cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      try {
        await browser?.close();
      } finally {
        await server.close();
      }
    })());
  t.after(cleanup);
  /** @type {import("playwright").Route[]} */
  const heldImages = [];
  /** @type {PromiseWithResolvers<void>} */
  const { promise: imageStarted, resolve: resolveImageStarted } =
    Promise.withResolvers();
  let holdImages = deferredImages;
  try {
    await server.listen();
    const origin = browserServerOrigin(server);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const context = await browser.newContext(
      mobile
        ? {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
          }
        : { viewport: { width: 1100, height: 900 } },
    );
    context.setDefaultTimeout(10_000);
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.origin === "https://cdn.lil.org") {
        if (holdImages && route.request().resourceType() === "image") {
          heldImages.push(route);
          resolveImageStarted();
          return;
        }
        return route.fulfill(imageResponse);
      }
      return route.abort();
    });
    const page = await context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
    await page.addInitScript(trackCardResources);
    await page.goto(`${origin}/__shiny-card`);
    if (errors.length) throw new Error(errors.join("\n"));
    await Promise.race([
      page.waitForFunction(() => !!window.shinyCardHarness),
      page.waitForEvent("pageerror").then((error) => {
        throw error;
      }),
    ]);
    if (!deferredSprites)
      await page.evaluate(() =>
        window.shinyCardHarness.environment.releaseSprites(),
      );
    await run({
      page,
      heldImages,
      imageStarted,
      releaseImages: async () => {
        holdImages = false;
        await Promise.all(
          heldImages.splice(0).map((route) => route.fulfill(imageResponse)),
        );
      },
    });
    assert.deepEqual(errors, []);
  } finally {
    await cleanup();
  }
}

/** @param {import("playwright").Page} page */
const waitForMons = (page) =>
  page.waitForFunction(
    () => window.shinyCardHarness.snapshot().mons.length === 5,
  );
const noResources = {
  timeouts: 0,
  rafs: 0,
  listeners: 0,
  elements: 0,
  detachedElements: 0,
  observed: 0,
};

/** @param {import("playwright").Page} page @param {Partial<import("./fixtures/shinyCardEnvironment.ts").FixtureValues>} [values] */
const openEditing = async (page, values = {}) => {
  await page.evaluate(async (values) => {
    window.shinyCardHarness.reset(values);
    await window.shinyCardHarness.own();
  }, values);
  await waitForMons(page);
  await page.evaluate(() => window.shinyCardHarness.edit());
};

/** @param {import("playwright").Page} page */
const editState = (page) =>
  page.evaluate(() => ({
    values: window.shinyCardHarness.environment.values,
    writes: window.shinyCardHarness.environment.writes,
    presentation: window.shinyCardHarness.snapshot(),
  }));

/** @param {number} id */
const emojiWrite = (id, aura = "none") => [
  "emoji",
  id,
  `https://cdn.lil.org/mons/emojipack/thumbs/${id}.webp`,
  aura,
];

test(
  "counter, background, and subtitle edits persist, present, and undo once",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      const cases = /** @type {const} */ ([
        {
          action: "clickCounter",
          field: "ProfileCounter",
          old: "gp",
          next: "mp",
          write: "counter",
          presentation: "counter",
          shown: "mp: 7",
        },
        {
          action: "clickBackground",
          field: "CardBackgroundId",
          old: 30,
          next: 31,
          write: "background",
          presentation: "background",
          shown: "https://cdn.lil.org/mons/id_cards/backgrounds/31.webp",
        },
        {
          action: "clickSubtitle",
          field: "CardSubtitleId",
          old: 0,
          next: 1,
          write: "subtitle",
          presentation: "subtitle",
        },
      ]);
      for (const entry of cases) {
        await openEditing(page);
        const before = await editState(page);
        await page.evaluate(
          (action) => window.shinyCardHarness[action](),
          entry.action,
        );
        const changed = await editState(page);
        const shown =
          ("shown" in entry ? entry.shown : undefined) ??
          (await page.evaluate(() => window.shinyCardHarness.subtitleForId(1)));
        assert.equal(changed.values[entry.field], entry.next, entry.action);
        assert.equal(
          changed.presentation[entry.presentation],
          shown,
          entry.action,
        );
        assert.equal(changed.presentation.undoDisabled, false, entry.action);
        assert.deepEqual(
          changed.writes,
          [[entry.write, entry.next]],
          entry.action,
        );
        await page.evaluate(() => window.shinyCardHarness.undo());
        const restored = await editState(page);
        assert.equal(restored.values[entry.field], entry.old, entry.action);
        assert.equal(
          restored.presentation[entry.presentation],
          before.presentation[entry.presentation],
          entry.action,
        );
        assert.equal(restored.presentation.undoDisabled, true, entry.action);
        assert.deepEqual(
          restored.writes,
          [
            [entry.write, entry.next],
            [entry.write, entry.old],
          ],
          entry.action,
        );
        await page.evaluate(() => window.shinyCardHarness.undo());
        assert.deepEqual(
          (await editState(page)).writes,
          restored.writes,
          entry.action,
        );
      }
    });
  },
);

test(
  "ordinary emoji edits and undo preserve canonical numeric IDs including zero",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      const baselines = [
        { label: "numeric", input: 1, read: 1, restored: 1, next: 2 },
        { label: "zero", input: 0, read: 0, restored: 0, next: 1 },
      ];
      for (const baseline of baselines) {
        await page.evaluate(async (input) => {
          const h = window.shinyCardHarness;
          h.reset();
          h.storeEmoji(input);
          await h.own();
        }, baseline.input);
        await waitForMons(page);
        await page.evaluate(() => window.shinyCardHarness.edit());
        const before = await editState(page);
        assert.equal(
          before.values.PlayerEmojiId,
          baseline.read,
          baseline.label,
        );
        await page.evaluate(() => window.shinyCardHarness.clickEmoji());
        const changed = await editState(page);
        assert.equal(
          changed.values.PlayerEmojiId,
          baseline.next,
          baseline.label,
        );
        assert.deepEqual(
          changed.writes,
          [emojiWrite(baseline.next)],
          baseline.label,
        );
        assert.equal(
          changed.presentation.emoji,
          `https://cdn.lil.org/mons/emojipack/regular/${baseline.next}.webp`,
          baseline.label,
        );
        assert.equal(changed.presentation.undoDisabled, false, baseline.label);
        await page.evaluate(() => window.shinyCardHarness.undo());
        const restored = await editState(page);
        assert.equal(
          restored.values.PlayerEmojiId,
          baseline.restored,
          baseline.label,
        );
        assert.deepEqual(
          restored.writes,
          [emojiWrite(baseline.next), emojiWrite(baseline.read)],
          baseline.label,
        );
        assert.equal(
          typeof required(restored.writes[1])[1],
          typeof baseline.read,
          baseline.label,
        );
        assert.equal(
          restored.presentation.emoji,
          before.presentation.emoji,
          baseline.label,
        );
        assert.equal(restored.presentation.undoDisabled, true, baseline.label);
        await page.evaluate(() => window.shinyCardHarness.undo());
        assert.deepEqual(
          (await editState(page)).writes,
          restored.writes,
          baseline.label,
        );
      }
    });
  },
);

test(
  "all five monster edits preserve other slots and undo without another mons notification",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      const nextKeys = [
        "notchur_demon",
        "gerp_angel",
        "greenseech_drainer",
        "omenstatue_spirit",
        "dart_mystic",
      ];
      for (const [index, key] of nextKeys.entries()) {
        await openEditing(page);
        const before = await editState(page);
        await page.evaluate(
          (index) => window.shinyCardHarness.clickMon(index),
          index,
        );
        await page.waitForFunction(
          ({ index, key }) =>
            window.shinyCardHarness.snapshot().mons[index] ===
            `data:image/webp;base64,${window.shinyCardHarness.spriteForKey(key)}`,
          { index, key },
        );
        const changed = await editState(page);
        const indexes = [0, 0, 0, 0, 0];
        indexes[index] = 1;
        assert.deepEqual(
          changed.values.ProfileMons,
          Object.fromEntries(
            ["demon", "angel", "drainer", "spirit", "mystic"].map((kind, i) => [
              kind,
              indexes[i],
            ]),
          ),
          key,
        );
        assert.deepEqual(
          changed.writes,
          [
            [
              "mons",
              Object.fromEntries(
                ["demon", "angel", "drainer", "spirit", "mystic"].map(
                  (kind, i) => [kind, indexes[i]],
                ),
              ),
            ],
            ["monsChanged"],
          ],
          key,
        );
        for (const other of indexes.keys()) {
          if (other !== index)
            assert.equal(
              changed.presentation.mons[other],
              before.presentation.mons[other],
              key,
            );
        }
        await page.evaluate(() => window.shinyCardHarness.undo());
        await page.waitForFunction(
          (mons) =>
            JSON.stringify(window.shinyCardHarness.snapshot().mons) ===
            JSON.stringify(mons),
          before.presentation.mons,
        );
        const restored = await editState(page);
        assert.deepEqual(
          restored.values.ProfileMons,
          { demon: 0, angel: 0, drainer: 0, spirit: 0, mystic: 0 },
          key,
        );
        assert.deepEqual(
          restored.writes,
          [
            [
              "mons",
              Object.fromEntries(
                ["demon", "angel", "drainer", "spirit", "mystic"].map(
                  (kind, i) => [kind, indexes[i]],
                ),
              ),
            ],
            ["monsChanged"],
            ["mons", { demon: 0, angel: 0, drainer: 0, spirit: 0, mystic: 0 }],
          ],
          key,
        );
        assert.equal(restored.presentation.undoDisabled, true, key);
      }
    });
  },
);

test(
  "all eight sticker slots preserve unrelated stickers and undo additions and removals",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      const namesByType = await page.evaluate(
        () => window.shinyCardHarness.stickerNames,
      );
      assert.equal(Object.keys(namesByType).length, 8);
      for (const [type, names] of Object.entries(namesByType)) {
        assert.ok(isStickerSlot(type));
        /** @type {import("@mons/shared/appearance").StickerMap} */
        const untouched =
          type === "mana" ? { "bottom-left": "heart" } : { mana: "blue-mana" };
        for (const previous of /** @type {const} */ ([
          undefined,
          names.at(-1),
        ])) {
          /** @type {Partial<Record<import("@mons/shared/appearance").StickerSlot, string>>} */
          const original = {
            ...untouched,
            ...(previous === undefined ? {} : { [type]: previous }),
          };
          const next = previous === undefined ? names[0] : undefined;
          /** @type {Partial<Record<import("@mons/shared/appearance").StickerSlot, string>>} */
          const updated = {
            ...untouched,
            ...(next === undefined ? {} : { [type]: next }),
          };
          assert.ok(isStickerMap(original));
          await openEditing(page, { CardStickers: original });
          await page.evaluate(
            (type) => window.shinyCardHarness.clickSticker(type),
            type,
          );
          const changed = await editState(page);
          assert.deepEqual(changed.values.CardStickers, updated, type);
          assert.deepEqual(changed.writes, [["stickers", updated]], type);
          assert.deepEqual(changed.presentation.stickers, updated, type);
          assert.equal(changed.presentation.undoDisabled, false, type);
          await page.evaluate(() => window.shinyCardHarness.undo());
          const restored = await editState(page);
          assert.deepEqual(restored.values.CardStickers, original, type);
          assert.deepEqual(restored.presentation.stickers, original, type);
          assert.deepEqual(
            restored.writes,
            [
              ["stickers", updated],
              ["stickers", original],
            ],
            type,
          );
          assert.equal(restored.presentation.undoDisabled, true, type);
          await page.evaluate(() => window.shinyCardHarness.undo());
          assert.deepEqual(
            (await editState(page)).writes,
            restored.writes,
            type,
          );
        }
      }
      await openEditing(page, {
        CardStickers: { "bottom-left": "heart" },
      });
      await page.evaluate(() => {
        window.shinyCardHarness.clickSticker("mana");
        window.shinyCardHarness.undo();
      });
      const empty = await editState(page);
      assert.deepEqual(empty.values.CardStickers, { "bottom-left": "heart" });
      assert.deepEqual(empty.presentation.stickers, { "bottom-left": "heart" });
      assert.deepEqual(empty.writes, [
        ["stickers", { mana: "blue-mana", "bottom-left": "heart" }],
        ["stickers", { "bottom-left": "heart" }],
      ]);
      assert.equal(empty.presentation.undoDisabled, true);
    });
  },
);

test(
  "inventory grants restore through regular edits and undo with canonical appearance payloads",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      for (const kind of /** @type {const} */ ([
        "emoji",
        "background",
        "drainer",
        "sticker",
      ])) {
        await openEditing(page);
        const original = await editState(page);
        await page.evaluate((kind) => {
          const h = window.shinyCardHarness;
          if (kind === "emoji") h.inventoryEmoji(1009, "rainbow");
          else
            h.inventorySpecial({ background: 1, drainer: 0, sticker: 2 }[kind]);
        }, kind);
        if (kind === "drainer")
          await page.waitForFunction(
            () =>
              window.shinyCardHarness.snapshot().mons[2] ===
              `data:image/webp;base64,${window.shinyCardHarness.spriteForKey("royal_aguapwoshi_drainer")}`,
          );
        const granted = await editState(page);
        await page.evaluate((kind) => {
          const h = window.shinyCardHarness;
          if (kind === "emoji") h.clickEmoji();
          else if (kind === "background") h.clickBackground();
          else if (kind === "drainer") h.clickMon(2);
          else h.clickSticker("big-mon-top-right");
        }, kind);
        const changed = await editState(page);
        await page.evaluate(() => window.shinyCardHarness.undo());
        if (kind === "drainer")
          await page.waitForFunction(
            () =>
              window.shinyCardHarness.snapshot().mons[2] ===
              `data:image/webp;base64,${window.shinyCardHarness.spriteForKey("royal_aguapwoshi_drainer")}`,
          );
        const restoredGrant = await editState(page);
        const field = /** @type {const} */ ({
          emoji: "PlayerEmojiId",
          background: "CardBackgroundId",
          drainer: "ProfileMons",
          sticker: "CardStickers",
        })[kind];
        const presentation = /** @type {const} */ ({
          emoji: "emoji",
          background: "background",
          drainer: "mons",
          sticker: "stickers",
        })[kind];
        assert.deepEqual(
          restoredGrant.values[field],
          granted.values[field],
          kind,
        );
        assert.deepEqual(
          restoredGrant.presentation[presentation],
          granted.presentation[presentation],
          kind,
        );
        assert.equal(restoredGrant.presentation.undoDisabled, false, kind);
        await page.evaluate(() => window.shinyCardHarness.undo());
        if (kind === "drainer")
          await page.waitForFunction(
            (mons) =>
              JSON.stringify(window.shinyCardHarness.snapshot().mons) ===
              JSON.stringify(mons),
            original.presentation.mons,
          );
        const restored = await editState(page);
        assert.deepEqual(
          restored.values[field],
          kind === "sticker"
            ? {}
            : kind === "emoji"
              ? 1
              : original.values[field],
          kind,
        );
        assert.deepEqual(
          restored.presentation[presentation],
          original.presentation[presentation],
          kind,
        );
        assert.equal(restored.presentation.undoDisabled, true, kind);
        if (kind === "emoji") {
          assert.equal(granted.values.PlayerEmojiId, 1009);
          assert.equal(typeof changed.values.PlayerEmojiId, "number");
          assert.equal(restoredGrant.values.PlayerEmojiId, 1009);
          assert.equal(granted.values.PlayerEmojiAura, "rainbow");
          assert.equal(granted.presentation.aura, "visible");
          assert.equal(changed.values.PlayerEmojiAura, "none");
          assert.equal(changed.presentation.aura, "hidden");
          assert.equal(restoredGrant.values.PlayerEmojiAura, "rainbow");
          assert.equal(restoredGrant.presentation.aura, "visible");
          assert.equal(restored.values.PlayerEmojiAura, "none");
          assert.equal(restored.presentation.aura, "hidden");
          assert.deepEqual(restored.writes, [
            emojiWrite(1009, "rainbow"),
            emojiWrite(changed.values.PlayerEmojiId),
            emojiWrite(1009, "rainbow"),
            emojiWrite(1),
          ]);
          assert.equal(typeof required(restored.writes[0])[1], "number");
          assert.equal(typeof required(restored.writes[1])[1], "number");
          assert.equal(typeof required(restored.writes[2])[1], "number");
          assert.equal(typeof required(restored.writes[3])[1], "number");
        } else if (kind === "background") {
          assert.deepEqual(restored.writes, [
            ["background", 100],
            ["background", 0],
            ["background", 100],
            ["background", 30],
          ]);
        } else if (kind === "drainer") {
          assert.deepEqual(restored.writes, [
            ["mons", { demon: 0, angel: 0, drainer: 5, spirit: 0, mystic: 0 }],
            ["monsChanged"],
            ["mons", { demon: 0, angel: 0, drainer: 0, spirit: 0, mystic: 0 }],
            ["monsChanged"],
            ["mons", { demon: 0, angel: 0, drainer: 5, spirit: 0, mystic: 0 }],
            ["mons", { demon: 0, angel: 0, drainer: 0, spirit: 0, mystic: 0 }],
          ]);
        } else {
          assert.deepEqual(restored.writes, [
            ["stickers", { "big-mon-top-right": "gate" }],
            ["stickers", { "big-mon-top-right": "crystal-owg" }],
            ["stickers", { "big-mon-top-right": "gate" }],
            ["stickers", {}],
          ]);
        }
      }
    });
  },
);

test(
  "ordinary cycling skips exclusive cosmetics and invalid inventory commands do nothing",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      await openEditing(page, {
        CardBackgroundId: 36,
        ProfileMons: { demon: 0, angel: 0, drainer: 4, spirit: 0, mystic: 0 },
        CardStickers: { "big-mon-top-right": "crystal-gummy-deino" },
      });
      await page.evaluate(() => {
        const h = window.shinyCardHarness;
        h.clickBackground();
        h.clickMon(2);
        h.clickSticker("big-mon-top-right");
      });
      const cycled = await editState(page);
      assert.equal(cycled.values.CardBackgroundId, 0);
      assert.deepEqual(cycled.values.ProfileMons, {
        demon: 0,
        angel: 0,
        drainer: 0,
        spirit: 0,
        mystic: 0,
      });
      assert.deepEqual(cycled.values.CardStickers, {
        "big-mon-top-right": "crystal-owg",
      });
      await page.evaluate(() => {
        window.shinyCardHarness.inventoryEmoji(999, "rainbow");
        window.shinyCardHarness.inventorySpecial(99);
      });
      const ignored = await editState(page);
      assert.deepEqual(ignored.values, cycled.values);
      assert.deepEqual(ignored.writes, cycled.writes);
      await page.evaluate(() =>
        Reflect.apply(
          window.shinyCardHarness.inventoryEmoji,
          window.shinyCardHarness,
          [1009, "unsupported"],
        ),
      );
      const normalized = await editState(page);
      assert.deepEqual(normalized.values, ignored.values);
      assert.deepEqual(normalized.writes, ignored.writes);
    });
  },
);

test(
  "a mounted card rejects edit and undo callbacks after its owner changes",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      await openEditing(page);
      await page.evaluate(() => window.shinyCardHarness.clickBackground());
      const before = await editState(page);
      await page.evaluate(() => {
        const h = window.shinyCardHarness;
        h.environment.values.ProfileId = "replacement-owner";
        h.clickBackground();
        h.clickEmoji();
        h.clickCounter();
        h.clickSubtitle();
        h.clickMon(0);
        h.clickSticker("mana");
        h.undo();
      });
      const stale = await editState(page);
      assert.deepEqual(stale.writes, before.writes);
      assert.deepEqual(stale.values, {
        ...before.values,
        ProfileId: "replacement-owner",
      });
      for (const key of /** @type {const} */ ([
        "background",
        "emoji",
        "counter",
        "subtitle",
        "mons",
        "stickers",
      ]))
        assert.deepEqual(
          stale.presentation[key],
          before.presentation[key],
          key,
        );
      await page.evaluate(() => window.shinyCardHarness.own());
      await waitForMons(page);
      await page.evaluate(() => window.shinyCardHarness.edit());
      assert.equal((await editState(page)).presentation.undoDisabled, true);
    });
  },
);

test(
  "synchronous persistence callbacks cannot enqueue for a new owner or change a replacement card",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      for (const replacement of /** @type {const} */ (["owner", "session"])) {
        await openEditing(page);
        await page.evaluate((replacement) => {
          const h = window.shinyCardHarness;
          h.environment.onWrite = () => {
            h.environment.onWrite = null;
            if (replacement === "owner") {
              h.environment.values.ProfileId = "reentrant-owner";
              h.environment.values.CardBackgroundId = 7;
              void h.own();
            } else {
              void h.other("replacement-card");
            }
          };
          h.clickBackground();
        }, replacement);
        await waitForMons(page);
        const replaced = await editState(page);
        assert.match(required(replaced.presentation.background), /\/7\.webp$/);
        assert.deepEqual(replaced.writes, [["background", 31]]);
        if (replacement === "owner") {
          await page.evaluate(() => window.shinyCardHarness.edit());
          assert.equal((await editState(page)).presentation.undoDisabled, true);
        } else {
          assert.match(
            required(replaced.presentation.text),
            /replacement-card/,
          );
          await page.evaluate(() => window.shinyCardHarness.own());
          await waitForMons(page);
          await page.evaluate(() => {
            window.shinyCardHarness.edit();
            window.shinyCardHarness.undo();
          });
          const undone = await editState(page);
          assert.equal(undone.values.CardBackgroundId, 30);
          assert.deepEqual(undone.writes, [
            ["background", 31],
            ["background", 30],
          ]);
          assert.equal(undone.presentation.undoDisabled, true);
        }
      }
    });
  },
);

test(
  "closing editing cards cancels resources immediately and repeatedly",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.evaluate(() => window.shinyCardHarness.own());
        await waitForMons(page);
        await page.evaluate(() => {
          window.shinyCardHarness.edit();
          window.shinyCardHarness.clickEmoji();
          window.shinyCardHarness.done();
          window.shinyCardHarness.edit();
        });
        const active = await page.evaluate(() => window.cardResources());
        assert.ok(active.rafs > 0);
        assert.ok(active.timeouts > 0);
        assert.ok(active.listeners > 0);
        assert.ok(active.observed > 0);
        await page.evaluate(() => {
          window.shinyCardHarness.retire();
          window.shinyCardHarness.hide();
        });
        assert.deepEqual(
          await page.evaluate(() => window.cardResources()),
          noResources,
        );
        const writes = await page.evaluate(
          () => window.shinyCardHarness.environment.writes.length,
        );
        await page.evaluate(() =>
          window.shinyCardHarness.dispatchRetiredEvents(),
        );
        await page.clock.runFor(1000);
        assert.equal(
          await page.evaluate(() => window.shinyCardHarness.retiredMutations()),
          0,
        );
        assert.equal(
          await page.evaluate(
            () => window.shinyCardHarness.environment.writes.length,
          ),
          writes,
        );
        assert.equal(
          await page.evaluate(() => window.shinyCardHarness.snapshot().count),
          0,
        );
      }
    });
  },
);

test(
  "editing panels and empty sticker targets release their listeners while the card stays open",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      await page.evaluate(() => window.shinyCardHarness.own());
      await waitForMons(page);
      const baseline = await page.evaluate(() => window.cardResources());
      for (let cycle = 0; cycle < 4; cycle++) {
        await page.evaluate(() => {
          window.shinyCardHarness.edit();
          window.shinyCardHarness.done();
        });
        await page.clock.runFor(600);
        const resources = await page.evaluate(() => window.cardResources());
        assert.equal(resources.detachedElements, 0);
        assert.equal(resources.elements, baseline.elements);
        assert.equal(resources.listeners, baseline.listeners);
      }
      await page.evaluate(() => window.shinyCardHarness.hide());
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
    });
  },
);

test(
  "externally removing the card uses the same complete cleanup",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      await page.evaluate(() => window.shinyCardHarness.own());
      await waitForMons(page);
      await page.evaluate(() => {
        window.shinyCardHarness.edit();
        window.shinyCardHarness.clickEmoji();
        const card = document.querySelector('[data-shiny-card="true"]');
        if (!card) throw new Error("missing-shiny-card");
        card.remove();
      });
      assert.equal(
        await page.evaluate(() => window.shinyCardHarness.snapshot().visible),
        false,
      );
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
      await page.evaluate(() => window.shinyCardHarness.hide());
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
    });
  },
);

test(
  "pending assets from a closed card cannot mutate its replacement",
  { timeout: 60_000 },
  async (t) => {
    await fixture(
      t,
      async ({ page, heldImages, imageStarted, releaseImages }) => {
        await page.evaluate(() => window.shinyCardHarness.own());
        await imageStarted;
        await page.evaluate(() => {
          window.shinyCardHarness.retire();
          return window.shinyCardHarness.other();
        });
        assert.equal(
          await page.evaluate(
            () => window.shinyCardHarness.snapshot().mons.length,
          ),
          0,
        );
        await page.evaluate(() =>
          window.shinyCardHarness.environment.releaseSprites(),
        );
        await waitForMons(page);
        await releaseImages();
        await page.evaluate(() =>
          window.shinyCardHarness.dispatchRetiredEvents(),
        );
        await page.clock.runFor(1000);
        const snapshot = await page.evaluate(() =>
          window.shinyCardHarness.snapshot(),
        );
        assert.equal(snapshot.count, 1);
        assert.match(required(snapshot.text), /other-b/);
        assert.match(required(snapshot.background), /\/7\.webp$/);
        assert.match(required(snapshot.emoji), /\/2\.webp$/);
        assert.equal(snapshot.mons.length, 5);
        assert.equal(
          await page.evaluate(() => window.shinyCardHarness.retiredMutations()),
          0,
        );
        assert.deepEqual(
          await page.evaluate(
            () => window.shinyCardHarness.environment.spriteRequests,
          ),
          [
            "notchur_demon",
            "gerp_angel",
            "greenseech_drainer",
            "omenstatue_spirit",
            "dart_mystic",
          ],
        );
        await page.evaluate(() => window.shinyCardHarness.hide());
        assert.deepEqual(
          await page.evaluate(() => window.cardResources()),
          noResources,
        );
        assert.equal(heldImages.length, 0);
      },
      { deferredSprites: true, deferredImages: true },
    );
  },
);

test(
  "public show behavior preserves toggling, replacement, and anonymous cards before sprites load",
  { timeout: 60_000 },
  async (t) => {
    await fixture(
      t,
      async ({ page }) => {
        const result = await page.evaluate(async () => {
          const h = window.shinyCardHarness;
          /** @type {import("@mons/shared/profiles").PlayerProfile} */
          const profile = {
            id: "same-other",
            emoji: 2,
            aura: "none",
            cardBackgroundId: 30,
            cardSubtitleId: 0,
            cardStickers: {},
            profileCounter: "gp",
            username: null,
            eth: null,
            sol: null,
            profileMons: {
              demon: 0,
              angel: 0,
              drainer: 0,
              spirit: 0,
              mystic: 0,
            },
          };
          await h.show(profile, "Other", true);
          const first = document.querySelector('[data-shiny-card="true"]');
          await h.show(null, "Invalid other", true);
          const invalidKeptCard =
            first === document.querySelector('[data-shiny-card="true"]');
          await h.show(profile, "Other", true);
          const toggled = h.snapshot();
          h.environment.values.ProfileId = "";
          await h.own();
          const anonymous = h.snapshot();
          const own = document.querySelector('[data-shiny-card="true"]');
          await h.own();
          const replaced =
            own !== document.querySelector('[data-shiny-card="true"]');
          return { invalidKeptCard, toggled, anonymous, replaced };
        });
        assert.equal(result.invalidKeptCard, true);
        assert.equal(result.toggled.count, 0);
        assert.equal(result.toggled.visible, false);
        assert.equal(result.anonymous.count, 1);
        assert.equal(result.anonymous.visible, true);
        assert.equal(result.anonymous.mons.length, 0);
        assert.equal(result.replaced, true);
        await page.evaluate(() =>
          window.shinyCardHarness.environment.releaseSprites(),
        );
        await waitForMons(page);
        await page.evaluate(() => {
          window.shinyCardHarness.edit();
          window.shinyCardHarness.clickBackground();
        });
        assert.equal(
          await page.evaluate(
            () => window.shinyCardHarness.environment.values.CardBackgroundId,
          ),
          31,
        );
        await page.evaluate(() => window.shinyCardHarness.hide());
        assert.deepEqual(
          await page.evaluate(() => window.cardResources()),
          noResources,
        );
      },
      { deferredSprites: true },
    );
  },
);

for (const mobile of /** @type {const} */ ([false, true])) {
  test(
    `card dimensions and editing remain stable on ${mobile ? "mobile" : "desktop"}`,
    { timeout: 60_000 },
    async (t) => {
      await fixture(
        t,
        async ({ page }) => {
          await page.evaluate(() => window.shinyCardHarness.own());
          await waitForMons(page);
          let snapshot = await page.evaluate(() =>
            window.shinyCardHarness.snapshot(),
          );
          const expectedWidth = mobile ? 312 : 350;
          assert.ok(
            Math.abs(required(snapshot.bounds).width - expectedWidth) < 1,
          );
          assert.ok(
            Math.abs(
              required(snapshot.bounds).width /
                required(snapshot.bounds).height -
                2217 / 1625,
            ) < 0.01,
          );
          await page.evaluate(() => window.shinyCardHarness.edit());
          assert.equal(
            await page.evaluate(
              () => window.shinyCardHarness.snapshot().editing,
            ),
            true,
          );
          await page.clock.runFor(600);
          if (process.env.MONS_SHINY_CARD_SCREENSHOTS) {
            await mkdir(process.env.MONS_SHINY_CARD_SCREENSHOTS, {
              recursive: true,
            });
            await page.screenshot({
              path: path.join(
                process.env.MONS_SHINY_CARD_SCREENSHOTS,
                `shiny-card-${mobile ? "mobile" : "desktop"}.png`,
              ),
            });
          }
          await page.evaluate(() => {
            window.shinyCardHarness.hide();
            return window.shinyCardHarness.other();
          });
          snapshot = await page.evaluate(() =>
            window.shinyCardHarness.snapshot(),
          );
          assert.ok(
            Math.abs(required(snapshot.bounds).width - (mobile ? 269.1 : 350)) <
              1,
          );
          await page.evaluate(() => {
            window.shinyCardHarness.edit();
            window.shinyCardHarness.clickEmoji();
          });
          assert.equal(
            await page.evaluate(
              () => window.shinyCardHarness.snapshot().editing,
            ),
            false,
          );
          assert.deepEqual(
            await page.evaluate(
              () => window.shinyCardHarness.environment.writes,
            ),
            [],
          );
          await page.evaluate(() => window.shinyCardHarness.hide());
          assert.deepEqual(
            await page.evaluate(() => window.cardResources()),
            noResources,
          );
        },
        { mobile },
      );
    },
  );
}

test(
  "undo survives reopening for one owner and resets for another owner",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      await page.evaluate(() => window.shinyCardHarness.own());
      await page.evaluate(() => {
        window.shinyCardHarness.edit();
        window.shinyCardHarness.clickBackground();
        window.shinyCardHarness.hide();
      });
      assert.equal(
        await page.evaluate(
          () => window.shinyCardHarness.environment.values.CardBackgroundId,
        ),
        31,
      );
      await page.evaluate(() => window.shinyCardHarness.own());
      await page.evaluate(() => window.shinyCardHarness.edit());
      assert.equal(
        await page.evaluate(
          () => window.shinyCardHarness.snapshot().undoDisabled,
        ),
        false,
      );
      await page.evaluate(() => window.shinyCardHarness.undo());
      assert.equal(
        await page.evaluate(
          () => window.shinyCardHarness.environment.values.CardBackgroundId,
        ),
        30,
      );
      await page.evaluate(() => {
        window.shinyCardHarness.clickBackground();
        window.shinyCardHarness.hide();
        window.shinyCardHarness.environment.values.ProfileId = "owner-b";
        return window.shinyCardHarness.own();
      });
      await page.evaluate(() => window.shinyCardHarness.edit());
      assert.equal(
        await page.evaluate(
          () => window.shinyCardHarness.snapshot().undoDisabled,
        ),
        true,
      );
      await page.evaluate(() => window.shinyCardHarness.hide());
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
    });
  },
);

test(
  "inventory applies while hidden or viewing another player without changing that card",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      await page.evaluate(() => {
        window.shinyCardHarness.inventoryEmoji(1009, "rainbow");
        window.shinyCardHarness.inventorySpecial(1);
        window.shinyCardHarness.inventorySpecial(2);
        window.shinyCardHarness.inventorySpecial(0);
      });
      assert.equal(
        await page.evaluate(() => window.shinyCardHarness.snapshot().count),
        0,
      );
      assert.deepEqual(
        await page.evaluate(() => window.shinyCardHarness.selection()),
        {
          avatarId: 9,
          specialIds: [0, 1, 2],
        },
      );
      await page.evaluate(() => window.shinyCardHarness.other());
      await waitForMons(page);
      const before = await page.evaluate(() =>
        window.shinyCardHarness.snapshot(),
      );
      await page.evaluate(() => {
        window.shinyCardHarness.inventoryEmoji(1010, "none");
        window.shinyCardHarness.inventorySpecial(0);
      });
      assert.deepEqual(
        await page.evaluate(() => window.shinyCardHarness.snapshot()),
        before,
      );
      await page.evaluate(() => {
        window.shinyCardHarness.hide();
        return window.shinyCardHarness.own();
      });
      await waitForMons(page);
      const own = await page.evaluate(() => window.shinyCardHarness.snapshot());
      assert.match(required(own.background), /\/100\.webp$/);
      assert.match(required(own.emoji), /\/1010\.webp$/);
      assert.equal(
        await page.evaluate(() => window.shinyCardHarness.selection().avatarId),
        10,
      );
      await page.evaluate(() => window.shinyCardHarness.hide());
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
    });
  },
);

test(
  "rapid monster edits keep the latest sprite and undo in edit order",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      await page.evaluate(() => window.shinyCardHarness.own());
      await waitForMons(page);
      await page.evaluate(() => {
        window.shinyCardHarness.edit();
        window.shinyCardHarness.clickMon(1);
        window.shinyCardHarness.clickMon(1);
        window.shinyCardHarness.clickMon(1);
      });
      await page.waitForFunction(
        () =>
          window.shinyCardHarness.snapshot().mons[1] ===
          `data:image/webp;base64,${window.shinyCardHarness.spriteForKey("mowch_angel")}`,
      );
      assert.deepEqual(
        await page.evaluate(
          () => window.shinyCardHarness.environment.values.ProfileMons,
        ),
        { demon: 0, angel: 3, drainer: 0, spirit: 0, mystic: 0 },
      );
      await page.evaluate(() => window.shinyCardHarness.undo());
      await page.waitForFunction(
        () =>
          window.shinyCardHarness.snapshot().mons[1] ===
          `data:image/webp;base64,${window.shinyCardHarness.spriteForKey("goxfold_angel")}`,
      );
      assert.deepEqual(
        await page.evaluate(
          () => window.shinyCardHarness.environment.values.ProfileMons,
        ),
        { demon: 0, angel: 2, drainer: 0, spirit: 0, mystic: 0 },
      );
      await page.evaluate(() => window.shinyCardHarness.hide());
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
    });
  },
);
