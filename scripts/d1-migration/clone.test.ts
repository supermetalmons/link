import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalJson } from "../operator/runtime.ts";
import {
  captureSchema,
  cloneDatabase,
  digestDatabase,
  resetCloneTarget,
  verifyDatabase,
  type SqlQuery,
} from "./clone.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function queryFor(db: DatabaseSync, queries: string[] = []): SqlQuery {
  return async (sql, params = []) => {
    assert.ok(Buffer.byteLength(sql) <= 90 * 1_024);
    assert.ok(params.length <= 100);
    queries.push(sql);
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  };
}

test("clone preserves storage types, int64, invalid UTF-8, NUL, and REAL identities", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(`
      CREATE TABLE values_table (id INTEGER PRIMARY KEY, value);
      INSERT INTO values_table VALUES
        (1, NULL), (2, 9223372036854775807), (3, -9223372036854775808),
        (4, X'FF00C080'), (5, CAST(X'FF00C080' AS TEXT)),
        (6, CAST('1.2345678901234567' AS REAL)), (7, CAST('-0.0' AS REAL)),
        (8, 9e999), (9, -9e999), (10, CAST('4.9406564584124654e-324' AS REAL)),
        (11, CAST('1.0' AS REAL)), (12, '1'), (13, X''), (14, ''),
        (15, CAST('1.7976931348623157e308' AS REAL));
    `);
    const expected = await cloneDatabase(queryFor(source), queryFor(target));
    assert.equal(
      (
        await verifyDatabase(queryFor(source), queryFor(target), {
          expectedSourceDigest: expected,
        })
      ).sha256,
      expected.sha256,
    );
    const int = target.prepare("SELECT value FROM values_table WHERE id = 2");
    int.setReadBigInts(true);
    assert.equal(int.get()?.value, 9_223_372_036_854_775_807n);
    assert.deepEqual(
      target
        .prepare(
          "SELECT typeof(value) AS type, hex(CAST(value AS BLOB)) AS bytes FROM values_table WHERE id IN (4,5) ORDER BY id",
        )
        .all(),
      [
        { type: "blob", bytes: "FF00C080" },
        { type: "text", bytes: "FF00C080" },
      ].map((row) => Object.assign(Object.create(null), row)),
    );
    assert.ok(
      Object.is(
        target.prepare("SELECT value FROM values_table WHERE id = 7").get()
          ?.value,
        -0,
      ),
    );
    for (const id of [6, 8, 9, 10, 11, 15])
      assert.ok(
        Object.is(
          target.prepare("SELECT value FROM values_table WHERE id = ?").get(id)
            ?.value,
          source.prepare("SELECT value FROM values_table WHERE id = ?").get(id)
            ?.value,
        ),
      );
  } finally {
    source.close();
    target.close();
  }
});

test("clone loads foreign-key parents, restores rejecting triggers after data, and preserves the ledger and sequences", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(`
      CREATE TABLE z_parent (id INTEGER PRIMARY KEY, payload TEXT);
      CREATE TABLE a_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES z_parent(id));
      CREATE TABLE generated (id INTEGER PRIMARY KEY, value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value * 2) STORED);
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO z_parent VALUES (2, 'retained');
      INSERT INTO a_child VALUES (10, 2);
      INSERT INTO generated (id,value) VALUES (3,7);
      INSERT INTO d1_migrations (id,name,applied_at) VALUES (4,'0007_finalized.sql','2026-09-12 01:02:03');
      UPDATE sqlite_sequence SET seq = 9007199254740993 WHERE name = 'd1_migrations';
      CREATE UNIQUE INDEX parent_payload ON z_parent(payload);
      CREATE VIEW child_view AS SELECT a_child.id,z_parent.payload FROM a_child JOIN z_parent ON a_child.parent=z_parent.id;
      CREATE TRIGGER child_is_immutable BEFORE INSERT ON a_child BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID;
      INSERT INTO _cf_KV VALUES ('source-secret',X'AB');
    `);
    target.exec(
      "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID; INSERT INTO _cf_KV VALUES ('target-owned',X'CD')",
    );
    const digest = await cloneDatabase(queryFor(source), queryFor(target));
    assert.equal(digest.sequences[0].value, "9007199254740993");
    assert.equal(
      target.prepare("SELECT doubled FROM generated").get()?.doubled,
      14,
    );
    assert.equal(
      target.prepare("SELECT payload FROM child_view").get()?.payload,
      "retained",
    );
    assert.throws(
      () => target.exec("INSERT INTO a_child VALUES(11,2)"),
      /immutable/,
    );
    assert.equal(
      target.prepare("SELECT key FROM _cf_KV").get()?.key,
      "target-owned",
    );
    await verifyDatabase(queryFor(source), queryFor(target));
  } finally {
    source.close();
    target.close();
  }
});

