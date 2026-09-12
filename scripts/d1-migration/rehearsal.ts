import {
  captureSchema,
  cloneDatabase,
  verifyDatabase,
  type CloneProgress,
  type DatabaseDigest,
  type DatabaseSchema,
  type SqlQuery,
} from "./clone.ts";

export type CloneRehearsalResult = {
  formatVersion: 1;
  passed: true;
  schema: DatabaseSchema;
  digest: DatabaseDigest;
  checks: string[];
};

export type CloneRehearsalOptions = {
  onProgress?: (progress: CloneProgress) => void | Promise<void>;
  signal?: AbortSignal;
};

const TEXT_HEX = "FF00C08041".repeat(26_215);
const BLOB_HEX = "00FFAA5510FE".repeat(21_848);
const CHUNK_HEX_LENGTH = 32_768 * 2;

async function requireRow(
  query: SqlQuery,
  sql: string,
  expected: Record<string, string>,
): Promise<void> {
  const rows = await query(sql);
  if (
    rows.length !== 1 ||
    Object.keys(rows[0]).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => rows[0][key] !== value)
  ) {
    throw new Error("D1 clone rehearsal fixture comparison failed");
  }
}

async function appendLargeCell(
  query: SqlQuery,
  column: "raw_text" | "raw_blob",
  bytes: string,
  signal?: AbortSignal,
): Promise<void> {
  const type = column === "raw_text" ? "TEXT" : "BLOB";
  for (let start = 0; start < bytes.length; start += CHUNK_HEX_LENGTH) {
    signal?.throwIfAborted();
    const chunk = bytes.slice(start, start + CHUNK_HEX_LENGTH);
    await query(
      `UPDATE clone_rehearsal_large
       SET ${column} = CAST(CAST(${column} AS BLOB) || X'${chunk}' AS ${type})
       WHERE id = 1 AND length(CAST(${column} AS BLOB)) = ?`,
      [start / 2],
    );
    await requireRow(
      query,
      `SELECT CAST(length(CAST(${column} AS BLOB)) AS TEXT) AS bytes,
              hex(substr(CAST(${column} AS BLOB), ${start / 2 + 1}, ${chunk.length / 2})) AS chunk
       FROM clone_rehearsal_large WHERE id = 1`,
      { bytes: String((start + chunk.length) / 2), chunk },
    );
  }
}

async function verifyFixtures(query: SqlQuery): Promise<void> {
  await requireRow(
    query,
    `
    SELECT
      (SELECT typeof(value) FROM clone_rehearsal_values WHERE id = 1) AS null_type,
      (SELECT CAST(value AS TEXT) FROM clone_rehearsal_values WHERE id = 2) AS int_max,
      (SELECT CAST(value AS TEXT) FROM clone_rehearsal_values WHERE id = 3) AS int_min,
      (SELECT typeof(value) || ':' || hex(CAST(value AS BLOB)) FROM clone_rehearsal_values WHERE id = 4) AS invalid_text,
      (SELECT typeof(value) || ':' || hex(CAST(value AS BLOB)) FROM clone_rehearsal_values WHERE id = 5) AS blob,
      (SELECT CASE WHEN typeof(value) = 'real' AND value = 0 AND atan2(value, -1.0) < 0 THEN 'ok' ELSE 'bad' END FROM clone_rehearsal_values WHERE id = 6) AS negative_zero,
      (SELECT CASE WHEN typeof(value) = 'real' AND value > 1.7976931348623157e308 THEN 'ok' ELSE 'bad' END FROM clone_rehearsal_values WHERE id = 7) AS positive_infinity,
      (SELECT CASE WHEN typeof(value) = 'real' AND value < -1.7976931348623157e308 THEN 'ok' ELSE 'bad' END FROM clone_rehearsal_values WHERE id = 8) AS negative_infinity,
      (SELECT CASE WHEN typeof(value) = 'real' AND value = CAST('4.9406564584124654e-324' AS REAL) AND value > 0 THEN 'ok' ELSE 'bad' END FROM clone_rehearsal_values WHERE id = 9) AS subnormal,
      (SELECT CASE WHEN typeof(value) = 'real' AND value = CAST('1.2345678901234567' AS REAL) THEN 'ok' ELSE 'bad' END FROM clone_rehearsal_values WHERE id = 10) AS precise_real
  `,
    {
      null_type: "null",
      int_max: "9223372036854775807",
      int_min: "-9223372036854775808",
      invalid_text: "text:FF00C080",
      blob: "blob:FF00C080",
      negative_zero: "ok",
      positive_infinity: "ok",
      negative_infinity: "ok",
      subnormal: "ok",
      precise_real: "ok",
    },
  );
  await requireRow(
    query,
    `
    SELECT typeof(raw_text) AS text_type, typeof(raw_blob) AS blob_type,
           CAST(length(CAST(raw_text AS BLOB)) AS TEXT) AS text_bytes,
           CAST(length(raw_blob) AS TEXT) AS blob_bytes,
           hex(substr(CAST(raw_text AS BLOB), -5)) AS text_suffix,
           hex(substr(raw_blob, -6)) AS blob_suffix
    FROM clone_rehearsal_large WHERE id = 1
  `,
    {
      text_type: "text",
      blob_type: "blob",
      text_bytes: String(TEXT_HEX.length / 2),
      blob_bytes: String(BLOB_HEX.length / 2),
      text_suffix: TEXT_HEX.slice(-10),
      blob_suffix: BLOB_HEX.slice(-12),
    },
  );
  await requireRow(
    query,
    `
    SELECT
      (SELECT CAST(COUNT(*) AS TEXT) FROM clone_rehearsal_child AS c JOIN clone_rehearsal_parent AS p ON c.token = p.token) AS children,
      (SELECT typeof(seq) || ':' || CAST(seq AS TEXT) FROM sqlite_sequence WHERE name = 'd1_migrations') AS sequence,
      (SELECT name || ':' || applied_at FROM d1_migrations WHERE id = 4) AS migration
  `,
    {
      children: "1",
      sequence: "integer:9007199254740993",
      migration: "0001_rehearsal.sql:2026-09-12 00:00:00",
    },
  );
}

