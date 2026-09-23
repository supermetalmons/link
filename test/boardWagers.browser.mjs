import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.MONS_PLAYWRIGHT_PATH || "playwright";
const { chromium } = require(playwrightPath);
const repository = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = process.env.MONS_BOARD_WAGER_BASELINE;
const outputDirectory = path.resolve(
  process.env.MONS_BOARD_WAGER_OUTPUT || "test-results/board-wagers",
);
const fixturePath = path.join(
  repository,
  "test/fixtures/boardWagersEnvironment.tsx",
);
const stubbedModules = new Set(
  [
    "game/gameController",
    "game/board",
    "connection/connection",
    "game/wagerState",
    "hooks/useAvailableMaterials",
    "utils/misc",
    "content/boardStyles",
    "resources/imageResources",
    "ui/rainbowAura",
    "ui/uiSession",
    "ui/controls/bottomControlsPort",
  ].map((name) => path.join(repository, "src", name)),
);

async function fixture(sourcePath, run) {
  const server = await createServer({
    root: repository,
    configFile: false,
    logLevel: "error",
    cacheDir: "node_modules/.vite-board-wagers-" + process.pid,
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    plugins: [
      {
        name: "board-wager-browser-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith("/__wagers?")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/test/fixtures/boardWagersHarness.tsx"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (importer && id.startsWith(".")) {
            const resolved = path
              .resolve(path.dirname(importer), id)
              .replace(/\.(ts|tsx)$/, "");
            if (stubbedModules.has(resolved)) return fixturePath;
          }
        },
        load(id) {
          if (
            sourcePath &&
            id === path.join(repository, "src/ui/BoardComponent.tsx")
          )
            return readFileSync(sourcePath, "utf8");
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    const origin = "http://127.0.0.1:" + server.httpServer.address().port;
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-threaded-animation"],
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    await run({ browser, origin });
  } finally {
    await browser?.close();
    await server.close();
  }
}

async function openPage(browser, origin, mobile, dark) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1200, height: 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: dark ? "dark" : "light",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (route.request().resourceType() === "image")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1161"><rect width="1100" height="1161" fill="#d1c7b9"/></svg>',
      });
    return route.abort();
  });
  const start = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  await page.addInitScript(() => {
    const timeout = window.setTimeout.bind(window);
    const clearTimeout = window.clearTimeout.bind(window);
    const raf = window.requestAnimationFrame.bind(window);
    const cancelRaf = window.cancelAnimationFrame.bind(window);
    const timeouts = new Set();
    const rafs = new Set();
    window.setTimeout = (callback, delay, ...args) => {
      const tracked = new Error().stack.includes("/src/ui/");
      const id = timeout(() => {
        timeouts.delete(id);
        callback(...args);
      }, delay);
      if (tracked) timeouts.add(id);
      return id;
    };
    window.clearTimeout = (id) => {
      timeouts.delete(id);
      clearTimeout(id);
    };
    window.requestAnimationFrame = (callback) => {
      const tracked = new Error().stack.includes("/src/ui/");
      const id = raf((time) => {
        rafs.delete(id);
        callback(time);
      });
      if (tracked) rafs.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      rafs.delete(id);
      cancelRaf(id);
    };
    window.pendingBoardUiWork = () => ({
      timeouts: timeouts.size,
      rafs: rafs.size,
    });
    HTMLMediaElement.prototype.play = async () => {};
    HTMLMediaElement.prototype.pause = () => {};
  });
  await page.goto(origin + "/__wagers?" + (mobile ? "mobile=1" : "desktop=1"));
  await page
    .waitForFunction(() => !!window.harness?.e.layouts?.player, null, {
      polling: 50,
      timeout: 15000,
    })
    .catch((error) => {
      throw new Error(error.message + "\nBrowser errors: " + errors.join("\n"));
    });
  await page.clock.runFor(100);
  assert.ok(
    (await page.evaluate(() => window.harness.e.renderReplays)) > 0,
    "Initial empty wager snapshot was not delivered",
  );
  return { context, page, errors };
}

