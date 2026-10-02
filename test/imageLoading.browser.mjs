import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
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
const previewUrl =
  "https://cdn.lil.org/mons/boards/backgrounds/thumbs/pangchiu.jpg";
const previewImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="blue"/></svg>';
const harnessSource = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import BoardStylePicker from '/src/ui/BoardStylePicker.tsx';
import { getImageResource } from '/src/resources/imageResources.ts';
const root = createRoot(document.getElementById('root'));
const resource = getImageResource(${JSON.stringify(previewUrl)});
const decodeRequests = [];
const loadResults = [];
const nativeDecode = HTMLImageElement.prototype.decode;
const NativeImage = window.Image;
let fallbackLoads = 0;
HTMLImageElement.prototype.decode = function() {
  const image = this;
  return new Promise((resolve, reject) => {
    decodeRequests.push({ image, resolve, reject });
  });
};
window.harness = {
  decodeRequests,
  loadResults,
  render(visible = true) {
    flushSync(() => root.render(React.createElement(React.StrictMode, null,
      visible ? React.createElement(BoardStylePicker) : null)));
  },
  observeLoad() {
    void resource.load().then(value => loadResults.push(value));
  },
  cachedUrl() { return resource.getCachedValue(); },
  snapshot() {
    const button = document.querySelector('[aria-label="Pangchiu board theme"]');
    const image = button?.querySelector('img');
    return {
      placeholder: !!button?.querySelector(':scope > div'),
      imageUrl: image?.getAttribute('src') ?? null,
      complete: image?.complete ?? false,
      naturalWidth: image?.naturalWidth ?? 0,
    };
  },
  async resolveDecode(index) {
    const request = decodeRequests[index];
    await nativeDecode.call(request.image);
    request.resolve();
  },
  rejectDecode(index) { decodeRequests[index].reject(new Error('decode failed')); },
  useOnloadFallback() {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: undefined,
    });
    window.Image = function(...args) {
      const image = new NativeImage(...args);
      image.addEventListener('load', () => { fallbackLoads += 1; });
      return image;
    };
  },
  fallbackLoads() { return fallbackLoads; },
};
`;

async function fixture(t, run) {
  const server = await createServer({
    root: repository,
    cacheDir: `node_modules/.vite-image-loading-${process.pid}`,
    configFile: false,
    logLevel: "error",
    optimizeDeps: {
      include: [
        ...sharedImports,
        "react",
        "react-dom/client",
        "styled-components",
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
        name: "image-loading-browser-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__images") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/__image-harness.js"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/__image-harness.js") return "\0image-harness";
          if (importer?.endsWith("/BoardStylePicker.tsx")) {
            if (id === "../game/board") return "\0image-board-actions";
            if (id === "../assets/gameAssetsLoader")
              return "\0image-item-assets";
          }
        },
        load(id) {
          if (id === "\0image-harness") return harnessSource;
          if (id === "\0image-board-actions")
            return "export const setBoardStyleSet=()=>{}; export const setItemsStyleSet=()=>{};";
          if (id === "\0image-item-assets")
            return "export const loadGameAssets=()=>Promise.reject(new Error('item preview omitted'));";
        },
      },
    ],
  });
  let browser;
  const cleanup = async () => {
    try {
      await browser?.close();
    } finally {
      await server.close();
    }
  };
  t.after(cleanup);
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
      viewport: { width: 1000, height: 700 },
    });
    context.setDefaultTimeout(15000);
    const requests = [];
    const requestEvents = new EventEmitter();
    const pendingRequests = [];
    const unexpectedRequests = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      if (url !== previewUrl) {
        unexpectedRequests.push(url);
        return route.abort();
      }
      requests.push(route);
      pendingRequests.push(route);
      requestEvents.emit("preview");
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/__images`);
    await page.waitForFunction(() => !!window.harness);
    await run({
      page,
      requests,
      nextRequest: async () => {
        if (!pendingRequests.length) {
          try {
            await once(requestEvents, "preview", {
              signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]),
            });
          } catch (cause) {
            throw new Error(
              `No board preview request arrived for ${previewUrl}`,
              {
                cause,
              },
            );
          }
        }
        return pendingRequests.shift();
      },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
  } finally {
    await cleanup();
  }
}

const fulfillImage = (request, status = 200) =>
  request.fulfill({
    status,
    contentType: "image/svg+xml",
    headers: { "access-control-allow-origin": "*" },
    body: status === 200 ? previewImage : "unavailable",
  });

