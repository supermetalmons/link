import { createHash, createSign, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertFirebaseInviteSourceAvailable } from "./invite-source-retirement.ts";

type JsonRecord = Record<string, unknown>;
type Operation =
  "status" | "preflight" | "export" | "import" | "verify" | "activate";
type Arguments = {
  operation: Operation;
  directory?: string;
  firebaseCredentials?: string;
  candidateVersionId?: string;
  pageSize: number;
};
type WagerRow = {
  inviteId: string;
  matchId: string;
  wagerJson: string | null;
  resolutionMarker: 0 | 1 | null;
};
type StoredWagerRow = WagerRow & {
  revision: number;
  updatedAtMs: number;
};
type Counts = {
  rowCount: number;
  wagerCount: number;
  markerCount: number;
};
type SourceSummary = Counts & { digest: string; scannedInviteCount: number };
type BaselineTable = { table: string; count: number; digest: string };
type Baseline = { digest: string; tables: BaselineTable[] };
type Maintenance = {
  profileState: string;
  reservationState: string;
  freezeGeneration: number;
  admissions: number;
  activeGameplayLeases: number;
};
type Activation = {
  activationEpoch: 0 | 1;
  importAttemptId: string | null;
  sourceDigest: string | null;
  importDigest: string | null;
  baselineDigest: string | null;
  verifiedBaselineDigest: string | null;
  sourceWagerCount: number | null;
  sourceMarkerCount: number | null;
  sourceRowCount: number | null;
  importedRowCount: number | null;
  verifiedFreezeGeneration: number | null;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
  candidateVersionId: string | null;
};
type ExportSession = {
  schemaVersion: 1;
  projectId: typeof PROJECT_ID;
  firebaseRoot: typeof FIREBASE_ROOT;
  exportId: string;
  createdAtMs: number;
  freezeGeneration: number;
  pageSize: number;
  baseline: Baseline;
};
type ExportPage = {
  schemaVersion: 1;
  index: number;
  after: string | null;
  inviteKeys: string[];
  rows: WagerRow[];
};
type PageProof = {
  index: number;
  digest: string;
  lastInviteId: string;
  scannedInviteCount: number;
  rowCount: number;
};
type Manifest = {
  session: ExportSession;
  source: SourceSummary;
  pages: PageProof[];
};
type Dependencies = {
  assertInviteSourceAvailable?(): Promise<void>;
  now(): number;
  log(value: JsonRecord): void;
  readMaintenance(): Promise<Maintenance>;
  readActivation(): Promise<Activation>;
  readBaseline(): Promise<Baseline>;
  readInvitePage(after: string | null, pageSize: number): Promise<unknown>;
  beginImport(manifest: Manifest): Promise<void>;
  importRows(manifest: Manifest, rows: WagerRow[]): Promise<void>;
  readRows(rows: WagerRow[]): Promise<StoredWagerRow[]>;
  countRows(): Promise<Counts & { nonInitialRevisions: number }>;
  finishImport(manifest: Manifest): Promise<void>;
  recordVerification(
    manifest: Manifest,
    versionId: string,
    nowMs: number,
  ): Promise<void>;
  activate(manifest: Manifest, versionId: string, nowMs: number): Promise<void>;
};

const PROJECT_ID = "mons-link";
const FIREBASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const PROFILE_DATABASE = "mons-link-profiles";
const GAMEPLAY_DATABASE = "mons-link-profile-games";
const ROOT = resolve(import.meta.dirname, "..");
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 100_000;
const ROW_BATCH_SIZE = 20;
const D1_PAGE_SIZE = 100;
const VERSION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LEDGER_TABLES = [
  { table: "profile_records", keys: ["profile_id"] },
  { table: "wager_frozen_balances", keys: ["player_uid"] },
  { table: "wager_frozen_operations", keys: ["player_uid", "operation_id"] },
  { table: "wager_settlements", keys: ["operation_id"] },
] as const;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function firebaseKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 768 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!;
      return code > 0x1f && code !== 0x7f && !".#$/[]".includes(character);
    })
  );
}

function canonicalJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    )
      return entry;
    if (typeof entry === "number") {
      if (
        !Number.isFinite(entry) ||
        (Number.isInteger(entry) && !Number.isSafeInteger(entry))
      ) {
        throw new Error("unsafe-json-number");
      }
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    const object = record(entry);
    if (!object) throw new Error("invalid-json-value");
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, visit(object[key])]),
    );
  };
  return JSON.stringify(visit(value));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("invalid JSON input; private contents were not logged");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compareFirebaseKeys(left: string, right: string): number {
  const asInteger = (value: string): number | null => {
    if (!/^-?(0*)\d{1,10}$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) &&
      parsed >= -2147483648 &&
      parsed <= 2147483647
      ? parsed
      : null;
  };
  const leftNumber = asInteger(left);
  const rightNumber = asInteger(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber || left.length - right.length;
  }
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArgs(argv: string[]): Arguments {
  const operation = argv[0]?.replace(/^--/, "");
  if (
    !["status", "preflight", "export", "import", "verify", "activate"].includes(
      operation,
    )
  ) {
    throw new Error(
      "choose --status, --preflight, --export, --import, --verify or --activate",
    );
  }
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !value ||
      value.startsWith("--") ||
      options.has(key) ||
      ![
        "--directory",
        "--firebase-credentials",
        "--candidate-version-id",
        "--page-size",
      ].includes(key)
    ) {
      throw new Error("invalid wager state arguments");
    }
    options.set(key, value);
  }
  const directory = options.get("--directory");
  const firebaseCredentials = options.get("--firebase-credentials");
  const candidateVersionId = options.get("--candidate-version-id");
  const pageSize = Number(options.get("--page-size") || 25);
  if (!integer(pageSize) || pageSize < 1 || pageSize > 100)
    throw new Error("page size must be between 1 and 100");
  if (operation === "status" && options.size !== 0)
    throw new Error("status takes no options");
  if (
    operation !== "status" &&
    operation !== "preflight" &&
    (!directory || !isAbsolute(directory))
  )
    throw new Error(
      "an absolute --directory outside the repository is required",
    );
  if (firebaseCredentials && !isAbsolute(firebaseCredentials))
    throw new Error("Firebase credential path must be absolute");
  if (
    (operation === "verify" || operation === "activate") &&
    (!candidateVersionId || !VERSION_PATTERN.test(candidateVersionId))
  ) {
    throw new Error(
      "verify and activate require --candidate-version-id with an uploaded version UUID",
    );
  }
  if (candidateVersionId && operation !== "verify" && operation !== "activate")
    throw new Error("candidate version is only valid for verify or activate");
  if (
    options.has("--page-size") &&
    operation !== "export" &&
    operation !== "preflight"
  )
    throw new Error("page size is only valid for export or preflight");
  if (operation === "preflight" && directory)
    throw new Error("preflight writes no artifacts and takes no directory");
  if (firebaseCredentials && operation === "import")
    throw new Error(
      "import reads the immutable export and does not use Firebase credentials",
    );
  return {
    operation: operation as Operation,
    directory,
    firebaseCredentials,
    candidateVersionId,
    pageSize,
  };
}

