import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const harnessSource = `
import React, { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BoardReactionsLayer } from '/src/ui/BoardReactionsLayer.tsx';
import { showVideoReaction } from '/src/ui/controls/boardReactionPort.ts';
const root = createRoot(document.getElementById('root'));
const timers = new Map();
const playRequests = [];
let nextTimerId = 0;
let now = 1000000;
let visibility = 'visible';
let layer;
let parentRenders = 0;
let mountSetups = 0;
let pendingPlayback = false;
Date.now = () => now;
Object.defineProperty(document, 'visibilityState', { get: () => visibility });
HTMLMediaElement.prototype.play = function () {
  const request = { video: this, reject: null };
  playRequests.push(request);
  return pendingPlayback ? new Promise((resolve, reject) => request.reject = reject) : Promise.resolve();
};
document.addEventListener('error', event => {
  if (event.isTrusted && event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
}, true);
const setTrackedTimeout = (callback, delay) => {
  const id = ++nextTimerId;
  timers.set(id, { callback, due: now + delay });
  return id;
};
const clearTrackedTimeout = id => timers.delete(id);
const viewport = { left: 12, top: 20, width: 440, height: 564 };
function Probe({ hasViewport, pangchiu, mountReaction }) {
  parentRenders++;
  const ref = useRef(null);
  layer = ref;
  useEffect(() => {
    if (mountReaction !== null) {
      mountSetups++;
      showVideoReaction(false, mountReaction);
    }
    return () => timers.clear();
  }, [mountReaction]);
  return React.createElement(BoardReactionsLayer, {
    ref,
    viewportRect: hasViewport ? viewport : null,
    isPangchiuBoardLayout: pangchiu,
    setTrackedTimeout,
    clearTrackedTimeout,
    wagerLayer: React.createElement('div', { id: 'wagers' }),
  }, React.createElement('div', { id: 'overlay' }));
}
const run = callback => flushSync(callback);
const video = opponent => document.querySelector('#root > div').children[opponent ? 1 : 2].querySelector('video');
window.harness = {
  render(hasViewport = true, pangchiu = false, mountReaction = null) {
    run(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(Probe, { hasViewport, pangchiu, mountReaction }))));
  },
  show(opponent, id) { run(() => showVideoReaction(opponent, id)); },
  advance(ms, runTimers = true) {
    const target = now + ms;
    if (runTimers) {
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        run(next[1].callback);
      }
    }
    now = target;
  },
  playing(opponent, duration, currentTime = 0) {
    const target = video(opponent);
    Object.defineProperty(target, 'duration', { configurable: true, value: duration });
    target.currentTime = currentTime;
    run(() => target.dispatchEvent(new Event('playing')));
  },
  error(opponent, source = false) {
    const target = source ? video(opponent).querySelector('source') : video(opponent);
    run(() => target.dispatchEvent(new Event('error', { bubbles: true })));
  },
  resume(eventName, nextVisibility = 'visible') {
    visibility = nextVisibility;
    const target = eventName === 'visibilitychange' ? document : window;
    run(() => target.dispatchEvent(new Event(eventName)));
  },
  clear(fade = false) {
    run(() => {
      timers.clear();
      layer.current.resetTimeoutRefs();
      layer.current.clear(fade);
    });
  },
  pendingPlayback(value) { pendingPlayback = value; },
  async rejectPlay(index, name) {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => playRequests[index].reject(Object.assign(new Error(name), { name })));
    } finally { globalThis.IS_REACT_ACT_ENVIRONMENT = false; }
  },
  snapshot() {
    const container = document.querySelector('#root > div');
    return {
      parentRenders,
      mountSetups,
      playCount: playRequests.length,
      timers: [...timers.values()].map(timer => timer.due - now).sort((a, b) => a - b),
      children: container ? [...container.children].map(element => element.id || element.tagName) : [],
      wrappers: container ? [...container.children].slice(1, 3).map(element => ({
        top: element.style.top,
        height: element.style.height,
        transform: element.style.transform,
      })) : [],
      videos: [...document.querySelectorAll('video')].map(element => ({
        id: Number(element.querySelector('source').src.split('/').pop().split('.')[0]),
        opacity: element.style.opacity,
        transform: element.style.transform,
        muted: element.muted,
        playsInline: element.playsInline,
        sources: [...element.querySelectorAll('source')].map(source => source.type),
      })),
    };
  },
  dispose() { run(() => root.unmount()); },
};
`;