const invoke = (page, method, ...args) =>
  page.evaluate(({ method, args }) => window.harness[method](...args), {
    method,
    args,
  });
const pile = (page, side) =>
  page.locator('[data-wager-pile="' + side + '"]').last();
async function waitForReadiness(promise, description) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for " + description)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
async function interact(page, locator, mobile) {
  await locator.evaluate(
    (element, touch) =>
      window.harness.run(() =>
        element.dispatchEvent(
          new Event(touch ? "touchstart" : "click", {
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
    mobile,
  );
}
async function capture(page, label, mode, snapshots, animationTime = 2000) {
  await waitForReadiness(
    page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images, (image) => image.decode().catch(() => {})),
      );
    }),
    label + ": fonts and images",
  );
  await page.clock.runFor(40);
  await waitForReadiness(
    page.evaluate(async (time) => {
      const animations = document.getAnimations();
      for (const animation of animations) animation.pause();
      await Promise.all(animations.map((animation) => animation.ready));
      for (const animation of animations) animation.currentTime = time;
    }, animationTime),
    label + ": animations",
  );
  await page.clock.runFor(32);
  const geometry = await page.evaluate(() => {
    const normalize = (number) => Math.round(number * 10000) / 10000;
    const measure = (element) => {
      const r = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        side: element.dataset.wagerPile ?? null,
        rect: [r.x, r.y, r.width, r.height].map(normalize),
        style: Object.fromEntries(
          [
            "opacity",
            "transform",
            "transition",
            "animationName",
            "animationDuration",
            "animationDelay",
            "zIndex",
            "pointerEvents",
            "display",
            "backgroundColor",
            "color",
            "border",
            "gridTemplateRows",
            "padding",
            "fontSize",
          ].map((key) => [key, style[key]]),
        ),
        disabled: element.disabled ?? null,
      };
    };
    return {
      layouts: window.harness.e.layouts,
      reactions: Array.from(document.querySelectorAll("span"))
        .filter((element) => element.textContent === "Wow!")
        .map(measure),
      elements: Array.from(
        document.querySelectorAll(
          "[data-wager-pile], [data-wager-pile] img, [data-wager-panel]",
        ),
        measure,
      ),
    };
  });
  await page.screenshot({ animations: "allow" });
  const png = await page.screenshot({ animations: "allow" });
  const repeatPng = await page.screenshot({ animations: "allow" });
  assert.ok(
    png.equals(repeatPng),
    label + ": fixed animation frame did not paint consistently",
  );
  writeFileSync(path.join(outputDirectory, mode + "-" + label + ".png"), png);
  writeFileSync(
    path.join(outputDirectory, mode + "-" + label + ".json"),
    JSON.stringify(geometry, null, 2),
  );
  if (mode === "baseline") snapshots.set(label, { geometry, png });
  else if (snapshots.has(label)) {
    const before = snapshots.get(label);
    assert.deepEqual(
      geometry,
      before.geometry,
      label + ": geometry/styles changed",
    );
    if (!before.png.equals(png)) {
      const changed = await page.evaluate(
        async ([before, after]) => {
          const decode = async (base64) => {
            const bytes = Uint8Array.from(atob(base64), (character) =>
              character.charCodeAt(0),
            );
            const bitmap = await createImageBitmap(
              new Blob([bytes], { type: "image/png" }),
            );
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext("2d");
            context.drawImage(bitmap, 0, 0);
            const image = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            bitmap.close();
            return image;
          };
          const a = await decode(before);
          const b = await decode(after);
          if (a.width !== b.width || a.height !== b.height) return -1;
          let changed = 0;
          for (let index = 0; index < a.data.length; index += 4) {
            if (
              [0, 1, 2, 3].some(
                (channel) =>
                  a.data[index + channel] !== b.data[index + channel],
              )
            )
              changed++;
          }
          return changed;
        },
        [before.png.toString("base64"), png.toString("base64")],
      );
      assert.equal(changed, 0, label + ": changed pixels or image dimensions");
    }
  }
}

