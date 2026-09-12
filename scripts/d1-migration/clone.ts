import { createHash } from "node:crypto";

export type SqlQuery = (
  sql: string,
  params?: (string | number | null)[],
) => Promise<Record<string, unknown>[]>;

export type SchemaObject = {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  table: string;
  sql: string;
};

export type ColumnSchema = {
  name: string;
  type: string;
  notNull: boolean;
  defaultSql: string | null;
  primaryKey: number;
  generated: boolean;
};

export type TableSchema = {
  name: string;
  columns: ColumnSchema[];
  rowid: string | null;
  primaryKey: string[];
  parents: string[];
};

export type DatabaseSchema = {
  formatVersion: 1;
  encoding: "UTF-8";
  objects: SchemaObject[];
  tables: TableSchema[];
  triggerOrder: string[];
};

export type TableDigest = {
  name: string;
  rows: string;
  sha256: string;
};

export type DatabaseDigest = {
  schemaSha256: string;
  tables: TableDigest[];
  sequences: { name: string; value: string }[];
  sha256: string;
};

export type CloneProgress = {
  stage: "schema" | "copy" | "verify" | "complete";
  table?: string;
  rows?: string;
};

export type CloneOptions = {
  schema?: DatabaseSchema;
  ignoreSchemaObjects?: readonly string[];
  onProgress?: (progress: CloneProgress) => void | Promise<void>;
  onTable?: (table: TableDigest) => void | Promise<void>;
  signal?: AbortSignal;
};

export type VerifyOptions = Omit<CloneOptions, "schema"> & {
  expectedSourceDigest?: DatabaseDigest;
};

type Cell =
  | { type: "null" }
  | { type: "integer" | "real"; value: string }
  | { type: "text" | "blob"; hex: string };

type CellPrefix = { cell: Cell; bytes: number };

const INLINE_BYTES = 2_048;
const CHUNK_BYTES = 32_768;
const MAX_CELL_BYTES = 2_000_000;
const MAX_SQL_BYTES = 90 * 1_024;
const MAX_PAGE_BYTES = 8 * 1_024 * 1_024;
const STAGING_TABLE = "__mons_d1_clone_cells";
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const REAL = /^-?(?:[0-9]+\.[0-9]*|[0-9]*\.[0-9]+)(?:e[+-]?[0-9]+)?$/i;
const HEX = /^(?:[0-9A-F]{2})*$/;

function fail(message: string): never {
  throw new Error(`D1 clone: ${message}`);
}

function identifier(name: string): string {
  if (!name || name.includes("\0")) fail("invalid schema identifier");
  return `"${name.replaceAll('"', '""')}"`;
}

function compareNames(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function string(value: unknown): string {
  if (typeof value !== "string") fail("expected a string result");
  return value;
}

function smallInteger(value: unknown, maximum = 100): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    fail("invalid schema integer");
  if (value < 0 || value > maximum) fail("schema integer out of range");
  return value;
}

function decimal(value: string): string {
  if (!INTEGER.test(value)) fail("invalid integer encoding");
  const parsed = BigInt(value);
  if (
    parsed < -9_223_372_036_854_775_808n ||
    parsed > 9_223_372_036_854_775_807n
  )
    fail("integer encoding out of range");
  return value;
}

function hex(value: string): string {
  if (!HEX.test(value)) fail("invalid byte encoding");
  return value;
}

function providerObject(name: string): boolean {
  return (
    name === "_cf_KV" ||
    name === "sqlite_sequence" ||
    name === "sqlite_schema" ||
    name === "sqlite_master" ||
    name.startsWith("sqlite_autoindex_") ||
    /^sqlite_stat[1-4]$/.test(name)
  );
}

function queryBounded(query: SqlQuery): SqlQuery {
  return async (sql, params = []) => {
    if (Buffer.byteLength(sql) > MAX_SQL_BYTES || params.length > 100)
      fail("statement exceeds the bounded SQL or parameter limit");
    return query(sql, params);
  };
}

