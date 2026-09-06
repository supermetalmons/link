import assert from "node:assert/strict";
import test from "node:test";
import { MatchPresentationState } from "../src/connection/matchPresentationState.ts";

const presentation = (overrides = {}) => ({
  matchId: "invite",
  actorUid: "host",
  emojiId: 1,
  aura: "",
  revision: 0,
  ...overrides,
});
const snapshot = (...players) => ({
  matchId: "invite",
  players: Object.fromEntries(players.map((value) => [value.actorUid, value])),
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides = {}) {
  const changes = [];
  const errors = [];
  const saves = [];
  const loads = [];
  let current = presentation();
  let active = true;
  let operation = 0;
  const state = new MatchPresentationState({
    matchId: "invite",
    actorUid: "host",
    isActive: () => active,
    load: async (signal) => {
      loads.push(signal);
      return snapshot(current);
    },
    save: async (request, signal) => {
      saves.push({ request, signal });
      current = presentation({
        emojiId: request.emojiId,
        aura: request.aura,
        revision: request.expectedRevision + 1,
      });
      return current;
    },
    onChange: (actorUid) =>
      changes.push({ actorUid, value: state.get(actorUid) }),
    onError: (error) => errors.push(error),
    createOperationId: () =>
      `00000000-0000-4000-8000-${String(++operation).padStart(12, "0")}`,
    ...overrides,
  });
  return {
    state,
    changes,
    errors,
    saves,
    loads,
    setCurrent: (value) => (current = value),
    setActive: (value) => (active = value),
  };
}

test("hydrates both players and rejects stale or foreign presentation without changing gameplay state", async () => {
  const h = harness();
  h.state.acceptSnapshot(
    snapshot(presentation(), presentation({ actorUid: "guest", emojiId: 7 })),
  );
  h.state.accept(presentation({ revision: 3, emojiId: 1001, aura: "rainbow" }));
  h.state.accept(presentation({ revision: 2, emojiId: 2 }));
  h.state.accept(presentation({ matchId: "other", revision: 99, emojiId: 3 }));
  h.state.acceptSnapshot(snapshot(presentation()));
  assert.deepEqual(
    h.state.get("host"),
    presentation({ revision: 3, emojiId: 1001, aura: "rainbow" }),
  );
  assert.equal(h.state.get("guest").emojiId, 7);
  assert.equal(h.saves.length, 0);
  assert.equal(h.changes.length, 3);
});

test("serializes writes and coalesces rapid choices while older responses cannot undo optimism", async () => {
  const first = deferred();
  const calls = [];
  const h = harness({
    save: async (request) => {
      calls.push(request);
      if (calls.length === 1) return first.promise;
      return presentation({
        emojiId: request.emojiId,
        aura: request.aura,
        revision: request.expectedRevision + 1,
      });
    },
  });
  h.state.update(2, "");
  await flush();
  assert.equal(calls.length, 1);
  h.state.update(3, "");
  h.state.update(1001, "rainbow");
  h.state.acceptSnapshot(snapshot(presentation()));
  assert.equal(h.state.get("host").emojiId, 1001);
  first.resolve(presentation({ emojiId: 2, revision: 1 }));
  await flush();
  assert.deepEqual(
    calls.map((value) => value.emojiId),
    [2, 1001],
  );
  assert.deepEqual(
    calls.map((value) => value.expectedRevision),
    [0, 1],
  );
  assert.deepEqual(
    h.state.get("host"),
    presentation({ emojiId: 1001, aura: "rainbow", revision: 2 }),
  );
  assert.equal(h.errors.length, 0);
});

test("clears aura explicitly and suppresses updates equal to canonical state", async () => {
  const h = harness();
  h.setCurrent(presentation({ emojiId: 1001, aura: "rainbow", revision: 2 }));
  await h.state.refresh();
  h.state.update(1001, "");
  await flush();
  assert.equal(h.saves[0].request.aura, "");
  assert.deepEqual(
    h.state.get("host"),
    presentation({ emojiId: 1001, revision: 3 }),
  );
  h.state.update(1001, "");
  await flush();
  assert.equal(h.saves.length, 1);
});

test("reconciles a conflict without blindly retrying the rejected choice", async () => {
  let calls = 0;
  const current = presentation({ emojiId: 7, revision: 4 });
  const h = harness({
    save: async () => {
      calls++;
      throw Object.assign(new Error("conflict"), {
        code: "presentation-conflict",
        presentation: current,
      });
    },
  });
  h.state.update(2, "");
  await flush();
  assert.deepEqual(h.state.get("host"), current);
  assert.equal(calls, 1);
});

test("refreshes after timeout before sending a distinct newer choice", async () => {
  const first = deferred();
  const reconcile = deferred();
  let loads = 0;
  const calls = [];
  const h = harness({
    load: async () =>
      ++loads === 1 ? snapshot(presentation()) : reconcile.promise,
    save: async (request) => {
      calls.push(request);
      return calls.length === 1
        ? first.promise
        : presentation({
            emojiId: request.emojiId,
            revision: request.expectedRevision + 1,
          });
    },
  });
  h.state.update(2, "");
  await flush();
  h.state.update(3, "");
  first.reject(Object.assign(new Error("timeout"), { code: "timeout" }));
  await flush();
  assert.equal(loads, 2);
  assert.equal(calls.length, 1);
  reconcile.resolve(snapshot(presentation({ emojiId: 2, revision: 1 })));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].expectedRevision, 1);
  assert.equal(h.state.get("host").emojiId, 3);
});