export async function runCloneRehearsal(
  source: SqlQuery,
  target: SqlQuery,
  options: CloneRehearsalOptions = {},
): Promise<CloneRehearsalResult> {
  options.signal?.throwIfAborted();
  if (source === target)
    throw new Error(
      "D1 clone rehearsal requires distinct source and target queries",
    );
  const sourceSchema = await captureSchema(source, options);
  const targetSchema = await captureSchema(target, options);
  if (sourceSchema.objects.length || targetSchema.objects.length)
    throw new Error(
      "D1 clone rehearsal requires two empty application schemas",
    );
  await options.onProgress?.({ stage: "schema" });
  const definitions = [
    "CREATE TABLE clone_rehearsal_values (id INTEGER PRIMARY KEY, value)",
    "CREATE TABLE clone_rehearsal_parent (id INTEGER PRIMARY KEY, token TEXT)",
    "CREATE UNIQUE INDEX clone_rehearsal_parent_token ON clone_rehearsal_parent(token)",
    "CREATE TABLE clone_rehearsal_child (id INTEGER PRIMARY KEY, token TEXT REFERENCES clone_rehearsal_parent(token))",
    "CREATE TABLE clone_rehearsal_large (id INTEGER PRIMARY KEY, raw_text TEXT, raw_blob BLOB)",
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
  ];
  for (const sql of definitions) {
    options.signal?.throwIfAborted();
    await source(sql);
  }
  await source(`INSERT INTO clone_rehearsal_values VALUES
    (1,NULL), (2,9223372036854775807), (3,-9223372036854775808),
    (4,CAST(X'FF00C080' AS TEXT)), (5,X'FF00C080'),
    (6,CAST('-0.0' AS REAL)), (7,9e999), (8,-9e999),
    (9,CAST('4.9406564584124654e-324' AS REAL)),
    (10,CAST('1.2345678901234567' AS REAL))`);
  await source("INSERT INTO clone_rehearsal_parent VALUES (1,'retained-key')");
  await source("INSERT INTO clone_rehearsal_child VALUES (2,'retained-key')");
  await source("INSERT INTO clone_rehearsal_large VALUES (1,'',X'')");
  await source(
    "INSERT INTO d1_migrations (id,name,applied_at) VALUES (4,'0001_rehearsal.sql','2026-09-12 00:00:00')",
  );
  await source(
    "UPDATE sqlite_sequence SET seq = CAST('9007199254740993' AS INTEGER) WHERE name = 'd1_migrations'",
  );
  await appendLargeCell(source, "raw_text", TEXT_HEX, options.signal);
  await appendLargeCell(source, "raw_blob", BLOB_HEX, options.signal);
  await source(`CREATE TRIGGER clone_rehearsal_immutable_insert
    BEFORE INSERT ON clone_rehearsal_child BEGIN SELECT RAISE(IGNORE); END`);
  await verifyFixtures(source);
  const schema = await captureSchema(source, options);
  const copied = await cloneDatabase(source, target, { ...options, schema });
  await verifyFixtures(target);
  await target("INSERT INTO clone_rehearsal_child VALUES (3,'retained-key')");
  await requireRow(
    target,
    "SELECT CAST(COUNT(*) AS TEXT) AS count FROM clone_rehearsal_child",
    { count: "1" },
  );
  const digest = await verifyDatabase(source, target, {
    ...options,
    expectedSourceDigest: copied,
  });
  return {
    formatVersion: 1,
    passed: true,
    schema,
    digest,
    checks: [
      "null-and-storage-types",
      "signed-int64-extrema",
      "invalid-utf8-and-embedded-nul",
      "real-negative-zero-infinities-subnormal-precision",
      "chunked-large-text-and-blob",
      "foreign-key-parent-unique-index",
      "immutable-trigger-restored-after-data",
      "migration-ledger-and-int64-sequence",
      "exact-schema-and-typed-row-digests",
      "foreign-key-and-quick-check",
    ],
  };
}
