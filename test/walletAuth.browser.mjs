import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const cacheDir = `node_modules/.vite-wallet-auth-${process.pid}`;
test.after(() =>
  rm(path.join(repository, cacheDir), { recursive: true, force: true }),
);
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
    "ui/eventModalController",
    "ui/identity/useAppleAuthFlow",
  ].map((name) => path.join(repository, "src", name)),
);

/**
 * @typedef {"signin" | "settings"} Screen
 * @typedef {{page: import("playwright").Page, wallet: (method: "eth" | "sol") => import("playwright").Locator, press: (locator: import("playwright").Locator) => Promise<void>}} FixtureContext
 * @param {Screen} screen
 * @param {(context: FixtureContext) => Promise<void>} run
 * @param {{mobile?: boolean, openSignIn?: boolean, query?: Record<string, string>}} [options]
 */
async function fixture(
  screen,
  run,
  { mobile = false, openSignIn = true, query = {} } = {},
) {
  const server = await createServer({
    root: repository,
    configFile: false,
    logLevel: "error",
    cacheDir,
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react-dom",
        "styled-components",
        "@mons/shared/auth",
        "@mons/shared/api-errors",
        "@mons/shared/appearance",
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
            if (!request.url?.startsWith("/__wallet-auth?")) return next();
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
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error("Fixture page error:", error.message);
    });
    const search = new URLSearchParams({ screen, ...query });
    if (mobile) search.set("mobile", "");
    await page.goto(`${origin}/__wallet-auth?${search}`);
    await page.waitForFunction(() => window.walletAuthHarness !== undefined);
    if (screen === "signin" && openSignIn) {
      const signIn = page.getByRole("button", { name: "Sign In", exact: true });
      if (mobile) await signIn.dispatchEvent("touchstart");
      else await signIn.click();
    } else if (screen === "settings")
      await page
        .getByRole("button", { name: "+", exact: true })
        .first()
        .waitFor();
    const wallet = (/** @type {"eth" | "sol"} */ method) =>
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
    const press = async (
      /** @type {import("playwright").Locator} */ locator,
    ) => {
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

/** @param {import("playwright").Page} page @param {"connectCalls" | "verificationCalls" | "xIntentCalls" | "xRedirectCalls"} type @param {number} count */
async function waitForCalls(page, type, count) {
  await page.waitForFunction(
    ({ type, count }) =>
      window.walletAuthHarness.environment[type].length === count,
    { type, count },
  );
}

for (const screen of /** @type {const} */ (["signin", "settings"])) {
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
            () => window.walletAuthHarness.environment.connectCalls.length,
          ),
          0,
        );
        await press(wallet("eth"));
        await page
          .getByRole("button", { name: "Wallet Two", exact: true })
          .click();
        await waitForCalls(page, "connectCalls", 1);
        await wallet("eth").evaluate((button) => {
          if (!(button instanceof HTMLElement))
            throw new Error("expected button");
          button.click();
          if (!(button instanceof HTMLElement))
            throw new Error("expected button");
          button.click();
        });
        assert.deepEqual(
          await page.evaluate(() =>
            window.walletAuthHarness.environment.connectCalls.map(
              ({ method, wallet }) => ({ method, wallet }),
            ),
          ),
          [{ method: "eth", wallet: "Wallet Two" }],
        );
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.providerReads,
          ),
          2,
        );
        assert.equal(await wallet("sol").isDisabled(), screen === "settings");
        if (screen === "signin") {
          await press(wallet("sol"));
          await waitForCalls(page, "connectCalls", 2);
        }
        await page.evaluate(() =>
          window.walletAuthHarness.resolveConnection(0),
        );
        await waitForCalls(page, "verificationCalls", 1);
        if (screen === "signin")
          await page
            .getByRole("button", { name: "Verifying...", exact: true })
            .waitFor();
        else assert.equal(await wallet("eth").textContent(), "+");
        assert.deepEqual(
          await page.evaluate(
            () =>
              window.walletAuthHarness.requireValue(
                window.walletAuthHarness.environment.verificationCalls[0],
              ).args,
          ),
          ["signed-message", "signature", "eth-intent"],
        );
        await page.evaluate(() =>
          window.walletAuthHarness.rejectVerification(0),
        );
        await wallet("eth").waitFor();
        if (screen === "settings")
          await page.waitForFunction(() =>
            [...document.querySelectorAll("button")]
              .filter((button) => button.textContent === "+")
              .every((button) => !button.disabled),
          );
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.logins.length,
          ),
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
          window.walletAuthHarness.rejectConnection(0, "not found"),
        );
        await page
          .getByRole("button", { name: "Not Found", exact: true })
          .waitFor();
        assert.deepEqual(
          await page.evaluate(() =>
            [...window.walletAuthHarness.environment.timers.values()].map(
              (timer) => timer.delay,
            ),
          ),
          [screen === "signin" ? 500 : 650],
        );
        await page.evaluate(() => window.walletAuthHarness.advanceTimers());
        await wallet("sol").waitFor();
        await press(wallet("sol"));
        await waitForCalls(page, "connectCalls", 2);
        await page.evaluate(() =>
          window.walletAuthHarness.rejectConnection(1, "not found"),
        );
        await page
          .getByRole("button", { name: "Not Found", exact: true })
          .waitFor();
        await page.evaluate(() => window.walletAuthHarness.dispose());
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.timers.size,
          ),
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
          await page.evaluate(() =>
            window.walletAuthHarness.resolveConnection(0),
          );
          await waitForCalls(page, "verificationCalls", 1);
          assert.deepEqual(
            await page.evaluate(
              () =>
                window.walletAuthHarness.requireValue(
                  window.walletAuthHarness.environment.verificationCalls[0],
                ).args,
            ),
            ["public-key", "signature", "sol-intent"],
          );
          await page.evaluate(() =>
            window.walletAuthHarness.resolveVerification(0),
          );
          await page.waitForFunction(
            () => window.walletAuthHarness.environment.logins.length === 1,
          );
          assert.deepEqual(
            await page.evaluate(
              () => window.walletAuthHarness.environment.authStatuses,
            ),
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
        await page.evaluate(() =>
          window.walletAuthHarness.resolveConnection(0),
        );
        await waitForCalls(page, "verificationCalls", 1);
        const reads = await page.evaluate(
          () => window.walletAuthHarness.environment.linkedReads,
        );
        await page.evaluate(async () => {
          window.walletAuthHarness.dispose();
          window.walletAuthHarness.resolveVerification(0);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.logins.length,
          ),
          screen === "signin" ? 1 : 0,
        );
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.linkedReads,
          ),
          reads,
        );
        assert.equal(await page.locator("#root").textContent(), "");
      });
    },
  );
}