test("large binary and malformed text cells are chunked, restored and compared through their last byte", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(
      "CREATE TABLE large_cells (id INTEGER PRIMARY KEY, text_value TEXT, blob_value BLOB)",
    );
    const textBytes = Buffer.alloc(160_001);
    for (let index = 0; index < textBytes.length; index++)
      textBytes[index] = [0xff, 0, 0xc0, 0x80, 0x41][index % 5];
    const blobBytes = Buffer.alloc(180_005, 0xa9);
    source
      .prepare("INSERT INTO large_cells VALUES (1, CAST(? AS TEXT), ?)")
      .run(textBytes, blobBytes);
    const targetQueries: string[] = [];
    const digest = await cloneDatabase(
      queryFor(source),
      queryFor(target, targetQueries),
    );
    assert.ok(
      targetQueries.some((sql) =>
        sql.startsWith('CREATE TABLE "__mons_d1_clone_cells"'),
      ),
    );
    assert.equal(
      target
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = '__mons_d1_clone_cells'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      target
        .prepare(
          "SELECT hex(substr(CAST(text_value AS BLOB),-10)) AS suffix FROM large_cells",
        )
        .get()?.suffix,
      textBytes.subarray(-10).toString("hex").toUpperCase(),
    );
    await verifyDatabase(queryFor(source), queryFor(target), {
      expectedSourceDigest: digest,
    });
    target.exec(
      "UPDATE large_cells SET blob_value = CAST(substr(blob_value,1,length(blob_value)-1) || X'FF' AS BLOB)",
    );
    await assert.rejects(
      verifyDatabase(queryFor(source), queryFor(target)),
      /typed row comparison/,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("keyset pages preserve mixed-type composite keys and implicit rowids", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(
      "CREATE TABLE composite (k, part INTEGER, value TEXT, PRIMARY KEY(k,part)) WITHOUT ROWID; CREATE TABLE implicit (value TEXT)",
    );
    for (let index = 0; index < 45; index++) {
      source
        .prepare("INSERT INTO composite VALUES (?, ?, ?)")
        .run(
          index % 3 === 0
            ? index
            : index % 3 === 1
              ? String(index)
              : Buffer.from(String(index)),
          index,
          `value-${index}`,
        );
      source
        .prepare("INSERT INTO implicit (rowid,value) VALUES (?,?)")
        .run(index * 2 + 1, `row-${index}`);
    }
    const digest = await cloneDatabase(queryFor(source), queryFor(target));
    assert.equal(
      digest.tables.find((table) => table.name === "composite")?.rows,
      "45",
    );
    assert.equal(
      target
        .prepare("SELECT CAST(MAX(rowid) AS TEXT) AS last FROM implicit")
        .get()?.last,
      "89",
    );
    await verifyDatabase(queryFor(source), queryFor(target));
  } finally {
    source.close();
    target.close();
  }
});

test("oversized primary keys use stable offset pages and chunk reads", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(
      "CREATE TABLE huge_key (k TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID",
    );
    for (let index = 0; index < 132; index++)
      source
        .prepare("INSERT INTO huge_key VALUES (?,?)")
        .run(
          `${String(index).padStart(3, "0")}${"x".repeat(50_000)}`,
          `v${index}`,
        );
    const sourceQueries: string[] = [];
    const digest = await cloneDatabase(
      queryFor(source, sourceQueries),
      queryFor(target),
    );
    assert.equal(digest.tables[0].rows, "132");
    assert.ok(
      sourceQueries.some((sql) =>
        sql.includes("OFFSET CAST('128' AS INTEGER)"),
      ),
    );
    await verifyDatabase(queryFor(source), queryFor(target));
  } finally {
    source.close();
    target.close();
  }
});

