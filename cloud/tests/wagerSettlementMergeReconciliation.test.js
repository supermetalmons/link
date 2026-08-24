"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { admin } = require("../admin/_admin");
const {
  DEFAULT_LIMIT,
  MAX_INCOMING_MERGE_TARGETS,
  MAX_LIMIT,
  compareTimestamps,
  parseArgs,
  reconcileWagerSettlementDocument,
  reconcileWagerSettlementPage,
  reconcileWagerSettlementResolution,
} = require("../admin/reconcileWagerSettlementMerges");

const timestamp = (seconds, nanoseconds = 0) => ({ seconds, nanoseconds });

const createFirestore = (initialRecords) => {
  const records = new Map(
    Object.entries(initialRecords).map(([path, value]) => [
      path,
      {
        createTime: value.createTime || timestamp(1),
        data: structuredClone(value.data || {}),
      },
    ]),
  );
  const updateCalls = [];
  const ref = (path) => ({ id: path.split("/").at(-1), path });
  const snapshot = (documentRef) => {
    const record = records.get(documentRef.path);
    return {
      createTime: record?.createTime,
      data: () => structuredClone(record?.data || {}),
      exists: Boolean(record),
      id: documentRef.id,
      ref: documentRef,
    };
  };
  const applyUpdate = (documentRef, patch) => {
    const record = records.get(documentRef.path);
    if (!record) {
      throw new Error(`missing document: ${documentRef.path}`);
    }
    for (const [path, value] of Object.entries(patch)) {
      const segments = path.split(".");
      let target = record.data;
      for (const segment of segments.slice(0, -1)) {
        target[segment] ||= {};
        target = target[segment];
      }
      const field = segments.at(-1);
      target[field] =
        value && typeof value === "object" && "increment" in value
          ? (target[field] || 0) + value.increment
          : value;
    }
  };
  const firestore = {
    collection: (collectionName) => ({
      doc: (id) => ref(`${collectionName}/${id}`),
      orderBy: () => {
        const queryState = { after: "", limit: Infinity };
        const query = {
          get: async () => {
            const docs = Array.from(records.keys())
              .filter((path) => path.startsWith(`${collectionName}/`))
              .map(ref)
              .filter((documentRef) => documentRef.id > queryState.after)
              .sort((left, right) => left.id.localeCompare(right.id))
              .slice(0, queryState.limit)
              .map(snapshot);
            return { docs, empty: docs.length === 0, size: docs.length };
          },
          limit: (value) => {
            queryState.limit = value;
            return query;
          },
          startAfter: (value) => {
            queryState.after = value;
            return query;
          },
        };
        return query;
      },
      where: (field, operator, value) => {
        const queryState = { limit: Infinity };
        const query = {
          execute: () => {
            assert.equal(operator, "==");
            const docs = Array.from(records.keys())
              .filter((path) => path.startsWith(`${collectionName}/`))
              .map(ref)
              .map(snapshot)
              .filter((document) => document.data()[field] === value)
              .sort((left, right) => left.id.localeCompare(right.id))
              .slice(0, queryState.limit);
            return { docs, empty: docs.length === 0, size: docs.length };
          },
          limit: (queryLimit) => {
            queryState.limit = queryLimit;
            return query;
          },
        };
        return query;
      },
    }),
    runTransaction: async (handler) => {
      const pendingUpdates = [];
      const transaction = {
        get: async (value) =>
          typeof value.execute === "function"
            ? value.execute()
            : snapshot(value),
        update: (documentRef, patch) => {
          pendingUpdates.push({ documentRef, patch });
        },
      };
      const result = await handler(transaction);
      for (const update of pendingUpdates) {
        updateCalls.push(update);
        applyUpdate(update.documentRef, update.patch);
      }
      return result;
    },
  };
  return {
    firestore,
    read: (path) => structuredClone(records.get(path)?.data),
    ref,
    updateCalls,
  };
};

