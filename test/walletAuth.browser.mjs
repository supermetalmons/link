import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const environmentPath = path.join(
  repository,
  "test/fixtures/walletAuthEnvironment.ts",
);
const mockedModules = new Set(
  [
    "connection/connection",
    "connection/ethereumConnection",
    "connection/solanaConnection",
    "connection/loginSuccess",
    "connection/authentication",
    "connection/injectedEthereumProviders",
    "connection/appleConnection",
    "connection/xConnection",
    "connection/xAuthUiFeedback",
    "connection/deferredProfilePresentation",
    "session/authRestoreTiming",
    "session/logoutOrchestrator",
    "utils/storage",
    "utils/misc",
    "services/nftCache",
    "ui/NameEditModal",
    "ui/LogoutConfirmModal",
    "ui/shinyCardUiPort",
    "ui/uiSession",
    "ui/eventModalController",
    "ui/identity/SessionResetNotice",
    "ui/identity/useAppleAuthFlow",
  ].map((name) => path.join(repository, "src", name)),
);

async function fixture(screen, run, { mobile = false } = {}) {
  const server = await createServer({
    root: repository,
    configFile: false,
    logLevel: "error",
    cacheDir: `node_modules/.vite-wallet-auth-${process.pid}`,
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react-dom",
        "styled-components",
        "@mons/shared/auth",
        "@mons/shared/profiles",
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
        name: "wallet-auth-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!request.url.startsWith("/__wallet-auth?")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body { margin: 32px; } #root { width: 360px; }</style><div id="root"></div><script type="module" src="/test/fixtures/walletAuthHarness.tsx"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (importer && id.startsWith(".")) {
            const resolved = path
              .resolve(path.dirname(importer), id)
              .replace(/\.(ts|tsx)$/, "");
            if (mockedModules.has(resolved)) return environmentPath;
          }
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
      hasTouch: mobile,
    });
    context.setDefaultTimeout(10_000);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error("Fixture page error:", error.message);
    });
    await page.goto(
      `${origin}/__wallet-auth?screen=${screen}${mobile ? "&mobile" : ""}`,
    );
    if (screen === "signin") {
      const signIn = page.getByRole("button", { name: "Sign In", exact: true });
      if (mobile) await signIn.dispatchEvent("touchstart");
      else await signIn.click();
    } else
      await page
        .getByRole("button", { name: "+", exact: true })
        .first()
        .waitFor();
    const wallet = (method) =>
      screen === "signin"
        ? page.getByRole("button", {
            name: method === "eth" ? "Ethereum" : "Solana",
            exact: true,
          })
        : page
            .getByText(method === "eth" ? "Ethereum" : "Solana", {
              exact: true,
            })
            .locator("../..")
            .getByRole("button");
    const press = async (locator) => {
      if (mobile)
        await locator.dispatchEvent(
          screen === "signin" ? "touchstart" : "touchend",
        );
      else await locator.click();
    };
    await run({ page, wallet, press });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

async function waitForCalls(page, type, count) {
  await page.waitForFunction(
    ({ type, count }) => window.harness.environment[type].length === count,
    { type, count },
  );
}