test(
  "X sign-in prevents duplicate starts and restores the button after cooldown and redirect errors",
  { timeout: 30_000 },
  async () => {
    await fixture("signin", async ({ page }) => {
      const xButton = page.getByRole("button", { name: "X", exact: true });
      await xButton.evaluate((button) => {
        if (!(button instanceof HTMLElement))
          throw new Error("expected button");
        button.click();
        if (!(button instanceof HTMLElement))
          throw new Error("expected button");
        button.click();
      });
      await waitForCalls(page, "xIntentCalls", 1);
      assert.equal(
        await page.getByRole("button", { name: "Connecting..." }).isDisabled(),
        true,
      );
      await page.evaluate(() =>
        window.walletAuthHarness.rejectXIntent(0, "auth-cooldown", {
          reason: "method-reuse-cooldown",
          method: "x",
        }),
      );
      await page
        .getByText(
          "This X sign-in was recently unlinked. Try again in up to 24 hours.",
        )
        .waitFor();
      await xButton.click();
      await waitForCalls(page, "xIntentCalls", 2);
      await page.evaluate(() => window.walletAuthHarness.resolveXIntent(1));
      await waitForCalls(page, "xRedirectCalls", 1);
      assert.deepEqual(
        await page.evaluate(() => {
          const { intentId, consentSource } =
            window.walletAuthHarness.requireValue(
              window.walletAuthHarness.environment.xRedirectCalls[0],
            );
          return { intentId, consentSource };
        }),
        { intentId: "x-intent-1", consentSource: "signin" },
      );
      await page.evaluate(() =>
        window.walletAuthHarness.rejectXRedirect(0, "x-oauth-access_denied"),
      );
      await page.getByText("X sign in was canceled.").waitFor();
      assert.equal(await xButton.isDisabled(), false);
      assert.equal(
        await page.evaluate(
          () => window.walletAuthHarness.environment.timers.size,
        ),
        0,
      );
    });
  },
);