test("failed reconciliation parks the newest choice until an uncertain write is retired", async () => {
  const first = deferred();
  let loads = 0;
  let saves = 0;
  const h = harness({
    load: async () => {
      if (++loads > 1) throw new Error("offline");
      return snapshot(presentation());
    },
    save: (request) =>
      ++saves === 1
        ? first.promise
        : Promise.resolve(
            presentation({
              emojiId: request.emojiId,
              revision: request.expectedRevision + 1,
            }),
          ),
  });
  h.state.update(2, "");
  await flush();
  h.state.update(3, "");
  first.reject(new Error("offline"));
  await flush();
  assert.equal(h.state.get("host").emojiId, 3);
  assert.equal(saves, 1);
  h.state.accept(presentation({ emojiId: 2, revision: 1 }));
  await flush();
  assert.deepEqual(
    h.state.get("host"),
    presentation({ emojiId: 3, revision: 2 }),
  );
  assert.equal(saves, 2);
});

test("retires a timed-out write before skipping a newer choice that matches the old snapshot", async () => {
  const first = deferred();
  const retirement = deferred();
  const calls = [];
  let stored = presentation();
  let lastOperation;
  const apply = (request) => {
    if (lastOperation !== request.operationId) {
      if (request.expectedRevision !== stored.revision) {
        throw Object.assign(new Error("conflict"), {
          code: "presentation-conflict",
          presentation: stored,
        });
      }
      lastOperation = request.operationId;
      stored = presentation({
        emojiId: request.emojiId,
        aura: request.aura,
        revision: stored.revision + 1,
      });
    }
    return stored;
  };
  const h = harness({
    load: async () => snapshot(stored),
    save: async (request) => {
      calls.push(request);
      if (calls.length === 1) return first.promise;
      if (calls.length === 2) await retirement.promise;
      return apply(request);
    },
  });
  h.state.update(2, "");
  await flush();
  h.state.update(1, "");
  first.reject(Object.assign(new Error("timeout"), { code: "timeout" }));
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(h.state.get("host").emojiId, 1);
  retirement.resolve();
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].emojiId, 1);
  assert.equal(calls[2].expectedRevision, 1);
  assert.notEqual(calls[2].operationId, calls[0].operationId);
  assert.throws(() => apply(calls[0]), { code: "presentation-conflict" });
  h.state.accept(stored);
  assert.deepEqual(
    h.state.get("host"),
    presentation({ emojiId: 1, revision: 2 }),
  );
});