const ledger = (operationId, overrides = {}) => ({
  count: 2,
  fingerprint: `${operationId}-fingerprint`,
  loserProfileId: `${operationId}-loser`,
  material: "dust",
  operationId,
  winnerProfileId: `${operationId}-winner`,
  ...overrides,
});

test("admin fallback exposes Firestore increments", () => {
  assert.equal(typeof admin.firestore.FieldValue.increment, "function");
});

test("wager reconciliation CLI is bounded and dry-run by default", () => {
  assert.deepEqual(parseArgs([]), {
    adminArgs: [],
    after: "",
    dryRun: true,
    limit: DEFAULT_LIMIT,
  });
  assert.deepEqual(
    parseArgs([
      "--project",
      "mons-link",
      "--after",
      "operation-20",
      "--limit",
      String(MAX_LIMIT),
      "--execute",
    ]),
    {
      adminArgs: ["--project", "mons-link"],
      after: "operation-20",
      dryRun: false,
      limit: MAX_LIMIT,
    },
  );
  assert.deepEqual(
    parseArgs([
      "--project",
      "mons-link",
      "--resolve",
      "operation-20",
      "--winner",
      "lost",
      "--loser",
      "included",
    ]),
    {
      adminArgs: ["--project", "mons-link"],
      decisions: { loser: "included", winner: "lost" },
      dryRun: true,
      operationId: "operation-20",
    },
  );
  for (const argv of [
    ["--limit", "0"],
    ["--limit", String(MAX_LIMIT + 1)],
    ["--after"],
    ["--execute", "--dry-run"],
    ["--project", "one", "--project", "two"],
    ["--resolve", "operation"],
    ["--resolve", "operation", "--winner", "unknown"],
    ["--resolve", "operation", "--winner", "lost", "--limit", "1"],
    ["--resolve", "operation", "--winner", "lost", "--after", "other"],
    ["--winner", "lost"],
    ["--after", "nested/path/id"],
    ["--resolve", " nested ", "--winner", "lost"],
    ["--resolve", "__reserved__", "--winner", "lost"],
    ["--resolve", "\ud800", "--winner", "lost"],
    ["--resolve", "x".repeat(1_501), "--winner", "lost"],
  ]) {
    assert.throws(() => parseArgs(argv), /Usage/);
  }
});

test("timestamp comparisons retain nanosecond ordering", () => {
  assert.equal(compareTimestamps(timestamp(10), timestamp(9, 999_999_999)), 1);
  assert.equal(compareTimestamps(timestamp(10, 2), timestamp(10, 1)), 1);
  assert.equal(compareTimestamps(timestamp(10, 1), timestamp(10, 1)), 0);
});

