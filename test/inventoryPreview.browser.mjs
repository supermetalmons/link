import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const recipientAddress = "11111111111111111111111111111111";
const prizeTileLabel = "View place 1 prize from event NN3eRzoZo80";
const previewLabel = "Place 1 event prize";
const environmentSource = `
export const identity = profileId => ({
  authStatus: 'authenticated', profileId, solAddress: '${recipientAddress}', ethAddress: '',
});
export const environment = {
  now: 1000000,
  owner: identity('a'),
  selection: { avatarId: null, specialIds: new Set() },
  aura: '',
  writes: [],
  nftRequests: [],
  withdrawals: [],
  outsideDismissals: 0,
  inventoryDismissals: 0,
  bubbledEscapes: 0,
};
export const fetchNftsForIdentity = async identity => {
  environment.nftRequests.push(identity);
  return {
    data: { ok: true, swagpack_avatars: [{ id: 9, count: 3 }, { id: 10, count: 1 }], specials: [{ id: 1, count: 1 }] },
    expiresAtMs: environment.now + 10000,
  };
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
};
export const getActiveInventoryItemSelection = () => environment.selection;
export const setOwnershipVerifiedIdCardEmoji = (id, aura) => {
  environment.writes.push(['avatar', id, aura]);
  environment.selection = { ...environment.selection, avatarId: id - 1000 };
  environment.aura = aura;
};
export const setOwnershipVerifiedSpecialItem = id => {
  environment.writes.push(['special', id]);
  environment.selection = { ...environment.selection, specialIds: new Set([id]) };
};
export const subscribeToProfileEventPrizes = (profileId, update) => {
  update({ prize: { eventId: 'NN3eRzoZo80', prizeId: '1092', profileId, place: 1, assignedAtMs: 100 } });
  return () => {};
};
export const withdrawProfileEventPrize = (eventId, prizeId, address) =>
  new Promise((resolve, reject) => environment.withdrawals.push({ eventId, prizeId, address, resolve, reject }));
`;
const harnessSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { InventoryModal } from '/src/ui/InventoryModal.tsx';
import { environment, identity } from 'inventory-environment';
Date.now = () => environment.now;
const root = createRoot(document.getElementById('root'));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') environment.bubbledEscapes += 1;
});
window.harness = {
  environment,
  render(profileId = 'a') {
    const authState = identity(profileId);
    environment.owner = authState;
    flushSync(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(InventoryModal, {
        key: JSON.stringify([true, profileId, authState.solAddress, authState.ethAddress]),
        id: 'inventory', authState,
        onDismiss: () => environment.inventoryDismissals += 1,
        onPreviewOutsideDismiss: () => environment.outsideDismissals += 1,
      }))));
  },
  resolve(index, status = 'completed') {
    environment.withdrawals[index].resolve({ ok: true, status });
  },
  reject(index, code, message = '') {
    environment.withdrawals[index].reject({ code, message });
  },
  dispose() { flushSync(() => root.unmount()); },
};
window.harness.render();
`;

async function fixture(run) {
  const stubbedModules = new Set(
    [
      "services/nftService",
      "utils/storage",
      "ui/shinyCardUiPort",
      "ui/profileSurfaceDataPort",
    ].map((name) => path.join(repository, "src", name)),
  );
  const server = await createServer({
    root: repository,
    configFile: false,
    logLevel: "error",
    cacheDir: `node_modules/.vite-inventory-preview-${process.pid}`,
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "styled-components",
        "@mons/shared/event-prizes",
        "@mons/shared/solana",
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
        name: "inventory-preview-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__inventory") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__inventory-harness.js"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/__inventory-harness.js") return "\0inventory-harness";
          if (id === "inventory-environment") return "\0inventory-environment";
          if (importer && id.startsWith(".")) {
            const resolved = path
              .resolve(path.dirname(importer), id)
              .replace(/\.(ts|tsx)$/, "");
            if (stubbedModules.has(resolved)) return "\0inventory-environment";
          }
        },
        load(id) {
          if (id === "\0inventory-harness") return harnessSource;
          if (id === "\0inventory-environment") return environmentSource;
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
    const context = await browser.newContext({
      viewport: { width: 1000, height: 760 },
      reducedMotion: "reduce",
    });
    context.setDefaultTimeout(10000);
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.origin === "https://cdn.lil.org") {
        return route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
        });
      }
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/__inventory`);
    try {
      await page
        .getByRole("button", { name: "View avatar 1009", exact: true })
        .waitFor();
      await run(page);
    } catch (error) {
      if (errors.length) throw new AggregateError([error, ...errors]);
      throw error;
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

const preview = (page, name = previewLabel) =>
  page.getByRole("dialog", { name, exact: true });
const openPrize = async (page) => {
  await page.getByRole("button", { name: prizeTileLabel, exact: true }).click();
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await page.getByRole("textbox", { name: "Solana address" }).waitFor();
};

test(
  "inventory preview preserves apply rules, focus, Escape capture, and outside dismissal",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const avatar = page.getByRole("button", {
        name: "View avatar 1009",
        exact: true,
      });
      await avatar.click();
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") === "Avatar 1009",
      );
      assert.equal(
        await page.locator('[data-inventory-item-preview="true"]').count(),
        2,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .getByRole("button", { name: "Set avatar", exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", { name: "Set avatar", exact: true })
        .waitFor({ state: "hidden" });
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.writes),
        [["avatar", 1009, "rainbow"]],
      );
      await page.keyboard.press("Escape");
      await preview(page, "Avatar 1009").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") ===
          "View avatar 1009, current",
      );
      assert.deepEqual(
        await page.evaluate(() => [
          window.harness.environment.bubbledEscapes,
          window.harness.environment.inventoryDismissals,
        ]),
        [0, 0],
      );
      await page
        .getByRole("button", { name: "View collectible 1", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Use card background", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Current Background", exact: true })
          .isDisabled(),
        true,
      );
      await preview(page, "Collectible 1")
        .locator("img")
        .click({ force: true });
      await preview(page, "Collectible 1").waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(() => window.harness.environment.outsideDismissals),
        1,
      );
      assert.equal(
        await page
          .getByRole("dialog", { name: "Collectibles", exact: true })
          .isVisible(),
        true,
      );
    });
  },
);

