import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBrowserViteServer } from "./browserViteServer.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="120"><rect width="100" height="120" fill="#88aa99"/></svg>';

async function fixture(
  run,
  { delayedPrize, viewport = { width: 1200, height: 900 } } = {},
) {
  const environmentPath = fileURLToPath(
    new URL("./fixtures/eventPrizeSelectionEnvironment.ts", import.meta.url),
  );
  const server = await createBrowserViteServer({
    root: repository,
    cacheDir: `node_modules/.vite-event-prizes-${process.pid}`,
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
      ],
    },
    logLevel: "error",
    plugins: [
      {
        name: "event-prize-browser-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__event-prizes") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/test/fixtures/eventPrizeSelectionHarness.tsx"></script>',
            );
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseImage;
    const imageGate = new Promise((resolve) => {
      releaseImage = resolve;
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/__prize/") || url.origin !== origin) {
        if (url.pathname === `/__prize/${delayedPrize}.svg`) await imageGate;
        if (route.request().resourceType() === "image") {
          return route.fulfill({ contentType: "image/svg+xml", body: svg });
        }
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(`${origin}/__event-prizes`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => !!window.harness);
    await page.waitForFunction(
      (count) => window.harness.snapshot().loadedImageIds.length === count,
      delayedPrize ? 2 : 3,
    );
    await run(page, releaseImage);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

const snapshot = (page) => page.evaluate(() => window.harness.snapshot());
const prizeButton = (page, id) =>
  page.locator(`button:has(> img[src="/__prize/${id}.svg"])`);
const row = (page) =>
  page.getByRole("group", { name: "Event prizes", exact: true });

test(
  "prize selection preserves initial hydration, rapid optimistic actions, and rollback",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const initial = await snapshot(page);
      assert.equal(initial.subscriptions.filter((s) => s.active).length, 1);
      assert.ok(initial.subscriptions.length >= 2);
      assert.deepEqual(initial.selections, { p1: "1092" });
      assert.deepEqual(initial.motions, []);
      assert.equal(
        await prizeButton(page, "1092").getAttribute("aria-pressed"),
        "true",
      );

      assert.equal(
        await page.evaluate(() => window.harness.toggleImmediately("1111")),
        true,
      );
      assert.equal(await row(page).getAttribute("aria-busy"), "true");
      assert.equal(await prizeButton(page, "1514").isEnabled(), true);
      await prizeButton(page, "1514").click();
      assert.deepEqual((await snapshot(page)).selections, { p1: "1514" });
      assert.equal((await snapshot(page)).mutations.length, 1);
      await page.evaluate(() => window.harness.settle(0, "1111"));
      assert.equal((await snapshot(page)).mutations[1].prizeId, "1514");
      assert.equal((await snapshot(page)).isPending, true);
      await page.evaluate(() => window.harness.settle(1, "1514"));
      assert.equal((await snapshot(page)).isPending, false);
      await prizeButton(page, "1514").click();
      assert.deepEqual((await snapshot(page)).selections, {});
      await page.evaluate(() => window.harness.settle(2, null));
      await prizeButton(page, "1092").click();
      await page.evaluate(() =>
        window.harness.settle(3, null, "request failed"),
      );
      assert.deepEqual((await snapshot(page)).selections, {});
      assert.equal(await row(page).getAttribute("aria-busy"), null);
    });
  },
);

test(
  "profile changes keep loaded artwork and prize selection avatars visible",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const artwork = await page
        .locator('img[src^="/__prize/"]')
        .elementHandles();
      assert.equal(artwork.length, 3);
      for (const currentProfileId of ["p2", "", "p1"]) {
        await page.evaluate(
          (currentProfileId) => window.harness.setView({ currentProfileId }),
          currentProfileId,
        );
        assert.equal((await snapshot(page)).loadedImageIds.length, 3);
        assert.equal(
          (await snapshot(page)).subscriptions.filter((s) => s.active).length,
          1,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Open Player 1", exact: true })
            .isVisible(),
          true,
        );
        await page.evaluate(() =>
          window.harness.emit({ p1: "1092", p2: "1111" }),
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Open Player 2", exact: true })
            .isVisible(),
          true,
        );
        for (const image of artwork) {
          assert.equal(
            await image.evaluate(
              (img) => img.isConnected && img.complete && img.naturalWidth > 0,
            ),
            true,
          );
        }
      }
    });
  },
);