test("repairs only a side settled after its original merge marker", async () => {
  const memory = createFirestore({
    "profileMergeTargets/source-winner": {
      createTime: timestamp(10),
      data: { targetProfileId: "middle" },
    },
    "profileMergeTargets/middle": {
      createTime: timestamp(30),
      data: { targetProfileId: "canonical" },
    },
    "profileMergeTargets/source-loser": {
      createTime: timestamp(25),
      data: { targetProfileId: "canonical" },
    },
    "users/canonical": {
      data: { mining: { materials: { dust: 8 } } },
    },
    "wagerSettlements/operation": {
      createTime: timestamp(20),
      data: ledger("operation", {
        loserProfileId: "source-loser",
        winnerProfileId: "source-winner",
      }),
    },
  });

  assert.deepEqual(
    await reconcileWagerSettlementDocument(
      {
        dryRun: false,
        firestore: memory.firestore,
        ledgerRef: memory.ref("wagerSettlements/operation"),
      },
      { increment: (count) => ({ increment: count }) },
    ),
    {
      action: "partially-repaired",
      deltas: [{ profileId: "canonical", count: 2 }],
      loser: {
        canonicalProfileId: "canonical",
        repairRequired: false,
        repaired: false,
        reviewRequired: true,
      },
      operationId: "operation",
      winner: {
        canonicalProfileId: "canonical",
        repairRequired: true,
        repaired: false,
        reviewRequired: false,
      },
    },
  );
  assert.equal(memory.read("users/canonical").mining.materials.dust, 10);
  assert.deepEqual(memory.read("wagerSettlements/operation"), {
    ...ledger("operation", {
      loserProfileId: "source-loser",
      winnerProfileId: "source-winner",
    }),
    profileMergeWinnerCanonicalProfileId: "canonical",
    profileMergeWinnerRepairVersion: 1,
  });

  const updateCount = memory.updateCalls.length;
  assert.deepEqual(
    await reconcileWagerSettlementDocument(
      {
        dryRun: false,
        firestore: memory.firestore,
        ledgerRef: memory.ref("wagerSettlements/operation"),
      },
      { increment: (count) => ({ increment: count }) },
    ),
    {
      action: "manual-review",
      deltas: [],
      loser: {
        canonicalProfileId: "canonical",
        repairRequired: false,
        repaired: false,
        reviewRequired: true,
      },
      operationId: "operation",
      winner: {
        canonicalProfileId: "canonical",
        repairRequired: false,
        repaired: true,
        reviewRequired: false,
      },
    },
  );
  assert.equal(memory.updateCalls.length, updateCount);
  assert.equal(memory.read("users/canonical").mining.materials.dust, 10);
});

test("does not reapply a settlement committed before the merge", async () => {
  const memory = createFirestore({
    "profileMergeTargets/before-winner": {
      createTime: timestamp(21),
      data: { targetProfileId: "before-canonical" },
    },
    "users/before-canonical": {
      data: { mining: { materials: { dust: 10 } } },
    },
    "wagerSettlements/before": {
      createTime: timestamp(20),
      data: ledger("before"),
    },
  });
  const result = await reconcileWagerSettlementDocument(
    {
      dryRun: false,
      firestore: memory.firestore,
      ledgerRef: memory.ref("wagerSettlements/before"),
    },
    { increment: (count) => ({ increment: count }) },
  );
  assert.equal(result.action, "manual-review");
  assert.deepEqual(result.deltas, []);
  assert.equal(memory.read("users/before-canonical").mining.materials.dust, 10);
  assert.equal(memory.updateCalls.length, 0);
});

test("leaves equal ledger and merge timestamps for manual review", async () => {
  const memory = createFirestore({
    "profileMergeTargets/same-winner": {
      createTime: timestamp(20),
      data: { targetProfileId: "same-canonical" },
    },
    "wagerSettlements/same": {
      createTime: timestamp(20),
      data: ledger("same"),
    },
  });
  const result = await reconcileWagerSettlementDocument({
    dryRun: false,
    firestore: memory.firestore,
    ledgerRef: memory.ref("wagerSettlements/same"),
  });
  assert.equal(result.action, "manual-review");
  assert.deepEqual(result.deltas, []);
  assert.equal(memory.updateCalls.length, 0);
  assert.equal(
    memory.read("wagerSettlements/same").profileMergeReconciliationVersion,
    undefined,
  );
});

test("leaves a wager preceding an incoming target merge for manual review", async () => {
  const memory = createFirestore({
    "profileMergeTargets/incoming-source": {
      createTime: timestamp(25),
      data: { targetProfileId: "incoming-target" },
    },
    "wagerSettlements/incoming": {
      createTime: timestamp(20),
      data: ledger("incoming", { winnerProfileId: "incoming-target" }),
    },
  });
  const result = await reconcileWagerSettlementDocument({
    dryRun: false,
    firestore: memory.firestore,
    ledgerRef: memory.ref("wagerSettlements/incoming"),
  });
  assert.equal(result.action, "manual-review");
  assert.equal(result.winner.reviewRequired, true);
  assert.deepEqual(result.deltas, []);
  assert.equal(memory.updateCalls.length, 0);
});

