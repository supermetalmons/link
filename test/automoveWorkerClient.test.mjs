import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/src/game/automoveWorkerClient.ts")) {
      return {
        ...result,
        source: String(result.source).replace("import.meta.env.DEV", "false"),
      };
    }
    return result;
  },
});

class FakeWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.messages = [];
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  resolveLast(result) {
    const request = this.messages.at(-1);
    this.onmessage?.({
      data: {
        type: "result",
        id: request.id,
        result,
      },
    });
  }

  fail(message) {
    this.onerror?.({ message });
  }
}

test("uses module workers, cleans up rejections, and restarts after failure", async () => {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  const unhandledRejections = [];
  const handleUnhandledRejection = (reason) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", handleUnhandledRejection);

  try {
    const { requestSmartAutomoveFromWorker } =
      await import("../src/game/automoveWorkerClient.ts");

    const firstRequest = requestSmartAutomoveFromWorker("fen-1", "normal");
    const firstWorker = FakeWorker.instances[0];
    assert.ok(firstWorker.url instanceof URL);
    assert.deepEqual(firstWorker.options, { type: "module" });
    firstWorker.resolveLast({ kind: "other" });
    assert.deepEqual(await firstRequest, { kind: "other" });

    const failedRequest = requestSmartAutomoveFromWorker("fen-2", "normal");
    firstWorker.fail("synthetic worker failure");
    await assert.rejects(failedRequest, /synthetic worker failure/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
    assert.equal(firstWorker.terminated, true);

    const restartedRequest = requestSmartAutomoveFromWorker("fen-3", "fast");
    const restartedWorker = FakeWorker.instances[1];
    assert.notStrictEqual(restartedWorker, firstWorker);
    restartedWorker.resolveLast({ kind: "other" });
    assert.deepEqual(await restartedRequest, { kind: "other" });
  } finally {
    process.off("unhandledRejection", handleUnhandledRejection);
    if (previousWorker) {
      Object.defineProperty(globalThis, "Worker", previousWorker);
    } else {
      delete globalThis.Worker;
    }
  }
});