test(
  "event and identity changes dispose subscriptions and fence old results, including anonymous callbacks",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const oldIndex = (await snapshot(page)).subscriptions.findIndex(
        (s) => s.active,
      );
      await page.evaluate(() => window.harness.toggleImmediately("1111"));
      await page.evaluate(() => window.harness.setView({ otherEvent: true }));
      await page.evaluate(
        (index) => window.harness.emit({ p2: "1514" }, index),
        oldIndex,
      );
      await page.evaluate(() => window.harness.settle(0, "1111"));
      assert.deepEqual((await snapshot(page)).selections, { p1: "1092" });
      assert.equal((await snapshot(page)).isPending, false);
      await page.evaluate(() =>
        window.harness.setView({ currentProfileId: "", canSelect: false }),
      );
      await page.evaluate(() => window.harness.emit({ p2: "1111" }));
      assert.deepEqual((await snapshot(page)).selections, { p2: "1111" });
      const anonymousIndex = (await snapshot(page)).subscriptions.findIndex(
        (s) => s.active,
      );
      await page.evaluate(() => window.harness.setView({ isOpen: false }));
      await page.evaluate(
        (index) => window.harness.emit({ p3: "1514" }, index),
        anonymousIndex,
      );
      assert.deepEqual((await snapshot(page)).selections, {});
      assert.equal(
        (await snapshot(page)).subscriptions.filter((s) => s.active).length,
        0,
      );
      await page.evaluate(() =>
        window.harness.setView({ isOpen: true, currentProfileId: "p2" }),
      );
      assert.equal(
        (await snapshot(page)).subscriptions.filter((s) => s.active).length,
        1,
      );
      await page.evaluate(() => window.harness.dispose());
      assert.equal(
        (await snapshot(page)).subscriptions.filter((s) => s.active).length,
        0,
      );
      assert.equal((await snapshot(page)).exitClones, 0);
    });
  },
);

test(
  "avatar animations clean up on concealment and close and honor reduced motion",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => window.harness.emit({ p1: "1111" }));
      assert.ok(
        (await snapshot(page)).motions.some(
          (motion) =>
            motion.target === "Open Player 1" &&
            motion.frames[0].transform.startsWith("translate(") &&
            motion.frames[1].transform === "translate(0, 0)",
        ),
      );
      await page.evaluate(() => window.harness.emit({}));
      assert.equal((await snapshot(page)).exitClones, 1);
      await page.evaluate(() => window.harness.finishAnimations());
      await page.waitForFunction(
        () => window.harness.snapshot().exitClones === 0,
      );
      await page.evaluate(() => window.harness.emit({ p1: "1111" }));
      await page.evaluate(() => window.harness.emit({}));
      assert.equal((await snapshot(page)).exitClones, 1);
      await page.evaluate(() => window.harness.setView({ concealed: true }));
      assert.equal((await snapshot(page)).exitClones, 0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => {
        window.harness.clearMotions();
        window.harness.setView({ concealed: false });
        window.harness.emit({ p2: "1092" });
        window.harness.emit({ p2: "1111" });
        window.harness.emit({});
      });
      assert.deepEqual((await snapshot(page)).motions, []);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => window.harness.emit({ p2: "1092" }));
      await page.evaluate(() => window.harness.emit({}));
      assert.equal((await snapshot(page)).exitClones, 1);
      await page.evaluate(() => window.harness.setView({ isOpen: false }));
      assert.equal((await snapshot(page)).exitClones, 0);
      await page.evaluate(() => {
        Element.prototype.animate = undefined;
        window.harness.setView({ isOpen: true });
        window.harness.emit({ p3: "1111" });
        window.harness.emit({});
      });
      assert.equal((await snapshot(page)).exitClones, 0);
    });
  },
);