test("resolves both manual decisions atomically after a dry run", async () => {
  const memory = createFirestore({
    "profileMergeTargets/manual-winner": {
      createTime: timestamp(20),
      data: { targetProfileId: "winner-canonical" },
    },
    "profileMergeTargets/manual-loser": {
      createTime: timestamp(20),
      data: { targetProfileId: "loser-canonical" },
    },
    "users/winner-canonical": {
      data: { mining: { materials: { dust: 5 } } },
    },
    "users/loser-canonical": {
      data: { mining: { materials: { dust: 7 } } },
    },
    "wagerSettlements/manual": {
      createTime: timestamp(20),
      data: ledger("manual"),
    },
  });
  const options = {
    decisions: { loser: "included", winner: "lost" },
    operationId: "manual",
  };
  const dependencies = {
    firestore: memory.firestore,
    increment: (count) => ({ increment: count }),
  };

  const preview = await reconcileWagerSettlementResolution(
    { ...options, dryRun: true },
    dependencies,
  );
  assert.equal(preview.dryRun, true);
  assert.equal(preview.action, "would-resolve");
  assert.deepEqual(preview.deltas, [
    { profileId: "winner-canonical", count: 2 },
  ]);
  assert.equal(preview.winner.reviewRequired, false);
  assert.equal(preview.winner.repairRequired, true);
  assert.equal(preview.loser.reviewRequired, false);
  assert.equal(preview.loser.repairRequired, false);
  assert.equal(memory.updateCalls.length, 0);
  assert.equal(memory.read("users/winner-canonical").mining.materials.dust, 5);

  const result = await reconcileWagerSettlementResolution(
    { ...options, dryRun: false },
    dependencies,
  );
  assert.equal(result.dryRun, false);
  assert.equal(result.action, "resolved");
  assert.equal(memory.read("users/winner-canonical").mining.materials.dust, 7);
  assert.equal(memory.read("users/loser-canonical").mining.materials.dust, 7);
  assert.deepEqual(memory.read("wagerSettlements/manual"), {
    ...ledger("manual"),
    profileMergeLoserCanonicalProfileId: "loser-canonical",
    profileMergeLoserRepaired: false,
    profileMergeLoserResolution: "included",
    profileMergeReconciliationVersion: 1,
    profileMergeWinnerCanonicalProfileId: "winner-canonical",
    profileMergeWinnerRepaired: true,
    profileMergeWinnerRepairVersion: 1,
    profileMergeWinnerResolution: "lost",
  });

  const updateCount = memory.updateCalls.length;
  assert.deepEqual(
    await reconcileWagerSettlementResolution(
      { ...options, dryRun: false },
      dependencies,
    ),
    {
      action: "already-reconciled",
      dryRun: false,
      operationId: "manual",
    },
  );
  assert.equal(memory.updateCalls.length, updateCount);
  assert.equal(memory.read("users/winner-canonical").mining.materials.dust, 7);

  await assert.rejects(
    reconcileWagerSettlementResolution(
      {
        ...options,
        decisions: { loser: "lost", winner: "included" },
        dryRun: false,
      },
      dependencies,
    ),
    /resolution decision mismatch/,
  );
  await assert.rejects(
    reconcileWagerSettlementResolution(
      {
        ...options,
        decisions: { winner: "lost" },
        dryRun: false,
      },
      dependencies,
    ),
    /resolution decision mismatch/,
  );
  assert.equal(memory.read("users/winner-canonical").mining.materials.dust, 7);
});

