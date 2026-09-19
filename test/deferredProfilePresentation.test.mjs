import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  beginVerifiedProfileApplication,
  createDeferredProfilePresentation,
  queueDeferredProfilePresentation,
} from "../src/connection/deferredProfilePresentation.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { bindShinyCardUi, showShinyCard } =
  await import("../src/ui/shinyCardUiPort.ts");

const identity = { profileId: "profile", displayName: "Verified name" };

function harness({ hidden = false } = {}) {
  let nextId = 0;
  let current = true;
  const frames = new Map();
  const tasks = new Map();
  const listeners = new Set();
  const errors = [];
  const writes = [];
  const values = new Map([
    ["background", "cached-background"],
    ["subtitle", "cached-subtitle"],
  ]);
  const run = (callbacks) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback());
  };
  const scheduler = createDeferredProfilePresentation({
    isHidden: () => hidden,
    requestFrame: (callback) => {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelFrame: (id) => frames.delete(id),
    scheduleTask: (callback) => {
      tasks.set(++nextId, callback);
      return nextId;
    },
    cancelTask: (id) => tasks.delete(id),
    subscribeVisibility: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    reportError: (error) => errors.push(error),
  });
  const fields = ["background", "subtitle"].map((key) => ({
    read: () => values.get(key),
    write: () => {
      writes.push(key);
      values.set(key, `verified-${key}`);
    },
  }));
  return {
    scheduler,
    frames,
    tasks,
    listeners,
    errors,
    writes,
    values,
    fields,
    queue: (nextFields = fields) =>
      scheduler.queue(
        scheduler.beginApplication(),
        identity,
        () => current,
        nextFields,
      ),
    frame: () => run(frames),
    task: () => run(tasks),
    invalidate: () => {
      current = false;
    },
    setHidden: (value) => {
      hidden = value;
      [...listeners].forEach((listener) => listener());
    },
  };
}

test("waits for the verified header commit and a paint opportunity without consulting timing marks", () => {
  const h = harness();
  h.queue();
  assert.equal(h.frames.size, 0);
  assert.equal(h.tasks.size, 0);
  h.scheduler.nameCommitted(identity, () => true);
  h.frame();
  assert.deepEqual(h.writes, []);
  h.frame();
  assert.deepEqual(h.writes, ["background", "subtitle"]);
  assert.equal(h.listeners.size, 0);
  h.scheduler.flush();
  assert.equal(h.writes.length, 2);
});

test("a mounted matching header schedules successive applications without another commit", () => {
  const h = harness();
  h.scheduler.nameCommitted(identity, () => true);
  h.queue();
  h.frame();
  h.frame();
  assert.equal(h.writes.length, 2);
  h.values.set("background", "later-baseline");
  h.queue();
  h.frame();
  assert.equal(h.writes.length, 2);
  h.frame();
  assert.equal(h.writes.length, 4);
  assert.equal(h.values.get("background"), "verified-background");
});

test("a changed profile or name waits for a matching commit before writing", () => {
  for (const replacement of [
    { ...identity, profileId: "other-profile" },
    { ...identity, displayName: "Updated name" },
  ]) {
    const h = harness();
    const oldCleanup = h.scheduler.nameCommitted(identity, () => true);
    h.scheduler.queue(
      h.scheduler.beginApplication(),
      replacement,
      () => true,
      h.fields,
    );
    assert.equal(h.frames.size, 0);
    h.scheduler.nameCommitted(replacement, () => true);
    oldCleanup();
    h.frame();
    h.frame();
    assert.equal(h.writes.length, 2);
  }
});

test("a name guard failure during the deferred frame is reported without escaping the callback", () => {
  const h = harness();
  const error = new Error("storage unavailable after commit");
  let failGuard = false;
  h.queue();
  h.scheduler.nameCommitted(identity, () => {
    if (failGuard) throw error;
    return true;
  });
  h.frame();
  failGuard = true;
  assert.doesNotThrow(h.frame);
  assert.deepEqual(h.errors, [error]);
  assert.deepEqual(h.writes, []);
  h.scheduler.beginApplication();
});

