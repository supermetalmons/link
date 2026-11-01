import { required } from "./fixtures/canonicalData.mjs";
import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBrowserViteServer } from "./browserViteServer.mjs";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="120"><rect width="100" height="120" fill="#88aa99"/></svg>';

/** @param {(page: import("playwright").Page, releaseImage: () => void) => Promise<void>} run @param {{delayedPrize?: import("@mons/shared/event-prizes").EventPrizeId, viewport?: {width: number, height: number}}} [options] */
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
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(10000);
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    /** @type {PromiseWithResolvers<void>} */
    const image = Promise.withResolvers();
    const imageGate = image.promise,
      releaseImage = image.resolve;
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
    await page.waitForFunction(() => !!window.eventPrizeSelectionHarness);
    await page.waitForFunction(
      (count) =>
        window.eventPrizeSelectionHarness.snapshot().loadedImageIds.length ===
        count,
      delayedPrize ? 2 : 3,
    );
    await run(page, releaseImage);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

/** @param {import("playwright").Page} page */
const snapshot = (page) =>
  page.evaluate(() => window.eventPrizeSelectionHarness.snapshot());
/** @param {import("playwright").Page} page @param {import("@mons/shared/event-prizes").EventPrizeId} id */
const prizeButton = (page, id) =>
  page.locator(`button:has(> img[src="/__prize/${id}.svg"])`);