test("manual resolution preserves a prior side repair without reapplying it", async () => {
  const memory = createFirestore({
    "profileMergeTargets/partial-loser": {
      createTime: timestamp(20),
      data: { targetProfileId: "partial-canonical" },
    },
    "users/partial-canonical": {
      data: { mining: { materials: { dust: 10 } } },
    },
    "wagerSettlements/partial": {
      createTime: timestamp(20),
      data: ledger("partial", {
        profileMergeWinnerCanonicalProfileId: "partial-canonical",
        profileMergeWinnerRepairVersion: 1,
      }),
    },
  });
  const input = {
    decisions: { loser: "included" },
    dryRun: false,
    firestore: memory.firestore,
    ledgerRef: memory.ref("wagerSettlements/partial"),
  };

  const result = await reconcileWagerSettlementDocument(input, {
    increment: (count) => ({ increment: count }),
  });
  assert.equal(result.action, "resolved");
  assert.deepEqual(result.deltas, []);
  assert.equal(result.winner.repaired, true);
  assert.deepEqual(
    memory.updateCalls.map((call) => call.documentRef.path),
    ["wagerSettlements/partial"],
  );
  assert.equal(
    memory.read("users/partial-canonical").mining.materials.dust,
    10,
  );
  assert.deepEqual(memory.read("wagerSettlements/partial"), {
    ...ledger("partial", {
      profileMergeWinnerCanonicalProfileId: "partial-canonical",
      profileMergeWinnerRepairVersion: 1,
    }),
    profileMergeLoserCanonicalProfileId: "partial-canonical",
    profileMergeLoserRepaired: false,
    profileMergeLoserResolution: "included",
    profileMergeReconciliationVersion: 1,
    profileMergeWinnerRepaired: true,
  });

  const updateCount = memory.updateCalls.length;
  assert.equal(
    (
      await reconcileWagerSettlementDocument(input, {
        increment: (count) => ({ increment: count }),
      })
    ).action,
    "already-reconciled",
  );
  assert.equal(memory.updateCalls.length, updateCount);
  assert.equal(
    memory.read("users/partial-canonical").mining.materials.dust,
    10,
  );
});

test("verifies a wager committed after every incoming target merge", async () => {
  const memory = createFirestore({
    "profileMergeTargets/earlier-source": {
      createTime: timestamp(10),
      data: { targetProfileId: "settled-target" },
    },
    "wagerSettlements/settled": {
      createTime: timestamp(20),
      data: ledger("settled", { winnerProfileId: "settled-target" }),
    },
  });
  const result = await reconcileWagerSettlementDocument({
    dryRun: false,
    firestore: memory.firestore,
    ledgerRef: memory.ref("wagerSettlements/settled"),
  });
  assert.equal(result.action, "verified");
  assert.equal(result.winner.reviewRequired, false);
  assert.equal(
    memory.read("wagerSettlements/settled").profileMergeReconciliationVersion,
    1,
  );
});

test("fails closed when incoming merge fan-in exceeds the audit bound", async () => {
  const records = {
    "wagerSettlements/fan-in": {
      createTime: timestamp(20),
      data: ledger("fan-in", { winnerProfileId: "fan-in-target" }),
    },
  };
  for (let index = 0; index <= MAX_INCOMING_MERGE_TARGETS; index++) {
    records[`profileMergeTargets/fan-in-${index}`] = {
      createTime: timestamp(10),
      data: { targetProfileId: "fan-in-target" },
    };
  }
  const memory = createFirestore(records);
  await assert.rejects(
    reconcileWagerSettlementDocument({
      dryRun: true,
      firestore: memory.firestore,
      ledgerRef: memory.ref("wagerSettlements/fan-in"),
    }),
    /Too many incoming profile merges/,
  );
  assert.equal(memory.updateCalls.length, 0);
});

test("dry-run detects repair work without changing balances or ledgers", async () => {
  const memory = createFirestore({
    "profileMergeTargets/dry-winner": {
      createTime: timestamp(10),
      data: { targetProfileId: "dry-canonical" },
    },
    "users/dry-canonical": {
      data: { mining: { materials: { dust: 10 } } },
    },
    "wagerSettlements/dry": {
      createTime: timestamp(20),
      data: ledger("dry"),
    },
  });

  const result = await reconcileWagerSettlementDocument(
    {
      dryRun: true,
      firestore: memory.firestore,
      ledgerRef: memory.ref("wagerSettlements/dry"),
    },
    { increment: (count) => ({ increment: count }) },
  );
  assert.equal(result.action, "would-repair");
  assert.deepEqual(result.deltas, [{ profileId: "dry-canonical", count: 2 }]);
  assert.equal(memory.updateCalls.length, 0);
  assert.equal(memory.read("users/dry-canonical").mining.materials.dust, 10);
  assert.equal(
    memory.read("wagerSettlements/dry").profileMergeReconciliationVersion,
    undefined,
  );
});