const waitForDecodedPreview = (page) =>
  page.waitForFunction(() => {
    const state = window.harness.snapshot();
    return !state.placeholder && state.complete && state.naturalWidth === 4;
  });

test(
  "board preview deduplicates mounted fetches, keeps its placeholder until decode, and reuses its warm cache",
  { timeout: 60000 },
  async (t) => {
    await fixture(t, async ({ page, requests, nextRequest }) => {
      await page.evaluate(() => {
        window.harness.render();
      });
      const request = await nextRequest();
      assert.equal(requests.length, 1);
      assert.deepEqual(await page.evaluate(() => window.harness.snapshot()), {
        placeholder: true,
        imageUrl: null,
        complete: false,
        naturalWidth: 0,
      });

      await fulfillImage(request);
      await page.waitForFunction(
        () =>
          window.harness.decodeRequests.length === 1 &&
          !!window.harness.snapshot().imageUrl,
      );
      const loading = await page.evaluate(() => window.harness.snapshot());
      assert.equal(loading.placeholder, true);
      assert.match(loading.imageUrl, /^blob:/);

      await page.evaluate(() => window.harness.resolveDecode(0));
      await waitForDecodedPreview(page);
      const reopened = await page.evaluate(() => {
        const h = window.harness;
        h.render(false);
        h.render();
        return { state: h.snapshot(), decodes: h.decodeRequests.length };
      });
      assert.equal(reopened.state.placeholder, false);
      assert.equal(reopened.state.imageUrl, loading.imageUrl);
      assert.equal(reopened.decodes, 1);
      assert.equal(requests.length, 1);
    });
  },
);

test(
  "board preview retries a failed HTTP response when the picker reopens",
  { timeout: 60000 },
  async (t) => {
    await fixture(t, async ({ page, requests, nextRequest }) => {
      await page.evaluate(() => {
        window.harness.render();
        window.harness.observeLoad();
      });
      await fulfillImage(await nextRequest(), 503);
      await page.waitForFunction(() => window.harness.loadResults.length === 1);
      assert.deepEqual(await page.evaluate(() => window.harness.loadResults), [
        null,
      ]);
      assert.equal(
        await page.evaluate(() => window.harness.snapshot().placeholder),
        true,
      );

      await page.evaluate(() => {
        window.harness.render(false);
        window.harness.render();
      });
      await fulfillImage(await nextRequest());
      await page.waitForFunction(
        () => window.harness.decodeRequests.length === 1,
      );
      await page.evaluate(() => window.harness.resolveDecode(0));
      await waitForDecodedPreview(page);
      assert.equal(requests.length, 2);
    });
  },
);

test(
  "board preview retries failed decoding from the same cached blob when the picker remounts",
  { timeout: 60000 },
  async (t) => {
    await fixture(t, async ({ page, requests, nextRequest }) => {
      await page.evaluate(() => {
        window.harness.render();
      });
      await fulfillImage(await nextRequest());
      await page.waitForFunction(
        () =>
          window.harness.decodeRequests.length === 1 &&
          !!window.harness.snapshot().imageUrl,
      );
      const cachedUrl = await page.evaluate(() => window.harness.cachedUrl());
      await page.evaluate(() => window.harness.rejectDecode(0));
      await page.waitForFunction(
        () => window.harness.snapshot().imageUrl === null,
      );
      assert.equal(
        await page.evaluate(() => window.harness.snapshot().placeholder),
        true,
      );

      await page.evaluate(() => {
        window.harness.render(false);
        window.harness.render();
      });
      await page.waitForFunction(
        () => window.harness.decodeRequests.length === 2,
      );
      await page.evaluate(() => window.harness.resolveDecode(1));
      await waitForDecodedPreview(page);
      assert.equal(
        await page.evaluate(() => window.harness.snapshot().imageUrl),
        cachedUrl,
      );
      assert.equal(requests.length, 1);
    });
  },
);

test(
  "board preview falls back to the native image load event when decode is unavailable",
  { timeout: 60000 },
  async (t) => {
    await fixture(t, async ({ page, requests, nextRequest }) => {
      await page.evaluate(() => {
        window.harness.useOnloadFallback();
        window.harness.render();
      });
      await fulfillImage(await nextRequest());
      await waitForDecodedPreview(page);
      assert.equal(
        await page.evaluate(() => window.harness.fallbackLoads()),
        1,
      );
      assert.equal(
        await page.evaluate(() => window.harness.decodeRequests.length),
        0,
      );
      assert.equal(requests.length, 1);
    });
  },
);