/** @param {import("playwright").Page} page */
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
        await page.evaluate(() =>
          window.eventPrizeSelectionHarness.toggleImmediately("1111"),
        ),
        true,
      );
      assert.equal(await row(page).getAttribute("aria-busy"), "true");
      assert.equal(await prizeButton(page, "1514").isEnabled(), true);
      await prizeButton(page, "1514").click();
      assert.deepEqual((await snapshot(page)).selections, { p1: "1514" });
      assert.equal((await snapshot(page)).mutations.length, 1);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.settle(0, "1111"),
      );
      assert.equal(
        required((await snapshot(page)).mutations[1]).prizeId,
        "1514",
      );
      assert.equal((await snapshot(page)).isPending, true);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.settle(1, "1514"),
      );
      assert.equal((await snapshot(page)).isPending, false);
      await prizeButton(page, "1514").click();
      assert.deepEqual((await snapshot(page)).selections, {});
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.settle(2, null),
      );
      await prizeButton(page, "1092").click();
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.settle(3, null, "request failed"),
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
          (currentProfileId) =>
            window.eventPrizeSelectionHarness.setView({ currentProfileId }),
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
          window.eventPrizeSelectionHarness.emit({ p1: "1092", p2: "1111" }),
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
              (img) =>
                img instanceof HTMLImageElement &&
                img.isConnected &&
                img.complete &&
                img.naturalWidth > 0,
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
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.toggleImmediately("1111"),
      );
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({ otherEvent: true }),
      );
      await page.evaluate(
        (index) =>
          window.eventPrizeSelectionHarness.emit({ p2: "1514" }, index),
        oldIndex,
      );
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.settle(0, "1111"),
      );
      assert.deepEqual((await snapshot(page)).selections, { p1: "1092" });
      assert.equal((await snapshot(page)).isPending, false);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({
          currentProfileId: "",
          canSelect: false,
        }),
      );
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.emit({ p2: "1111" }),
      );
      assert.deepEqual((await snapshot(page)).selections, { p2: "1111" });
      const anonymousIndex = (await snapshot(page)).subscriptions.findIndex(
        (s) => s.active,
      );
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({ isOpen: false }),
      );
      await page.evaluate(
        (index) =>
          window.eventPrizeSelectionHarness.emit({ p3: "1514" }, index),
        anonymousIndex,
      );
      assert.deepEqual((await snapshot(page)).selections, {});
      assert.equal(
        (await snapshot(page)).subscriptions.filter((s) => s.active).length,
        0,
      );
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({
          isOpen: true,
          currentProfileId: "p2",
        }),
      );
      assert.equal(
        (await snapshot(page)).subscriptions.filter((s) => s.active).length,
        1,
      );
      await page.evaluate(() => window.eventPrizeSelectionHarness.dispose());
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
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.emit({ p1: "1111" }),
      );
      assert.ok(
        (await snapshot(page)).motions.some((motion) => {
          if (!Array.isArray(motion.frames)) return false;
          const first = motion.frames[0],
            last = motion.frames[1];
          return (
            motion.target === "Open Player 1" &&
            typeof first?.transform === "string" &&
            first.transform.startsWith("translate(") &&
            last?.transform === "translate(0, 0)"
          );
        }),
      );
      await page.evaluate(() => window.eventPrizeSelectionHarness.emit({}));
      assert.equal((await snapshot(page)).exitClones, 1);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.finishAnimations(),
      );
      await page.waitForFunction(
        () => window.eventPrizeSelectionHarness.snapshot().exitClones === 0,
      );
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.emit({ p1: "1111" }),
      );
      await page.evaluate(() => window.eventPrizeSelectionHarness.emit({}));
      assert.equal((await snapshot(page)).exitClones, 1);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({ concealed: true }),
      );
      assert.equal((await snapshot(page)).exitClones, 0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => {
        window.eventPrizeSelectionHarness.clearMotions();
        window.eventPrizeSelectionHarness.setView({ concealed: false });
        window.eventPrizeSelectionHarness.emit({ p2: "1092" });
        window.eventPrizeSelectionHarness.emit({ p2: "1111" });
        window.eventPrizeSelectionHarness.emit({});
      });
      assert.deepEqual((await snapshot(page)).motions, []);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.emit({ p2: "1092" }),
      );
      await page.evaluate(() => window.eventPrizeSelectionHarness.emit({}));
      assert.equal((await snapshot(page)).exitClones, 1);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({ isOpen: false }),
      );
      assert.equal((await snapshot(page)).exitClones, 0);
      await page.evaluate(() => {
        if (!Reflect.set(Element.prototype, "animate", undefined))
          throw new Error("fixture-animation-disable-failed");
        window.eventPrizeSelectionHarness.setView({ isOpen: true });
        window.eventPrizeSelectionHarness.emit({ p3: "1111" });
        window.eventPrizeSelectionHarness.emit({});
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
          window.eventPrizeSelectionHarness.emit({
            p1: "1092",
            p2: "1111",
            p8: "1514",
          }),
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
          window.eventPrizeSelectionHarness.setView({ participantCount: 8 }),
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
                Array.isArray(motion.frames) &&
                motion.frames[0]?.opacity === 0 &&
                motion.frames[1]?.opacity === 1,
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
      /** @type {[number, string, string][]} */
      const densityCases = [
        [3, "4px", "0px"],
        [4, "1px", "-4px"],
        [6, "1px", "-4px"],
        [7, "0px", "-8px"],
      ];
      for (const [count, gap, margin] of densityCases) {
        await page.evaluate(
          (count) =>
            window.eventPrizeSelectionHarness.emit(
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
      const before = required(await row(page).boundingBox());
      await page.setViewportSize({ width: 360, height: 740 });
      const after = required(await row(page).boundingBox());
      assert.ok(before.width > 0 && after.width > 0 && after.width <= 360);
      const artwork = await prizeButton(page, "1092")
        .locator("img")
        .evaluate((img) => {
          if (!(img instanceof HTMLImageElement))
            throw new Error("fixture-prize-image-missing");
          return {
            width: img.width,
            height: img.height,
            declaredWidth: Number(img.getAttribute("width")),
            declaredHeight: Number(img.getAttribute("height")),
          };
        });
      assert.ok(artwork.declaredWidth > 0 && artwork.declaredHeight > 0);
      assert.ok(
        Math.abs(
          artwork.width / artwork.height -
            artwork.declaredWidth / artwork.declaredHeight,
        ) < 0.03,
      );
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({ concealed: true }),
      );
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
        window.eventPrizeSelectionHarness.setView({
          concealed: false,
          canSelect: false,
        }),
      );
      assert.equal(await prizeButton(page, "1092").isDisabled(), true);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.setView({ ended: true }),
      );
      assert.equal(
        await page.getByRole("group", { name: /^Selected by/ }).count(),
        0,
      );
    });
  },
);