test("repeated uncertain responses do not loop or discard the latest choice", async () => {
  const first = deferred();
  const calls = [];
  let available = false;
  let stored = presentation();
  const h = harness({
    load: async () => snapshot(stored),
    save: async (request) => {
      calls.push(request);
      if (calls.length === 1) return first.promise;
      if (!available)
        throw Object.assign(new Error("timeout"), { code: "timeout" });
      stored = presentation({
        emojiId: request.emojiId,
        aura: request.aura,
        revision: request.expectedRevision + 1,
      });
      return stored;
    },
  });
  h.state.update(2, "");
  await flush();
  h.state.update(1, "");
  first.reject(Object.assign(new Error("timeout"), { code: "timeout" }));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(h.state.get("host").emojiId, 1);
  await flush();
  assert.equal(calls.length, 2);
  available = true;
  await h.state.refresh();
  await flush();
  assert.deepEqual(calls[2], calls[0]);
  assert.equal(calls[3].emojiId, 1);
  assert.equal(h.state.get("host").emojiId, 1);
  assert.equal(h.state.get("host").revision, 2);
});

test("an unchanged reconnect snapshot resumes the parked operation and newest choice", async () => {
  const first = deferred();
  const calls = [];
  let available = false;
  let stored = presentation();
  let reads = 0;
  const h = harness({
    load: async () => {
      reads++;
      return snapshot(stored);
    },
    save: async (request) => {
      calls.push(request);
      if (calls.length === 1) return first.promise;
      if (!available)
        throw Object.assign(new Error("timeout"), { code: "timeout" });
      assert.equal(request.expectedRevision, stored.revision);
      stored = presentation({
        emojiId: request.emojiId,
        aura: request.aura,
        revision: stored.revision + 1,
      });
      return stored;
    },
  });
  h.state.update(2, "");
  await flush();
  h.state.update(3, "");
  first.reject(Object.assign(new Error("timeout"), { code: "timeout" }));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(stored.emojiId, 1);
  assert.equal(h.state.get("host").emojiId, 3);

  available = true;
  h.state.acceptSnapshot({ matchId: "other", players: {} });
  h.state.acceptSnapshot(snapshot(presentation({ revision: -1 })));
  await flush();
  assert.equal(calls.length, 2);

  const readsBeforeReconnect = reads;
  h.state.acceptSnapshot(snapshot(stored));
  await flush();
  assert.equal(reads, readsBeforeReconnect);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2], calls[0]);
  assert.equal(calls[3].emojiId, 3);
  assert.equal(calls[3].expectedRevision, 1);
  assert.notEqual(calls[3].operationId, calls[0].operationId);
  assert.deepEqual(stored, presentation({ emojiId: 3, revision: 2 }));
  assert.deepEqual(h.state.get("host"), stored);

  h.state.stop();
  h.state.acceptSnapshot(snapshot(stored));
  await flush();
  assert.equal(calls.length, 4);
});