test("opposite repairs to one canonical profile cancel without a balance write", async () => {
  const memory = createFirestore({
    "profileMergeTargets/cancel-winner": {
      createTime: timestamp(10),
      data: { targetProfileId: "cancel-canonical" },
    },
    "profileMergeTargets/cancel-loser": {
      createTime: timestamp(11),
      data: { targetProfileId: "cancel-canonical" },
    },
    "users/cancel-canonical": {
      data: { mining: { materials: { dust: 10 } } },
    },
    "wagerSettlements/cancel": {
      createTime: timestamp(20),
      data: ledger("cancel"),
    },
  });

  const result = await reconcileWagerSettlementDocument(
    {
      dryRun: false,
      firestore: memory.firestore,
      ledgerRef: memory.ref("wagerSettlements/cancel"),
    },
    { increment: (count) => ({ increment: count }) },
  );
  assert.equal(result.action, "repaired");
  assert.deepEqual(result.deltas, []);
  assert.deepEqual(
    memory.updateCalls.map((call) => call.documentRef.path),
    ["wagerSettlements/cancel"],
  );
  assert.equal(
    memory.read("wagerSettlements/cancel").profileMergeReconciliationVersion,
    1,
  );
  assert.deepEqual(
    await reconcileWagerSettlementDocument(
      {
        dryRun: false,
        firestore: memory.firestore,
        ledgerRef: memory.ref("wagerSettlements/cancel"),
      },
      { increment: (count) => ({ increment: count }) },
    ),
    { action: "already-reconciled", operationId: "cancel" },
  );
});

test("leaves an overdrawn canonical repair for manual review", async () => {
  const memory = createFirestore({
    "profileMergeTargets/overdrawn-loser": {
      createTime: timestamp(10),
      data: { targetProfileId: "overdrawn-canonical" },
    },
    "users/overdrawn-canonical": {
      data: { mining: { materials: { dust: 1 } } },
    },
    "wagerSettlements/overdrawn": {
      createTime: timestamp(20),
      data: ledger("overdrawn"),
    },
  });

  await assert.rejects(
    reconcileWagerSettlementDocument(
      {
        dryRun: false,
        firestore: memory.firestore,
        ledgerRef: memory.ref("wagerSettlements/overdrawn"),
      },
      { increment: (count) => ({ increment: count }) },
    ),
    /Unsafe canonical balance repair/,
  );
  assert.equal(
    memory.read("users/overdrawn-canonical").mining.materials.dust,
    1,
  );
  assert.equal(memory.updateCalls.length, 0);
});

test("page reconciliation returns a bounded resumable cursor", async () => {
  const records = {};
  for (const operationId of ["a", "b", "c"]) {
    records[`wagerSettlements/${operationId}`] = {
      createTime: timestamp(20),
      data: ledger(operationId),
    };
  }
  const memory = createFirestore(records);
  const result = await reconcileWagerSettlementPage(
    { after: "", dryRun: true, limit: 2 },
    {
      documentIdField: "__name__",
      firestore: memory.firestore,
      increment: (count) => ({ increment: count }),
    },
  );
  assert.equal(result.hasMore, true);
  assert.equal(result.manualReviewRequired, false);
  assert.equal(result.nextCursor, "b");
  assert.deepEqual(
    result.results.map((entry) => entry.operationId),
    ["a", "b"],
  );
  await assert.rejects(
    reconcileWagerSettlementPage(
      { after: "nested/path/id", dryRun: true, limit: 2 },
      {
        documentIdField: "__name__",
        firestore: memory.firestore,
        increment: (count) => ({ increment: count }),
      },
    ),
    /cursor-invalid/,
  );
});