test(
  "concealed portrait artwork fills the card without zoom or washed-out edges",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.addStyleTag({
        content:
          '[aria-label="Event prizes"] button > span[aria-hidden="true"] { visibility: hidden !important; }',
      });
      const button = prizeButton(page, "1092");
      const image = button.locator("img");
      for (const viewport of [
        { width: 1200, height: 900 },
        { width: 360, height: 740 },
      ]) {
        await page.setViewportSize(viewport);
        /** @type {("light" | "dark")[]} */
        const colorSchemes = ["light", "dark"];
        for (const colorScheme of colorSchemes) {
          await page.emulateMedia({ colorScheme });
          await page.evaluate(() =>
            window.eventPrizeSelectionHarness.setView({ concealed: true }),
          );
          const presentation = await image.evaluate((img) => {
            if (!(img instanceof HTMLImageElement) || !img.parentElement)
              throw new Error("fixture-prize-image-missing");
            const style = getComputedStyle(img);
            const filterId = style.filter.match(/#([^"')]+)["']?\)$/)?.[1];
            const imageBounds = img.getBoundingClientRect();
            const cardBounds = img.parentElement.getBoundingClientRect();
            return {
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              objectFit: style.objectFit,
              transform: style.transform,
              opacity: style.opacity,
              concealmentFilterPresent: Boolean(
                filterId &&
                document.getElementById(decodeURIComponent(filterId)) instanceof
                  SVGFilterElement,
              ),
              imageBounds: imageBounds.toJSON(),
              cardBounds: cardBounds.toJSON(),
            };
          });
          assert.ok(presentation.naturalHeight > presentation.naturalWidth);
          assert.equal(presentation.objectFit, "cover");
          assert.equal(presentation.transform, "none");
          assert.equal(presentation.opacity, "1");
          assert.equal(presentation.concealmentFilterPresent, true);
          assert.ok(
            Math.abs(
              presentation.cardBounds.width - presentation.cardBounds.height,
            ) < 1,
          );
          for (const dimension of ["x", "y", "width", "height"]) {
            assert.ok(
              Math.abs(
                presentation.imageBounds[dimension] -
                  presentation.cardBounds[dimension],
              ) < 1,
            );
          }
          const screenshot = await button.screenshot();
          const samples = await page.evaluate(
            async (dataUrl) => {
              const screenshot = new Image();
              screenshot.src = dataUrl;
              await screenshot.decode();
              const canvas = document.createElement("canvas");
              canvas.width = screenshot.naturalWidth;
              canvas.height = screenshot.naturalHeight;
              const context = canvas.getContext("2d");
              if (!context) throw new Error("fixture-canvas-context-missing");
              context.drawImage(screenshot, 0, 0);
              const centerX = Math.floor(canvas.width / 2);
              const centerY = Math.floor(canvas.height / 2);
              /** @type {[number, number][]} */
              const coordinates = [
                [centerX, centerY],
                [3, centerY],
                [canvas.width - 4, centerY],
                [centerX, 3],
                [centerX, canvas.height - 4],
                [8, 8],
                [canvas.width - 9, canvas.height - 9],
              ];
              return coordinates.map(([x, y]) => ({
                x,
                y,
                rgb: [...context.getImageData(x, y, 1, 1).data].slice(0, 3),
              }));
            },
            `data:image/png;base64,${screenshot.toString("base64")}`,
          );
          for (const sample of samples) {
            assert.ok(
              sample.rgb.every(
                (channel, index) =>
                  Math.abs(channel - required([136, 170, 153][index])) <= 6,
              ),
              `${colorScheme} ${viewport.width}px at ${sample.x},${sample.y}: ${sample.rgb}`,
            );
          }
          await page.evaluate(() =>
            window.eventPrizeSelectionHarness.setView({ concealed: false }),
          );
          const revealed = await image.evaluate((img) => {
            if (!(img instanceof HTMLImageElement))
              throw new Error("fixture-prize-image-missing");
            return {
              filter: getComputedStyle(img).filter,
              transform: getComputedStyle(img).transform,
              width: img.width,
              height: img.height,
              declaredWidth: Number(img.getAttribute("width")),
              declaredHeight: Number(img.getAttribute("height")),
            };
          });
          assert.equal(revealed.filter, "none");
          assert.equal(revealed.transform, "none");
          assert.ok(
            Math.abs(
              revealed.width / revealed.height -
                revealed.declaredWidth / revealed.declaredHeight,
            ) < 0.03,
          );
        }
      }
    });
  },
);

test(
  "the real event modal replaces scheduled prizes with ended awards at desktop and narrow sizes",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => window.eventPrizeSelectionHarness.mountModal());
      await row(page).waitFor();
      assert.equal(await row(page).locator("img").count(), 3);
      await page.evaluate(() =>
        window.eventPrizeSelectionHarness.finishEvent(),
      );
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
      await page.evaluate(() => window.eventPrizeSelectionHarness.closeModal());
      assert.equal(await awards.count(), 0);
      assert.equal(
        (await snapshot(page)).subscriptions.filter((s) => s.active).length,
        0,
      );
    });
  },
);