async function scenarios(browser, origin, mode, snapshots) {
  for (const mobile of [false, true]) {
    for (const dark of [false, true]) {
      const { context, page, errors } = await openPage(
        browser,
        origin,
        mobile,
        dark,
      );
      const prefix =
        (mobile ? "mobile" : "desktop") + "-" + (dark ? "dark" : "light");
      try {
        await invoke(page, "proposals");
        await invoke(page, "emit", { playerCount: 40 });
        assert.equal(await pile(page, "player").locator("img").count(), 13);
        await interact(page, pile(page, "opponent"), mobile);
        assert.equal(
          await page
            .getByRole("button", { name: "Accept", exact: true })
            .count(),
          1,
        );
        await capture(page, prefix + "-proposals", mode, snapshots);
        await interact(
          page,
          page.getByRole("button", { name: "Accept", exact: true }),
          mobile,
        );
        assert.equal(
          await page.evaluate(() => window.harness.e.calls.at(-1)),
          "acceptWagerProposal",
        );
        assert.equal(await page.locator("[data-wager-panel]").count(), 0);
        await invoke(page, "balance", 0, "loading");
        await interact(page, pile(page, "opponent"), mobile);
        assert.equal(
          await page
            .getByRole("button", { name: "Checking balance" })
            .isDisabled(),
          true,
        );
        await invoke(page, "balance", 0, "unavailable");
        assert.equal(
          await page
            .getByRole("button", { name: "Balance unavailable" })
            .isDisabled(),
          true,
        );
        await invoke(page, "proposals", 0, 8);
        await invoke(page, "balance", 0);
        assert.equal(
          await page
            .getByRole("button", { name: "Accept", exact: true })
            .isDisabled(),
          true,
        );
        const callsBeforeDisabled = await page.evaluate(
          () => window.harness.e.calls.length,
        );
        await interact(
          page,
          page.getByRole("button", { name: "Accept", exact: true }),
          mobile,
        );
        assert.equal(
          await page.evaluate(() => window.harness.e.calls.length),
          callsBeforeDisabled,
        );
        await invoke(page, "balance", 3);
        await interact(page, pile(page, "opponent"), mobile);
        if (
          (await page
            .getByRole("button", { name: "Accept (3)", exact: true })
            .count()) === 0
        ) {
          await interact(page, pile(page, "opponent"), mobile);
        }
        assert.equal(
          await page
            .getByRole("button", { name: "Accept (3)", exact: true })
            .isDisabled(),
          false,
        );
        await capture(page, prefix + "-partial-balance", mode, snapshots);
        await invoke(page, "proposals", 4, 8);
        assert.equal(
          await page
            .getByRole("button", { name: "Accept (7)", exact: true })
            .count(),
          1,
        );
        await interact(
          page,
          page.getByRole("button", { name: "Decline", exact: true }),
          mobile,
        );
        assert.equal(
          await page.evaluate(() => window.harness.e.calls.at(-1)),
          "declineWagerProposal",
        );
        await interact(page, pile(page, "player"), mobile);
        await interact(
          page,
          page.getByRole("button", { name: "Cancel Proposal", exact: true }),
          mobile,
        );
        assert.equal(
          await page.evaluate(() => window.harness.e.calls.at(-1)),
          "cancelWagerProposal",
        );
        await interact(page, pile(page, "opponent"), mobile);
        const outside = await page.evaluate(() => {
          const h = window.harness;
          let inside;
          let outside;
          h.run(() => {
            inside = h.e.outside({
              target: document.querySelector("[data-wager-panel]"),
            });
            outside = h.e.outside({ target: document.body });
          });
          return { inside, outside, visible: h.e.visible() };
        });
        assert.deepEqual(outside, {
          inside: false,
          outside: true,
          visible: false,
        });
        await invoke(page, "watch", true);
        await interact(page, pile(page, "opponent"), mobile);
        assert.equal(
          await page.getByRole("button", { name: /Accept|Decline/ }).count(),
          0,
        );
        await capture(page, prefix + "-watch-only", mode, snapshots);
        await invoke(page, "watch", false);
        await invoke(page, "state", {
          proposals: {},
          agreed: { material: "obsidian", count: 8 },
        });
        await invoke(page, "emit");
        await interact(page, pile(page, "opponent"), mobile);
        assert.equal(
          await page.getByRole("button", { name: /Accept|Decline/ }).count(),
          0,
        );
        await capture(page, prefix + "-agreed", mode, snapshots);
        await invoke(page, "state", {
          proposals: {},
          resolved: { winnerUid: "p" },
        });
        await invoke(page, "emit");
        assert.equal(
          await page.getByRole("button", { name: /Accept|Decline/ }).count(),
          0,
        );
        await invoke(page, "reset");
        await invoke(page, "proposals");
        await invoke(page, "names", true, true);
        await invoke(page, "emit");
        await capture(page, prefix + "-long-flipped-names", mode, snapshots);
        await invoke(page, "style", "pangchiu");
        await page.clock.runFor(80);
        await invoke(page, "emit");
        await interact(page, pile(page, "player"), mobile);
        await capture(page, prefix + "-pangchiu", mode, snapshots);
        await page.setViewportSize(
          mobile ? { width: 844, height: 390 } : { width: 860, height: 650 },
        );
        await page.evaluate(() =>
          window.harness.run(() => window.dispatchEvent(new Event("resize"))),
        );
        await page.clock.runFor(80);
        await invoke(page, "emit");
        await capture(page, prefix + "-resized", mode, snapshots);
        await invoke(page, "reset");
        await invoke(page, "clearPiles");
        await invoke(page, "emit", { animation: "appear" });
        await capture(page, prefix + "-appear-start", mode, snapshots, 0);
        await capture(page, prefix + "-appear-midpoint", mode, snapshots, 160);
        await page.clock.runFor(1300);
        await capture(page, prefix + "-pending-pulse", mode, snapshots, 700);
        assert.equal(
          await pile(page, "player").evaluate((element) =>
            element.style.animation.includes("wagerPilePendingPulse"),
          ),
          true,
        );
        await invoke(page, "emit", { material: "gold" });
        await capture(page, prefix + "-material-swap", mode, snapshots, 140);
        await page.clock.runFor(300);
        await invoke(page, "disappear");
        await capture(page, prefix + "-disappear", mode, snapshots, 140);
        await invoke(page, "winner", true);
        assert.equal(await pile(page, "winner").locator("img").count(), 26);
        await capture(page, prefix + "-winner-moving", mode, snapshots);
        await invoke(page, "winner", false);
        await interact(page, pile(page, "winner"), mobile);
        await capture(page, prefix + "-winner-panel", mode, snapshots);
        await invoke(page, "videos");
        assert.equal(await page.locator("video").count(), 2);
        await invoke(page, "reset");
        assert.equal(await page.locator("video").count(), 0);
        assert.equal(await page.locator("[data-wager-panel]").count(), 0);
        assert.equal(
          await page.evaluate(() => window.pendingBoardUiWork().timeouts),
          0,
        );
        const delayedRoutes = [];
        let resolveDelayedRoute;
        const delayedRouteReady = new Promise((resolve) => {
          resolveDelayedRoute = resolve;
        });
        await page.route("**/__delayed-rock.svg", (route) => {
          delayedRoutes.push(route);
          resolveDelayedRoute();
        });
        await invoke(page, "clearPiles");
        await invoke(page, "emit", {
          animation: "appear",
          image: origin + "/__delayed-rock.svg",
        });
        await waitForReadiness(delayedRouteReady, "wager image request");
        assert.ok(delayedRoutes.length > 0);
        await invoke(page, "videos");
        await invoke(page, "dispose");
        assert.equal(
          await page.evaluate(() => window.pendingBoardUiWork().timeouts),
          0,
        );
        for (const route of delayedRoutes)
          await route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="purple"/></svg>',
          });
        await page.unroute("**/__delayed-rock.svg");
        await page.clock.runFor(80);
        assert.equal(
          await page
            .locator("[data-wager-pile], [data-wager-panel], video")
            .count(),
          0,
        );
        await invoke(page, "mount");
        await page.clock.runFor(80);
        await invoke(page, "emit", { animation: "appear" });
        await invoke(page, "videos");
        await invoke(page, "dispose");
        assert.equal(
          await page.evaluate(() => window.pendingBoardUiWork().timeouts),
          0,
        );
        await page.clock.runFor(15000);
        assert.deepEqual(
          await page.evaluate(() => window.pendingBoardUiWork()),
          { timeouts: 0, rafs: 0 },
        );
        assert.equal(
          await page
            .locator("[data-wager-pile], [data-wager-panel], video")
            .count(),
          0,
        );
        assert.deepEqual(await invoke(page, "bindings"), {
          wager: 0,
          watch: 0,
          material: 0,
          styles: 0,
          squares: 0,
          render: false,
          layouts: false,
          outside: false,
          visible: false,
          transient: false,
        });
        await invoke(page, "mount");
        await page.clock.runFor(80);
        await invoke(page, "proposals");
        await invoke(page, "emit");
        assert.equal(await page.locator("[data-wager-pile]").count(), 5);
        const bindings = await invoke(page, "bindings");
        assert.equal(bindings.wager, 2);
        assert.equal(bindings.material, 1);
        await invoke(page, "dispose");
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  }
}