for (const wake of [
  "refresh",
  "selection during retry",
  "selection during read",
]) {
  test(`${wake} is preserved while an uncertain retry is draining`, async () => {
    const first = deferred();
    const retry = deferred();
    const foregroundRead = deferred();
    const calls = [];
    let holdRead = false;
    let stored = presentation();
    const h = harness({
      load: async () => {
        if (holdRead) {
          holdRead = false;
          return foregroundRead.promise;
        }
        return snapshot(stored);
      },
      save: async (request) => {
        calls.push(request);
        if (calls.length === 1) return first.promise;
        if (calls.length === 2) return retry.promise;
        assert.equal(request.expectedRevision, stored.revision);
        stored = presentation({
          emojiId: request.emojiId,
          aura: request.aura,
          revision: stored.revision + 1,
        });
        return stored;
      },
    });
    h.state.update(2, "");
    await flush();
    h.state.update(3, "");
    first.reject(new Error("timeout"));
    await flush();
    assert.equal(calls.length, 2);

    holdRead = true;
    const refreshing = wake === "refresh" ? h.state.refresh() : null;
    if (wake === "selection during retry") h.state.update(4, "");
    retry.reject(new Error("timeout"));
    await flush();
    if (wake === "selection during read") h.state.update(4, "");
    foregroundRead.resolve(snapshot(stored));
    await refreshing;
    await flush();

    const desiredEmoji = wake === "refresh" ? 3 : 4;
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[2], calls[0]);
    assert.equal(calls[3].expectedRevision, 1);
    assert.equal(calls[3].emojiId, desiredEmoji);
    assert.deepEqual(
      stored,
      presentation({ emojiId: desiredEmoji, revision: 2 }),
    );
    assert.deepEqual(h.state.get("host"), stored);
    await flush();
    assert.equal(calls.length, 4);
    h.state.stop();
  });
}

test("a selection wake preserves the fresh-read requirement and does not create a retry loop", async () => {
  const first = deferred();
  const retry = deferred();
  const calls = [];
  let reads = 0;
  let available = false;
  let stored = presentation();
  const h = harness({
    load: async () => {
      if (++reads >= 3 && !available) throw new Error("offline");
      return snapshot(stored);
    },
    save: async (request) => {
      calls.push(request);
      if (calls.length === 1) return first.promise;
      if (calls.length === 2) return retry.promise;
      assert.equal(available, true);
      stored = presentation({
        emojiId: request.emojiId,
        revision: request.expectedRevision + 1,
      });
      return stored;
    },
  });
  h.state.update(2, "");
  await flush();
  h.state.update(3, "");
  first.reject(new Error("timeout"));
  await flush();
  h.state.update(4, "");
  retry.reject(new Error("timeout"));
  await flush();
  assert.equal(reads, 4);
  assert.equal(calls.length, 2);
  assert.equal(h.state.get("host").emojiId, 4);
  await flush();
  assert.equal(reads, 4);

  available = true;
  await h.state.refresh();
  await flush();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2], calls[0]);
  assert.equal(stored.emojiId, 4);
  h.state.stop();
});

for (const recovery of ["unchanged snapshot", "advanced snapshot", "event"]) {
  for (const failedAttempt of [1, 2]) {
    test(`${recovery} survives a failing reconciliation after uncertain attempt ${failedAttempt}`, async () => {
      const first = deferred();
      const staleRead = deferred();
      const calls = [];
      let reads = 0;
      let available = false;
      let stored = presentation();
      const h = harness({
        load: async () =>
          ++reads === failedAttempt + 1 ? staleRead.promise : snapshot(stored),
        save: async (request) => {
          calls.push(request);
          if (calls.length === 1) return first.promise;
          if (!available) throw new Error("timeout");
          assert.equal(request.expectedRevision, stored.revision);
          stored = presentation({
            emojiId: request.emojiId,
            aura: request.aura,
            revision: stored.revision + 1,
          });
          return stored;
        },
      });
      h.state.update(2, "");
      await flush();
      h.state.update(3, "");
      first.reject(new Error("timeout"));
      await flush();
      assert.equal(calls.length, failedAttempt);
      assert.equal(reads, failedAttempt + 1);

      available = true;
      if (recovery !== "unchanged snapshot")
        stored = presentation({ emojiId: 2, revision: 1 });
      if (recovery === "event") h.state.accept(stored);
      else h.state.acceptSnapshot(snapshot(stored));
      staleRead.reject(new Error("stale-read-failed"));
      await flush();

      const recoveredCalls = calls.slice(failedAttempt);
      if (recovery === "unchanged snapshot") {
        assert.equal(recoveredCalls.length, 2);
        assert.deepEqual(recoveredCalls[0], calls[0]);
      } else {
        assert.equal(recoveredCalls.length, 1);
      }
      assert.equal(recoveredCalls.at(-1).expectedRevision, 1);
      assert.equal(recoveredCalls.at(-1).emojiId, 3);
      assert.deepEqual(stored, presentation({ emojiId: 3, revision: 2 }));
      assert.deepEqual(h.state.get("host"), stored);
      h.state.stop();
    });
  }
}

