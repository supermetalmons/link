import assert from "node:assert/strict";
import test from "node:test";
import {
  markAuthRestoreStart,
  markAuthLocalReady,
  markAuthSessionReady,
  markAuthIdentityReady,
  markAuthNameCommitted,
} from "../src/session/authRestoreTiming.ts";

test("auth timing records first stages and guards the visible-name frame without telemetry", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  /** @type {Map<number, FrameRequestCallback>} */
  const frames = new Map();
  let next = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++next, callback);
    return next;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { visibilityState: "visible" },
  });
  const frame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  try {
    markAuthRestoreStart();
    markAuthRestoreStart();
    markAuthLocalReady();
    markAuthSessionReady();
    markAuthIdentityReady(false);
    markAuthNameCommitted();
    assert.equal(
      performance.getEntriesByName("auth:name-committed", "mark").length,
      0,
    );
    markAuthIdentityReady();
    let current = true;
    markAuthNameCommitted(() => current);
    current = false;
    frame();
    frame();
    assert.equal(
      performance.getEntriesByName("auth:name-visible", "mark").length,
      0,
    );
    const cancel = markAuthNameCommitted();
    cancel();
    frame();
    frame();
    assert.equal(
      performance.getEntriesByName("auth:name-visible", "mark").length,
      0,
    );
    markAuthNameCommitted();
    frame();
    assert.equal(
      performance.getEntriesByName("auth:name-visible", "mark").length,
      0,
    );
    frame();
    for (const name of [
      "restore-start",
      "local-ready",
      "session-ready",
      "identity-ready",
      "name-committed",
      "name-visible",
    ])
      assert.equal(
        performance.getEntriesByName(`auth:${name}`, "mark").length,
        1,
      );
    assert.equal(
      performance.getEntriesByName("auth:name-visible", "measure").length,
      1,
    );
  } finally {
    if (originalRaf === undefined)
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    else globalThis.requestAnimationFrame = originalRaf;
    if (originalCancel === undefined)
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    else globalThis.cancelAnimationFrame = originalCancel;
    if (originalDocument === undefined)
      Reflect.deleteProperty(globalThis, "document");
    else globalThis.document = originalDocument;
  }
});