test(
  "X stalled navigation recovers when visible and cleans timers and subscriptions on unmount",
  { timeout: 30_000 },
  async () => {
    await fixture("signin", async ({ page }) => {
      await page.getByRole("button", { name: "X", exact: true }).click();
      await waitForCalls(page, "xIntentCalls", 1);
      await page.evaluate(() => window.walletAuthHarness.resolveXIntent(0));
      await waitForCalls(page, "xRedirectCalls", 1);
      await page.evaluate(() =>
        window.walletAuthHarness.rejectXRedirect(0, "x-redirect-started"),
      );
      await page.waitForFunction(() =>
        [...window.walletAuthHarness.environment.timers.values()].some(
          (timer) => timer.delay === 1500,
        ),
      );
      await page.evaluate(() => {
        window.walletAuthHarness.setVisibilityState("hidden");
        window.walletAuthHarness.advanceTimers(1500);
      });
      assert.equal(
        await page.getByRole("button", { name: "Connecting..." }).isDisabled(),
        true,
      );
      await page.evaluate(() =>
        window.walletAuthHarness.setVisibilityState("visible"),
      );
      await page.getByRole("button", { name: "X", exact: true }).waitFor();
      await page.evaluate(() =>
        window.walletAuthHarness.setPendingXRedirectResult({
          flowId: "pending-flow",
          status: "ready",
          errorCode: "",
          consentSource: "signin",
        }),
      );
      await page.getByRole("button", { name: "Verifying..." }).waitFor();
      await page.evaluate(() => window.walletAuthHarness.dispose());
      assert.deepEqual(
        await page.evaluate(() => ({
          timers: window.walletAuthHarness.environment.timers.size,
          pendingListeners:
            window.walletAuthHarness.environment.xPendingListeners.size,
          feedbackListeners:
            window.walletAuthHarness.environment.xFeedbackListeners.size,
        })),
        { timers: 0, pendingListeners: 0, feedbackListeners: 0 },
      );
      await page.evaluate(() => {
        window.walletAuthHarness.setVisibilityState("hidden");
        window.walletAuthHarness.setVisibilityState("visible");
        window.walletAuthHarness.publishXAuthUiFeedback({
          target: "signin",
          kind: "error",
          message: "Late callback",
        });
      });
      assert.equal(await page.locator("#root").textContent(), "");
    });
  },
);

test(
  "X pending callback blocks sign-in until stale retry clears the result",
  { timeout: 30_000 },
  async () => {
    await fixture(
      "signin",
      async ({ page }) => {
        const verifying = page.getByRole("button", { name: "Verifying..." });
        await verifying.waitFor();
        assert.equal(await verifying.isDisabled(), true);
        assert.equal(await verifying.getAttribute("aria-busy"), "true");
        assert.equal(
          await page.getByRole("button", { name: "X", exact: true }).count(),
          0,
        );
        await page.evaluate(() =>
          window.walletAuthHarness.advanceTimers(20_000),
        );
        await page.getByRole("button", { name: "Try Again" }).click();
        await page
          .getByText("X sign in took too long. Please try again.")
          .waitFor();
        await page.getByRole("button", { name: "X", exact: true }).click();
        await waitForCalls(page, "xIntentCalls", 1);
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.xClearedResults,
          ),
          1,
        );
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.xPending,
          ),
          null,
        );
      },
      { openSignIn: false, query: { xPendingSource: "signin" } },
    );
  },
);

