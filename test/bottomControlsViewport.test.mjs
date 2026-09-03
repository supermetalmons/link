import assert from "node:assert/strict";
import test from "node:test";

import { observeBottomControlsViewport } from "../src/ui/controls/bottomControlsViewport.ts";

const offsetProperty = "--bottom-controls-offset";
const viewportHeightProperty = "--bottom-controls-viewport-height";

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount() {
      return [...listeners.values()].reduce(
        (count, set) => count + set.size,
        0,
      );
    },
  };
}

function harness(
  t,
  {
    fixedBottomEdge = 900,
    spacing = 10,
    viewportHeight = 900,
    offsetTop = 0,
    scale = 1,
    hasVisualViewport = true,
  } = {},
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const properties = new Map();
  const writes = [];
  const frames = new Map();
  const canceledFrames = [];
  const layout = { fixedBottomEdge, spacing };
  let nextFrame = 1;
  let measurements = 0;
  const viewport = Object.assign(eventTarget(), {
    height: viewportHeight,
    offsetTop,
    scale,
  });
  const currentOffset = () => parseFloat(properties.get(offsetProperty) ?? "0");
  const controls = {
    getBoundingClientRect() {
      measurements += 1;
      return {
        bottom: layout.fixedBottomEdge - layout.spacing - currentOffset(),
      };
    },
  };
  const container = {
    style: {
      setProperty(name, value) {
        writes.push({ name, value });
        properties.set(name, value);
      },
      removeProperty(name) {
        writes.push({ name, value: null });
        properties.delete(name);
      },
    },
  };
  const window = Object.assign(eventTarget(), {
    visualViewport: hasVisualViewport ? viewport : undefined,
    getComputedStyle(element) {
      assert.equal(element, controls);
      return { bottom: `${layout.spacing + currentOffset()}px` };
    },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      canceledFrames.push(id);
      frames.delete(id);
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  let cleanup = observeBottomControlsViewport(container, controls);
  const dispose = () => {
    cleanup?.();
    cleanup = null;
  };
  t.after(() => {
    dispose();
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  });
  return {
    controls,
    layout,
    viewport,
    window,
    writes,
    frames,
    canceledFrames,
    properties,
    measurements: () => measurements,
    dispose,
    flushFrame() {
      const scheduled = [...frames.values()];
      frames.clear();
      for (const callback of scheduled) callback();
    },
  };
}

test("already visible controls retain their position without style writes", (t) => {
  const h = harness(t);
  assert.equal(h.controls.getBoundingClientRect().bottom, 890);
  assert.deepEqual(h.writes, []);

  h.viewport.dispatch("resize");
  h.viewport.dispatch("scroll");
  h.window.dispatch("resize");
  h.flushFrame();

  assert.equal(h.controls.getBoundingClientRect().bottom, 890);
  assert.deepEqual(h.writes, []);
});

test("a browser that already anchors controls above its toolbar needs no correction", (t) => {
  const h = harness(t, { fixedBottomEdge: 780, viewportHeight: 780 });
  assert.equal(h.controls.getBoundingClientRect().bottom, 770);
  assert.deepEqual(h.writes, []);
});

test("covered controls move above the toolbar with their original safe-area spacing", (t) => {
  const h = harness(t, { spacing: 34, viewportHeight: 780 });
  assert.equal(h.controls.getBoundingClientRect().bottom, 746);
  assert.deepEqual(h.writes, [
    { name: offsetProperty, value: "120px" },
    { name: viewportHeightProperty, value: "780px" },
  ]);
});

test("repeated viewport events do not oscillate or apply the correction twice", (t) => {
  const h = harness(t, { viewportHeight: 780 });
  for (let i = 0; i < 5; i += 1) {
    h.viewport.dispatch("resize");
    h.viewport.dispatch("scroll");
    h.flushFrame();
    assert.equal(h.controls.getBoundingClientRect().bottom, 770);
  }
  assert.deepEqual(h.writes, [
    { name: offsetProperty, value: "120px" },
    { name: viewportHeightProperty, value: "780px" },
  ]);
});

test("hiding the toolbar restores the original position and removes the override", (t) => {
  const h = harness(t, { viewportHeight: 780 });
  h.viewport.height = 900;
  h.viewport.dispatch("resize");
  h.flushFrame();

  assert.equal(h.controls.getBoundingClientRect().bottom, 890);
  assert.equal(h.properties.has(offsetProperty), false);
  assert.equal(h.properties.has(viewportHeightProperty), false);
  assert.deepEqual(h.writes, [
    { name: offsetProperty, value: "120px" },
    { name: viewportHeightProperty, value: "780px" },
    { name: offsetProperty, value: null },
    { name: viewportHeightProperty, value: null },
  ]);
});

test("pinch zoom does not cause toolbar compensation", (t) => {
  const h = harness(t, { viewportHeight: 450, scale: 2 });
  assert.deepEqual(h.writes, []);

  h.viewport.scale = 1;
  h.viewport.height = 780;
  h.viewport.dispatch("resize");
  h.flushFrame();
  assert.equal(h.controls.getBoundingClientRect().bottom, 770);

  h.viewport.scale = 1.5;
  h.viewport.height = 600;
  h.viewport.dispatch("resize");
  h.flushFrame();
  assert.equal(h.properties.has(offsetProperty), false);
  assert.equal(h.properties.has(viewportHeightProperty), false);
  assert.equal(h.controls.getBoundingClientRect().bottom, 890);
});

test("the visible bottom includes a viewport shifted below the layout origin", (t) => {
  const h = harness(t, { viewportHeight: 720, offsetTop: 60 });
  assert.equal(h.controls.getBoundingClientRect().bottom, 770);
  assert.deepEqual(h.writes, [
    { name: offsetProperty, value: "120px" },
    { name: viewportHeightProperty, value: "720px" },
  ]);

  h.viewport.offsetTop = 180;
  h.viewport.dispatch("scroll");
  h.flushFrame();
  assert.equal(h.controls.getBoundingClientRect().bottom, 890);
  assert.equal(h.properties.has(offsetProperty), false);
});

test("window resize preserves the new short-screen spacing", (t) => {
  const h = harness(t, { viewportHeight: 780 });
  h.layout.fixedBottomEdge = 430;
  h.layout.spacing = 6;
  h.viewport.height = 370;
  h.window.dispatch("resize");
  h.flushFrame();

  assert.equal(h.controls.getBoundingClientRect().bottom, 364);
  assert.equal(h.properties.get(offsetProperty), "60px");
  assert.equal(h.properties.get(viewportHeightProperty), "370px");
});

test("popup height follows a shrinking viewport even when its bottom stays unchanged", (t) => {
  const h = harness(t, { viewportHeight: 780 });
  h.viewport.height = 720;
  h.viewport.offsetTop = 60;
  h.viewport.dispatch("resize");
  h.flushFrame();

  assert.equal(h.controls.getBoundingClientRect().bottom, 770);
  assert.equal(h.properties.get(offsetProperty), "120px");
  assert.equal(h.properties.get(viewportHeightProperty), "720px");
});

test("missing VisualViewport leaves controls untouched and installs no listeners", (t) => {
  const h = harness(t, { hasVisualViewport: false });
  assert.equal(h.measurements(), 0);
  assert.equal(h.window.listenerCount(), 0);
  assert.equal(h.viewport.listenerCount(), 0);
  h.dispose();
  assert.deepEqual(h.writes, []);
});

test("viewport and window event bursts share one animation frame", (t) => {
  const h = harness(t);
  assert.equal(h.measurements(), 1);
  h.viewport.height = 780;
  h.viewport.dispatch("resize");
  h.viewport.dispatch("scroll");
  h.window.dispatch("resize");
  h.window.dispatch("pageshow");
  assert.equal(h.frames.size, 1);
  assert.equal(h.measurements(), 1);
  assert.deepEqual(h.writes, []);

  h.flushFrame();
  assert.equal(h.measurements(), 2);
  assert.equal(h.frames.size, 0);
  assert.equal(h.controls.getBoundingClientRect().bottom, 770);
});

test("cleanup removes listeners, cancels pending work, and restores original placement", (t) => {
  const h = harness(t, { viewportHeight: 780 });
  assert.equal(h.window.listenerCount(), 2);
  assert.equal(h.viewport.listenerCount(), 2);
  h.viewport.height = 700;
  h.viewport.dispatch("resize");
  assert.equal(h.frames.size, 1);
  const measurementsBeforeCleanup = h.measurements();

  h.dispose();
  assert.equal(h.window.listenerCount(), 0);
  assert.equal(h.viewport.listenerCount(), 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.canceledFrames.length, 1);
  assert.equal(h.properties.has(offsetProperty), false);
  assert.equal(h.properties.has(viewportHeightProperty), false);

  h.viewport.dispatch("resize");
  h.window.dispatch("pageshow");
  h.flushFrame();
  assert.equal(h.measurements(), measurementsBeforeCleanup);
  assert.equal(h.controls.getBoundingClientRect().bottom, 890);
});