test("commit cleanup cancels frames while a replacement commit can complete the pending job", () => {
  const h = harness();
  h.queue();
  const cleanup = h.scheduler.nameCommitted(identity, () => true);
  h.frame();
  cleanup();
  h.frame();
  assert.deepEqual(h.writes, []);
  h.scheduler.nameCommitted(identity, () => true);
  h.frame();
  h.frame();
  assert.equal(h.writes.length, 2);
});

test("a header that no longer matches cannot release presentation writes", () => {
  const h = harness();
  let nameCurrent = true;
  h.queue();
  h.scheduler.nameCommitted(identity, () => nameCurrent);
  h.frame();
  nameCurrent = false;
  h.frame();
  assert.deepEqual(h.writes, []);
  h.scheduler.nameCommitted(identity, () => true);
  h.frame();
  h.frame();
  assert.equal(h.writes.length, 2);
});

test("hidden documents persist in a regular task without waiting for an unavailable paint", () => {
  const h = harness({ hidden: true });
  h.queue();
  assert.equal(h.frames.size, 0);
  assert.equal(h.tasks.size, 1);
  assert.deepEqual(h.writes, []);
  h.task();
  assert.equal(h.writes.length, 2);
  assert.equal(h.listeners.size, 0);
});

test("hiding a visible document replaces its pending animation frames with a task", () => {
  const h = harness();
  h.queue();
  h.scheduler.nameCommitted(identity, () => true);
  h.frame();
  h.setHidden(true);
  assert.equal(h.frames.size, 0);
  h.task();
  assert.equal(h.writes.length, 2);
});

test("returning visible before the hidden task runs waits for the header paint", () => {
  const h = harness({ hidden: true });
  h.queue();
  h.setHidden(false);
  assert.equal(h.tasks.size, 0);
  h.task();
  assert.deepEqual(h.writes, []);
  h.scheduler.nameCommitted(identity, () => true);
  h.frame();
  h.frame();
  assert.equal(h.writes.length, 2);
});

test("a superseding application cancels pending frames and ignores an older enqueue", () => {
  const h = harness();
  h.queue();
  h.scheduler.nameCommitted(identity, () => true);
  const oldRevision = h.scheduler.beginApplication();
  h.scheduler.beginApplication();
  h.scheduler.queue(oldRevision, identity, () => true, h.fields);
  assert.equal(h.frames.size, 0);
  assert.equal(h.listeners.size, 0);
  h.scheduler.flush();
  assert.deepEqual(h.writes, []);
});

test("an invalidated session cannot write or retain visibility listeners", () => {
  const h = harness({ hidden: true });
  h.queue();
  h.invalidate();
  h.task();
  assert.deepEqual(h.writes, []);
  assert.equal(h.listeners.size, 0);
});

test("preserves a changed field without dropping unchanged fields", () => {
  const h = harness();
  h.queue();
  h.values.set("background", "newer-background");
  h.scheduler.flush();
  assert.equal(h.values.get("background"), "newer-background");
  assert.equal(h.values.get("subtitle"), "verified-subtitle");
  assert.deepEqual(h.writes, ["subtitle"]);
});

test("reports read and write failures independently while tolerating browser quota errors", () => {
  const h = harness();
  const readError = new Error("blocked baseline");
  const writeError = new Error("blocked write");
  h.queue([
    {
      read: () => {
        throw readError;
      },
      write: () => assert.fail("failed baseline must be excluded"),
    },
    {
      read: () => null,
      write: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    },
    {
      read: () => null,
      write: () => {
        throw writeError;
      },
    },
    ...h.fields,
  ]);
  h.scheduler.flush();
  assert.deepEqual(h.errors, [readError, writeError]);
  assert.equal(h.writes.length, 2);
});

test("opening an own profile card flushes pending fields before the card reads them", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.window = {};
  let value = "cached";
  const shown = [];
  const unbind = bindShinyCardUi({
    show: async (_profile, _name, isOtherPlayer) => {
      shown.push([isOtherPlayer, value]);
    },
  });
  try {
    queueDeferredProfilePresentation(
      beginVerifiedProfileApplication(),
      identity,
      () => true,
      [
        {
          read: () => value,
          write: () => {
            value = "verified";
          },
        },
      ],
    );
    await showShinyCard(null, "Other player", true);
    await showShinyCard(null, "Own player", false);
    assert.deepEqual(shown, [
      [true, "cached"],
      [false, "verified"],
    ]);
  } finally {
    beginVerifiedProfileApplication();
    unbind();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