test(
  "X feedback chooses the current inline or event sign-in surface",
  { timeout: 30_000 },
  async () => {
    await fixture(
      "signin",
      async ({ page }) => {
        await page.evaluate(() =>
          window.walletAuthHarness.publishXAuthUiFeedback({
            target: "signin",
            kind: "error",
            message: "Inline callback error",
          }),
        );
        await page.getByText("Inline callback error").waitFor();
        assert.equal(
          await page.getByRole("dialog", { name: "Sign In" }).count(),
          0,
        );
        await page.evaluate(() => {
          window.walletAuthHarness.setEventModalState(true);
          window.walletAuthHarness.publishXAuthUiFeedback({
            target: "signin",
            kind: "error",
            message: "Event callback error",
          });
        });
        const eventDialog = page.getByRole("dialog", { name: "Sign In" });
        await eventDialog.getByText("Event callback error").waitFor();
        await page.evaluate(() =>
          window.walletAuthHarness.setEventModalState(false),
        );
        await eventDialog.waitFor({ state: "detached" });
        await page
          .getByRole("button", { name: "Sign In", exact: true })
          .waitFor();
        await page.evaluate(() =>
          window.walletAuthHarness.publishXAuthUiFeedback({
            target: "signin",
            kind: "error",
            message: "Current inline error",
          }),
        );
        await page.getByText("Current inline error").waitFor();
        assert.equal(await eventDialog.count(), 0);
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.xFeedbackDeliveries,
          ),
          3,
        );
      },
      { openSignIn: false },
    );
  },
);

for (const kind of /** @type {const} */ (["success", "error"])) {
  test(
    `X settings return ${kind} reopens Settings and preserves callback feedback`,
    { timeout: 30_000 },
    async () => {
      await fixture(
        "signin",
        async ({ page }) => {
          await page.evaluate((kind) => {
            if (kind === "success") {
              window.walletAuthHarness.environment.linkedMethods.x = true;
              window.walletAuthHarness.setPendingXRedirectResult(null);
              window.walletAuthHarness.publishXAuthUiFeedback({
                target: "settings",
                kind,
                message: "X linked",
              });
            } else {
              window.walletAuthHarness.publishXAuthUiFeedback({
                target: "settings",
                kind,
                message: "Settings callback error",
              });
              window.walletAuthHarness.setPendingXRedirectResult(null);
            }
          }, kind);
          const settings = page.getByRole("dialog", { name: "Settings" });
          await settings.waitFor();
          if (kind === "error") {
            await settings.getByText("Settings callback error").waitFor();
          } else {
            await settings
              .getByRole("button", { name: "×", exact: true })
              .waitFor();
            assert.equal(await settings.getByText("X linked").count(), 0);
          }
          assert.deepEqual(
            await page.evaluate(() => ({
              subscribers:
                window.walletAuthHarness.environment.xFeedbackListeners.size,
              deliveries:
                window.walletAuthHarness.environment.xFeedbackDeliveries,
            })),
            { subscribers: 1, deliveries: 1 },
          );
          await settings
            .getByRole("button", { name: "OK", exact: true })
            .click();
          await settings.waitFor({ state: "detached" });
        },
        { openSignIn: false, query: { xPendingSource: "settings" } },
      );
    },
  );
}

test(
  "X persisted feedback is consumed once with Profile and Settings mounted in StrictMode",
  { timeout: 30_000 },
  async () => {
    await fixture(
      "signin",
      async ({ page }) => {
        const settings = page.getByRole("dialog", { name: "Settings" });
        await settings.getByText("Persisted callback error").waitFor();
        assert.deepEqual(
          await page.evaluate(() => ({
            consumed: window.walletAuthHarness.environment.xFeedbackConsumed,
            subscribers:
              window.walletAuthHarness.environment.xFeedbackListeners.size,
          })),
          { consumed: 1, subscribers: 1 },
        );
        await page.evaluate(() =>
          window.walletAuthHarness.publishXAuthUiFeedback({
            target: "settings",
            kind: "error",
            message: "Updated callback error",
          }),
        );
        await settings.getByText("Updated callback error").waitFor();
        assert.equal(
          await page.getByRole("dialog", { name: "Settings" }).count(),
          1,
        );
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.xFeedbackDeliveries,
          ),
          1,
        );
        await page.evaluate(() => window.walletAuthHarness.dispose());
        assert.equal(
          await page.evaluate(
            () => window.walletAuthHarness.environment.xFeedbackListeners.size,
          ),
          0,
        );
      },
      {
        openSignIn: false,
        query: {
          xFeedbackTarget: "settings",
          xFeedbackMessage: "Persisted callback error",
        },
      },
    );
  },
);