export async function captureSchema(
  query: SqlQuery,
  options: Pick<CloneOptions, "ignoreSchemaObjects" | "signal"> = {},
): Promise<DatabaseSchema> {
  options.signal?.throwIfAborted();
  const db = queryBounded(query);
  const probe = await db(
    "SELECT hex(CAST(char(233) AS BLOB)) AS encoding_probe",
  );
  if (probe.length !== 1 || probe[0].encoding_probe !== "C3A9")
    fail("source and destination require UTF-8 SQLite encoding");
  const ignored = new Set(options.ignoreSchemaObjects || []);
  const raw = await db(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY rowid",
  );
  const objects: SchemaObject[] = [];
  for (const entry of raw) {
    const name = string(entry.name);
    if (providerObject(name)) continue;
    if (name.startsWith("_cf_"))
      fail("unclassified Cloudflare internal object");
    const type = string(entry.type);
    if (ignored.has(name)) {
      if (type !== "trigger")
        fail("only exact relocation triggers may be ignored");
      continue;
    }
    if (!(["table", "index", "view", "trigger"] as string[]).includes(type))
      fail("unsupported schema object");
    if (name.startsWith("sqlite_")) fail("unclassified SQLite internal object");
    const sql = string(entry.sql);
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql))
      fail("virtual tables require a separate migration procedure");
    objects.push({
      type: type as SchemaObject["type"],
      name,
      table: string(entry.tbl_name),
      sql,
    });
  }
  const triggerOrder = objects
    .filter((entry) => entry.type === "trigger")
    .map((entry) => entry.name);
  objects.sort((a, b) =>
    compareNames(`${a.type}\0${a.name}`, `${b.type}\0${b.name}`),
  );
  const tableList = await db("PRAGMA table_list");
  const tables: TableSchema[] = [];
  for (const object of objects.filter((entry) => entry.type === "table")) {
    options.signal?.throwIfAborted();
    const rawColumns = await db(
      `PRAGMA table_xinfo(${identifier(object.name)})`,
    );
    const columns = rawColumns.map((column, index): ColumnSchema => {
      if (smallInteger(column.cid) !== index)
        fail("noncontiguous table columns");
      const hidden = smallInteger(column.hidden, 3);
      if (hidden === 1) fail("hidden virtual-table columns are unsupported");
      return {
        name: string(column.name),
        type: string(column.type),
        notNull: smallInteger(column.notnull, 1) === 1,
        defaultSql:
          column.dflt_value === null ? null : string(column.dflt_value),
        primaryKey: smallInteger(column.pk),
        generated: hidden === 2 || hidden === 3,
      };
    });
    if (!columns.length) fail("table has no columns");
    const description = tableList.find(
      (entry) => entry.schema === "main" && entry.name === object.name,
    );
    if (!description || description.type !== "table")
      fail("unsupported table kind");
    const withoutRowid = smallInteger(description.wr, 1) === 1;
    const primaryKey = columns
      .filter((column) => column.primaryKey > 0)
      .sort((a, b) => a.primaryKey - b.primaryKey)
      .map((column) => column.name);
    const occupied = new Set(
      columns.map((column) => column.name.toLowerCase()),
    );
    const rowid = withoutRowid
      ? null
      : ["rowid", "_rowid_", "oid"].find((name) => !occupied.has(name));
    if (rowid === undefined || (withoutRowid && !primaryKey.length))
      fail("table has no usable stable row identity");
    const foreignKeys = await db(
      `PRAGMA foreign_key_list(${identifier(object.name)})`,
    );
    tables.push({
      name: object.name,
      columns,
      rowid,
      primaryKey,
      parents: [
        ...new Set(foreignKeys.map((entry) => string(entry.table))),
      ].sort(compareNames),
    });
  }
  return { formatVersion: 1, encoding: "UTF-8", objects, tables, triggerOrder };
}