test(
  "inventory ownership and snapshot freshness remain required for applying items",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page
        .getByRole("button", { name: "View avatar 1009", exact: true })
        .click();
      await page.evaluate(() => {
        window.harness.environment.owner = {
          ...window.harness.environment.owner,
          profileId: "b",
        };
      });
      await page
        .getByRole("button", { name: "Set avatar", exact: true })
        .click();
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.writes),
        [],
      );
      const requests = await page.evaluate(() => {
        window.harness.environment.owner.profileId = "a";
        window.harness.environment.now += 10001;
        return window.harness.environment.nftRequests.length;
      });
      await page
        .getByRole("button", { name: "Set avatar", exact: true })
        .click();
      await page.waitForFunction(
        (count) => window.harness.environment.nftRequests.length > count,
        requests,
      );
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.writes),
        [],
      );
      await page
        .getByRole("button", { name: "View avatar 1009", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Set avatar", exact: true })
        .click();
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.writes),
        [["avatar", 1009, "rainbow"]],
      );
    });
  },
);

test(
  "prize withdrawal validates, traps focus, prevents duplicate submission, and supports retry and completion",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await openPrize(page);
      const address = page.getByRole("textbox", { name: "Solana address" });
      assert.equal(await address.inputValue(), recipientAddress);
      assert.equal(
        await address.evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .getByRole("button", { name: "Send", exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await address.evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page
          .getByRole("button", { name: "Send", exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await address.fill("bad");
      await address.press("Enter");
      assert.equal(await address.getAttribute("aria-invalid"), "true");
      assert.equal(
        await page.getByText("Enter a valid Solana address.").isVisible(),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.withdrawals.length,
        ),
        0,
      );
      await address.fill(`  ${recipientAddress}  `);
      await page
        .getByRole("button", { name: "Send", exact: true })
        .evaluate((button) => {
          button.click();
          button.click();
        });
      await page
        .getByRole("button", { name: "Sending...", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.withdrawals.length,
        ),
        1,
      );
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.withdrawals[0].address,
        ),
        recipientAddress,
      );
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 5);
      assert.equal(await preview(page).isVisible(), true);
      assert.equal(
        await page.evaluate(() => window.harness.environment.outsideDismissals),
        0,
      );
      await page.evaluate(() =>
        window.harness.reject(
          0,
          "functions/failed-precondition",
          "Use the original destination",
        ),
      );
      await page
        .getByText("Retry with the original destination address.")
        .waitFor();
      assert.equal(await address.isEnabled(), true);
      await address.fill(` ${recipientAddress} `);
      assert.equal(
        await page
          .getByText("Retry with the original destination address.")
          .count(),
        0,
      );
      await address.press("Enter");
      await page.waitForFunction(
        () => window.harness.environment.withdrawals.length === 2,
      );
      await page.evaluate(() => window.harness.resolve(1, "processing"));
      await page
        .getByText("Could not send the prize. Please try again.")
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: prizeTileLabel, exact: true })
          .count(),
        1,
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(
        () => window.harness.environment.withdrawals.length === 3,
      );
      await page.clock.install();
      await page.evaluate(() => window.harness.resolve(2));
      await page
        .getByRole("button", { name: "Success", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: prizeTileLabel, exact: true })
          .count(),
        0,
      );
      await page.keyboard.press("Escape");
      assert.equal(await preview(page).isVisible(), true);
      await page.clock.fastForward(1000);
      await preview(page).waitFor({ state: "hidden" });
      assert.equal(
        await page
          .getByRole("dialog", { name: "Collectibles", exact: true })
          .isVisible(),
        true,
      );
    });
  },
);