test("malformed and cyclic reconciliation state fails closed", async () => {
  const malformed = createFirestore({
    "wagerSettlements/malformed": {
      createTime: timestamp(20),
      data: ledger("malformed", { count: -1 }),
    },
  });
  await assert.rejects(
    reconcileWagerSettlementDocument({
      dryRun: true,
      firestore: malformed.firestore,
      ledgerRef: malformed.ref("wagerSettlements/malformed"),
    }),
    /Invalid wager settlement ledger/,
  );

  const cyclic = createFirestore({
    "profileMergeTargets/cycle-winner": {
      createTime: timestamp(10),
      data: { targetProfileId: "cycle-middle" },
    },
    "profileMergeTargets/cycle-middle": {
      createTime: timestamp(11),
      data: { targetProfileId: "cycle-winner" },
    },
    "wagerSettlements/cycle": {
      createTime: timestamp(20),
      data: ledger("cycle"),
    },
  });
  await assert.rejects(
    reconcileWagerSettlementDocument({
      dryRun: true,
      firestore: cyclic.firestore,
      ledgerRef: cyclic.ref("wagerSettlements/cycle"),
    }),
    /profile-merge-target-cycle/,
  );
  assert.equal(cyclic.updateCalls.length, 0);

  for (const targetProfileId of [
    " nested ",
    "nested/path/id",
    ".",
    "__reserved__",
    "\ud800",
    "x".repeat(1_501),
  ]) {
    const invalidTarget = createFirestore({
      "profileMergeTargets/invalid-target-winner": {
        createTime: timestamp(10),
        data: { targetProfileId },
      },
      "wagerSettlements/invalid-target": {
        createTime: timestamp(20),
        data: ledger("invalid-target"),
      },
    });
    await assert.rejects(
      reconcileWagerSettlementDocument({
        dryRun: false,
        firestore: invalidTarget.firestore,
        ledgerRef: invalidTarget.ref("wagerSettlements/invalid-target"),
      }),
      /Invalid merge target/,
    );
    assert.equal(invalidTarget.updateCalls.length, 0);
  }

  for (const fields of [
    { winnerProfileId: "nested/path/id" },
    {
      profileMergeWinnerCanonicalProfileId: "nested/path/id",
      profileMergeWinnerRepairVersion: 1,
    },
  ]) {
    const invalidLedger = createFirestore({
      "wagerSettlements/invalid-ledger": {
        createTime: timestamp(20),
        data: ledger("invalid-ledger", fields),
      },
    });
    await assert.rejects(
      reconcileWagerSettlementDocument({
        dryRun: false,
        firestore: invalidLedger.firestore,
        ledgerRef: invalidLedger.ref("wagerSettlements/invalid-ledger"),
      }),
      /ledger|profile-id-invalid/,
    );
    assert.equal(invalidLedger.updateCalls.length, 0);
  }
});

test("manual resolution fails when its ledger is missing", async () => {
  const memory = createFirestore({});
  await assert.rejects(
    reconcileWagerSettlementResolution(
      {
        decisions: { winner: "lost" },
        dryRun: false,
        operationId: "missing",
      },
      {
        firestore: memory.firestore,
        increment: (count) => ({ increment: count }),
      },
    ),
    /Missing wager settlement ledger/,
  );
  await assert.rejects(
    reconcileWagerSettlementResolution(
      {
        decisions: { winner: "lost" },
        dryRun: false,
        operationId: "nested/path/id",
      },
      {
        firestore: memory.firestore,
        increment: (count) => ({ increment: count }),
      },
    ),
    /operation-id-invalid/,
  );
  assert.equal(memory.updateCalls.length, 0);
});