for (const eventOpen of [false, true]) {
  test(
    `X initial sign-in feedback opens ${eventOpen ? "event" : "inline"} UI without losing the error`,
    { timeout: 30_000 },
    async () => {
      await fixture(
        "signin",
        async ({ page }) => {
          await page.getByText("Restored sign-in error").waitFor();
          assert.equal(
            await page.getByRole("dialog", { name: "Sign In" }).count(),
            eventOpen ? 1 : 0,
          );
          assert.equal(
            await page.getByRole("button", { name: "X", exact: true }).count(),
            1,
          );
          assert.equal(
            await page.evaluate(
              () => window.walletAuthHarness.environment.xFeedbackConsumed,
            ),
            1,
          );
        },
        {
          openSignIn: false,
          query: {
            xFeedbackTarget: "signin",
            xFeedbackMessage: "Restored sign-in error",
            ...(eventOpen ? { eventOpen: "" } : {}),
          },
        },
      );
    },
  );
}

test(
  "X linking blocks other settings actions and refreshes only when intent preparation fails",
  { timeout: 30_000 },
  async () => {
    await fixture("settings", async ({ page, wallet }) => {
      const xButton = page
        .getByText("X", { exact: true })
        .locator("../..")
        .getByRole("button");
      const reads = await page.evaluate(
        () => window.walletAuthHarness.environment.linkedReads,
      );
      await xButton.click();
      await waitForCalls(page, "xIntentCalls", 1);
      assert.equal(await wallet("eth").isDisabled(), true);
      await page.evaluate(() =>
        window.walletAuthHarness.rejectXIntent(0, "x-auth-disabled"),
      );
      await page.getByText("Linking X is temporarily unavailable.").waitFor();
      assert.equal(await wallet("eth").isDisabled(), false);
      assert.equal(
        await page.evaluate(
          () => window.walletAuthHarness.environment.linkedReads,
        ),
        reads + 1,
      );
      await xButton.click();
      await waitForCalls(page, "xIntentCalls", 2);
      await page.evaluate(() => window.walletAuthHarness.resolveXIntent(1));
      await waitForCalls(page, "xRedirectCalls", 1);
      assert.equal(
        await page.evaluate(
          () =>
            window.walletAuthHarness.requireValue(
              window.walletAuthHarness.environment.xRedirectCalls[0],
            ).consentSource,
        ),
        "settings",
      );
      await page.evaluate(() =>
        window.walletAuthHarness.rejectXRedirect(0, "x-redirect-started"),
      );
      await page.waitForFunction(() =>
        [...document.querySelectorAll("button")]
          .filter((button) => button.textContent === "+")
          .every((button) => !button.disabled),
      );
      assert.equal(
        await page.evaluate(
          () => window.walletAuthHarness.environment.linkedReads,
        ),
        reads + 1,
      );
      assert.equal(
        await page.evaluate(
          () => window.walletAuthHarness.environment.xFeedbackListeners.size,
        ),
        0,
      );
    });
  },
);

for (const target of ["settings", "signin"]) {
  test(
    `X queued ${target} feedback survives pending startup UI cleanup in StrictMode`,
    { timeout: 30_000 },
    async () => {
      await fixture(
        "signin",
        async ({ page }) => {
          await page.getByText("Restored callback error").waitFor();
          assert.ok(
            await page.evaluate(
              () => window.walletAuthHarness.environment.hiddenCards > 0,
            ),
          );
          if (target === "settings") {
            await page.getByRole("dialog", { name: "Settings" }).waitFor();
          } else {
            await page
              .getByRole("button", { name: "X", exact: true })
              .waitFor();
          }
          assert.equal(
            await page.evaluate(
              () => window.walletAuthHarness.environment.xFeedbackConsumed,
            ),
            1,
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.walletAuthHarness.environment.xFeedbackListeners.size,
            ),
            1,
          );
        },
        {
          openSignIn: false,
          query: {
            pendingTransientCleanup: "",
            xFeedbackTarget: target,
            xFeedbackMessage: "Restored callback error",
          },
        },
      );
    },
  );
}
