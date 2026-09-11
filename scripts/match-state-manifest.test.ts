import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "./operator/runtime.ts";
import { matchStateDigest } from "../cloud/workers/api/src/matchStateMigration.ts";
import {
  assertSameMatchStateSource,
  buildMatchStateBundle,
  buildMatchStateManifest,
  matchRecordPath,
  validateMatchStateManifest,
  type MatchStateInventory,
} from "./match-state-manifest.ts";

const input = {
  importId: "import",
  epoch: 2,
  candidateVersionId: "00000000-0000-4000-8000-000000000001",
  freezeGeneration: 1,
};
function inventory(): MatchStateInventory {
  return {
    records: [
      {
        actorUid: "host",
        matchId: "game",
        value: {
          color: "white",
          fen: "fen",
          timer: "5;123456",
          extra: { retained: true },
        },
      },
      { actorUid: "orphan", matchId: "gone", value: 7 },
    ],
    claims: [],
    invites: [
      {
        inviteId: "game",
        value: { hostId: "host", guestId: "guest" },
        revision: 1,
      },
      { inviteId: "empty", value: { hostId: "host" }, revision: 1 },
    ],
    discovery: [
      {
        actorUid: "host",
        matchId: "game",
        inviteId: "game",
        resolution: "resolved",
      },
      {
        actorUid: "orphan",
        matchId: "gone",
        inviteId: null,
        resolution: "missing",
      },
    ],
    crossChecks: { timerMarkers: [] },
  };
}

test("manifest retains orphan raw values and includes empty canonical rooms", () => {
  const source = inventory();
  const manifest = buildMatchStateManifest(source, input);
  assert.equal(
    manifest.records.find((row) => row.actorUid === "orphan")?.disposition,
    "malformed",
  );
  const read = (path: string) =>
    source.records.find((row) => matchRecordPath(row) === path)?.value;
  const room = buildMatchStateBundle(manifest, "game", read);
  assert.equal(room.records[0].value.timer, "5;123456");
  assert.deepEqual(room.records[0].value.extra, { retained: true });
  assert.equal(
    room.digest,
    digest({
      inviteId: "game",
      epoch: 2,
      importId: "import",
      records: room.records,
      claims: [],
    }),
  );
  assert.equal(buildMatchStateBundle(manifest, "empty", read).recordCount, 0);
});

test("inventory ordering does not change the content manifest", () => {
  const source = inventory();
  const before = buildMatchStateManifest(source, input);
  source.records.reverse();
  source.invites.reverse();
  source.discovery.reverse();
  assert.deepEqual(buildMatchStateManifest(source, input), before);
});

test("duplicate source keys and unresolved playable mappings block import", () => {
  const source = inventory();
  source.records.push(source.records[0]);
  assert.throws(() => buildMatchStateManifest(source, input), /duplicate/);
  source.records.pop();
  source.discovery[0].resolution = "ambiguous";
  source.discovery[0].inviteId = null;
  assert.throws(
    () => buildMatchStateManifest(source, input),
    /unresolved-playable/,
  );
});

test("conflicting discovery and malformed playable records fail closed", () => {
  const source = inventory();
  source.discovery[0].inviteId = "empty";
  assert.throws(
    () => buildMatchStateManifest(source, input),
    /mapping-conflict/,
  );
  source.discovery[0].inviteId = "game";
  source.records[0].value = 7;
  assert.throws(
    () => buildMatchStateManifest(source, input),
    /malformed-playable/,
  );
});

test("pending claimed-game fences require explicit recovery, deadlines remain exact", () => {
  const source = inventory();
  source.claims.push({
    matchId: "game",
    value: {
      inviteId: "game",
      playerId: "host",
      opponentId: "guest",
      status: "pending",
      timer: "5;123456",
      expiresAtMs: 1,
    },
  });
  assert.throws(() => buildMatchStateManifest(source, input), /pending-claim/);
  (source.claims[0].value as Record<string, unknown>).status = "claimed";
  const manifest = buildMatchStateManifest(source, input);
  assert.equal(manifest.claims[0].digest, digest(source.claims[0].value));
});

test("modified manifests and source changes invalidate verification", () => {
  const source = inventory();
  const original = buildMatchStateManifest(source, input);
  assert.deepEqual(validateMatchStateManifest(original), original);
  assert.throws(
    () => validateMatchStateManifest({ ...original, records: [] }),
    /digest-conflict/,
  );
  (source.records[0].value as Record<string, unknown>).fen = "changed";
  assert.throws(
    () =>
      assertSameMatchStateSource(
        original,
        buildMatchStateManifest(source, input),
      ),
    /source-changed/,
  );
});

test("a stale invite field on an unreferenced claim remains legacy evidence", () => {
  const source = inventory();
  source.claims.push({
    matchId: "orphan",
    value: {
      inviteId: "game",
      playerId: "host",
      opponentId: "guest",
      status: "claimed",
    },
  });
  const manifest = buildMatchStateManifest(source, input);
  assert.equal(manifest.claims[0].inviteId, null);
  assert.equal(manifest.claims[0].disposition, "unreferenced-claim");
});

test("one Firebase timer fence cannot silently split across multiple invites", () => {
  const source = inventory();
  source.invites.push({
    inviteId: "series",
    value: { hostId: "a", guestId: "b", hostRematches: "1" },
    revision: 1,
  });
  source.invites.push({
    inviteId: "series1",
    value: { hostId: "c", guestId: "d" },
    revision: 1,
  });
  source.claims.push({
    matchId: "series1",
    value: {
      inviteId: "series1",
      playerId: "c",
      opponentId: "d",
      status: "claimed",
    },
  });
  assert.throws(
    () => buildMatchStateManifest(source, input),
    /shared-by-multiple/,
  );
});

test("bundle digests preserve the shared canonical ordering for numeric object keys", async () => {
  const source = inventory();
  (source.records[0].value as Record<string, unknown>).unknown = {
    "2": "two",
    "10": "ten",
  };
  const manifest = buildMatchStateManifest(source, input);
  const bundle = buildMatchStateBundle(
    manifest,
    "game",
    (path) =>
      source.records.find((row) => matchRecordPath(row) === path)?.value,
  );
  assert.equal(
    bundle.digest,
    await matchStateDigest({
      inviteId: bundle.inviteId,
      epoch: bundle.epoch,
      importId: bundle.importId,
      records: bundle.records,
      claims: bundle.claims,
    }),
  );
});

test("retained resolved discovery for a nonparticipant stays read-only without rewriting discovery", () => {
  const source = inventory();
  source.records.push({
    actorUid: "previous-host",
    matchId: "game",
    value: { fen: "retained", timer: "gg" },
  });
  source.discovery.push({
    actorUid: "previous-host",
    matchId: "game",
    inviteId: "game",
    resolution: "resolved",
  });
  const before = structuredClone(source.discovery);
  const manifest = buildMatchStateManifest(source, input);
  assert.deepEqual(
    manifest.records.find((row) => row.actorUid === "previous-host"),
    {
      actorUid: "previous-host",
      matchId: "game",
      inviteId: null,
      disposition: "nonparticipant",
      digest: digest(source.records[2].value),
    },
  );
  assert.deepEqual(source.discovery, before);
});
