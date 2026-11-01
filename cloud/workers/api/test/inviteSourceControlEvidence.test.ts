import assert from "node:assert/strict";
import test from "node:test";
import {
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
} from "../src/inviteSourceD1.ts";

test("business control reads exclude archived migration metadata and never decode it", () => {
  const row = {
    backend: "d1",
    state: "active",
    epoch: 1,
    freeze_generation: 4,
    candidate_version_id: "candidate",
    source_digest: null,
    import_digest: null,
    verified_at_ms: 1,
    activated_at_ms: 2,
  };
  Object.defineProperty(row, "metadata_json", {
    get() {
      throw new Error("archived-evidence-is-not-business-state");
    },
  });
  const control = parseInviteSourceControlRow(row);
  assert.equal(Object.hasOwn(control, "metadata"), false);
  let query = "";
  prepareInviteSourceControlRead({
    prepare(sql) {
      query = sql;
      return null as never;
    },
  });
  assert.equal(query.includes("metadata_json"), false);
  assert.equal(query.includes("SELECT *"), false);
});
