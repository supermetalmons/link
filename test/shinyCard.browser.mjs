import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
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
    /\/src\/ui\/(?:ShinyCard|shinyCard)/.test(new Error().stack);
  const timeouts = new Set();
  const rafs = new Set();
  const listeners = [];
  const observers = new Map();
  const setTimeoutNative = window.setTimeout.bind(window);
  const clearTimeoutNative = window.clearTimeout.bind(window);
  const rafNative = window.requestAnimationFrame.bind(window);
  const cancelRafNative = window.cancelAnimationFrame.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    const tracked = owned();
    const id = setTimeoutNative(() => {
      timeouts.delete(id);
      callback(...args);
    }, delay);
    if (tracked) timeouts.add(id);
    return id;
  };
  window.clearTimeout = (id) => {
    timeouts.delete(id);
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
  const capture = (options) =>
    typeof options === "boolean" ? options : !!options?.capture;
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (owned() && !options?.signal?.aborted) {
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
        if (options?.signal)
          add.call(
            options.signal,
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
  EventTarget.prototype.removeEventListener = function (
    type,
    callback,
    options,
  ) {
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
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback) {
      super(callback);
      if (owned()) observers.set(this, new Set());
    }
    observe(target, options) {
      observers.get(this)?.add(target);
      super.observe(target, options);
    }
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
    optimizeDeps: { include: ["@mons/shared/profiles", "@mons/shared/ids"] },
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
  let browser;
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
  const heldImages = [];
  let resolveImageStarted;
  const imageStarted = new Promise((resolve) => {
    resolveImageStarted = resolve;
  });
  let holdImages = deferredImages;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
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
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
    await page.addInitScript(trackCardResources);
    await page.goto(`${origin}/__shiny-card`);
    await page.waitForFunction(() => !!window.harness);
    if (!deferredSprites)
      await page.evaluate(() => window.harness.environment.releaseSprites());
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

const waitForMons = (page) =>
  page.waitForFunction(() => window.harness.snapshot().mons.length === 5);
const noResources = {
  timeouts: 0,
  rafs: 0,
  listeners: 0,
  elements: 0,
  detachedElements: 0,
  observed: 0,
};

test(
  "closing editing cards cancels resources immediately and repeatedly",
  { timeout: 60_000 },
  async (t) => {
    await fixture(t, async ({ page }) => {
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.evaluate(() => window.harness.own());
        await waitForMons(page);
        await page.evaluate(() => {
          window.harness.edit();
          window.harness.clickEmoji();
          window.harness.done();
          window.harness.edit();
        });
        const active = await page.evaluate(() => window.cardResources());
        assert.ok(active.rafs > 0);
        assert.ok(active.timeouts > 0);
        assert.ok(active.listeners > 0);
        assert.ok(active.observed > 0);
        await page.evaluate(() => {
          window.harness.retire();
          window.harness.hide();
        });
        assert.deepEqual(
          await page.evaluate(() => window.cardResources()),
          noResources,
        );
        const writes = await page.evaluate(
          () => window.harness.environment.writes.length,
        );
        await page.evaluate(() => window.harness.dispatchRetiredEvents());
        await page.clock.runFor(1000);
        assert.equal(
          await page.evaluate(() => window.harness.retiredMutations()),
          0,
        );
        assert.equal(
          await page.evaluate(() => window.harness.environment.writes.length),
          writes,
        );
        assert.equal(
          await page.evaluate(() => window.harness.snapshot().count),
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
      await page.evaluate(() => window.harness.own());
      await waitForMons(page);
      const baseline = await page.evaluate(() => window.cardResources());
      for (let cycle = 0; cycle < 4; cycle++) {
        await page.evaluate(() => {
          window.harness.edit();
          window.harness.done();
        });
        await page.clock.runFor(600);
        const resources = await page.evaluate(() => window.cardResources());
        assert.equal(resources.detachedElements, 0);
        assert.equal(resources.elements, baseline.elements);
        assert.equal(resources.listeners, baseline.listeners);
      }
      await page.evaluate(() => window.harness.hide());
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
      await page.evaluate(() => window.harness.own());
      await waitForMons(page);
      await page.evaluate(() => {
        window.harness.edit();
        window.harness.clickEmoji();
        document.querySelector('[data-shiny-card="true"]').remove();
      });
      assert.equal(
        await page.evaluate(() => window.harness.snapshot().visible),
        false,
      );
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
      await page.evaluate(() => window.harness.hide());
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
        await page.evaluate(() => window.harness.own());
        await imageStarted;
        await page.evaluate(() => {
          window.harness.retire();
          return window.harness.other();
        });
        assert.equal(
          await page.evaluate(() => window.harness.snapshot().mons.length),
          0,
        );
        await page.evaluate(() => window.harness.environment.releaseSprites());
        await waitForMons(page);
        await releaseImages();
        await page.evaluate(() => window.harness.dispatchRetiredEvents());
        await page.clock.runFor(1000);
        const snapshot = await page.evaluate(() => window.harness.snapshot());
        assert.equal(snapshot.count, 1);
        assert.match(snapshot.text, /other-b/);
        assert.match(snapshot.background, /\/7\.webp$/);
        assert.match(snapshot.emoji, /\/2\.webp$/);
        assert.equal(snapshot.mons.length, 5);
        assert.equal(
          await page.evaluate(() => window.harness.retiredMutations()),
          0,
        );
        assert.deepEqual(
          await page.evaluate(() => window.harness.environment.spriteRequests),
          [
            "notchur_demon",
            "gerp_angel",
            "greenseech_drainer",
            "omenstatue_spirit",
            "dart_mystic",
          ],
        );
        await page.evaluate(() => window.harness.hide());
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
          const h = window.harness;
          const profile = {
            id: "same-other",
            emoji: "2",
            profileMons: "0,0,0,0,0",
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
        await page.evaluate(() => window.harness.environment.releaseSprites());
        await waitForMons(page);
        await page.evaluate(() => {
          window.harness.edit();
          window.harness.clickBackground();
        });
        assert.equal(
          await page.evaluate(
            () => window.harness.environment.values.CardBackgroundId,
          ),
          31,
        );
        await page.evaluate(() => window.harness.hide());
        assert.deepEqual(
          await page.evaluate(() => window.cardResources()),
          noResources,
        );
      },
      { deferredSprites: true },
    );
  },
);

for (const mobile of [false, true]) {
  test(
    `card dimensions and editing remain stable on ${mobile ? "mobile" : "desktop"}`,
    { timeout: 60_000 },
    async (t) => {
      await fixture(
        t,
        async ({ page }) => {
          await page.evaluate(() => window.harness.own());
          await waitForMons(page);
          let snapshot = await page.evaluate(() => window.harness.snapshot());
          const expectedWidth = mobile ? 312 : 350;
          assert.ok(Math.abs(snapshot.bounds.width - expectedWidth) < 1);
          assert.ok(
            Math.abs(
              snapshot.bounds.width / snapshot.bounds.height - 2217 / 1625,
            ) < 0.01,
          );
          await page.evaluate(() => window.harness.edit());
          assert.equal(
            await page.evaluate(() => window.harness.snapshot().editing),
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
            window.harness.hide();
            return window.harness.other();
          });
          snapshot = await page.evaluate(() => window.harness.snapshot());
          assert.ok(
            Math.abs(snapshot.bounds.width - (mobile ? 269.1 : 350)) < 1,
          );
          await page.evaluate(() => {
            window.harness.edit();
            window.harness.clickEmoji();
          });
          assert.equal(
            await page.evaluate(() => window.harness.snapshot().editing),
            false,
          );
          assert.deepEqual(
            await page.evaluate(() => window.harness.environment.writes),
            [],
          );
          await page.evaluate(() => window.harness.hide());
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
      await page.evaluate(() => window.harness.own());
      await page.evaluate(() => {
        window.harness.edit();
        window.harness.clickBackground();
        window.harness.hide();
      });
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.values.CardBackgroundId,
        ),
        31,
      );
      await page.evaluate(() => window.harness.own());
      await page.evaluate(() => window.harness.edit());
      assert.equal(
        await page.evaluate(() => window.harness.snapshot().undoDisabled),
        false,
      );
      await page.evaluate(() => window.harness.undo());
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.values.CardBackgroundId,
        ),
        30,
      );
      await page.evaluate(() => {
        window.harness.clickBackground();
        window.harness.hide();
        window.harness.environment.values.ProfileId = "owner-b";
        return window.harness.own();
      });
      await page.evaluate(() => window.harness.edit());
      assert.equal(
        await page.evaluate(() => window.harness.snapshot().undoDisabled),
        true,
      );
      await page.evaluate(() => window.harness.hide());
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
        window.harness.inventoryEmoji(1009, "rainbow");
        window.harness.inventorySpecial(1);
        window.harness.inventorySpecial(2);
        window.harness.inventorySpecial(0);
      });
      assert.equal(
        await page.evaluate(() => window.harness.snapshot().count),
        0,
      );
      assert.deepEqual(await page.evaluate(() => window.harness.selection()), {
        avatarId: 9,
        specialIds: [0, 1, 2],
      });
      await page.evaluate(() => window.harness.other());
      await waitForMons(page);
      const before = await page.evaluate(() => window.harness.snapshot());
      await page.evaluate(() => {
        window.harness.inventoryEmoji(1010, "");
        window.harness.inventorySpecial(0);
      });
      assert.deepEqual(
        await page.evaluate(() => window.harness.snapshot()),
        before,
      );
      await page.evaluate(() => {
        window.harness.hide();
        return window.harness.own();
      });
      await waitForMons(page);
      const own = await page.evaluate(() => window.harness.snapshot());
      assert.match(own.background, /\/100\.webp$/);
      assert.match(own.emoji, /\/1010\.webp$/);
      assert.equal(
        await page.evaluate(() => window.harness.selection().avatarId),
        10,
      );
      await page.evaluate(() => window.harness.hide());
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
      await page.evaluate(() => window.harness.own());
      await waitForMons(page);
      await page.evaluate(() => {
        window.harness.edit();
        window.harness.clickMon(1);
        window.harness.clickMon(1);
        window.harness.clickMon(1);
      });
      await page.waitForFunction(
        () =>
          window.harness.snapshot().mons[1] ===
          `data:image/webp;base64,${window.harness.spriteForKey("mowch_angel")}`,
      );
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.values.ProfileMons,
        ),
        "0,3,0,0,0",
      );
      await page.evaluate(() => window.harness.undo());
      await page.waitForFunction(
        () =>
          window.harness.snapshot().mons[1] ===
          `data:image/webp;base64,${window.harness.spriteForKey("goxfold_angel")}`,
      );
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.values.ProfileMons,
        ),
        "0,2,0,0,0",
      );
      await page.evaluate(() => window.harness.hide());
      assert.deepEqual(
        await page.evaluate(() => window.cardResources()),
        noResources,
      );
    });
  },
);