test("socket recovery received before reconciliation starts is not lost when that read fails", async () => {
  const first = deferred();
  const calls = [];
  let reads = 0;
  let stored = presentation();
  const h = harness({
    load: async () => {
      if (++reads > 1) throw new Error("reconciliation-unavailable");
      return snapshot(stored);
    },
    save: async (request) => {
      calls.push(request);
      if (calls.length === 1) return first.promise;
      assert.equal(request.expectedRevision, stored.revision);
      stored = presentation({
        emojiId: request.emojiId,
        revision: stored.revision + 1,
      });
      return stored;
    },
  });
  h.state.update(2, "");
  await flush();
  h.state.update(3, "");
  h.state.acceptSnapshot(snapshot(stored));
  first.reject(new Error("timeout"));
  await flush();
  assert.equal(reads, 2);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(stored, presentation({ emojiId: 3, revision: 2 }));
  assert.deepEqual(h.state.get("host"), stored);
  h.state.stop();
});

test("timeout reconciliation starts a fresh read after an older overlapping refresh completes", async () => {
  const failedSave = deferred();
  const oldRefresh = deferred();
  let loads = 0;
  const calls = [];
  const h = harness({
    load: async () => {
      loads++;
      if (loads === 1) return snapshot(presentation());
      if (loads === 2) return oldRefresh.promise;
      return snapshot(presentation({ emojiId: 2, revision: 1 }));
    },
    save: async (request) => {
      calls.push(request);
      if (calls.length === 1) return failedSave.promise;
      return presentation({
        emojiId: request.emojiId,
        revision: request.expectedRevision + 1,
      });
    },
  });
  h.state.update(2, "");
  await flush();
  const waking = h.state.refresh();
  h.state.update(3, "");
  failedSave.reject(Object.assign(new Error("timeout"), { code: "timeout" }));
  await flush();
  assert.equal(loads, 2);
  oldRefresh.resolve(snapshot(presentation()));
  await waking;
  await flush();
  assert.equal(loads, 3);
  assert.deepEqual(
    calls.map((request) => request.expectedRevision),
    [0, 1],
  );
  assert.equal(h.state.get("host").emojiId, 3);
  assert.equal(h.state.get("host").revision, 2);
});

test("teardown aborts work and discards queued choices, late responses, and retained state", async () => {
  const first = deferred();
  const signals = [];
  const h = harness({
    save: async (_request, signal) => {
      signals.push(signal);
      return first.promise;
    },
  });
  h.state.update(2, "");
  await flush();
  h.state.update(3, "");
  h.state.stop();
  const changeCount = h.changes.length;
  first.resolve(presentation({ emojiId: 2, revision: 1 }));
  await flush();
  assert.equal(signals[0].aborted, true);
  assert.equal(h.changes.length, changeCount);
  assert.equal(h.state.get("host"), null);
});

test("read-only spectators hydrate but cannot submit cosmetic changes", async () => {
  const h = harness({ actorUid: null });
  await h.state.refresh();
  h.state.update(2, "");
  await flush();
  assert.deepEqual(h.state.get("host"), presentation());
  assert.equal(h.saves.length, 0);
});

test("deduplicates overlapping HTTP hydration and preserves a newer socket revision", async () => {
  const pending = deferred();
  let loads = 0;
  const h = harness({
    load: () => {
      loads++;
      return pending.promise;
    },
  });
  const first = h.state.refresh();
  const second = h.state.refresh();
  h.state.accept(presentation({ emojiId: 7, revision: 4 }));
  pending.resolve(snapshot(presentation()));
  await Promise.all([first, second]);
  assert.equal(loads, 1);
  assert.equal(h.state.get("host").revision, 4);
});