test(
  "prize preview resets on reopen and follows compact visual viewports",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.setViewportSize({ width: 390, height: 430 });
      await openPrize(page);
      const address = page.getByRole("textbox", { name: "Solana address" });
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[aria-modal="true"]'))
            .display === "grid",
      );
      const bounds = await address.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 430);
      const viewport = await preview(page).boundingBox();
      assert.deepEqual(viewport, { x: 0, y: 0, width: 390, height: 430 });
      await address.fill("invalid");
      await address.press("Enter");
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: prizeTileLabel, exact: true })
        .click();
      assert.equal(
        await page.getByRole("textbox", { name: "Solana address" }).count(),
        0,
      );
      await page.getByRole("button", { name: "Withdraw", exact: true }).click();
      assert.equal(await address.inputValue(), recipientAddress);
      assert.equal(
        await page.getByText("Enter a valid Solana address.").count(),
        0,
      );
      await page.setViewportSize({ width: 1000, height: 760 });
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[aria-modal="true"]'))
            .display === "flex",
      );
    });
  },
);

test(
  "late withdrawal completion cannot dismiss or mutate a new identity's preview",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await openPrize(page);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(
        () => window.harness.environment.withdrawals.length === 1,
      );
      await page.evaluate(() => window.harness.render("b"));
      await openPrize(page);
      await page.clock.install();
      await page.evaluate(() => window.harness.resolve(0));
      await page.clock.fastForward(2000);
      assert.equal(await preview(page).isVisible(), true);
      assert.equal(
        await page
          .getByRole("button", { name: "Send", exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: prizeTileLabel, exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Solana address" })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.evaluate(() => window.harness.resolve(1));
      await page
        .getByRole("button", { name: "Success", exact: true })
        .waitFor();
      await page.evaluate(() => window.harness.render("c"));
      await openPrize(page);
      await page.clock.fastForward(2000);
      assert.equal(await preview(page).isVisible(), true);
      assert.equal(
        await page
          .getByRole("button", { name: "Send", exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Solana address" })
          .evaluate((node) => node === document.activeElement),
        true,
      );
    });
  },
);