for (const screen of ["signin", "settings"]) {
  test(
    `${screen}: wallet picker cancellation restores availability and duplicate presses do not start another request`,
    { timeout: 30_000 },
    async () => {
      await fixture(screen, async ({ page, wallet, press }) => {
        await press(wallet("eth"));
        await page.getByRole("dialog", { name: "Select Wallet" }).waitFor();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(
          await page.evaluate(
            () => window.harness.environment.connectCalls.length,
          ),
          0,
        );
        await press(wallet("eth"));
        await page
          .getByRole("button", { name: "Wallet Two", exact: true })
          .click();
        await waitForCalls(page, "connectCalls", 1);
        await wallet("eth").evaluate((button) => {
          button.click();
          button.click();
        });
        assert.deepEqual(
          await page.evaluate(() =>
            window.harness.environment.connectCalls.map(
              ({ method, wallet }) => ({ method, wallet }),
            ),
          ),
          [{ method: "eth", wallet: "Wallet Two" }],
        );
        assert.equal(
          await page.evaluate(() => window.harness.environment.providerReads),
          2,
        );
        assert.equal(await wallet("sol").isDisabled(), screen === "settings");
        if (screen === "signin") {
          await press(wallet("sol"));
          await waitForCalls(page, "connectCalls", 2);
        }
        await page.evaluate(() => window.harness.resolveConnection(0));
        await waitForCalls(page, "verificationCalls", 1);
        if (screen === "signin")
          await page
            .getByRole("button", { name: "Verifying...", exact: true })
            .waitFor();
        else assert.equal(await wallet("eth").textContent(), "+");
        assert.deepEqual(
          await page.evaluate(
            () => window.harness.environment.verificationCalls[0].args,
          ),
          ["signed-message", "signature", "eth-intent"],
        );
        await page.evaluate(() => window.harness.rejectVerification(0));
        await wallet("eth").waitFor();
        if (screen === "settings")
          await page.waitForFunction(() =>
            [...document.querySelectorAll("button")]
              .filter((button) => button.textContent === "+")
              .every((button) => !button.disabled),
          );
        assert.equal(
          await page.evaluate(() => window.harness.environment.logins.length),
          0,
        );
      });
    },
  );

  test(
    `${screen}: missing wallet labels use their existing timeout and timers are cleared on unmount`,
    { timeout: 30_000 },
    async () => {
      await fixture(screen, async ({ page, wallet, press }) => {
        await press(wallet("sol"));
        await waitForCalls(page, "connectCalls", 1);
        await page.evaluate(() =>
          window.harness.rejectConnection(0, "not found"),
        );
        await page
          .getByRole("button", { name: "Not Found", exact: true })
          .waitFor();
        assert.deepEqual(
          await page.evaluate(() =>
            [...window.harness.environment.timers.values()].map(
              (timer) => timer.delay,
            ),
          ),
          [screen === "signin" ? 500 : 650],
        );
        await page.evaluate(() => window.harness.advanceTimers());
        await wallet("sol").waitFor();
        await press(wallet("sol"));
        await waitForCalls(page, "connectCalls", 2);
        await page.evaluate(() =>
          window.harness.rejectConnection(1, "not found"),
        );
        await page
          .getByRole("button", { name: "Not Found", exact: true })
          .waitFor();
        await page.evaluate(() => window.harness.dispose());
        assert.equal(
          await page.evaluate(() => window.harness.environment.timers.size),
          0,
        );
        assert.equal(await page.locator("#root").textContent(), "");
      });
    },
  );

  test(
    `${screen}: successful wallet verification applies the screen's completion behavior`,
    { timeout: 30_000 },
    async () => {
      await fixture(
        screen,
        async ({ page, wallet, press }) => {
          await press(wallet("sol"));
          await waitForCalls(page, "connectCalls", 1);
          await page.evaluate(() => window.harness.resolveConnection(0));
          await waitForCalls(page, "verificationCalls", 1);
          assert.deepEqual(
            await page.evaluate(
              () => window.harness.environment.verificationCalls[0].args,
            ),
            ["public-key", "signature", "sol-intent"],
          );
          await page.evaluate(() => window.harness.resolveVerification(0));
          await page.waitForFunction(
            () => window.harness.environment.logins.length === 1,
          );
          assert.deepEqual(
            await page.evaluate(() => window.harness.environment.authStatuses),
            ["authenticated"],
          );
          if (screen === "signin")
            assert.equal(
              await page
                .getByRole("button", { name: "Solana", exact: true })
                .count(),
              0,
            );
          else
            await page
              .getByRole("button", { name: "×", exact: true })
              .waitFor();
        },
        { mobile: true },
      );
    },
  );

  test(
    `${screen}: late verification ${screen === "signin" ? "can finish authentication" : "is ignored"} after unmount`,
    { timeout: 30_000 },
    async () => {
      await fixture(screen, async ({ page, wallet, press }) => {
        await press(wallet("sol"));
        await waitForCalls(page, "connectCalls", 1);
        await page.evaluate(() => window.harness.resolveConnection(0));
        await waitForCalls(page, "verificationCalls", 1);
        const reads = await page.evaluate(
          () => window.harness.environment.linkedReads,
        );
        await page.evaluate(async () => {
          window.harness.dispose();
          window.harness.resolveVerification(0);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });
        assert.equal(
          await page.evaluate(() => window.harness.environment.logins.length),
          screen === "signin" ? 1 : 0,
        );
        assert.equal(
          await page.evaluate(() => window.harness.environment.linkedReads),
          reads,
        );
        assert.equal(await page.locator("#root").textContent(), "");
      });
    },
  );
}