function privateDirectory(directory: string): string {
  const path = resolve(directory);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive: true });
  const stat = lstatSync(path);
  const real = realpathSync(path);
  const fromRoot = relative(realpathSync(ROOT), real);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== process.getuid?.() ||
    (fromRoot !== ".." && !fromRoot.startsWith("../"))
  ) {
    throw new Error(
      "artifact directory must be owned by this user, mode 0700, outside the repository, and not a symlink",
    );
  }
  return real;
}

function readPrivateJson(path: string, allowReadOnly = false): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      ((stat.mode & 0o777) !== 0o600 &&
        !(allowReadOnly && (stat.mode & 0o777) === 0o400)) ||
      stat.uid !== process.getuid?.() ||
      stat.size > MAX_FILE_BYTES
    ) {
      throw new Error(
        "artifact must be a private regular file no larger than 64 MiB",
      );
    }
    if (!allowReadOnly && stat.nlink === 2) {
      const directory = privateDirectory(dirname(path));
      for (const name of readdirSync(directory)) {
        if (
          !name.startsWith(".partial-") ||
          !VERSION_PATTERN.test(name.slice(9))
        )
          continue;
        const partial = resolve(directory, name);
        if (name === basename(path)) continue;
        const linked = lstatSync(partial, { throwIfNoEntry: false });
        if (
          linked?.isFile() &&
          linked.dev === stat.dev &&
          linked.ino === stat.ino
        ) {
          rmSync(partial, { force: true });
          break;
        }
      }
    }
    if (fstatSync(fd).nlink !== 1)
      throw new Error("artifact must not have unrelated hard links");
    const value = parseJson(readFileSync(fd, "utf8"));
    canonicalJson(value);
    return value;
  } finally {
    closeSync(fd);
  }
}