test(
  "board commands survive StrictMode and remount while preserving only cached player info",
  { timeout: 60_000 },
  async () => {
    await fixture(null, async ({ browser, origin }) => {
      const { context, page, errors } = await openPage(
        browser,
        origin,
        false,
        false,
      );
      try {
        await invoke(page, "dispose");
        await invoke(page, "names", true);
        await invoke(page, "overlay", "unmounted");
        await invoke(page, "videos");
        assert.equal(
          await page.locator("video, [data-fixture-overlay]").count(),
          0,
        );
        assert.equal(
          await page.evaluate(() => window.pendingBoardUiWork().timeouts),
          0,
        );

        const initial = await page.evaluate(() => {
          const h = window.harness;
          h.mount({ seedNames: false });
          h.videos();
          return {
            videos: document.querySelectorAll("video").length,
            overlay: document.querySelectorAll("[data-fixture-overlay]").length,
          };
        });
        assert.deepEqual(initial, { videos: 2, overlay: 0 });
        assert.equal(
          await page
            .getByText("player_a_very_long_player_name", { exact: true })
            .count(),
          1,
        );
        await invoke(page, "reset");

        await invoke(page, "overlay", "old");
        await invoke(page, "overlay", "latest");
        assert.equal(
          await page.locator('[data-fixture-overlay="latest"]').count(),
          1,
        );
        await page.locator("button").last().dispatchEvent("click");
        await page.locator("button").first().dispatchEvent("click");
        assert.deepEqual(await page.evaluate(() => window.harness.e.calls), [
          "confirm:latest",
          "cancel:latest",
        ]);
        await invoke(page, "overlay", null);

        await invoke(page, "styleViaBoardPort", "pangchiu");
        assert.equal(await page.locator(".board-svg.grid-hidden").count(), 2);
        await invoke(page, "styleViaBoardPort", "grid");
        assert.equal(await page.locator(".board-svg.grid-visible").count(), 2);
        for (const opponent of [true, false]) {
          const expected = await invoke(page, "aura", opponent, true);
          const aura = page
            .locator("[data-fixture-aura]")
            .nth(opponent ? 0 : 1);
          const actual = await aura.evaluate((element) => {
            const wrapper = element.parentElement.parentElement;
            return {
              visible: element.dataset.visible,
              mask: element.firstElementChild.dataset.mask,
              left: parseFloat(wrapper.style.left),
              top: parseFloat(wrapper.style.top),
              width: parseFloat(wrapper.style.width),
              height: parseFloat(wrapper.style.height),
            };
          });
          assert.equal(actual.visible, "true");
          assert.equal(actual.mask, `mask:${opponent}`);
          for (const key of ["left", "top", "width", "height"])
            assert.ok(Math.abs(actual[key] - expected[key]) < 0.01, key);
          await invoke(page, "aura", opponent, false);
          assert.equal(await aura.getAttribute("data-visible"), "false");
        }

        await invoke(page, "bridge", "next-player", "next-opponent");
        await invoke(page, "state", {
          proposals: {
            "next-player": { material: "obsidian", count: 4 },
            "next-opponent": { material: "obsidian", count: 8 },
          },
        });
        await invoke(page, "emit");
        await interact(page, pile(page, "player"), false);
        assert.equal(
          await page
            .getByRole("button", { name: "Cancel Proposal", exact: true })
            .count(),
          1,
        );
        await invoke(page, "clearPiles");
        await invoke(page, "dispose");
        await invoke(page, "videos");
        assert.equal(
          await page.evaluate(() => window.pendingBoardUiWork().timeouts),
          0,
        );
        await invoke(page, "mount", { seedNames: false });
        assert.equal(
          await page
            .getByText("player_a_very_long_player_name", { exact: true })
            .count(),
          1,
        );
        await invoke(page, "names");
        assert.equal(await page.getByText("Moss", { exact: true }).count(), 1);
        await invoke(page, "videos");
        assert.equal(await page.locator("video").count(), 2);
        await invoke(page, "dispose");
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  },
);

test(
  "wager actions follow confirmation readiness even when the proposal object is unchanged",
  { timeout: 60_000 },
  async () => {
    await fixture(null, async ({ browser, origin }) => {
      for (const mobile of [false, true]) {
        const { context, page, errors } = await openPage(
          browser,
          origin,
          mobile,
          false,
        );
        try {
          await invoke(page, "proposals");
          await invoke(page, "emit");
          await interact(page, pile(page, "player"), mobile);
          assert.equal(
            await page
              .getByRole("button", { name: "Cancel Proposal", exact: true })
              .count(),
            1,
          );
          await invoke(page, "confirmed", false);
          assert.equal(
            await page
              .getByRole("button", { name: "Cancel Proposal", exact: true })
              .count(),
            0,
          );
          await interact(page, pile(page, "opponent"), mobile);
          assert.equal(
            await page
              .getByRole("button", { name: "Accept", exact: true })
              .count(),
            0,
          );
          assert.equal(
            await page
              .getByRole("button", { name: "Decline", exact: true })
              .count(),
            0,
          );
          assert.deepEqual(
            await page.evaluate(() => window.harness.e.calls),
            [],
          );
          await invoke(page, "confirmed", true);
          for (const [side, name, method] of [
            ["opponent", "Accept", "acceptWagerProposal"],
            ["opponent", "Decline", "declineWagerProposal"],
            ["player", "Cancel Proposal", "cancelWagerProposal"],
          ]) {
            if (
              !(await page.getByRole("button", { name, exact: true }).count())
            )
              await interact(page, pile(page, side), mobile);
            await interact(
              page,
              page.getByRole("button", { name, exact: true }),
              mobile,
            );
            assert.equal(
              await page.evaluate(() => window.harness.e.calls.at(-1)),
              method,
            );
          }
          await invoke(page, "dispose");
          assert.equal((await invoke(page, "bindings")).wager, 0);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    });
  },
);

test(
  "capture readiness times out for a retained pending image",
  { timeout: 20000 },
  async (t) => {
    await fixture(null, async ({ browser, origin }) => {
      const { context, page } = await openPage(browser, origin, false, false);
      t.after(() => context.close());
      try {
        const imageUrl = origin + "/__stalled-capture.svg";
        await page.route(imageUrl, () => {});
        await Promise.all([
          page.waitForRequest(imageUrl, { timeout: 5000 }),
          invoke(page, "emit", { image: imageUrl, animation: "appear" }),
        ]);
        await assert.rejects(
          capture(page, "stalled-image", "current", new Map()),
          { message: "Timed out waiting for stalled-image: fonts and images" },
        );
      } finally {
        await context.close();
      }
    });
  },
);

test(
  baselinePath
    ? "board wager extraction exactly matches baseline visuals and preserves interactions and lifecycle"
    : "board wagers preserve interactions and lifecycle (current implementation; no baseline comparison)",
  { timeout: 180000 },
  async (t) => {
    mkdirSync(outputDirectory, { recursive: true });
    const snapshots = new Map();
    if (baselinePath) {
      assert.ok(
        existsSync(baselinePath),
        "Missing baseline source: " + baselinePath,
      );
      await fixture(baselinePath, ({ browser, origin }) =>
        scenarios(browser, origin, "baseline", snapshots),
      );
    }
    await fixture(null, ({ browser, origin }) =>
      scenarios(browser, origin, "current", snapshots),
    );
    if (baselinePath)
      t.diagnostic(
        "Compared " +
          snapshots.size +
          " before/after screenshots and geometry/style snapshots with zero differences.",
      );
  },
);

async function transitionScenarios(browser, origin, mode, snapshots) {
  for (const mobile of [false, true]) {
    const { context, page, errors } = await openPage(
      browser,
      origin,
      mobile,
      false,
    );
    const prefix = "transitions-" + (mobile ? "mobile" : "desktop");
    try {
      await invoke(page, "proposals");
      await invoke(page, "materialBalances", 3, 0);
      await invoke(page, "emit");
      await interact(page, pile(page, "opponent"), mobile);
      assert.equal(
        await page
          .getByRole("button", { name: "Accept (7)", exact: true })
          .count(),
        1,
      );
      await invoke(page, "bridge", "o", "p");
      assert.equal(
        await page
          .getByRole("button", { name: "Accept", exact: true })
          .isDisabled(),
        false,
      );
      await capture(page, prefix + "-uid-flip", mode, snapshots);
      await invoke(page, "state", {
        proposals: { o: { material: "obsidian", count: 8 } },
      });
      assert.equal(await page.locator("[data-wager-panel]").count(), 0);
      await interact(page, pile(page, "opponent"), mobile);
      assert.equal(await page.locator("[data-wager-panel]").count(), 0);

      await invoke(page, "reset");
      await invoke(page, "bridge", "next-player", "next-opponent");
      await invoke(page, "state", {
        proposals: {
          "next-player": { material: "obsidian", count: 4 },
          "next-opponent": { material: "obsidian", count: 8 },
        },
      });
      await invoke(page, "emit");
      await interact(page, pile(page, "opponent"), mobile);
      assert.equal(
        await page
          .getByRole("button", { name: "Accept (7)", exact: true })
          .count(),
        1,
      );
      await invoke(page, "state", {
        proposals: {
          "next-player": { material: "obsidian", count: 4 },
          "next-opponent": { material: "gold", count: 8 },
        },
      });
      const disabledAccept = page.getByRole("button", {
        name: "Accept",
        exact: true,
      });
      assert.equal(await disabledAccept.isDisabled(), true);
      const callCount = await page.evaluate(
        () => window.harness.e.calls.length,
      );
      await interact(page, disabledAccept, mobile);
      assert.equal(
        await page.evaluate(() => window.harness.e.calls.length),
        callCount,
      );
      await invoke(page, "materialBalances", 3, 2);
      if (
        (await page
          .getByRole("button", { name: "Accept (2)", exact: true })
          .count()) === 0
      ) {
        await interact(page, pile(page, "opponent"), mobile);
      }
      assert.equal(
        await page
          .getByRole("button", { name: "Accept (2)", exact: true })
          .isDisabled(),
        false,
      );
      await capture(page, prefix + "-material-change-open", mode, snapshots);
      await interact(
        page,
        page.getByRole("button", { name: "Accept (2)", exact: true }),
        mobile,
      );
      assert.equal(
        await page.evaluate(() => window.harness.e.calls.at(-1)),
        "acceptWagerProposal",
      );
      await interact(page, pile(page, "player"), mobile);
      await invoke(page, "state", {
        proposals: { "next-opponent": { material: "gold", count: 8 } },
      });
      assert.equal(await page.locator("[data-wager-panel]").count(), 0);

      await invoke(page, "reset");
      await invoke(page, "clearPiles");
      let resolvePendingImage;
      const pendingImage = new Promise((resolve) => {
        resolvePendingImage = resolve;
      });
      await page.route("**/__reset-delayed-rock.svg", (route) =>
        resolvePendingImage(route),
      );
      await invoke(page, "emit", {
        image: origin + "/__reset-delayed-rock.svg",
        animation: "appear",
      });
      const imageRoute = await waitForReadiness(
        pendingImage,
        "wager image request",
      );
      await invoke(page, "reset");
      assert.equal(
        await page.evaluate(() => window.pendingBoardUiWork().timeouts),
        0,
      );
      await invoke(page, "clearPiles");
      await invoke(page, "emit", {
        material: "gold",
        playerCount: 3,
        opponentCount: 6,
      });
      await capture(
        page,
        prefix + "-replacement-before-late-load",
        mode,
        snapshots,
      );
      const replacementImages = await page
        .locator("[data-wager-pile] img")
        .evaluateAll((images) =>
          images.map((image) => ({
            source: image.getAttribute("src"),
            layout: ["left", "top", "width", "height", "zIndex"].map(
              (property) => image.style[property],
            ),
          })),
        );
      await imageRoute.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
      });
      await page.unroute("**/__reset-delayed-rock.svg");
      await page.clock.runFor(1600);
      assert.deepEqual(
        await page.locator("[data-wager-pile] img").evaluateAll((images) =>
          images.map((image) => ({
            source: image.getAttribute("src"),
            layout: ["left", "top", "width", "height", "zIndex"].map(
              (property) => image.style[property],
            ),
          })),
        ),
        replacementImages,
      );
      assert.equal(await page.locator("[data-wager-panel]").count(), 0);
      assert.equal(
        await page.evaluate(() => window.pendingBoardUiWork().timeouts),
        0,
      );
      await capture(
        page,
        prefix + "-replacement-after-late-load",
        mode,
        snapshots,
      );

      const replayBefore = await page.evaluate(
        () => window.harness.e.renderReplays,
      );
      await invoke(page, "dispose");
      await invoke(page, "mount");
      await page.clock.runFor(80);
      assert.equal(await pile(page, "player").locator("img").count(), 3);
      assert.equal(await pile(page, "opponent").locator("img").count(), 6);
      const revision = await page.evaluate(() => {
        const e = window.harness.e;
        return {
          requested: e.requestedLayoutRevision,
          committed: e.committedLayoutRevision,
          rejected: e.layoutCalls.filter((call) => !call.accepted),
          replayed: e.renderReplays,
          bindings: e.renderBindings,
        };
      });
      assert.equal(revision.committed, revision.requested);
      assert.deepEqual(revision.rejected, []);
      assert.ok(revision.replayed > replayBefore);
      assert.ok(revision.bindings.length > 0);
      for (const binding of revision.bindings) {
        assert.equal(binding.hasLayout, true);
        assert.equal(binding.committed, binding.requested);
      }
      await invoke(page, "names", true, true);
      assert.equal(
        await page.evaluate(
          () =>
            window.harness.e.committedLayoutRevision ===
            window.harness.e.requestedLayoutRevision,
        ),
        true,
      );
      await capture(page, prefix + "-initial-replay-revision", mode, snapshots);
      await invoke(page, "dispose");
      await page.clock.runFor(80);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

test(
  baselinePath
    ? "board wager transitions match baseline for UID changes, proposal replacement, late loads, and layout replay"
    : "board wager transitions handle UID changes, proposal replacement, late loads, and layout replay",
  { timeout: 90000 },
  async (t) => {
    mkdirSync(outputDirectory, { recursive: true });
    const snapshots = new Map();
    if (baselinePath) {
      assert.ok(existsSync(baselinePath));
      await fixture(baselinePath, ({ browser, origin }) =>
        transitionScenarios(browser, origin, "baseline", snapshots),
      );
    }
    await fixture(null, ({ browser, origin }) =>
      transitionScenarios(browser, origin, "current", snapshots),
    );
    if (baselinePath)
      t.diagnostic(
        "Compared " +
          snapshots.size +
          " transition screenshots and geometry/style snapshots with zero differences.",
      );
  },
);