function orderedTables(schema: DatabaseSchema): TableSchema[] {
  const byName = new Map(
    schema.tables.map((table) => [table.name.toLowerCase(), table]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: TableSchema[] = [];
  const visit = (table: TableSchema): void => {
    if (visited.has(table.name)) return;
    if (visiting.has(table.name))
      fail("cyclic foreign keys require a separate import plan");
    visiting.add(table.name);
    for (const name of table.parents) {
      const parent = byName.get(name.toLowerCase());
      if (!parent) fail("foreign key references an uncopied table");
      visit(parent);
    }
    visiting.delete(table.name);
    visited.add(table.name);
    ordered.push(table);
  };
  schema.tables.forEach(visit);
  return ordered;
}

function readColumns(table: TableSchema): string[] {
  return [
    ...(table.rowid === null ? [] : [table.rowid]),
    ...table.columns.map((column) => column.name),
  ];
}

function orderColumns(table: TableSchema): string[] {
  return table.rowid === null ? table.primaryKey : [table.rowid];
}

function encodeExpression(column: string): string {
  const value = identifier(column);
  const bytes = `CAST(${value} AS BLOB)`;
  return `CASE typeof(${value})
    WHEN 'null' THEN 'n'
    WHEN 'integer' THEN 'i' || CAST(${value} AS TEXT)
    WHEN 'real' THEN 'r' || CASE
      WHEN ${value} > 1.7976931348623157e308 THEN 'Infinity'
      WHEN ${value} < -1.7976931348623157e308 THEN '-Infinity'
      WHEN ${value} = 0 AND atan2(${value}, -1.0) < 0 THEN '-0.0'
      ELSE printf('%!.26g', ${value}) END
    WHEN 'text' THEN 't' || CAST(length(${bytes}) AS TEXT) || ':' || hex(substr(${bytes}, 1, ${INLINE_BYTES}))
    WHEN 'blob' THEN 'b' || CAST(length(${value}) AS TEXT) || ':' || hex(substr(${value}, 1, ${INLINE_BYTES}))
    END`;
}

function decodePrefix(encoded: unknown): CellPrefix {
  const value = string(encoded);
  if (value === "n") return { cell: { type: "null" }, bytes: 0 };
  if (value.startsWith("i"))
    return {
      cell: { type: "integer", value: decimal(value.slice(1)) },
      bytes: 0,
    };
  if (value.startsWith("r")) {
    const number = value.slice(1);
    if (!REAL.test(number) && number !== "Infinity" && number !== "-Infinity")
      fail("invalid real encoding");
    return { cell: { type: "real", value: number }, bytes: 0 };
  }
  const match = /^([tb])(0|[1-9][0-9]*):([0-9A-F]*)$/.exec(value);
  if (!match) fail("invalid cell encoding");
  const length = BigInt(match[2]);
  if (length > BigInt(MAX_CELL_BYTES)) fail("cell exceeds D1's maximum size");
  const bytes = Number(length);
  const prefix = hex(match[3]);
  if (prefix.length !== Math.min(bytes, INLINE_BYTES) * 2)
    fail("incomplete cell prefix");
  return {
    cell: { type: match[1] === "t" ? "text" : "blob", hex: prefix },
    bytes,
  };
}

function cellSql(cell: Cell): string {
  switch (cell.type) {
    case "null":
      return "NULL";
    case "integer":
      return `CAST('${decimal(cell.value)}' AS INTEGER)`;
    case "real":
      if (cell.value === "Infinity") return "9e999";
      if (cell.value === "-Infinity") return "-9e999";
      if (!REAL.test(cell.value)) fail("invalid real encoding");
      return `CAST('${cell.value}' AS REAL)`;
    case "text":
      return `CAST(X'${hex(cell.hex)}' AS TEXT)`;
    case "blob":
      return `X'${hex(cell.hex)}'`;
  }
}

function cursorSql(
  table: TableSchema,
  cells: Cell[],
  comparison: ">" | "=",
): string | null {
  const columns = readColumns(table);
  const keys = orderColumns(table);
  const values = keys.map((key) => cellSql(cells[columns.indexOf(key)]));
  const sql = `(${keys.map(identifier).join(", ")}) ${comparison} (${values.join(", ")})`;
  return Buffer.byteLength(sql) < MAX_SQL_BYTES / 2 ? sql : null;
}

async function readCells(
  query: SqlQuery,
  table: TableSchema,
  row: Record<string, unknown>,
  offset: bigint,
  signal?: AbortSignal,
): Promise<Cell[]> {
  const columns = readColumns(table);
  const prefixes = columns.map((_, index) => decodePrefix(row[`c${index}`]));
  const keysComplete = orderColumns(table).every((key) => {
    const entry = prefixes[columns.indexOf(key)];
    return entry.bytes <= INLINE_BYTES;
  });
  const locator = keysComplete
    ? cursorSql(
        table,
        prefixes.map((prefix) => prefix.cell),
        "=",
      )
    : null;
  const selection = locator
    ? `WHERE ${locator}`
    : `ORDER BY ${orderColumns(table).map(identifier).join(", ")} LIMIT 1 OFFSET CAST('${offset}' AS INTEGER)`;
  for (let index = 0; index < prefixes.length; index++) {
    const { cell, bytes } = prefixes[index];
    if (cell.type !== "text" && cell.type !== "blob") continue;
    const chunks = [cell.hex];
    for (let start = INLINE_BYTES; start < bytes; start += CHUNK_BYTES) {
      signal?.throwIfAborted();
      const length = Math.min(CHUNK_BYTES, bytes - start);
      const result = await query(
        `SELECT hex(substr(CAST(${identifier(columns[index])} AS BLOB), ?, ?)) AS chunk
         FROM ${identifier(table.name)} ${selection}`,
        [start + 1, length],
      );
      if (result.length !== 1) fail("cell disappeared while reading");
      const chunk = hex(string(result[0].chunk));
      if (chunk.length !== length * 2) fail("cell changed while reading");
      chunks.push(chunk);
    }
    cell.hex = chunks.join("");
  }
  return prefixes.map((prefix) => prefix.cell);
}

async function scanTable(
  query: SqlQuery,
  table: TableSchema,
  options: CloneOptions,
  stage: "copy" | "verify",
  onRow?: (cells: Cell[]) => Promise<void>,
): Promise<TableDigest> {
  const hash = createHash("sha256");
  const columns = readColumns(table);
  const rowBytes = columns.length * (INLINE_BYTES * 2 + 64) + 64;
  const pageRows = Math.max(
    1,
    Math.min(128, Math.floor((MAX_PAGE_BYTES - 4_096) / rowBytes)),
  );
  hash.update(JSON.stringify({ name: table.name, columns }) + "\n");
  let rows = 0n;
  let cursor: Cell[] | null = null;
  for (;;) {
    options.signal?.throwIfAborted();
    const after = cursor === null ? null : cursorSql(table, cursor, ">");
    const offset =
      cursor !== null && after === null
        ? ` OFFSET CAST('${rows}' AS INTEGER)`
        : "";
    const page = await query(
      `SELECT ${columns.map((column, index) => `${encodeExpression(column)} AS c${index}`).join(", ")}
       FROM ${identifier(table.name)} ${after ? `WHERE ${after}` : ""}
       ORDER BY ${orderColumns(table).map(identifier).join(", ")} LIMIT ${pageRows}${offset}`,
    );
    if (page.length > pageRows) fail("oversized page");
    for (const row of page) {
      const cells = await readCells(query, table, row, rows, options.signal);
      hash.update(JSON.stringify(cells) + "\n");
      if (onRow) await onRow(cells);
      cursor = cells;
      rows++;
    }
    await options.onProgress?.({
      stage,
      table: table.name,
      rows: rows.toString(),
    });
    if (page.length < pageRows) break;
  }
  const count = await query(
    `SELECT CAST(COUNT(*) AS TEXT) AS count FROM ${identifier(table.name)}`,
  );
  if (count.length !== 1 || string(count[0].count) !== rows.toString())
    fail(`row count changed for ${table.name}`);
  const result = {
    name: table.name,
    rows: rows.toString(),
    sha256: hash.digest("hex"),
  };
  await options.onTable?.(result);
  return result;
}

async function readSequences(
  query: SqlQuery,
  schema: DatabaseSchema,
): Promise<DatabaseDigest["sequences"]> {
  const exists = await query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'",
  );
  if (exists.length === 0) return [];
  const tables = new Set(schema.tables.map((table) => table.name));
  const rows = await query(
    "SELECT name, typeof(seq) AS type, CAST(seq AS TEXT) AS value FROM sqlite_sequence ORDER BY name",
  );
  const seen = new Set<string>();
  const sequences: DatabaseDigest["sequences"] = [];
  for (const row of rows) {
    const name = string(row.name);
    if (providerObject(name)) continue;
    if (!tables.has(name) || seen.has(name) || row.type !== "integer")
      fail("invalid application AUTOINCREMENT sequence");
    seen.add(name);
    const value = decimal(string(row.value));
    if (BigInt(value) < 0n) fail("negative AUTOINCREMENT sequence");
    sequences.push({ name, value });
  }
  return sequences.sort((a, b) => compareNames(a.name, b.name));
}

function digestSchema(schema: DatabaseSchema): string {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

function finishDigest(
  schema: DatabaseSchema,
  tables: TableDigest[],
  sequences: DatabaseDigest["sequences"],
): DatabaseDigest {
  const contents = {
    schemaSha256: digestSchema(schema),
    tables: [...tables].sort((a, b) => compareNames(a.name, b.name)),
    sequences,
  };
  return {
    ...contents,
    sha256: createHash("sha256").update(JSON.stringify(contents)).digest("hex"),
  };
}

export async function digestDatabase(
  query: SqlQuery,
  options: CloneOptions = {},
): Promise<DatabaseDigest> {
  const db = queryBounded(query);
  const schema = options.schema || (await captureSchema(db, options));
  const tables: TableDigest[] = [];
  for (const table of schema.tables)
    tables.push(await scanTable(db, table, options, "verify"));
  return finishDigest(schema, tables, await readSequences(db, schema));
}

async function assertHealthy(query: SqlQuery): Promise<void> {
  const keys = await query("PRAGMA foreign_key_check");
  if (keys.length) fail("foreign-key verification failed");
  const check = await query("PRAGMA quick_check");
  if (check.length !== 1 || String(check[0].quick_check).toLowerCase() !== "ok")
    fail("SQLite integrity verification failed");
}

export async function verifyDatabase(
  sourceQuery: SqlQuery,
  targetQuery: SqlQuery,
  options: VerifyOptions = {},
): Promise<DatabaseDigest> {
  const source = queryBounded(sourceQuery);
  const target = queryBounded(targetQuery);
  const sourceSchema = await captureSchema(source, options);
  const targetSchema = await captureSchema(target, options);
  if (digestSchema(sourceSchema) !== digestSchema(targetSchema))
    fail("schema comparison failed");
  const sourceDigest = await digestDatabase(source, {
    ...options,
    schema: sourceSchema,
  });
  if (
    options.expectedSourceDigest &&
    sourceDigest.sha256 !== options.expectedSourceDigest.sha256
  )
    fail("source changed after the frozen copy");
  const targetDigest = await digestDatabase(target, {
    ...options,
    schema: targetSchema,
  });
  if (sourceDigest.sha256 !== targetDigest.sha256)
    fail("typed row comparison failed");
  await assertHealthy(source);
  await assertHealthy(target);
  await options.onProgress?.({ stage: "complete" });
  return sourceDigest;
}

async function stageCell(
  query: SqlQuery,
  slot: number,
  cell: Extract<Cell, { type: "text" | "blob" }>,
  signal?: AbortSignal,
): Promise<void> {
  await query(
    `INSERT INTO ${identifier(STAGING_TABLE)} (slot, value) VALUES (?, X'')`,
    [slot],
  );
  for (let start = 0; start < cell.hex.length; start += CHUNK_BYTES * 2) {
    signal?.throwIfAborted();
    const chunk = cell.hex.slice(start, start + CHUNK_BYTES * 2);
    await query(
      `UPDATE ${identifier(STAGING_TABLE)} SET value = CAST(value || X'${hex(chunk)}' AS BLOB)
       WHERE slot = ? AND length(value) = ?`,
      [slot, start / 2],
    );
    const result = await query(
      `SELECT CAST(length(value) AS TEXT) AS size, hex(substr(value, ?, ?)) AS chunk
       FROM ${identifier(STAGING_TABLE)} WHERE slot = ?`,
      [start / 2 + 1, chunk.length / 2, slot],
    );
    if (
      result.length !== 1 ||
      result[0].size !== String((start + chunk.length) / 2) ||
      result[0].chunk !== chunk
    )
      fail("staged cell verification failed");
  }
}

export async function cloneDatabase(
  sourceQuery: SqlQuery,
  targetQuery: SqlQuery,
  options: CloneOptions = {},
): Promise<DatabaseDigest> {
  const source = queryBounded(sourceQuery);
  const target = queryBounded(targetQuery);
  const currentSourceSchema = await captureSchema(source, options);
  if (
    options.schema &&
    digestSchema(options.schema) !== digestSchema(currentSourceSchema)
  )
    fail("source schema changed after planning");
  const schema = options.schema || currentSourceSchema;
  if (schema.objects.some((object) => object.name === STAGING_TABLE))
    fail("reserved clone staging name already exists in source");
  const targetSchema = await captureSchema(target, options);
  if (targetSchema.objects.length)
    fail("destination application schema must be empty");
  const order = orderedTables(schema);
  await assertHealthy(source);
  await options.onProgress?.({ stage: "schema" });
  for (const object of schema.objects.filter(
    (entry) => entry.type === "table",
  )) {
    options.signal?.throwIfAborted();
    await target(object.sql);
  }
  for (const object of schema.objects.filter(
    (entry) => entry.type === "index",
  )) {
    options.signal?.throwIfAborted();
    await target(object.sql);
  }
  const tables: TableDigest[] = [];
  let staging = false;
  for (const table of order) {
    const columnNames = readColumns(table);
    const insertIndices = columnNames
      .map((_, index) => index)
      .filter((index) => {
        const column = table.columns[index - (table.rowid === null ? 0 : 1)];
        return !column?.generated;
      });
    const insertPrefix = `INSERT INTO ${identifier(table.name)} (${insertIndices.map((index) => identifier(columnNames[index])).join(", ")}) VALUES `;
    let pendingRows: string[] = [];
    let pendingBytes = Buffer.byteLength(insertPrefix);
    const flushRows = async (): Promise<void> => {
      if (pendingRows.length === 0) return;
      options.signal?.throwIfAborted();
      await target(insertPrefix + pendingRows.join(", "));
      pendingRows = [];
      pendingBytes = Buffer.byteLength(insertPrefix);
    };
    const result = await scanTable(
      source,
      table,
      { ...options, onTable: undefined },
      "copy",
      async (cells) => {
        options.signal?.throwIfAborted();
        const expressions = insertIndices.map((index) => cellSql(cells[index]));
        const tuple = "(" + expressions.join(", ") + ")";
        const tupleBytes = Buffer.byteLength(tuple);
        if (Buffer.byteLength(insertPrefix) + tupleBytes <= MAX_SQL_BYTES) {
          if (
            pendingRows.length >= 128 ||
            pendingBytes + tupleBytes + 2 > MAX_SQL_BYTES
          )
            await flushRows();
          pendingBytes += tupleBytes + (pendingRows.length ? 2 : 0);
          pendingRows.push(tuple);
          return;
        }
        await flushRows();
        if (!staging) {
          await target(
            `CREATE TABLE ${identifier(STAGING_TABLE)} (slot INTEGER PRIMARY KEY, value BLOB NOT NULL)`,
          );
          staging = true;
        }
        for (let slot = 0; slot < insertIndices.length; slot++) {
          const cell = cells[insertIndices[slot]];
          if (cell.type !== "text" && cell.type !== "blob") continue;
          await stageCell(target, slot, cell, options.signal);
          const reference = `(SELECT value FROM ${identifier(STAGING_TABLE)} WHERE slot = ${slot})`;
          expressions[slot] =
            cell.type === "text" ? `CAST(${reference} AS TEXT)` : reference;
        }
        await target(insertPrefix + "(" + expressions.join(", ") + ")");
        await target(`DELETE FROM ${identifier(STAGING_TABLE)}`);
      },
    );
    await flushRows();
    tables.push(result);
    await options.onTable?.(result);
  }
  if (staging) await target(`DROP TABLE ${identifier(STAGING_TABLE)}`);
  const sequences = await readSequences(source, schema);
  for (const sequence of sequences) {
    await target("DELETE FROM sqlite_sequence WHERE name = ?", [sequence.name]);
    await target(
      "INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))",
      [sequence.name, sequence.value],
    );
  }
  const finalObjects = [
    ...schema.objects.filter((entry) => entry.type === "view"),
    ...schema.triggerOrder.map((name) => {
      const trigger = schema.objects.find(
        (entry) => entry.type === "trigger" && entry.name === name,
      );
      if (!trigger) fail("missing ordered trigger definition");
      return trigger;
    }),
  ];
  for (const object of finalObjects) {
    options.signal?.throwIfAborted();
    await target(object.sql);
  }
  const sourceDigest = finishDigest(schema, tables, sequences);
  const restoredSchema = await captureSchema(target, options);
  if (digestSchema(restoredSchema) !== digestSchema(schema))
    fail("restored schema comparison failed");
  const restored = await digestDatabase(target, {
    ...options,
    schema: restoredSchema,
  });
  if (sourceDigest.sha256 !== restored.sha256)
    fail("restored typed row comparison failed");
  await assertHealthy(target);
  await options.onProgress?.({ stage: "complete" });
  return sourceDigest;
}

export async function resetCloneTarget(
  query: SqlQuery,
  expectedSchema: DatabaseSchema,
  options: Pick<CloneOptions, "ignoreSchemaObjects" | "signal"> = {},
): Promise<void> {
  const db = queryBounded(query);
  const current = await captureSchema(db);
  const allowed = new Set(
    expectedSchema.objects.map((object) => `${object.type}:${object.name}`),
  );
  allowed.add(`table:${STAGING_TABLE}`);
  for (const name of options.ignoreSchemaObjects || [])
    allowed.add(`trigger:${name}`);
  for (const object of current.objects)
    if (!allowed.has(`${object.type}:${object.name}`))
      fail("destination reset encountered an unrecognized object");
  for (const type of ["trigger", "view"] as const) {
    for (const object of current.objects.filter(
      (entry) => entry.type === type,
    )) {
      options.signal?.throwIfAborted();
      await db(`DROP ${type.toUpperCase()} ${identifier(object.name)}`);
    }
  }
  const present = new Set(current.tables.map((table) => table.name));
  for (const table of orderedTables(expectedSchema).reverse()) {
    if (!present.has(table.name)) continue;
    options.signal?.throwIfAborted();
    await db(`DROP TABLE ${identifier(table.name)}`);
  }
  if (present.has(STAGING_TABLE))
    await db(`DROP TABLE ${identifier(STAGING_TABLE)}`);
}