async function fixture(run) {
  const server = await createServer({
    root: repository,
    configFile: false,
    logLevel: "error",
    cacheDir: `node_modules/.vite-board-reactions-${process.pid}`,
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    plugins: [
      {
        name: "board-reactions-browser-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__reactions") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/__reactions.js"></script>',
            );
          });
        },
        resolveId(id) {
          if (id === "/__reactions.js") return "\0board-reactions-harness";
        },
        load(id) {
          if (id === "\0board-reactions-harness") return harnessSource;
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
    const context = await browser.newContext();
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/__reactions`);
    await page.waitForFunction(() => !!window.harness);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

const invoke = (page, method, ...args) =>
  page.evaluate(({ method, args }) => window.harness[method](...args), {
    method,
    args,
  });
const snapshot = (page) => invoke(page, "snapshot");
const videoIds = (state) => state.videos.map((video) => video.id);

test("reactions retain pre-layout state, placement, media sources, and isolate parent renders", async () => {
  await fixture(async (page) => {
    await invoke(page, "render", false);
    await invoke(page, "show", true, 17);
    await invoke(page, "show", false, 20);
    assert.deepEqual(videoIds(await snapshot(page)), []);
    await invoke(page, "render", true);
    const state = await snapshot(page);
    assert.deepEqual(videoIds(state), [17, 20]);
    assert.deepEqual(state.children, ["wagers", "DIV", "DIV", "overlay"]);
    assert.deepEqual(state.wrappers, [
      { top: "7.02%", height: "12.5%", transform: "translate(-50%, -100%)" },
      { top: "85.22%", height: "12.5%", transform: "translateX(-50%)" },
    ]);
    assert.ok(state.videos.every((video) => video.muted && video.playsInline));
    assert.deepEqual(state.videos[0].sources, [
      'video/quicktime; codecs="hvc1"',
      "video/webm",
    ]);
    await invoke(page, "advance", 400);
    const appeared = await snapshot(page);
    assert.ok(appeared.videos.every((video) => video.opacity === "1"));
    assert.equal(appeared.parentRenders, state.parentRenders);
    await invoke(page, "render", true, true);
    assert.deepEqual((await snapshot(page)).wrappers, [
      { top: "7.05%", height: "13.5%", transform: "translate(-50%, -100%)" },
      { top: "89.65%", height: "13.5%", transform: "translateX(-50%)" },
    ]);
  });
});

test("playback updates lifetime and replacement ignores stale playback failures", async () => {
  await fixture(async (page) => {
    await invoke(page, "render");
    await invoke(page, "pendingPlayback", true);
    await invoke(page, "show", false, 1);
    await invoke(page, "show", false, 2);
    await invoke(page, "rejectPlay", 0, "NotAllowedError");
    assert.deepEqual(videoIds(await snapshot(page)), [2]);
    await invoke(page, "advance", 400);
    assert.equal((await snapshot(page)).videos[0].opacity, "1");
    await invoke(page, "playing", false, 2, 1);
    assert.deepEqual((await snapshot(page)).timers, [1700]);
    await invoke(page, "advance", 1699);
    assert.equal((await snapshot(page)).videos[0].opacity, "1");
    await invoke(page, "advance", 1);
    assert.equal((await snapshot(page)).videos[0].opacity, "0");
    await invoke(page, "advance", 200);
    assert.deepEqual(videoIds(await snapshot(page)), []);
    await invoke(page, "show", false, 3);
    await invoke(page, "playing", false, 30);
    assert.deepEqual((await snapshot(page)).timers, [400, 12000]);
    await invoke(page, "playing", false, 0.1);
    assert.deepEqual((await snapshot(page)).timers, [400, 1000]);
  });
});

test("page resume resumes active playback and expires suspended reactions", async () => {
  await fixture(async (page) => {
    await invoke(page, "render");
    await invoke(page, "show", true, 17);
    const first = await snapshot(page);
    await invoke(page, "resume", "visibilitychange", "hidden");
    assert.equal((await snapshot(page)).playCount, first.playCount);
    await invoke(page, "resume", "focus");
    assert.equal((await snapshot(page)).playCount, first.playCount + 1);
    await invoke(page, "advance", 7001, false);
    await invoke(page, "resume", "pageshow");
    assert.equal((await snapshot(page)).videos[0].opacity, "0");
    await invoke(page, "advance", 121, false);
    await invoke(page, "resume", "visibilitychange");
    assert.deepEqual(videoIds(await snapshot(page)), []);
  });
});

test("clearing both reactions cancels old timers and preserves new reactions", async () => {
  await fixture(async (page) => {
    await invoke(page, "render");
    await invoke(page, "show", false, 1);
    await invoke(page, "show", true, 2);
    await invoke(page, "clear", true);
    assert.deepEqual((await snapshot(page)).timers, [120, 120]);
    await invoke(page, "advance", 120);
    assert.deepEqual(videoIds(await snapshot(page)), []);
    await invoke(page, "show", false, 3);
    await invoke(page, "clear", false);
    assert.deepEqual((await snapshot(page)).timers, []);
    assert.deepEqual(videoIds(await snapshot(page)), []);
    await invoke(page, "show", false, 4);
    await invoke(page, "advance", 400);
    assert.deepEqual(videoIds(await snapshot(page)), [4]);
    assert.equal((await snapshot(page)).videos[0].opacity, "1");
    await invoke(page, "dispose");
    await invoke(page, "show", false, 5);
    assert.deepEqual((await snapshot(page)).timers, []);
    assert.deepEqual(videoIds(await snapshot(page)), []);
  });
});

test("source errors do not dismiss a reaction but media element errors do", async () => {
  await fixture(async (page) => {
    await invoke(page, "render");
    await invoke(page, "show", false, 1);
    await invoke(page, "advance", 400);
    await invoke(page, "error", false, true);
    assert.equal((await snapshot(page)).videos[0].opacity, "1");
    await invoke(page, "error", false);
    assert.equal((await snapshot(page)).videos[0].opacity, "0");
    await invoke(page, "advance", 200);
    assert.deepEqual(videoIds(await snapshot(page)), []);
  });
});

test("StrictMode mount replay replaces canceled reaction timers and unmount releases them", async () => {
  await fixture(async (page) => {
    await invoke(page, "render", true, false, 17);
    const state = await snapshot(page);
    assert.equal(state.mountSetups, 2);
    assert.deepEqual(videoIds(state), [17]);
    assert.deepEqual(state.timers, [400, 7000]);
    await invoke(page, "advance", 400);
    assert.equal((await snapshot(page)).videos[0].opacity, "1");
    await invoke(page, "playing", false, 2);
    assert.deepEqual((await snapshot(page)).timers, [2700]);
    await invoke(page, "dispose");
    await invoke(page, "advance", 10000);
    await invoke(page, "resume", "pageshow");
    assert.deepEqual((await snapshot(page)).timers, []);
    assert.deepEqual(videoIds(await snapshot(page)), []);
  });
});