test("verification rejects equal-byte values whose SQLite storage type changed", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(
      "CREATE TABLE cells(id INTEGER PRIMARY KEY,value); INSERT INTO cells VALUES(1,CAST(X'FF00' AS TEXT))",
    );
    await cloneDatabase(queryFor(source), queryFor(target));
    target.exec("UPDATE cells SET value=CAST(value AS BLOB)");
    await assert.rejects(
      verifyDatabase(queryFor(source), queryFor(target)),
      /typed row comparison/,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("the final frozen-source comparison detects a writer missed by maintenance", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(
      "CREATE TABLE cells(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO cells VALUES(1,'before')",
    );
    const digest = await cloneDatabase(queryFor(source), queryFor(target), {
      onProgress(progress) {
        if (progress.stage === "copy" && progress.table === "cells")
          source.exec("UPDATE cells SET value='after'");
      },
    });
    await assert.rejects(
      verifyDatabase(queryFor(source), queryFor(target), {
        expectedSourceDigest: digest,
      }),
      /source changed/,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("interrupted partial destinations can be reset and cloned again without touching source", async () => {
  const source = database();
  const target = database();
  try {
    source.exec("CREATE TABLE cells(id INTEGER PRIMARY KEY,value BLOB)");
    source
      .prepare("INSERT INTO cells VALUES(1,?)")
      .run(Buffer.alloc(150_000, 0xfd));
    const schema = await captureSchema(queryFor(source));
    const before = await digestDatabase(queryFor(source), { schema });
    const targetQuery = queryFor(target);
    let interrupted = false;
    const failing: SqlQuery = async (sql, params) => {
      const result = await targetQuery(sql, params);
      if (!interrupted && sql.startsWith('UPDATE "__mons_d1_clone_cells"')) {
        interrupted = true;
        throw new Error("transport interrupted after a successful write");
      }
      return result;
    };
    await assert.rejects(
      cloneDatabase(queryFor(source), failing),
      /transport interrupted/,
    );
    assert.equal(
      (await digestDatabase(queryFor(source))).sha256,
      before.sha256,
    );
    await resetCloneTarget(targetQuery, schema);
    assert.equal((await captureSchema(targetQuery)).objects.length, 0);
    assert.equal(
      (await cloneDatabase(queryFor(source), targetQuery)).sha256,
      before.sha256,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("only exact listed relocation triggers are ignored; unknown destination objects prevent reset", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(`
      CREATE TABLE cells(id INTEGER PRIMARY KEY,value TEXT);
      INSERT INTO cells VALUES(1,'keep');
      CREATE TRIGGER relocation_test BEFORE INSERT ON cells BEGIN SELECT RAISE(ABORT,'frozen'); END;
      CREATE TRIGGER important_guard BEFORE DELETE ON cells BEGIN SELECT RAISE(ABORT,'permanent'); END;
    `);
    const options = { ignoreSchemaObjects: ["relocation_test"] };
    await cloneDatabase(queryFor(source), queryFor(target), options);
    assert.equal(
      target
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'relocation_test'",
        )
        .get(),
      undefined,
    );
    assert.throws(() => target.exec("DELETE FROM cells"), /permanent/);
    await verifyDatabase(queryFor(source), queryFor(target), options);
    await assert.rejects(
      captureSchema(queryFor(source), { ignoreSchemaObjects: ["cells"] }),
      /only exact relocation triggers/,
    );
    target.exec("CREATE TABLE unexpected (id INTEGER PRIMARY KEY)");
    const schema = await captureSchema(queryFor(source), options);
    await assert.rejects(
      resetCloneTarget(queryFor(target), schema, options),
      /unrecognized object/,
    );
    assert.equal(
      target.prepare("SELECT COUNT(*) AS count FROM cells").get()?.count,
      1,
    );
    await assert.rejects(
      cloneDatabase(queryFor(source), queryFor(target), options),
      /must be empty/,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("cyclic foreign keys and changed schemas fail before any clone writes", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(
      "CREATE TABLE a(id INTEGER PRIMARY KEY,b INTEGER REFERENCES b(id)); CREATE TABLE b(id INTEGER PRIMARY KEY,a INTEGER REFERENCES a(id))",
    );
    await assert.rejects(
      cloneDatabase(queryFor(source), queryFor(target)),
      /cyclic foreign keys/,
    );
    assert.equal((await captureSchema(queryFor(target))).objects.length, 0);
    const schema = await captureSchema(queryFor(source));
    source.exec("CREATE TABLE added(id INTEGER PRIMARY KEY)");
    await assert.rejects(
      cloneDatabase(queryFor(source), queryFor(target), { schema }),
      /schema changed/,
    );
    assert.equal((await captureSchema(queryFor(target))).objects.length, 0);
  } finally {
    source.close();
    target.close();
  }
});

test("explicit unique parent indexes are present while dependent rows are loaded", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(`
      CREATE TABLE parent(id INTEGER PRIMARY KEY, external_key TEXT);
      CREATE UNIQUE INDEX parent_key ON parent(external_key);
      CREATE TABLE child(id INTEGER PRIMARY KEY, external_key TEXT REFERENCES parent(external_key));
      INSERT INTO parent VALUES(1,'key');
      INSERT INTO child VALUES(2,'key');
    `);
    await cloneDatabase(queryFor(source), queryFor(target));
    assert.equal(
      target.prepare("SELECT COUNT(*) AS count FROM child").get()?.count,
      1,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("trigger creation order is retained even when it differs from name order", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(`
      CREATE TABLE writes(id INTEGER PRIMARY KEY);
      CREATE TABLE audit(id INTEGER PRIMARY KEY, label TEXT);
      CREATE TRIGGER z_first AFTER INSERT ON writes BEGIN INSERT INTO audit(label) VALUES('first'); END;
      CREATE TRIGGER a_second AFTER INSERT ON writes BEGIN INSERT INTO audit(label) VALUES('second'); END;
    `);
    await cloneDatabase(queryFor(source), queryFor(target));
    source.exec("INSERT INTO writes VALUES(1)");
    target.exec("INSERT INTO writes VALUES(1)");
    assert.deepEqual(
      target.prepare("SELECT label FROM audit ORDER BY id").all(),
      source.prepare("SELECT label FROM audit ORDER BY id").all(),
    );
    await verifyDatabase(queryFor(source), queryFor(target));
  } finally {
    source.close();
    target.close();
  }
});

test("unknown provider objects and non-UTF8 databases fail classification", async () => {
  const unknown = database();
  const utf16 = database();
  try {
    unknown.exec("CREATE TABLE _cf_unknown (id INTEGER PRIMARY KEY)");
    await assert.rejects(
      captureSchema(queryFor(unknown)),
      /unclassified Cloudflare/,
    );
    utf16.exec(
      "PRAGMA encoding = 'UTF-16le'; CREATE TABLE test(id INTEGER PRIMARY KEY)",
    );
    await assert.rejects(captureSchema(queryFor(utf16)), /UTF-8/);
  } finally {
    unknown.close();
    utf16.close();
  }
});

test("narrow tables use 128-row pages and still traverse every key exactly once", async () => {
  const source = database();
  const target = database();
  try {
    source.exec("CREATE TABLE narrow (id INTEGER PRIMARY KEY, value TEXT)");
    for (let index = 0; index < 260; index++)
      source
        .prepare("INSERT INTO narrow VALUES (?,?)")
        .run(index, `row-${index}`);
    const queries: string[] = [];
    const copied = await cloneDatabase(
      queryFor(source, queries),
      queryFor(target),
    );
    assert.equal(copied.tables[0].rows, "260");
    const pages = queries.filter(
      (sql) => sql.includes('FROM "narrow"') && sql.includes("AS c0"),
    );
    assert.equal(pages.length, 3);
    assert.ok(pages.every((sql) => sql.includes("LIMIT 128")));
    await verifyDatabase(queryFor(source), queryFor(target));
  } finally {
    source.close();
    target.close();
  }
});

test("wide-table page responses remain below eight MiB", async () => {
  const source = database();
  const target = database();
  try {
    const columns = Array.from({ length: 20 }, (_, index) => `value_${index}`);
    source.exec(
      `CREATE TABLE wide (id INTEGER PRIMARY KEY, ${columns.map((name) => `${name} TEXT`).join(", ")})`,
    );
    const insert = source.prepare(
      `INSERT INTO wide VALUES (${Array.from({ length: 21 }, () => "?").join(", ")})`,
    );
    for (let index = 0; index < 110; index++)
      insert.run(index, ...columns.map(() => "x".repeat(2_048)));
    const raw = queryFor(source);
    const sizes: number[] = [];
    const pages: number[] = [];
    const bounded: SqlQuery = async (sql, params) => {
      const result = await raw(sql, params);
      if (sql.includes('FROM "wide"') && sql.includes("AS c0")) {
        sizes.push(Buffer.byteLength(JSON.stringify(result)));
        pages.push(result.length);
      }
      return result;
    };
    const copied = await cloneDatabase(bounded, queryFor(target));
    assert.equal(copied.tables[0].rows, "110");
    assert.ok(sizes.every((size) => size + 4_096 <= 8 * 1_024 * 1_024));
    assert.ok(pages.length === 2 && pages[0] > 16 && pages[0] < 128);
  } finally {
    source.close();
    target.close();
  }
});

test("persisted recursively sorted schema keys preserve clone and verification digests", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(`
      CREATE TABLE parent(id INTEGER PRIMARY KEY, value TEXT DEFAULT 'retained');
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      INSERT INTO parent VALUES(1,'preserved');
      INSERT INTO child VALUES(2,1);
      CREATE INDEX child_parent ON child(parent_id);
      CREATE TRIGGER immutable_child BEFORE DELETE ON child BEGIN SELECT RAISE(ABORT,'immutable'); END;
    `);
    const captured = await captureSchema(queryFor(source));
    const persisted = JSON.parse(canonicalJson(captured));
    assert.notEqual(JSON.stringify(captured), JSON.stringify(persisted));
    const before = await digestDatabase(queryFor(source), { schema: captured });
    assert.deepEqual(
      await digestDatabase(queryFor(source), { schema: persisted }),
      before,
    );
    const copied = await cloneDatabase(queryFor(source), queryFor(target), {
      schema: persisted,
    });
    assert.deepEqual(copied, before);
    const persistedDigest = JSON.parse(canonicalJson(copied));
    assert.deepEqual(
      await verifyDatabase(queryFor(source), queryFor(target), {
        expectedSourceDigest: persistedDigest,
      }),
      copied,
    );
  } finally {
    source.close();
    target.close();
  }
});

test("verification overlaps four rows with out-of-order replies while preserving the sequential copy digest", async () => {
  const source = database();
  const target = database();
  try {
    source.exec(
      "CREATE TABLE concurrent_cells(id INTEGER PRIMARY KEY, value BLOB)",
    );
    for (let id = 1; id <= 8; id++)
      source
        .prepare("INSERT INTO concurrent_cells VALUES (?,?)")
        .run(id, Buffer.alloc(4_096, id));
    const raw = queryFor(source);
    let copying = 0;
    let copyPeak = 0;
    const copyQuery: SqlQuery = async (sql, params) => {
      if (!sql.startsWith("SELECT hex(substr")) return raw(sql, params);
      copying++;
      copyPeak = Math.max(copyPeak, copying);
      try {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        return await raw(sql, params);
      } finally {
        copying--;
      }
    };
    const expected = await cloneDatabase(copyQuery, queryFor(target));
    assert.equal(copyPeak, 1);
    let active = 0;
    let peak = 0;
    let queued: Array<{
      id: number;
      resolve: (rows: Record<string, unknown>[]) => void;
      rows: Record<string, unknown>[];
    }> = [];
    const completionOrder: number[] = [];
    const parallel: SqlQuery = async (sql, params) => {
      if (!sql.startsWith("SELECT hex(substr")) return raw(sql, params);
      const id = Number(/CAST\('(\d+)' AS INTEGER\)/.exec(sql)![1]);
      active++;
      peak = Math.max(peak, active);
      const rows = await raw(sql, params);
      return new Promise((resolve) => {
        queued.push({ id, resolve, rows });
        if (queued.length === 4) {
          const current = queued;
          queued = [];
          for (const pending of current.reverse()) {
            completionOrder.push(pending.id);
            active--;
            pending.resolve(pending.rows);
          }
        }
      });
    };
    const actual = await digestDatabase(parallel);
    assert.equal(peak, 4);
    assert.deepEqual(completionOrder, [4, 3, 2, 1, 8, 7, 6, 5]);
    assert.deepEqual(actual, expected);
  } finally {
    source.close();
    target.close();
  }
});

test("verification batches budget decoded row bytes and allow an oversized valid row alone", async () => {
  for (const wideRow of [false, true]) {
    const source = database();
    try {
      source.exec(
        "CREATE TABLE budget_cells(id INTEGER PRIMARY KEY, a BLOB, b BLOB, c BLOB)",
      );
      const rows = wideRow ? 2 : 4;
      for (let id = 1; id <= rows; id++)
        source
          .prepare("INSERT INTO budget_cells VALUES (?,?,?,?)")
          .run(
            id,
            Buffer.alloc(1_500_000, id),
            wideRow ? Buffer.alloc(1_500_000, id) : null,
            wideRow ? Buffer.alloc(1_500_000, id) : null,
          );
      const raw = queryFor(source);
      const startedRows = new Set<number>();
      const completedRows = new Set<number>();
      let activeRows = 0;
      let peakRows = 0;
      const parallel: SqlQuery = async (sql, params) => {
        if (!sql.startsWith("SELECT hex(substr")) return raw(sql, params);
        const id = Number(/CAST\('(\d+)' AS INTEGER\)/.exec(sql)![1]);
        if (!startedRows.has(id)) {
          startedRows.add(id);
          activeRows++;
          peakRows = Math.max(peakRows, activeRows);
          if (activeRows > 1)
            assert.ok(activeRows * 3_000_000 <= 8 * 1_024 * 1_024);
        }
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const result = await raw(sql, params);
        const lastColumn = sql.includes(
          `CAST("${wideRow ? "c" : "a"}" AS BLOB)`,
        );
        if (
          lastColumn &&
          Number(params![0]) - 1 + Number(params![1]) === 1_500_000
        ) {
          completedRows.add(id);
          activeRows--;
        }
        return result;
      };
      const actual = await digestDatabase(parallel);
      assert.equal(actual.tables[0].rows, String(rows));
      assert.equal(peakRows, wideRow ? 1 : 2);
      assert.equal(completedRows.size, rows);
      assert.equal(activeRows, 0);
    } finally {
      source.close();
    }
  }
});

test("a failed verification read waits for every started row and starts no later batch", async () => {
  const source = database();
  try {
    source.exec(
      "CREATE TABLE failure_cells(id INTEGER PRIMARY KEY,value BLOB)",
    );
    for (let id = 1; id <= 8; id++)
      source
        .prepare("INSERT INTO failure_cells VALUES (?,?)")
        .run(id, Buffer.alloc(4_096, id));
    const raw = queryFor(source);
    const started = Promise.withResolvers<void>();
    const pending: Array<{ id: number; finish: () => void }> = [];
    const readRows: number[] = [];
    const settledRows: number[] = [];
    const failing: SqlQuery = async (sql, params) => {
      if (!sql.startsWith("SELECT hex(substr")) return raw(sql, params);
      const id = Number(/CAST\('(\d+)' AS INTEGER\)/.exec(sql)![1]);
      readRows.push(id);
      const result = await raw(sql, params);
      return new Promise((resolve, reject) => {
        pending.push({
          id,
          finish: () => {
            settledRows.push(id);
            if (id === 1) reject(new Error("injected row read failure"));
            else resolve(result);
          },
        });
        if (pending.length === 4) started.resolve();
      });
    };
    let finished = false;
    const digest = digestDatabase(failing).finally(() => {
      finished = true;
    });
    const rejected = assert.rejects(digest, /injected row read failure/);
    await started.promise;
    pending[0].finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.deepEqual(readRows, [1, 2, 3, 4]);
    for (const entry of pending.slice(1).reverse()) entry.finish();
    await rejected;
    assert.deepEqual(settledRows, [1, 4, 3, 2]);
    assert.deepEqual(readRows, [1, 2, 3, 4]);
    assert.equal(finished, true);
  } finally {
    source.close();
  }
});
