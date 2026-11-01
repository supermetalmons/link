import assert from "node:assert/strict";
import test from "node:test";
import { InviteMetadataState } from "../src/connection/inviteMetadataState.ts";

/**
 * @param {Partial<import("@mons/shared/invite-metadata").InviteMetadataSnapshot>} [overrides]
 * @returns {import("@mons/shared/invite-metadata").InviteMetadataSnapshot}
 */
const snapshot = (overrides = {}) => ({
  inviteId: "invite",
  revision: 1,
  hostId: "host",
  guestId: "guest",
  hostColor: "white",
  hostRematches: { state: "open", indices: [] },
  guestRematches: { state: "open", indices: [] },
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
  ...overrides,
});

test("drops snapshots from old revisions, other invites and different hosts", () => {
  const initial = snapshot({ revision: 5 });
  const state = new InviteMetadataState(initial);
  for (const other of [
    snapshot({ revision: 4, hostRematches: { state: "open", indices: [1] } }),
    snapshot({ revision: 6, inviteId: "other" }),
    snapshot({ revision: 6, hostId: "other" }),
  ]) {
    assert.equal(state.accept(other), false);
    assert.deepEqual(state.snapshot, initial);
  }
});

test("confirmed local proposals survive stale snapshots while the other side advances", () => {
  const state = new InviteMetadataState(snapshot());
  state.confirmRematches("host", { state: "open", indices: [1] });
  state.accept(
    snapshot({ revision: 2, guestRematches: { state: "open", indices: [1] } }),
  );
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "open",
    indices: [1],
  });
  assert.deepEqual(state.snapshot.guestRematches, {
    state: "open",
    indices: [1],
  });
  state.accept(
    snapshot({
      revision: 3,
      hostRematches: { state: "open", indices: [1] },
      guestRematches: { state: "open", indices: [1] },
    }),
  );
  assert.equal(state.snapshot.revision, 3);
  state.accept(
    snapshot({
      revision: 4,
      hostRematches: { state: "open", indices: [1, 2] },
      guestRematches: { state: "open", indices: [1] },
    }),
  );
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "open",
    indices: [1, 2],
  });
});

test("rematch monotonicity compares complete indices instead of string prefixes", () => {
  const state = new InviteMetadataState(
    snapshot({ hostRematches: { state: "open", indices: [1] } }),
  );
  state.accept(
    snapshot({ revision: 2, hostRematches: { state: "open", indices: [10] } }),
  );
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "open",
    indices: [1],
  });
  state.accept(
    snapshot({
      revision: 3,
      hostRematches: { state: "open", indices: [1, 10] },
    }),
  );
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "open",
    indices: [1, 10],
  });
  state.accept(
    snapshot({
      revision: 4,
      hostRematches: { state: "open", indices: [1, 2] },
    }),
  );
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "open",
    indices: [1, 10],
  });
});

test("series end stays closed and accepts the canonical end marker on either side", () => {
  for (const actor of /** @type {const} */ (["host", "guest"])) {
    const state = new InviteMetadataState(
      snapshot({
        hostRematches: { state: "open", indices: [1] },
        guestRematches: { state: "open", indices: [1] },
      }),
    );
    state.confirmRematches(actor, { state: "ended", indices: [1] });
    state.accept(
      snapshot({
        revision: 2,
        hostRematches: { state: "open", indices: [1] },
        guestRematches: { state: "open", indices: [1] },
      }),
    );
    assert.deepEqual(state.snapshot[`${actor}Rematches`], {
      state: "ended",
      indices: [1],
    });
    const canonical = snapshot({
      revision: 3,
      hostRematches:
        actor === "guest"
          ? { state: "ended", indices: [1] }
          : { state: "open", indices: [1] },
      guestRematches:
        actor === "host"
          ? { state: "ended", indices: [1] }
          : { state: "open", indices: [1] },
    });
    state.accept(canonical);
    assert.deepEqual(state.snapshot, canonical);
    state.accept(
      snapshot({
        revision: 4,
        hostRematches: { state: "open", indices: [1] },
        guestRematches: { state: "open", indices: [1] },
      }),
    );
    assert.ok(
      state.snapshot.hostRematches.state === "ended" ||
        state.snapshot.guestRematches.state === "ended",
    );
  }
});

test("a joined guest cannot disappear when a cancellation snapshot arrives late", () => {
  const state = new InviteMetadataState(
    snapshot({ guestId: null, automatchStateHint: "pending" }),
  );
  state.accept(snapshot({ revision: 2, automatchStateHint: "matched" }));
  state.accept(
    snapshot({ revision: 3, guestId: null, automatchStateHint: "canceled" }),
  );
  assert.equal(state.snapshot.guestId, "guest");
});

test("an end response establishes the ended floor even if its indices precede a confirmed proposal", () => {
  const state = new InviteMetadataState(
    snapshot({ hostRematches: { state: "open", indices: [1] } }),
  );
  state.confirmRematches("host", { state: "ended", indices: [] });
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "ended",
    indices: [1],
  });
  state.accept(
    snapshot({
      revision: 2,
      hostRematches: { state: "open", indices: [1] },
      guestRematches: { state: "ended", indices: [] },
    }),
  );
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "open",
    indices: [1],
  });
  assert.deepEqual(state.snapshot.guestRematches, {
    state: "ended",
    indices: [],
  });
});

test("callers cannot mutate metadata state through its input or snapshot getter", () => {
  const initial = snapshot();
  const state = new InviteMetadataState(initial);
  initial.hostRematches = { state: "open", indices: [1] };
  const copy = state.snapshot;
  copy.hostRematches = { state: "open", indices: [2] };
  state.confirmRematches("unrelated-login", { state: "open", indices: [3] });
  assert.deepEqual(state.snapshot.hostRematches, {
    state: "open",
    indices: [],
  });
});