test(
  "avatar placement waits for artwork and participants without losing pending updates",
  { timeout: 60000 },
  async () => {
    await fixture(
      async (page, releaseImage) => {
        await page.evaluate(() =>
          window.harness.emit({ p1: "1092", p2: "1111", p8: "1514" }),
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Open Player 2", exact: true })
            .count(),
          0,
        );
        releaseImage();
        await page
          .getByRole("button", { name: "Open Player 2", exact: true })
          .waitFor();
        await page.evaluate(() =>
          window.harness.setView({ participantCount: 8 }),
        );
        await page
          .getByRole("button", { name: "Open Player 8", exact: true })
          .waitFor();
        const motions = (await snapshot(page)).motions;
        for (const name of ["Open Player 2", "Open Player 8"]) {
          assert.ok(
            motions.some(
              (motion) =>
                motion.target === name &&
                motion.frames[0].opacity === 0 &&
                motion.frames[1].opacity === 1,
            ),
          );
        }
        await page
          .getByRole("button", { name: "Open Player 2", exact: true })
          .click();
        assert.deepEqual((await snapshot(page)).participantClicks, ["p2"]);
      },
      { delayedPrize: "1111" },
    );
  },
);

test(
  "prize presentation preserves labels, artwork sizes, density, concealment, and locked states",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const [count, gap, margin] of [
        [3, "4px", "0px"],
        [4, "1px", "-4px"],
        [6, "1px", "-4px"],
        [7, "0px", "-8px"],
      ]) {
        await page.evaluate(
          (count) =>
            window.harness.emit(
              Object.fromEntries(
                Array.from({ length: count }, (_, i) => [`p${i + 1}`, "1092"]),
              ),
            ),
          count,
        );
        const group = page.getByRole("group", { name: /^Selected by/ });
        assert.equal(
          await group.evaluate((el) => getComputedStyle(el).columnGap),
          gap,
        );
        assert.equal(
          await group
            .locator("button")
            .first()
            .evaluate((el) => getComputedStyle(el).marginLeft),
          margin,
        );
      }
      const before = await row(page).boundingBox();
      await page.setViewportSize({ width: 360, height: 740 });
      const after = await row(page).boundingBox();
      assert.ok(before.width > 0 && after.width > 0 && after.width <= 360);
      const artwork = await prizeButton(page, "1092")
        .locator("img")
        .evaluate((img) => ({
          width: img.width,
          height: img.height,
          declaredWidth: Number(img.getAttribute("width")),
          declaredHeight: Number(img.getAttribute("height")),
        }));
      assert.ok(artwork.declaredWidth > 0 && artwork.declaredHeight > 0);
      assert.ok(
        Math.abs(
          artwork.width / artwork.height -
            artwork.declaredWidth / artwork.declaredHeight,
        ) < 0.03,
      );
      await page.evaluate(() => window.harness.setView({ concealed: true }));
      assert.equal(
        await page
          .getByRole("button", {
            name: "Mystery prize. Reveals less than one hour before the event starts.",
            exact: true,
          })
          .count(),
        3,
      );
      assert.equal(
        await prizeButton(page, "1092").getAttribute("aria-pressed"),
        null,
      );
      assert.equal(
        await prizeButton(page, "1092")
          .locator('> span[aria-hidden="true"] > span')
          .count(),
        7,
      );
      await page.evaluate(() =>
        window.harness.setView({ concealed: false, canSelect: false }),
      );
      assert.equal(await prizeButton(page, "1092").isDisabled(), true);
      await page.evaluate(() => window.harness.setView({ ended: true }));
      assert.equal(
        await page.getByRole("group", { name: /^Selected by/ }).count(),
        0,
      );
    });
  },
);

test(
  "the real event modal replaces scheduled prizes with ended awards at desktop and narrow sizes",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => window.harness.mountModal());
      await row(page).waitFor();
      assert.equal(await row(page).locator("img").count(), 3);
      await page.evaluate(() => window.harness.finishEvent());
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Event prizes"]'),
      );
      const awards = page.getByRole("group", {
        name: "Event prize winners",
        exact: true,
      });
      await awards.waitFor();
      for (const viewport of [
        { width: 1200, height: 900 },
        { width: 360, height: 740 },
      ]) {
        await page.setViewportSize(viewport);
        const bounds = await awards.boundingBox();
        assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
        assert.ok(
          bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1,
        );
        assert.ok(
          bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1,
        );
        assert.equal(await awards.locator("img").count(), 4);
      }
      await page.evaluate(() => window.harness.closeModal());
      assert.equal(await awards.count(), 0);
      assert.equal(
        (await snapshot(page)).subscriptions.filter((s) => s.active).length,
        0,
      );
    });
  },
);
