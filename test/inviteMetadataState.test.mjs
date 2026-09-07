import assert from "node:assert/strict";
import test from "node:test";
import { InviteMetadataState } from "../src/connection/inviteMetadataState.ts";

const snapshot = (overrides = {}) => ({
  inviteId: "invite",
  revision: 1,
  hostId: "host",
  guestId: "guest",
  hostColor: "white",
  hostRematches: "",
  guestRematches: "",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
  ...overrides,
});

test("drops snapshots from old revisions, other invites and different hosts", () => {
  const initial = snapshot({ revision: 5 });
  const state = new InviteMetadataState(initial);
  for (const other of [
    snapshot({ revision: 4, hostRematches: "1" }),
    snapshot({ revision: 6, inviteId: "other" }),
    snapshot({ revision: 6, hostId: "other" }),
  ]) {
    assert.equal(state.accept(other), false);
    assert.deepEqual(state.snapshot, initial);
  }
});

test("confirmed local proposals survive stale snapshots while the other side advances", () => {
  const state = new InviteMetadataState(snapshot());
  state.confirmRematches("host", "1");
  state.accept(snapshot({ revision: 2, guestRematches: "1" }));
  assert.equal(state.snapshot.hostRematches, "1");
  assert.equal(state.snapshot.guestRematches, "1");
  state.accept(
    snapshot({ revision: 3, hostRematches: "1", guestRematches: "1" }),
  );
  assert.equal(state.snapshot.revision, 3);
  state.accept(
    snapshot({ revision: 4, hostRematches: "1;2", guestRematches: "1" }),
  );
  assert.equal(state.snapshot.hostRematches, "1;2");
});

test("rematch monotonicity compares complete indices instead of string prefixes", () => {
  const state = new InviteMetadataState(snapshot({ hostRematches: "1" }));
  state.accept(snapshot({ revision: 2, hostRematches: "10" }));
  assert.equal(state.snapshot.hostRematches, "1");
  state.accept(snapshot({ revision: 3, hostRematches: "1;10" }));
  assert.equal(state.snapshot.hostRematches, "1;10");
  state.accept(snapshot({ revision: 4, hostRematches: "1;2" }));
  assert.equal(state.snapshot.hostRematches, "1;10");
});

test("series end stays closed and accepts the canonical end marker on either side", () => {
  for (const actor of ["host", "guest"]) {
    const state = new InviteMetadataState(
      snapshot({ hostRematches: "1", guestRematches: "1" }),
    );
    state.confirmRematches(actor, "1x");
    state.accept(
      snapshot({ revision: 2, hostRematches: "1", guestRematches: "1" }),
    );
    assert.equal(state.snapshot[`${actor}Rematches`], "1x");
    const canonical = snapshot({
      revision: 3,
      hostRematches: actor === "guest" ? "1x" : "1",
      guestRematches: actor === "host" ? "1x" : "1",
    });
    state.accept(canonical);
    assert.deepEqual(state.snapshot, canonical);
    state.accept(
      snapshot({ revision: 4, hostRematches: "1", guestRematches: "1" }),
    );
    assert.ok(
      state.snapshot.hostRematches.endsWith("x") ||
        state.snapshot.guestRematches.endsWith("x"),
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
  const state = new InviteMetadataState(snapshot({ hostRematches: "1" }));
  state.confirmRematches("host", "x");
  assert.equal(state.snapshot.hostRematches, "1x");
  state.accept(
    snapshot({ revision: 2, hostRematches: "1", guestRematches: "x" }),
  );
  assert.equal(state.snapshot.hostRematches, "1");
  assert.equal(state.snapshot.guestRematches, "x");
});

test("callers cannot mutate metadata state through its input or snapshot getter", () => {
  const initial = snapshot();
  const state = new InviteMetadataState(initial);
  initial.hostRematches = "1";
  const copy = state.snapshot;
  copy.hostRematches = "2";
  state.confirmRematches("unrelated-login", "3");
  assert.equal(state.snapshot.hostRematches, "");
});