function writePrivateImmutable(path: string, value: unknown): void {
  const data = canonicalJson(value) + "\n";
  if (Buffer.byteLength(data) > MAX_FILE_BYTES)
    throw new Error("artifact page is too large; reduce export page size");
  if (existsSync(path)) {
    if (canonicalJson(readPrivateJson(path)) !== canonicalJson(value))
      throw new Error("immutable artifact conflict");
    return;
  }
  const temporary = resolve(dirname(path), `.partial-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (
        !existsSync(path) ||
        canonicalJson(readPrivateJson(path)) !== canonicalJson(value)
      )
        throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function pagePath(directory: string, index: number): string {
  return resolve(directory, `source-${String(index).padStart(6, "0")}.json`);
}

function parseWagerRow(value: unknown): WagerRow {
  const row = record(value);
  if (
    !row ||
    !firebaseKey(row.inviteId) ||
    !firebaseKey(row.matchId) ||
    (row.wagerJson !== null && typeof row.wagerJson !== "string") ||
    ![null, 0, 1].includes(row.resolutionMarker as number | null)
  ) {
    throw new Error("invalid exported wager row");
  }
  if (row.wagerJson === null && row.resolutionMarker === null)
    throw new Error("empty exported wager row");
  if (
    typeof row.wagerJson === "string" &&
    canonicalJson(parseJson(row.wagerJson)) !== row.wagerJson
  )
    throw new Error("noncanonical exported wager JSON");
  if (typeof row.wagerJson === "string" && !record(parseJson(row.wagerJson)))
    throw new Error(
      `non-object wager aggregate: ${row.inviteId}/${row.matchId}`,
    );
  return {
    inviteId: row.inviteId,
    matchId: row.matchId,
    wagerJson: row.wagerJson as string | null,
    resolutionMarker: row.resolutionMarker as 0 | 1 | null,
  };
}

function normalizeSourcePage(
  value: unknown,
  index: number,
  after: string | null,
  pageSize: number,
  allowNonObjectWagers = false,
): ExportPage {
  const source = value === null ? {} : record(value);
  if (!source) throw new Error("invalid Firebase invite page");
  const allKeys = Object.keys(source).sort(compareFirebaseKeys);
  if (
    allKeys.length > pageSize + (after === null ? 0 : 1) ||
    allKeys.some((key) => !firebaseKey(key))
  )
    throw new Error("invalid Firebase pagination response");
  if (after !== null && (allKeys[0] !== after || !Object.hasOwn(source, after)))
    throw new Error("Firebase pagination cursor changed during export");
  const inviteKeys = after === null ? allKeys : allKeys.slice(1);
  if (
    inviteKeys.some(
      (key) => after !== null && compareFirebaseKeys(key, after) <= 0,
    )
  )
    throw new Error("Firebase pagination did not advance");
  const rows: WagerRow[] = [];
  for (const inviteId of inviteKeys) {
    const invite = record(source[inviteId]);
    if (!invite)
      throw new Error(
        "invalid Firebase invite aggregate; preserve and reconcile before migration",
      );
    const wagers =
      invite.wagers === undefined || invite.wagers === null
        ? {}
        : record(invite.wagers);
    const markers =
      invite.matchesWagerResolutions === undefined ||
      invite.matchesWagerResolutions === null
        ? {}
        : record(invite.matchesWagerResolutions);
    if (!wagers || !markers)
      throw new Error(
        "invalid wager or resolution-map aggregate; migration must not discard it",
      );
    for (const matchId of Array.from(
      new Set([...Object.keys(wagers), ...Object.keys(markers)]),
    ).sort()) {
      if (!firebaseKey(matchId)) throw new Error("invalid wager match key");
      const marker = Object.hasOwn(markers, matchId) ? markers[matchId] : null;
      if (marker !== null && typeof marker !== "boolean")
        throw new Error(
          "nonboolean wager resolution marker; migration must not discard it",
        );
      const wagerJson = Object.hasOwn(wagers, matchId)
        ? canonicalJson(wagers[matchId])
        : null;
      if (
        !allowNonObjectWagers &&
        wagerJson !== null &&
        !record(wagers[matchId])
      )
        throw new Error(`non-object wager aggregate: ${inviteId}/${matchId}`);
      rows.push({
        inviteId,
        matchId,
        wagerJson,
        resolutionMarker: marker === null ? null : marker ? 1 : 0,
      });
    }
  }
  return { schemaVersion: 1, index, after, inviteKeys, rows };
}

function parsePage(
  value: unknown,
  index: number,
  after: string | null,
): ExportPage {
  const page = record(value);
  if (
    !page ||
    page.schemaVersion !== 1 ||
    page.index !== index ||
    page.after !== after ||
    !Array.isArray(page.inviteKeys) ||
    page.inviteKeys.length === 0 ||
    !page.inviteKeys.every(firebaseKey) ||
    !Array.isArray(page.rows)
  )
    throw new Error("invalid export page");
  const keys = page.inviteKeys as string[];
  if (
    keys.some(
      (key, offset) =>
        compareFirebaseKeys(
          key,
          offset === 0 ? (after ?? key) : keys[offset - 1],
        ) <= 0 &&
        (offset > 0 || after !== null),
    )
  )
    throw new Error("unordered export page");
  const rows = page.rows.map(parseWagerRow);
  let previous = -1;
  let previousMatch = "";
  for (const row of rows) {
    const current = keys.indexOf(row.inviteId);
    if (
      current < 0 ||
      current < previous ||
      (current === previous && row.matchId <= previousMatch)
    )
      throw new Error("duplicate or unordered exported wager row");
    previous = current;
    previousMatch = row.matchId;
  }
  return { schemaVersion: 1, index, after, inviteKeys: keys, rows };
}

function parseBaseline(value: unknown): Baseline {
  const baseline = record(value);
  if (
    !baseline ||
    !Array.isArray(baseline.tables) ||
    baseline.tables.length !== LEDGER_TABLES.length
  )
    throw new Error("invalid ledger baseline");
  const tables = baseline.tables.map((value, index) => {
    const table = record(value);
    if (
      !table ||
      table.table !== LEDGER_TABLES[index].table ||
      !integer(table.count) ||
      typeof table.digest !== "string" ||
      !DIGEST_PATTERN.test(table.digest)
    )
      throw new Error("invalid ledger baseline table");
    return {
      table: table.table as string,
      count: table.count,
      digest: table.digest,
    };
  });
  if (baseline.digest !== digest(tables))
    throw new Error("ledger baseline digest mismatch");
  return { digest: baseline.digest as string, tables };
}

function parseSession(value: unknown): ExportSession {
  const session = record(value);
  if (
    !session ||
    session.schemaVersion !== 1 ||
    session.projectId !== PROJECT_ID ||
    session.firebaseRoot !== FIREBASE_ROOT ||
    typeof session.exportId !== "string" ||
    !VERSION_PATTERN.test(session.exportId) ||
    !integer(session.createdAtMs) ||
    !integer(session.freezeGeneration) ||
    !integer(session.pageSize) ||
    session.pageSize < 1 ||
    session.pageSize > 100
  )
    throw new Error("invalid export session");
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    firebaseRoot: FIREBASE_ROOT,
    exportId: session.exportId,
    createdAtMs: session.createdAtMs,
    freezeGeneration: session.freezeGeneration,
    pageSize: session.pageSize,
    baseline: parseBaseline(session.baseline),
  };
}

function sourceAccumulator() {
  const hash = createHash("sha256");
  let rowCount = 0;
  let wagerCount = 0;
  let markerCount = 0;
  let scannedInviteCount = 0;
  return {
    add(page: ExportPage) {
      for (const row of page.rows) {
        hash.update(canonicalJson(row) + "\n");
        rowCount++;
        if (row.wagerJson !== null) wagerCount++;
        if (row.resolutionMarker !== null) markerCount++;
      }
      scannedInviteCount += page.inviteKeys.length;
    },
    finish(): SourceSummary {
      return {
        digest: hash.digest("hex"),
        rowCount,
        wagerCount,
        markerCount,
        scannedInviteCount,
      };
    },
  };
}

function pageProof(page: ExportPage): PageProof {
  return {
    index: page.index,
    digest: digest(page),
    lastInviteId: page.inviteKeys.at(-1)!,
    scannedInviteCount: page.inviteKeys.length,
    rowCount: page.rows.length,
  };
}

function loadExport(directory: string): Manifest {
  const value = record(readPrivateJson(resolve(directory, "manifest.json")));
  if (!value || !Array.isArray(value.pages) || value.pages.length > MAX_PAGES)
    throw new Error("invalid export manifest");
  const session = parseSession(value.session);
  if (
    canonicalJson(readPrivateJson(resolve(directory, "session.json"))) !==
    canonicalJson(session)
  )
    throw new Error("export session conflict");
  const accumulator = sourceAccumulator();
  const pages: PageProof[] = [];
  let after: string | null = null;
  for (let index = 0; index < value.pages.length; index++) {
    const page = parsePage(
      readPrivateJson(pagePath(directory, index)),
      index,
      after,
    );
    if (page.inviteKeys.length > session.pageSize)
      throw new Error("export page exceeds configured size");
    const proof = pageProof(page);
    if (canonicalJson(proof) !== canonicalJson(value.pages[index]))
      throw new Error("export page digest mismatch");
    accumulator.add(page);
    pages.push(proof);
    after = proof.lastInviteId;
  }
  const source = accumulator.finish();
  if (canonicalJson(source) !== canonicalJson(value.source))
    throw new Error("export manifest source digest mismatch");
  const sourceFiles = readdirSync(directory).filter((name) =>
    /^source-\d+\.json$/.test(name),
  );
  if (sourceFiles.length !== pages.length)
    throw new Error("export contains unmanifested source pages");
  return { session, source, pages };
}

async function assertFrozen(
  dependencies: Dependencies,
  generation?: number,
): Promise<Maintenance> {
  const state = await dependencies.readMaintenance();
  if (state.profileState !== "frozen" || state.reservationState !== "frozen")
    throw new Error("freeze canonical profiles and wager reservations first");
  if (
    !integer(state.freezeGeneration) ||
    (generation !== undefined && state.freezeGeneration !== generation)
  )
    throw new Error(
      "wager freeze generation changed; retain export and start a separately reconciled cutover",
    );
  if (state.admissions !== 0 || state.activeGameplayLeases !== 0)
    throw new Error(
      "wager admissions and gameplay leases must be drained and uncertain source effects reconciled",
    );
  return state;
}

async function assertBaseline(
  dependencies: Dependencies,
  expected: Baseline,
): Promise<void> {
  if (
    canonicalJson(await dependencies.readBaseline()) !== canonicalJson(expected)
  )
    throw new Error(
      "profile balances, frozen reservations, operation tombstones or settlement receipts changed",
    );
}

async function exportSource(
  directory: string,
  args: Arguments,
  dependencies: Dependencies,
): Promise<Manifest> {
  if ((await dependencies.readActivation()).activationEpoch !== 0)
    throw new Error(
      "wager state is already activated; source export is retired",
    );
  const maintenance = await assertFrozen(dependencies);
  const sessionFile = resolve(directory, "session.json");
  if (!existsSync(sessionFile)) {
    const baseline = await dependencies.readBaseline();
    await assertFrozen(dependencies, maintenance.freezeGeneration);
    writePrivateImmutable(sessionFile, {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      firebaseRoot: FIREBASE_ROOT,
      exportId: randomUUID(),
      createdAtMs: dependencies.now(),
      freezeGeneration: maintenance.freezeGeneration,
      pageSize: args.pageSize,
      baseline,
    });
  }
  const session = parseSession(readPrivateJson(sessionFile));
  if (session.pageSize !== args.pageSize)
    throw new Error("resume export with its original page size");
  await assertFrozen(dependencies, session.freezeGeneration);
  await assertBaseline(dependencies, session.baseline);
  if (existsSync(resolve(directory, "manifest.json")))
    return loadExport(directory);
  const accumulator = sourceAccumulator();
  const pages: PageProof[] = [];
  let after: string | null = null;
  let scannedInviteCount = 0;
  for (let index = 0; ; index++) {
    if (index >= MAX_PAGES) throw new Error("export page limit exceeded");
    await assertFrozen(dependencies, session.freezeGeneration);
    const path = pagePath(directory, index);
    const page: ExportPage = existsSync(path)
      ? parsePage(readPrivateJson(path), index, after)
      : normalizeSourcePage(
          await dependencies.readInvitePage(after, session.pageSize),
          index,
          after,
          session.pageSize,
        );
    if (page.inviteKeys.length === 0) break;
    if (page.inviteKeys.length > session.pageSize)
      throw new Error("export page exceeds configured size");
    writePrivateImmutable(path, page);
    accumulator.add(page);
    pages.push(pageProof(page));
    after = page.inviteKeys.at(-1)!;
    scannedInviteCount += page.inviteKeys.length;
    dependencies.log({
      event: "wager_state_export_progress",
      pages: pages.length,
      scannedInvites: scannedInviteCount,
    });
  }
  await assertFrozen(dependencies, session.freezeGeneration);
  await assertBaseline(dependencies, session.baseline);
  const manifest: Manifest = { session, source: accumulator.finish(), pages };
  writePrivateImmutable(resolve(directory, "manifest.json"), manifest);
  return loadExport(directory);
}

async function verifyDestination(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  const accumulator = sourceAccumulator();
  let after: string | null = null;
  for (const proof of manifest.pages) {
    const page = parsePage(
      readPrivateJson(pagePath(directory, proof.index)),
      proof.index,
      after,
    );
    const found: WagerRow[] = [];
    for (let index = 0; index < page.rows.length; index += ROW_BATCH_SIZE) {
      const expected = page.rows.slice(index, index + ROW_BATCH_SIZE);
      const actual = await dependencies.readRows(expected);
      const byKey = new Map(
        actual.map((row) => [canonicalJson([row.inviteId, row.matchId]), row]),
      );
      if (byKey.size !== expected.length || actual.length !== expected.length)
        throw new Error("destination wager rows are missing or duplicated");
      for (const row of expected) {
        const stored = byKey.get(canonicalJson([row.inviteId, row.matchId]));
        if (
          !stored ||
          stored.revision !== 1 ||
          stored.updatedAtMs !== manifest.session.createdAtMs
        )
          throw new Error(
            "destination row is not the immutable imported revision",
          );
        const candidate = {
          inviteId: stored.inviteId,
          matchId: stored.matchId,
          wagerJson: stored.wagerJson,
          resolutionMarker: stored.resolutionMarker,
        };
        if (canonicalJson(candidate) !== canonicalJson(row))
          throw new Error("destination wager payload conflict");
        found.push(candidate);
      }
    }
    accumulator.add({ ...page, rows: found });
    after = proof.lastInviteId;
  }
  const summary = accumulator.finish();
  const counts = await dependencies.countRows();
  if (
    canonicalJson(summary) !== canonicalJson(manifest.source) ||
    counts.nonInitialRevisions !== 0 ||
    counts.rowCount !== summary.rowCount ||
    counts.wagerCount !== summary.wagerCount ||
    counts.markerCount !== summary.markerCount
  )
    throw new Error(
      "destination contains extra, missing or changed wager state",
    );
}

async function importSource(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  if ((await dependencies.readActivation()).activationEpoch !== 0)
    throw new Error("activated wager state cannot be imported or overwritten");
  await assertFrozen(dependencies, manifest.session.freezeGeneration);
  await assertBaseline(dependencies, manifest.session.baseline);
  await dependencies.beginImport(manifest);
  let after: string | null = null;
  for (const proof of manifest.pages) {
    const page = parsePage(
      readPrivateJson(pagePath(directory, proof.index)),
      proof.index,
      after,
    );
    for (let index = 0; index < page.rows.length; index += ROW_BATCH_SIZE) {
      await assertFrozen(dependencies, manifest.session.freezeGeneration);
      await dependencies.importRows(
        manifest,
        page.rows.slice(index, index + ROW_BATCH_SIZE),
      );
    }
    after = proof.lastInviteId;
    dependencies.log({
      event: "wager_state_import_progress",
      pages: proof.index + 1,
      totalPages: manifest.pages.length,
    });
  }
  await verifyDestination(directory, manifest, dependencies);
  await assertBaseline(dependencies, manifest.session.baseline);
  await assertFrozen(dependencies, manifest.session.freezeGeneration);
  await dependencies.finishImport(manifest);
}

async function verifySource(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  const accumulator = sourceAccumulator();
  let after: string | null = null;
  for (let index = 0; ; index++) {
    if (index > manifest.pages.length)
      throw new Error("Firebase source grew after export");
    await assertFrozen(dependencies, manifest.session.freezeGeneration);
    const page = normalizeSourcePage(
      await dependencies.readInvitePage(after, manifest.session.pageSize),
      index,
      after,
      manifest.session.pageSize,
    );
    if (page.inviteKeys.length === 0) {
      if (index !== manifest.pages.length)
        throw new Error("Firebase source shrank after export");
      break;
    }
    if (
      !manifest.pages[index] ||
      digest(page) !== manifest.pages[index].digest ||
      canonicalJson(page) !==
        canonicalJson(readPrivateJson(pagePath(directory, index)))
    )
      throw new Error("Firebase wager source changed after export");
    accumulator.add(page);
    after = page.inviteKeys.at(-1)!;
  }
  if (canonicalJson(accumulator.finish()) !== canonicalJson(manifest.source))
    throw new Error("Firebase source digest mismatch");
}

function assertImported(activation: Activation, manifest: Manifest): void {
  if (
    activation.activationEpoch !== 0 ||
    activation.importAttemptId !== null ||
    activation.sourceDigest !== manifest.source.digest ||
    activation.importDigest !== manifest.source.digest ||
    activation.baselineDigest !== manifest.session.baseline.digest ||
    activation.sourceRowCount !== manifest.source.rowCount ||
    activation.importedRowCount !== manifest.source.rowCount ||
    activation.sourceWagerCount !== manifest.source.wagerCount ||
    activation.sourceMarkerCount !== manifest.source.markerCount
  )
    throw new Error("import is incomplete or belongs to another export");
}

function assertVerification(
  activation: Activation,
  manifest: Manifest,
  versionId: string,
): void {
  if (
    activation.sourceDigest !== manifest.source.digest ||
    activation.importDigest !== manifest.source.digest ||
    activation.baselineDigest !== manifest.session.baseline.digest ||
    activation.verifiedBaselineDigest !== manifest.session.baseline.digest ||
    activation.verifiedFreezeGeneration !== manifest.session.freezeGeneration ||
    activation.candidateVersionId !== versionId ||
    activation.verifiedAtMs === null
  )
    throw new Error(
      "activation verification proof does not match this export and candidate",
    );
}

async function verifyImport(
  directory: string,
  manifest: Manifest,
  versionId: string,
  dependencies: Dependencies,
): Promise<void> {
  await assertFrozen(dependencies, manifest.session.freezeGeneration);
  assertImported(await dependencies.readActivation(), manifest);
  await assertBaseline(dependencies, manifest.session.baseline);
  await verifySource(directory, manifest, dependencies);
  await verifyDestination(directory, manifest, dependencies);
  await assertBaseline(dependencies, manifest.session.baseline);
  await assertFrozen(dependencies, manifest.session.freezeGeneration);
  await dependencies.recordVerification(
    manifest,
    versionId,
    dependencies.now(),
  );
  const activation = await dependencies.readActivation();
  assertImported(activation, manifest);
  assertVerification(activation, manifest, versionId);
}

async function manageWagerState(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation !== "status")
    await dependencies.assertInviteSourceAvailable?.();
  if (args.operation === "preflight") {
    const accumulator = sourceAccumulator();
    const states = {
      proposalRows: 0,
      agreedRows: 0,
      pendingSettlements: 0,
      completedSettlements: 0,
      resolvedRows: 0,
      markerOnlyRows: 0,
      nonObjectWagers: 0,
    };
    const unsupportedWagers: Array<{ inviteId: string; matchId: string }> = [];
    let after: string | null = null;
    for (let index = 0; ; index++) {
      if (index >= MAX_PAGES) throw new Error("preflight page limit exceeded");
      const page = normalizeSourcePage(
        await dependencies.readInvitePage(after, args.pageSize),
        index,
        after,
        args.pageSize,
        true,
      );
      if (page.inviteKeys.length === 0) break;
      accumulator.add(page);
      for (const row of page.rows) {
        if (row.wagerJson === null) {
          states.markerOnlyRows++;
          continue;
        }
        const wager = record(parseJson(row.wagerJson));
        if (!wager) {
          states.nonObjectWagers++;
          if (unsupportedWagers.length < 100)
            unsupportedWagers.push({
              inviteId: row.inviteId,
              matchId: row.matchId,
            });
          continue;
        }
        if (wager.proposals) states.proposalRows++;
        if (wager.agreed) states.agreedRows++;
        if (wager.resolved) states.resolvedRows++;
        const settlement = record(wager.settlement);
        if (settlement?.state === "pending") states.pendingSettlements++;
        if (settlement?.state === "completed") states.completedSettlements++;
      }
      after = page.inviteKeys.at(-1)!;
    }
    dependencies.log({
      operation: "preflight",
      maintenance: await dependencies.readMaintenance(),
      source: accumulator.finish(),
      states,
      unsupportedWagers,
      activationProof: false,
    });
    return;
  }
  if (args.operation === "status") {
    dependencies.log({
      operation: "status",
      maintenance: await dependencies.readMaintenance(),
      activation: await dependencies.readActivation(),
      destination: await dependencies.countRows(),
    });
    return;
  }
  const directory = privateDirectory(args.directory!);
  const manifest =
    args.operation === "export"
      ? await exportSource(directory, args, dependencies)
      : loadExport(directory);
  if (args.operation === "import")
    await importSource(directory, manifest, dependencies);
  if (args.operation === "verify")
    await verifyImport(
      directory,
      manifest,
      args.candidateVersionId!,
      dependencies,
    );
  if (args.operation === "activate") {
    const activation = await dependencies.readActivation();
    if (activation.activationEpoch === 1) {
      assertVerification(activation, manifest, args.candidateVersionId!);
      if (activation.activatedAtMs === null)
        throw new Error("activated wager state has no activation timestamp");
      dependencies.log({
        operation: "activate",
        alreadyActivated: true,
        activation,
      });
      return;
    }
    await verifyImport(
      directory,
      manifest,
      args.candidateVersionId!,
      dependencies,
    );
    await dependencies.activate(
      manifest,
      args.candidateVersionId!,
      dependencies.now(),
    );
    const after = await dependencies.readActivation();
    assertVerification(after, manifest, args.candidateVersionId!);
    if (after.activationEpoch !== 1 || after.activatedAtMs === null)
      throw new Error(
        "activation outcome is unconfirmed; keep writes frozen and retry the same command",
      );
  }
  dependencies.log({
    operation: args.operation,
    exportId: manifest.session.exportId,
    source: manifest.source,
    baseline: manifest.session.baseline,
    activation: await dependencies.readActivation(),
  });
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

type SqlBinding = string | number | null;
type SqlRunner = (
  sql: string,
  database?: string,
  bindings?: SqlBinding[],
) => Promise<JsonRecord[]>;

function parseD1Results(response: unknown): JsonRecord[] {
  if (!Array.isArray(response) || response.length === 0)
    throw new Error("invalid D1 query response");
  return response.flatMap((entry) => {
    const result = record(entry);
    if (!result || result.success === false || !Array.isArray(result.results))
      throw new Error("D1 query was not confirmed");
    return result.results.map((value: unknown) => {
      const row = record(value);
      if (!row) throw new Error("invalid D1 query result row");
      if (Object.hasOwn(row, "Total queries executed"))
        throw new Error("D1 bulk import summary cannot verify query results");
      return row;
    });
  });
}

function createWranglerRunner({
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  fetcher = fetch,
}: { apiToken?: string; fetcher?: typeof fetch } = {}): SqlRunner {
  return async (sql, database = PROFILE_DATABASE, bindings = []) => {
    if (bindings.length > 100 || Buffer.byteLength(sql) > 90 * 1024)
      throw new Error("D1 query exceeds the bounded SQL or parameter limit");
    if (apiToken) {
      const require = createRequire(import.meta.url);
      const typescript = require("typescript") as typeof import("typescript");
      const configPath = resolve(ROOT, "cloud/workers/api/wrangler.jsonc");
      const parsed = typescript.parseConfigFileTextToJson(
        configPath,
        readFileSync(configPath, "utf8"),
      );
      const config = record(parsed.config);
      const accountId = config?.account_id;
      const databases = config?.d1_databases;
      const entry = Array.isArray(databases)
        ? databases.map(record).find((item) => item?.database_name === database)
        : null;
      const databaseId = entry?.database_id;
      if (
        parsed.error ||
        typeof accountId !== "string" ||
        !/^[a-f0-9]{32}$/.test(accountId) ||
        typeof databaseId !== "string" ||
        !VERSION_PATTERN.test(databaseId)
      )
        throw new Error("invalid tracked D1 account or database configuration");
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sql, params: bindings }),
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
      );
      const payload = record(await readResponseJson(response));
      if (!payload || payload.success !== true)
        throw new Error(
          "D1 query failed; keep writes frozen and inspect migration status",
        );
      return parseD1Results(payload.result);
    }
    if (bindings.length > 0 || !sql.trimStart().startsWith("SELECT "))
      throw new Error(
        "set CLOUDFLARE_API_TOKEN for parameterized migration writes; private wager contents must not enter command arguments",
      );
    const directory = mkdtempSync(resolve(tmpdir(), "mons-wager-state-sql-"));
    try {
      const result = spawnSync(
        resolve(ROOT, "node_modules/.bin/wrangler"),
        [
          "d1",
          "execute",
          database,
          "--remote",
          "--command",
          sql,
          "--json",
          "--config",
          "cloud/workers/api/wrangler.jsonc",
          "--env-file",
          "cloud/workers/api/release.env",
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          maxBuffer: MAX_FILE_BYTES,
          shell: false,
          env: {
            ...process.env,
            WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"),
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );
      if (result.status !== 0)
        throw new Error(
          "D1 operation failed; keep maintenance controls frozen and retry after inspecting state",
        );
      return parseD1Results(parseJson(result.stdout));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function parseActivation(value: unknown): Activation {
  const row = record(value);
  if (!row || (row.activation_epoch !== 0 && row.activation_epoch !== 1))
    throw new Error(
      "missing or invalid wager state activation control; apply the reviewed schema while frozen first",
    );
  const nullableString = (key: string) => {
    if (row[key] === null) return null;
    if (typeof row[key] !== "string" || !row[key])
      throw new Error("invalid wager activation string");
    return row[key] as string;
  };
  const nullableInteger = (key: string) => {
    if (row[key] === null) return null;
    if (!integer(row[key])) throw new Error("invalid wager activation integer");
    return row[key] as number;
  };
  const result: Activation = {
    activationEpoch: row.activation_epoch,
    importAttemptId: nullableString("import_attempt_id"),
    sourceDigest: nullableString("source_digest"),
    importDigest: nullableString("import_digest"),
    baselineDigest: nullableString("baseline_digest"),
    verifiedBaselineDigest: nullableString("verified_baseline_digest"),
    sourceWagerCount: nullableInteger("source_wager_count"),
    sourceMarkerCount: nullableInteger("source_marker_count"),
    sourceRowCount: nullableInteger("source_row_count"),
    importedRowCount: nullableInteger("imported_row_count"),
    verifiedFreezeGeneration: nullableInteger("verified_freeze_generation"),
    verifiedAtMs: nullableInteger("verified_at_ms"),
    activatedAtMs: nullableInteger("activated_at_ms"),
    candidateVersionId: nullableString("candidate_version_id"),
  };
  for (const value of [
    result.sourceDigest,
    result.importDigest,
    result.baselineDigest,
    result.verifiedBaselineDigest,
  ])
    if (value !== null && !DIGEST_PATTERN.test(value))
      throw new Error("invalid wager activation digest");
  return result;
}

function importGuard(manifest: Manifest): string {
  return `activation_epoch = 0 AND EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen') AND EXISTS (SELECT 1 FROM wager_reservation_runtime_control WHERE singleton = 1 AND storage_mode = 'frozen' AND freeze_generation = ${manifest.session.freezeGeneration}) AND NOT EXISTS (SELECT 1 FROM wager_reservation_write_admissions)`;
}

function createSqlDependencies(
  run: SqlRunner,
  sourceReader: Dependencies["readInvitePage"],
  now = Date.now,
): Dependencies {
  const readActivation = async () =>
    parseActivation(
      (
        await run("SELECT * FROM wager_state_activation WHERE singleton = 1")
      )[0],
    );
  const requireOne = async (sql: string) => {
    if ((await run(sql)).length !== 1)
      throw new Error("wager state control update conflicted");
  };
  const readMaintenance = async (): Promise<Maintenance> => {
    const row = (
      await run(
        "SELECT profile.state AS profile_state, reservation.storage_mode AS reservation_state, reservation.freeze_generation, (SELECT COUNT(*) FROM wager_reservation_write_admissions) AS admissions FROM profile_canonical_control AS profile JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1 WHERE profile.singleton = 1",
      )
    )[0];
    const lease = (
      await run(
        `SELECT COUNT(*) AS count FROM game_session_mutation_locks WHERE expires_at_ms > ${now()}`,
        GAMEPLAY_DATABASE,
      )
    )[0];
    if (
      !row ||
      typeof row.profile_state !== "string" ||
      typeof row.reservation_state !== "string" ||
      !integer(row.freeze_generation) ||
      !integer(row.admissions) ||
      !integer(lease?.count)
    )
      throw new Error("invalid maintenance control response");
    return {
      profileState: row.profile_state,
      reservationState: row.reservation_state,
      freezeGeneration: row.freeze_generation,
      admissions: row.admissions,
      activeGameplayLeases: lease.count,
    };
  };
  const readBaseline = async (): Promise<Baseline> => {
    const tables: BaselineTable[] = [];
    for (const definition of LEDGER_TABLES) {
      const hash = createHash("sha256");
      let count = 0;
      let cursor: string[] | null = null;
      for (;;) {
        const where =
          cursor === null
            ? ""
            : `WHERE (${definition.keys.join(", ")}) > (${cursor.map(sqlText).join(", ")})`;
        const rows = await run(
          `SELECT * FROM ${definition.table} ${where} ORDER BY ${definition.keys.join(", ")} LIMIT ${D1_PAGE_SIZE}`,
        );
        if (rows.length > D1_PAGE_SIZE)
          throw new Error("oversized ledger page");
        if (rows.length === 0) break;
        for (const row of rows) {
          hash.update(canonicalJson(row) + "\n");
          count++;
        }
        const next = definition.keys.map((key) => {
          const value = rows.at(-1)![key];
          if (typeof value !== "string")
            throw new Error("invalid ledger pagination key");
          return value;
        });
        if (cursor !== null && canonicalJson(next) === canonicalJson(cursor))
          throw new Error("ledger pagination did not advance");
        cursor = next;
      }
      tables.push({
        table: definition.table,
        count,
        digest: hash.digest("hex"),
      });
    }
    return { tables, digest: digest(tables) };
  };
  return {
    now,
    assertInviteSourceAvailable: () => assertFirebaseInviteSourceAvailable(run),
    log: (value) => console.log(JSON.stringify(value)),
    readMaintenance,
    readActivation,
    readBaseline,
    readInvitePage: sourceReader,
    async beginImport(manifest) {
      await requireOne(
        `UPDATE wager_state_activation SET import_attempt_id = ${sqlText(manifest.session.exportId)}, source_digest = ${sqlText(manifest.source.digest)}, import_digest = NULL, baseline_digest = ${sqlText(manifest.session.baseline.digest)}, verified_baseline_digest = NULL, source_wager_count = ${manifest.source.wagerCount}, source_marker_count = ${manifest.source.markerCount}, source_row_count = ${manifest.source.rowCount}, imported_row_count = NULL, verified_freeze_generation = NULL, verified_at_ms = NULL, candidate_version_id = NULL WHERE singleton = 1 AND ${importGuard(manifest)} AND (import_attempt_id IS NULL OR import_attempt_id = ${sqlText(manifest.session.exportId)}) AND (source_digest IS NULL OR source_digest = ${sqlText(manifest.source.digest)}) AND (baseline_digest IS NULL OR baseline_digest = ${sqlText(manifest.session.baseline.digest)}) AND NOT EXISTS (SELECT 1 FROM invite_wager_states WHERE revision != 1 OR updated_at_ms != ${manifest.session.createdAtMs}) RETURNING singleton;`,
      );
    },
    async importRows(manifest, rows) {
      if (rows.length > ROW_BATCH_SIZE)
        throw new Error("oversized import batch");
      if (rows.length === 0) return;
      await run(
        `WITH imported(invite_id, match_id, wager_json, resolution_marker) AS (VALUES ${rows.map(() => "(?, ?, ?, ?)").join(", ")}) INSERT INTO invite_wager_states (invite_id, match_id, wager_json, resolution_marker, revision, updated_at_ms) SELECT invite_id, match_id, wager_json, resolution_marker, 1, ${manifest.session.createdAtMs} FROM imported WHERE EXISTS (SELECT 1 FROM wager_state_activation WHERE singleton = 1 AND ${importGuard(manifest)} AND import_attempt_id = ${sqlText(manifest.session.exportId)} AND source_digest = ${sqlText(manifest.source.digest)}) ON CONFLICT(invite_id, match_id) DO NOTHING;`,
        PROFILE_DATABASE,
        rows.flatMap((row) => [
          row.inviteId,
          row.matchId,
          row.wagerJson,
          row.resolutionMarker,
        ]),
      );
      const stored = await this.readRows(rows);
      if (stored.length !== rows.length)
        throw new Error("wager import was not applied");
      const byKey = new Map(
        stored.map((row) => [canonicalJson([row.inviteId, row.matchId]), row]),
      );
      for (const row of rows) {
        if (
          canonicalJson(
            byKey.get(canonicalJson([row.inviteId, row.matchId])),
          ) !==
          canonicalJson({
            ...row,
            revision: 1,
            updatedAtMs: manifest.session.createdAtMs,
          })
        )
          throw new Error(
            "wager import conflicts with an existing destination row",
          );
      }
    },
    async readRows(rows) {
      if (rows.length === 0) return [];
      if (rows.length > ROW_BATCH_SIZE)
        throw new Error("oversized wager verification batch");
      const predicate = rows
        .map(
          (row) =>
            `(invite_id = ${sqlText(row.inviteId)} AND match_id = ${sqlText(row.matchId)})`,
        )
        .join(" OR ");
      return (
        await run(
          `SELECT * FROM invite_wager_states WHERE ${predicate} LIMIT ${ROW_BATCH_SIZE + 1}`,
        )
      ).map((row) => {
        const value = parseWagerRow({
          inviteId: row.invite_id,
          matchId: row.match_id,
          wagerJson: row.wager_json,
          resolutionMarker: row.resolution_marker,
        });
        if (!integer(row.revision) || !integer(row.updated_at_ms))
          throw new Error("invalid imported wager revision");
        return {
          ...value,
          revision: row.revision,
          updatedAtMs: row.updated_at_ms,
        };
      });
    },
    async countRows() {
      const row = (
        await run(
          "SELECT COUNT(*) AS row_count, COUNT(wager_json) AS wager_count, COUNT(resolution_marker) AS marker_count, COALESCE(SUM(CASE WHEN revision != 1 THEN 1 ELSE 0 END), 0) AS non_initial_revisions FROM invite_wager_states",
        )
      )[0];
      if (
        !row ||
        !integer(row.row_count) ||
        !integer(row.wager_count) ||
        !integer(row.marker_count) ||
        !integer(row.non_initial_revisions)
      )
        throw new Error("invalid wager destination counts");
      return {
        rowCount: row.row_count,
        wagerCount: row.wager_count,
        markerCount: row.marker_count,
        nonInitialRevisions: row.non_initial_revisions,
      };
    },
    async finishImport(manifest) {
      await requireOne(
        `UPDATE wager_state_activation SET import_attempt_id = NULL, import_digest = ${sqlText(manifest.source.digest)}, imported_row_count = ${manifest.source.rowCount} WHERE singleton = 1 AND ${importGuard(manifest)} AND import_attempt_id = ${sqlText(manifest.session.exportId)} AND source_digest = ${sqlText(manifest.source.digest)} RETURNING singleton;`,
      );
    },
    async recordVerification(manifest, versionId, nowMs) {
      await requireOne(
        `UPDATE wager_state_activation SET verified_baseline_digest = ${sqlText(manifest.session.baseline.digest)}, verified_freeze_generation = ${manifest.session.freezeGeneration}, verified_at_ms = ${nowMs}, candidate_version_id = ${sqlText(versionId)} WHERE singleton = 1 AND ${importGuard(manifest)} AND import_attempt_id IS NULL AND source_digest = ${sqlText(manifest.source.digest)} AND import_digest = source_digest AND baseline_digest = ${sqlText(manifest.session.baseline.digest)} RETURNING singleton;`,
      );
    },
    async activate(manifest, versionId, nowMs) {
      await requireOne(
        `UPDATE wager_state_activation SET activation_epoch = 1, activated_at_ms = ${nowMs} WHERE singleton = 1 AND ${importGuard(manifest)} AND import_attempt_id IS NULL AND source_digest = ${sqlText(manifest.source.digest)} AND import_digest = source_digest AND baseline_digest = ${sqlText(manifest.session.baseline.digest)} AND verified_baseline_digest = baseline_digest AND verified_freeze_generation = ${manifest.session.freezeGeneration} AND candidate_version_id = ${sqlText(versionId)} AND verified_at_ms IS NOT NULL RETURNING singleton;`,
      );
    },
  };
}

async function readResponseJson(
  response: Response,
  maximumBytes = MAX_FILE_BYTES,
): Promise<unknown> {
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("Content-Length")) > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      "remote query or authentication failed; no credential or response body was logged",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes)
        throw new Error("Firebase page exceeds 64 MiB; reduce page size");
      chunks.push(value);
    }
    const parsed = parseJson(Buffer.concat(chunks).toString("utf8"));
    canonicalJson(parsed);
    return parsed;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function createFirebaseTokenProvider(
  credentialsPath?: string,
): () => Promise<string> {
  let cached: { value: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const body = new URLSearchParams();
    if (credentialsPath) {
      const credentials = record(readPrivateJson(credentialsPath, true));
      if (
        !credentials ||
        credentials.type !== "service_account" ||
        typeof credentials.client_email !== "string" ||
        typeof credentials.private_key !== "string" ||
        credentials.project_id !== PROJECT_ID
      )
        throw new Error(
          "expected a private mons-link service-account credential file",
        );
      const issuedAt = Math.floor(Date.now() / 1000);
      const encoded = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const message = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({ iss: credentials.client_email, scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email", aud: "https://oauth2.googleapis.com/token", iat: issuedAt, exp: issuedAt + 3600 })}`;
      const signature = createSign("RSA-SHA256")
        .update(message)
        .sign(credentials.private_key, "base64url");
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      body.set("assertion", `${message}.${signature}`);
    } else {
      const require = createRequire(import.meta.url);
      const auth = require("firebase-tools/lib/auth.js") as {
        getProjectDefaultAccount(path: string):
          | {
              tokens?: {
                refresh_token?: string;
                access_token?: string;
                expires_at?: number;
              };
            }
          | undefined;
      };
      const api = require("firebase-tools/lib/api.js") as {
        clientId(): string;
        clientSecret(): string;
      };
      const account = auth.getProjectDefaultAccount(resolve(ROOT, "cloud"));
      const tokens = account?.tokens;
      if (
        tokens?.access_token &&
        typeof tokens.expires_at === "number" &&
        tokens.expires_at > Date.now() + 60_000
      ) {
        cached = { value: tokens.access_token, expiresAt: tokens.expires_at };
        return cached.value;
      }
      if (!tokens?.refresh_token)
        throw new Error(
          "Firebase authentication unavailable; run firebase login locally or provide --firebase-credentials",
        );
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", tokens.refresh_token);
      body.set("client_id", api.clientId());
      body.set("client_secret", api.clientSecret());
    }
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const token = record(await readResponseJson(response, 64 * 1024));
    if (
      !token ||
      typeof token.access_token !== "string" ||
      !integer(token.expires_in) ||
      token.expires_in < 1
    )
      throw new Error("invalid Firebase access-token response");
    cached = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    return cached.value;
  };
}

function createFirebaseReader(
  credentialsPath?: string,
): Dependencies["readInvitePage"] {
  const token = createFirebaseTokenProvider(credentialsPath);
  return async (after, pageSize) => {
    const url = new URL(`${FIREBASE_ROOT}/invites.json`);
    url.searchParams.set("orderBy", JSON.stringify("$key"));
    url.searchParams.set(
      "limitToFirst",
      String(pageSize + (after === null ? 0 : 1)),
    );
    if (after !== null) url.searchParams.set("startAt", JSON.stringify(after));
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: "application/json",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    return readResponseJson(response);
  };
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const dependencies = createSqlDependencies(
    createWranglerRunner(),
    createFirebaseReader(
      args.firebaseCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ),
  );
  await manageWagerState(args, dependencies);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  execute().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "wager state migration failed; keep writes frozen",
    );
    process.exitCode = 1;
  });
}

export {
  canonicalJson,
  compareFirebaseKeys,
  createSqlDependencies,
  createWranglerRunner,
  createFirebaseTokenProvider,
  digest,
  execute,
  loadExport,
  manageWagerState,
  normalizeSourcePage,
  parseActivation,
  parseArgs,
  privateDirectory,
  readPrivateJson,
  readResponseJson,
  writePrivateImmutable,
  type Activation,
  type Arguments,
  type Baseline,
  type Dependencies,
  type ExportPage,
  type Manifest,
  type Maintenance,
  type SqlRunner,
  type StoredWagerRow,
  type WagerRow,
};
