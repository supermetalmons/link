import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  inventory,
  inventoryKeys,
  parseShallowKeys,
} from "./manage-login-match-discovery.ts";
import {
  canonicalJson,
  createFirebaseTokenProvider,
  createWranglerRunner,
  digest,
  privateDirectory,
  readPrivateJson,
  readResponseJson,
  writePrivateImmutable,
  type SqlRunner,
} from "./manage-wager-state.ts";
import { normalizeHistoricalMatchRecord } from "../cloud/functions/shared/game-sessions.js";
import {
  createInviteCandidatesFromMatchId,
  parseInviteMatchIndex,
  parseRematchIndices,
} from "../cloud/functions/shared/rematches.js";
import { isMatchPresentation } from "../cloud/functions/shared/match-presentation.js";
import { isSafeFirebaseKey } from "../cloud/functions/shared/ids.js";

const ROOT = resolve(import.meta.dirname, "..");
const DATABASE = "mons-link-profile-games";
const FIREBASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const API_ROOT = "https://api.mons.link";
const PAGE_SIZE = 100;
const REQUEST_BATCH_SIZE = 25;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const GUARDS = [
  "match_presentation_manual_completion_guard",
  "match_presentation_event_publication_guard",
  "match_presentation_registration_immutable_guard",
  "match_presentation_control_phase_guard",
];
type JsonRecord = Record<string, unknown>;
type Operation =
  | "status"
  | "preflight"
  | "enable-capture"
  | "export"
  | "import"
  | "verify"
  | "activate";
type Arguments = {
  operation: Operation;
  directory?: string;
  candidateVersionId?: string;
  firebaseCredentials?: string;
  writerEvidence?: string;
  sourceExceptions?: string;
};
type SourceRow = {
  inviteId: string;
  matchId: string;
  actorUid: string;
  emojiId: number;
  aura: string;
  seedDigest: string;
  exception?: SourceExceptionProof;
};
type SourceExceptionDeclaration = {
  inviteId: string;
  matchId: string;
  actorUid: string;
  disposition: "alias" | "archive";
  sourceDigest: string;
  canonicalActorUid?: string;
  reason: "linked-login-copy" | "no-canonical-owner" | "conflicting-color";
};
type SourceExceptionFile = {
  schemaVersion: 1;
  exceptions: SourceExceptionDeclaration[];
};
type SourceExceptionProof = {
  disposition: "alias" | "archive";
  reason: SourceExceptionDeclaration["reason"];
  sourceDigest: string;
  source: JsonRecord;
  canonicalActorUid: string | null;
  canonicalSeedDigest: string | null;
  ownership: JsonRecord[];
  profileId: string | null;
};
type ReadbackRow = Pick<
  SourceRow,
  "inviteId" | "matchId" | "actorUid" | "seedDigest"
> & {
  provenance: "creation" | "backfill";
  sourceId: string;
  presentation: unknown;
};
type PageProof = { file: string; digest: string; count: number };
type Inventory = Awaited<ReturnType<typeof inventory>>;
type PlayerExport = {
  actorUid: string;
  inventory: Inventory;
  pages: PageProof[];
};
type Manifest = {
  schemaVersion: 1;
  migrationId: string;
  captureVersionId: string;
  captureStartedAtMs: number;
  createdAtMs: number;
  players: Inventory;
  playerExports: PageProof[];
  invites: PageProof[];
  discovery: PageProof[];
  sourceCount: number;
  sourceDigest: string;
  sourceExceptions?: PageProof;
  absentMetadata?: PageProof[];
};
type AbsentMetadataReference = Pick<
  SourceRow,
  "inviteId" | "matchId" | "actorUid"
>;
type Control = {
  phase: "legacy" | "capture" | "durable";
  candidate_version_id: string | null;
  migration_id: string | null;
  capture_started_at_ms: number | null;
  source_digest: string | null;
  source_count: number | null;
  verification_digest: string | null;
  verified_at_ms: number | null;
  activated_at_ms: number | null;
};
type BridgeRequest = {
  schemaVersion: 1;
  operation: "import" | "readback";
  migrationId: string;
  sourceDigest: string;
  rows: SourceRow[];
};
type WorkflowEvidence = { id: string; status: string; versionId: string };
type Dependencies = {
  run: SqlRunner;
  now(): number;
  log(value: JsonRecord): void;
  assertDeployment(versionId: string): Promise<void>;
  auditWriters(versionId: string): Promise<JsonRecord>;
  streamKeys(path: string): AsyncIterable<string>;
  readMatch(actorUid: string, matchId: string): Promise<unknown>;
  bridge(request: BridgeRequest): Promise<ReadbackRow[]>;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid appearance migration record");
  return value as JsonRecord;
}

function key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    isSafeFirebaseKey(value)
  );
}

function actor(value: unknown): value is string {
  return key(value) && value.length <= 128;
}

function parseArgs(argv: string[]): Arguments {
  const operation = argv[0]?.replace(/^--/, "") as Operation;
  if (
    ![
      "status",
      "preflight",
      "enable-capture",
      "export",
      "import",
      "verify",
      "activate",
    ].includes(operation)
  )
    throw new Error(
      "choose --status, --preflight, --enable-capture, --export, --import, --verify or --activate",
    );
  const options = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const option = argv[i];
    const value = argv[i + 1];
    if (
      !value ||
      value.startsWith("--") ||
      options.has(option) ||
      ![
        "--directory",
        "--candidate-version-id",
        "--firebase-credentials",
        "--writer-evidence",
        "--source-exceptions",
      ].includes(option)
    )
      throw new Error("invalid appearance migration arguments");
    options.set(option, value);
  }
  if (operation === "status" && options.size)
    throw new Error("status takes no options");
  const directory = options.get("--directory");
  const candidateVersionId = options.get("--candidate-version-id");
  const firebaseCredentials = options.get("--firebase-credentials");
  const writerEvidence = options.get("--writer-evidence");
  const sourceExceptions = options.get("--source-exceptions");
  if (operation !== "status" && (!directory || !isAbsolute(directory)))
    throw new Error(
      "an absolute private --directory outside the repository is required",
    );
  const versionOperation = [
    "preflight",
    "enable-capture",
    "verify",
    "activate",
  ].includes(operation);
  if (
    versionOperation &&
    (!candidateVersionId || !UUID.test(candidateVersionId))
  )
    throw new Error("the exact --candidate-version-id is required");
  if (candidateVersionId && !versionOperation)
    throw new Error("candidate version is not valid for this operation");
  if (
    firebaseCredentials &&
    (!isAbsolute(firebaseCredentials) ||
      !["export", "verify", "activate"].includes(operation))
  )
    throw new Error(
      "this operation requires no Firebase credentials, or the credential path is not absolute",
    );
  if (writerEvidence && (!isAbsolute(writerEvidence) || !versionOperation))
    throw new Error(
      "writer evidence is only valid as an absolute path for preflight, enable-capture, verify and activate",
    );
  if (
    sourceExceptions &&
    (!isAbsolute(sourceExceptions) ||
      !["export", "verify", "activate"].includes(operation))
  )
    throw new Error(
      "source exceptions require an absolute protected file for export, verify or activate",
    );
  return {
    operation,
    directory,
    candidateVersionId,
    firebaseCredentials,
    writerEvidence,
    sourceExceptions,
  };
}

function artifactPath(directory: string, file: string): string {
  if (!/^[a-z0-9-]+\.json$/.test(file))
    throw new Error("invalid artifact path");
  return resolve(directory, file);
}

function publish(
  directory: string,
  file: string,
  value: unknown,
  count: number,
): PageProof {
  writePrivateImmutable(artifactPath(directory, file), value);
  return { file, count, digest: digest(value) };
}

function readProof<T>(directory: string, proof: PageProof): T {
  if (
    !HASH.test(proof.digest) ||
    !Number.isSafeInteger(proof.count) ||
    proof.count < 0
  )
    throw new Error("invalid appearance page proof");
  const value = readPrivateJson(artifactPath(directory, proof.file));
  if (digest(value) !== proof.digest)
    throw new Error("artifact digest mismatch");
  return value as T;
}

function seedDigest(row: Omit<SourceRow, "seedDigest">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.inviteId,
        row.matchId,
        row.actorUid,
        row.emojiId,
        row.aura,
      ]),
    )
    .digest("hex");
}

function parseSourceRow(value: unknown): SourceRow {
  const row = record(value);
  if (
    !key(row.inviteId) ||
    !key(row.matchId) ||
    !actor(row.actorUid) ||
    parseInviteMatchIndex(row.inviteId, row.matchId) === null ||
    !Number.isSafeInteger(row.emojiId) ||
    typeof row.aura !== "string" ||
    row.aura.length > 32
  )
    throw new Error("invalid source appearance row");
  const parsed = row as SourceRow;
  if (parsed.seedDigest !== seedDigest(parsed))
    throw new Error("immutable appearance seed digest mismatch");
  if (parsed.exception !== undefined) {
    const proof = record(parsed.exception);
    const source = record(proof.source);
    const normalized = normalizeHistoricalMatchRecord(source);
    if (
      !normalized ||
      !["alias", "archive"].includes(String(proof.disposition)) ||
      !Array.isArray(proof.ownership) ||
      typeof proof.sourceDigest !== "string" ||
      proof.sourceDigest !== digest(source) ||
      normalized.emojiId !== parsed.emojiId ||
      normalized.aura !== parsed.aura ||
      (proof.disposition === "alias"
        ? proof.reason !== "linked-login-copy" ||
          !actor(proof.canonicalActorUid) ||
          proof.canonicalActorUid === parsed.actorUid ||
          !key(proof.profileId) ||
          proof.canonicalSeedDigest !==
            seedDigest({ ...parsed, actorUid: proof.canonicalActorUid })
        : !["no-canonical-owner", "conflicting-color"].includes(
            String(proof.reason),
          ) ||
          proof.canonicalActorUid !== null ||
          proof.canonicalSeedDigest !== null)
    )
      throw new Error("invalid physical source exception proof");
  }
  return parsed;
}

function exceptionIdentity(
  row: Pick<SourceRow, "inviteId" | "matchId" | "actorUid">,
): string {
  return canonicalJson([row.inviteId, row.matchId, row.actorUid]);
}

function parseSourceExceptions(value: unknown): SourceExceptionFile {
  const file = record(value);
  if (
    file.schemaVersion !== 1 ||
    !Array.isArray(file.exceptions) ||
    !file.exceptions.length ||
    file.exceptions.length > 1000
  )
    throw new Error("invalid reviewed source exception file");
  const seen = new Set<string>();
  const exceptions = file.exceptions.map((value) => {
    const row = record(value);
    if (
      !key(row.inviteId) ||
      !key(row.matchId) ||
      !actor(row.actorUid) ||
      typeof row.sourceDigest !== "string" ||
      !HASH.test(row.sourceDigest) ||
      !["alias", "archive"].includes(String(row.disposition)) ||
      (row.disposition === "alias"
        ? row.reason !== "linked-login-copy" ||
          !actor(row.canonicalActorUid) ||
          row.canonicalActorUid === row.actorUid
        : !["no-canonical-owner", "conflicting-color"].includes(
            String(row.reason),
          ) || row.canonicalActorUid !== undefined) ||
      Object.keys(row).some(
        (name) =>
          ![
            "inviteId",
            "matchId",
            "actorUid",
            "disposition",
            "sourceDigest",
            "canonicalActorUid",
            "reason",
          ].includes(name),
      )
    )
      throw new Error("invalid reviewed source exception declaration");
    const parsed = row as SourceExceptionDeclaration;
    const identity = exceptionIdentity(parsed);
    if (seen.has(identity))
      throw new Error("duplicate reviewed source exception");
    seen.add(identity);
    return parsed;
  });
  return { schemaVersion: 1, exceptions };
}

function retainedSourceExceptions(
  directory: string,
  manifest?: Manifest,
): SourceExceptionFile | undefined {
  if (manifest && !manifest.sourceExceptions) return undefined;
  const path = artifactPath(directory, "source-exceptions.json");
  if (!existsSync(path)) {
    if (manifest?.sourceExceptions)
      throw new Error("source exception evidence is missing");
    return undefined;
  }
  const value = manifest?.sourceExceptions
    ? readProof<unknown>(directory, manifest.sourceExceptions)
    : readPrivateJson(path);
  const file = parseSourceExceptions(value);
  if (
    manifest?.sourceExceptions &&
    manifest.sourceExceptions.count !== file.exceptions.length
  )
    throw new Error("source exception count mismatch");
  return file;
}

function canonicalSourceRow(row: SourceRow): SourceRow | null {
  if (row.exception?.disposition === "archive") return null;
  return {
    inviteId: row.inviteId,
    matchId: row.matchId,
    actorUid: row.exception?.canonicalActorUid || row.actorUid,
    emojiId: row.emojiId,
    aura: row.aura,
    seedDigest: row.exception?.canonicalSeedDigest || row.seedDigest,
  };
}

function validateExceptionCoverage(
  db: DatabaseSync,
  declarations?: SourceExceptionFile,
): number {
  const rows = db
    .prepare(
      "SELECT row_json FROM sources WHERE json_type(row_json, '$.exception') = 'object'",
    )
    .all();
  const declared = new Map(
    declarations?.exceptions.map((row) => [exceptionIdentity(row), row]) || [],
  );
  if (rows.length !== declared.size)
    throw new Error("reviewed source exception inventory is incomplete");
  for (const stored of rows) {
    const row = parseSourceRow(JSON.parse(String(stored.row_json)));
    const declaration = declared.get(exceptionIdentity(row));
    if (
      !declaration ||
      row.exception?.sourceDigest !== declaration.sourceDigest ||
      row.exception.disposition !== declaration.disposition ||
      row.exception.reason !== declaration.reason ||
      (declaration.disposition === "alias" &&
        row.exception.canonicalActorUid !== declaration.canonicalActorUid)
    )
      throw new Error(
        "source exception does not match the reviewed physical key",
      );
    if (row.exception.disposition === "alias") {
      const target = db
        .prepare(
          "SELECT row_json FROM sources WHERE actor_uid = ? AND match_id = ?",
        )
        .get(row.exception.canonicalActorUid!, row.matchId);
      if (!target)
        throw new Error(
          "duplicate alias canonical target is absent from the independent physical inventory",
        );
      const canonical = parseSourceRow(JSON.parse(String(target.row_json)));
      if (
        canonical.exception ||
        canonical.inviteId !== row.inviteId ||
        canonical.seedDigest !== row.exception.canonicalSeedDigest
      )
        throw new Error(
          "duplicate alias target has conflicting physical source evidence",
        );
    }
  }
  return rows.length;
}

function* exportedRows(
  directory: string,
  manifest: Manifest,
): Generator<SourceRow> {
  const players = inventoryKeys(directory, manifest.players);
  const hash = createHash("sha256");
  let count = 0;
  for (const proof of manifest.playerExports) {
    const player = readProof<PlayerExport>(directory, proof);
    if (
      !actor(player.actorUid) ||
      players.next().value !== player.actorUid ||
      player.inventory.path !== `players/${player.actorUid}/matches`
    )
      throw new Error("player inventory coverage mismatch");
    const matches = inventoryKeys(directory, player.inventory);
    let playerCount = 0;
    for (const page of player.pages) {
      const rows = readProof<unknown[]>(directory, page);
      if (
        !Array.isArray(rows) ||
        rows.length !== page.count ||
        rows.length > PAGE_SIZE
      )
        throw new Error("invalid appearance page");
      for (const raw of rows) {
        const row = parseSourceRow(raw);
        if (
          row.actorUid !== player.actorUid ||
          matches.next().value !== row.matchId
        )
          throw new Error("match inventory coverage mismatch");
        hash.update(canonicalJson(row) + "\n");
        count++;
        playerCount++;
        yield row;
      }
    }
    if (
      !matches.next().done ||
      playerCount !== player.inventory.count ||
      proof.count !== playerCount
    )
      throw new Error("incomplete player export");
  }
  if (
    !players.next().done ||
    manifest.playerExports.length !== manifest.players.count ||
    count !== manifest.sourceCount ||
    hash.digest("hex") !== manifest.sourceDigest
  )
    throw new Error("incomplete source manifest");
}

function* absentMetadataReferences(
  directory: string,
  manifest: Manifest,
): Generator<AbsentMetadataReference> {
  const seen = new Set<string>();
  for (const proof of manifest.absentMetadata || []) {
    const rows = readProof<unknown[]>(directory, proof);
    if (
      !Array.isArray(rows) ||
      rows.length !== proof.count ||
      rows.length > PAGE_SIZE
    )
      throw new Error("invalid absent metadata reference page");
    for (const value of rows) {
      const row = record(value);
      if (
        !key(row.inviteId) ||
        !key(row.matchId) ||
        !actor(row.actorUid) ||
        parseInviteMatchIndex(row.inviteId, row.matchId) === null ||
        Object.keys(row).length !== 3
      )
        throw new Error("invalid absent metadata actor reference");
      const reference = row as AbsentMetadataReference;
      const identity = exceptionIdentity(reference);
      if (seen.has(identity))
        throw new Error("duplicate absent metadata actor reference");
      seen.add(identity);
      yield reference;
    }
  }
}

function recordAbsentMetadata(
  directory: string,
  db: DatabaseSync,
): PageProof[] {
  const pages: PageProof[] = [];
  let actorCursor = "";
  let matchCursor = "";
  let inviteCursor = "";
  for (;;) {
    const rows = db
      .prepare(
        "SELECT e.actor_uid, e.match_id, e.invite_id FROM expected e LEFT JOIN sources s ON s.actor_uid = e.actor_uid AND s.match_id = e.match_id AND s.invite_id = e.invite_id WHERE s.actor_uid IS NULL AND (e.actor_uid > ? OR (e.actor_uid = ? AND e.match_id > ?) OR (e.actor_uid = ? AND e.match_id = ? AND e.invite_id > ?)) ORDER BY e.actor_uid, e.match_id, e.invite_id LIMIT ?",
      )
      .all(
        actorCursor,
        actorCursor,
        matchCursor,
        actorCursor,
        matchCursor,
        inviteCursor,
        PAGE_SIZE,
      );
    if (!rows.length) break;
    const references = rows.map((row) => ({
      inviteId: String(row.invite_id),
      matchId: String(row.match_id),
      actorUid: String(row.actor_uid),
    }));
    pages.push(
      publish(
        directory,
        `metadata-absent-${pages.length}.json`,
        references,
        references.length,
      ),
    );
    const last = rows.at(-1)!;
    actorCursor = String(last.actor_uid);
    matchCursor = String(last.match_id);
    inviteCursor = String(last.invite_id);
  }
  return pages;
}

function loadExport(directory: string): Manifest {
  const value = record(
    readPrivateJson(artifactPath(directory, "manifest.json")),
  ) as Manifest;
  if (
    value.schemaVersion !== 1 ||
    !UUID.test(value.migrationId) ||
    !UUID.test(value.captureVersionId) ||
    !Number.isSafeInteger(value.captureStartedAtMs) ||
    !HASH.test(value.sourceDigest) ||
    !Number.isSafeInteger(value.sourceCount) ||
    value.sourceCount < 0 ||
    value.players.path !== "players"
  )
    throw new Error("invalid appearance manifest");
  for (const proofs of [value.invites, value.discovery])
    for (const proof of proofs) {
      const rows = readProof<unknown[]>(directory, proof);
      if (
        !Array.isArray(rows) ||
        rows.length !== proof.count ||
        rows.length > PAGE_SIZE
      )
        throw new Error("invalid D1 inventory page");
    }
  for (const reference of absentMetadataReferences(directory, value))
    void reference;
  const declarations = retainedSourceExceptions(directory, value);
  if (declarations) {
    const local = spool(directory);
    try {
      for (const row of exportedRows(directory, value))
        local.db
          .prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?)")
          .run(
            row.actorUid,
            row.matchId,
            row.inviteId,
            row.seedDigest,
            canonicalJson(row),
          );
      validateExceptionCoverage(local.db, declarations);
    } finally {
      local.close();
    }
  } else
    for (const row of exportedRows(directory, value)) {
      if (row.exception)
        throw new Error("source exception has no reviewed declaration");
    }
  return value;
}

function spool(directory: string) {
  const path = resolve(directory, `reconcile-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode = MEMORY; CREATE TABLE invites (invite_id TEXT PRIMARY KEY, source_json TEXT NOT NULL); CREATE TABLE discovery (actor_uid TEXT, match_id TEXT, invite_id TEXT, resolution TEXT, PRIMARY KEY(actor_uid, match_id)); CREATE TABLE sources (actor_uid TEXT, match_id TEXT, invite_id TEXT, seed_digest TEXT, row_json TEXT, PRIMARY KEY(actor_uid, match_id)); CREATE TABLE expected (actor_uid TEXT, match_id TEXT, invite_id TEXT, PRIMARY KEY(actor_uid, match_id, invite_id));",
  );
  return {
    db,
    close() {
      db.close();
      rmSync(path, { force: true });
    },
  };
}

async function readControl(dependencies: Dependencies): Promise<Control> {
  const rows = await dependencies.run(
    "SELECT * FROM match_presentation_control WHERE singleton = 1",
    DATABASE,
  );
  const control = record(rows[0]) as Control;
  if (!["legacy", "capture", "durable"].includes(control.phase))
    throw new Error("appearance control is unavailable");
  return control;
}

async function assertAuthority(dependencies: Dependencies): Promise<void> {
  const rows = await dependencies.run(
    "SELECT (SELECT backend FROM invite_source_control WHERE singleton = 1) AS invite_backend, (SELECT discovery_backend FROM login_match_discovery_control WHERE singleton = 1) AS discovery_backend, (SELECT backend FROM automatch_runtime_control WHERE singleton = 1) AS automatch_backend, (SELECT state FROM event_transition_receipt_control WHERE singleton = 1) AS receipts_state",
    DATABASE,
  );
  if (
    rows[0]?.invite_backend !== "d1" ||
    rows[0]?.discovery_backend !== "d1" ||
    rows[0]?.automatch_backend !== "d1" ||
    rows[0]?.receipts_state !== "active"
  )
    throw new Error(
      "D1 invite, discovery, automatch and event receipt authority are required",
    );
  const guards = await dependencies.run(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (SELECT value FROM json_each(?))",
    DATABASE,
    [JSON.stringify(GUARDS)],
  );
  if (guards.length !== GUARDS.length)
    throw new Error("reviewed appearance publication guards are required");
}

async function assertCapture(
  dependencies: Dependencies,
  manifest?: Manifest,
): Promise<Control> {
  const control = await readControl(dependencies);
  if (
    control.phase !== "capture" ||
    !control.candidate_version_id ||
    !control.migration_id ||
    !Number.isSafeInteger(control.capture_started_at_ms)
  )
    throw new Error(
      "appearance capture must be enabled before migration; durable authority cannot be reverted",
    );
  if (
    manifest &&
    (control.migration_id !== manifest.migrationId ||
      control.candidate_version_id !== manifest.captureVersionId ||
      control.capture_started_at_ms !== manifest.captureStartedAtMs)
  )
    throw new Error("capture generation changed");
  await assertAuthority(dependencies);
  await dependencies.assertDeployment(control.candidate_version_id);
  return control;
}

async function assertNoPendingCreations(
  dependencies: Dependencies,
): Promise<void> {
  const pending = await dependencies.run(
    "SELECT transition_id FROM game_session_transitions WHERE status = 'pending' AND json_array_length(payload_json, '$.creations') > 0 LIMIT 1",
    DATABASE,
  );
  const eventPending = await dependencies.run(
    "SELECT transition_id FROM event_transition_intents WHERE EXISTS (SELECT 1 FROM json_each(event_transition_intents.intent_json, '$.rtdbEffects') AS effect WHERE effect.type = 'object' AND effect.key LIKE 'players/%/matches/%' AND length(effect.key) - length(replace(effect.key, '/', '')) = 3) LIMIT 1",
    "mons-link-events",
  );
  if (pending.length || eventPending.length)
    throw new Error(
      "pending player creation must complete through capture before continuing; retry after recovery",
    );
}

async function d1Inventory(
  directory: string,
  kind: "invites" | "discovery",
  dependencies: Dependencies,
): Promise<PageProof[]> {
  const complete = artifactPath(directory, `d1-${kind}-complete.json`);
  if (existsSync(complete)) {
    const proofs = readPrivateJson(complete) as PageProof[];
    for (const proof of proofs) readProof(directory, proof);
    return proofs;
  }
  const proofs: PageProof[] = [];
  let cursor = "";
  let second = "";
  for (;;) {
    const file = `d1-${kind}-${proofs.length}.json`;
    let rows: JsonRecord[];
    if (existsSync(artifactPath(directory, file)))
      rows = readPrivateJson(artifactPath(directory, file)) as JsonRecord[];
    else
      rows =
        kind === "invites"
          ? await dependencies.run(
              "SELECT invite_id, source_json FROM invite_sources WHERE invite_id > ? ORDER BY invite_id LIMIT ?",
              DATABASE,
              [cursor, PAGE_SIZE],
            )
          : await dependencies.run(
              "SELECT login_uid, match_id, invite_id, resolution FROM login_match_discovery WHERE login_uid > ? OR (login_uid = ? AND match_id > ?) ORDER BY login_uid, match_id LIMIT ?",
              DATABASE,
              [cursor, cursor, second, PAGE_SIZE],
            );
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE)
      throw new Error("invalid D1 inventory page");
    if (!rows.length) break;
    const last = record(rows.at(-1));
    const next = String(kind === "invites" ? last.invite_id : last.login_uid);
    const nextSecond = kind === "invites" ? "" : String(last.match_id);
    if (next === cursor && nextSecond === second)
      throw new Error("D1 inventory cursor did not advance");
    proofs.push(publish(directory, file, rows, rows.length));
    cursor = next;
    second = nextSecond;
  }
  writePrivateImmutable(complete, proofs);
  return proofs;
}

function matchesCanonicalActor(
  inviteId: string,
  matchId: string,
  actorUid: string,
  source: JsonRecord,
): boolean {
  if (
    !actor(source.hostId) ||
    (source.guestId !== undefined &&
      source.guestId !== null &&
      (!actor(source.guestId) || source.guestId === source.hostId))
  )
    throw new Error("canonical invite membership is malformed");
  const role =
    actorUid === source.hostId
      ? "host"
      : actorUid === source.guestId
        ? "guest"
        : null;
  const index = parseInviteMatchIndex(inviteId, matchId);
  return (
    role !== null &&
    index !== null &&
    (index === 0 ||
      [
        ...parseRematchIndices(source.hostRematches),
        ...parseRematchIndices(source.guestRematches),
      ].includes(index))
  );
}

function addInvite(db: DatabaseSync, value: JsonRecord): void {
  if (!key(value.invite_id) || typeof value.source_json !== "string")
    throw new Error("invalid canonical invite inventory");
  const source = record(JSON.parse(value.source_json));
  if (
    !matchesCanonicalActor(
      value.invite_id,
      value.invite_id,
      String(source.hostId),
      source,
    )
  )
    throw new Error("invalid canonical host");
  db.prepare(
    "INSERT INTO invites VALUES (?, ?) ON CONFLICT(invite_id) DO UPDATE SET source_json = excluded.source_json",
  ).run(value.invite_id, value.source_json);
  for (const role of ["host", "guest"]) {
    const uid = source[`${role}Id`];
    if (!uid) continue;
    for (const index of [
      0,
      ...parseRematchIndices(source[`${role}Rematches`]),
    ]) {
      const matchId =
        index === 0 ? value.invite_id : `${value.invite_id}${index}`;
      db.prepare("INSERT OR IGNORE INTO expected VALUES (?, ?, ?)").run(
        String(uid),
        matchId,
        value.invite_id,
      );
    }
  }
}

async function reconcileException(
  declaration: SourceExceptionDeclaration,
  source: JsonRecord,
  invite: JsonRecord,
  dependencies: Dependencies,
): Promise<SourceExceptionProof> {
  if (
    digest(source) !== declaration.sourceDigest ||
    [invite.hostId, invite.guestId].includes(declaration.actorUid)
  )
    throw new Error(
      "reviewed exception source changed or became a canonical participant",
    );
  const index = parseInviteMatchIndex(
    declaration.inviteId,
    declaration.matchId,
  );
  if (
    index === null ||
    (index > 0 &&
      ![
        ...parseRematchIndices(invite.hostRematches),
        ...parseRematchIndices(invite.guestRematches),
      ].includes(index))
  )
    throw new Error("reviewed exception is outside the canonical match series");
  if (
    !actor(invite.hostId) ||
    (invite.guestId !== undefined &&
      invite.guestId !== null &&
      !actor(invite.guestId))
  )
    throw new Error("reviewed exception canonical membership is invalid");
  const participantUids = [invite.hostId, invite.guestId].filter(actor);
  const owners = await dependencies.run(
    "SELECT o.login_uid, o.profile_id, o.revision, p.state, p.merged_into_profile_id FROM profile_login_owners o LEFT JOIN profile_records p ON p.profile_id = o.profile_id WHERE o.login_uid IN (SELECT value FROM json_each(?)) ORDER BY o.login_uid",
    "mons-link-profiles",
    [JSON.stringify([declaration.actorUid, ...participantUids])],
  );
  for (const owner of owners) {
    if (
      !actor(owner.login_uid) ||
      !key(owner.profile_id) ||
      !Number.isSafeInteger(owner.revision) ||
      Number(owner.revision) < 1 ||
      owner.state !== "active" ||
      owner.merged_into_profile_id !== null
    )
      throw new Error(
        "source exception ownership is not a unique active canonical profile",
      );
  }
  const own = owners.find((owner) => owner.login_uid === declaration.actorUid);
  const matches = own
    ? owners.filter(
        (owner) =>
          participantUids.includes(String(owner.login_uid)) &&
          owner.profile_id === own.profile_id,
      )
    : [];
  let target: JsonRecord | null = null;
  let canonicalActorUid: string | null = null;
  let canonicalSeedDigest: string | null = null;
  if (declaration.reason === "no-canonical-owner") {
    if (declaration.disposition !== "archive" || matches.length !== 0)
      throw new Error("reviewed no-owner archive classification changed");
  } else {
    if (matches.length !== 1)
      throw new Error(
        "reviewed duplicate/conflict lacks exactly one canonical ownership match",
      );
    const targetUid = String(matches[0].login_uid);
    target = record(
      await dependencies.readMatch(targetUid, declaration.matchId),
    );
    const targetMatch = normalizeHistoricalMatchRecord(target);
    const physicalMatch = normalizeHistoricalMatchRecord(source);
    if (
      !targetMatch ||
      !physicalMatch ||
      physicalMatch.emojiId !== targetMatch.emojiId ||
      physicalMatch.aura !== targetMatch.aura
    )
      throw new Error(
        "reviewed physical and canonical immutable appearances no longer match",
      );
    if (declaration.disposition === "alias") {
      if (
        declaration.reason !== "linked-login-copy" ||
        declaration.canonicalActorUid !== targetUid ||
        target.color !== source.color
      )
        throw new Error(
          "duplicate alias color or canonical actor proof changed",
        );
      canonicalActorUid = targetUid;
      canonicalSeedDigest = seedDigest({
        inviteId: declaration.inviteId,
        matchId: declaration.matchId,
        actorUid: targetUid,
        emojiId: targetMatch.emojiId,
        aura: targetMatch.aura,
      });
    } else if (
      declaration.reason !== "conflicting-color" ||
      target.color === source.color
    ) {
      throw new Error(
        "reviewed conflicting-color archive classification changed",
      );
    }
  }
  return {
    disposition: declaration.disposition,
    reason: declaration.reason,
    sourceDigest: declaration.sourceDigest,
    source,
    canonicalActorUid,
    canonicalSeedDigest,
    ownership: owners,
    profileId: typeof own?.profile_id === "string" ? own.profile_id : null,
  };
}

async function reconcileRow(
  db: DatabaseSync,
  actorUid: string,
  matchId: string,
  value: unknown,
  dependencies: Dependencies,
  exceptions?: ReadonlyMap<string, SourceExceptionDeclaration>,
): Promise<SourceRow> {
  if (!actor(actorUid) || !key(matchId))
    throw new Error("malformed Firebase actor or match key");
  const match = normalizeHistoricalMatchRecord(value);
  if (!match)
    throw new Error(
      `malformed Firebase match (record digest ${digest([actorUid, matchId])})`,
    );
  let mapping = db
    .prepare("SELECT * FROM discovery WHERE actor_uid = ? AND match_id = ?")
    .get(actorUid, matchId) as JsonRecord | undefined;
  if (!mapping) {
    const rows = await dependencies.run(
      "SELECT login_uid, match_id, invite_id, resolution FROM login_match_discovery WHERE login_uid = ? AND match_id = ?",
      DATABASE,
      [actorUid, matchId],
    );
    mapping = rows[0];
  }
  if (!mapping || mapping.resolution !== "resolved" || !key(mapping.invite_id))
    throw new Error(
      `missing or ambiguous D1 discovery mapping (record digest ${digest([actorUid, matchId])})`,
    );
  const candidates = Array.from(
    new Set([matchId, ...createInviteCandidatesFromMatchId(matchId)]),
  );
  let sources = db
    .prepare(
      "SELECT invite_id, source_json FROM invites WHERE invite_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(candidates)) as JsonRecord[];
  const selectMatches = (values: JsonRecord[]) =>
    values.filter((source) =>
      matchesCanonicalActor(
        String(source.invite_id),
        matchId,
        actorUid,
        record(JSON.parse(String(source.source_json))),
      ),
    );
  let matches = selectMatches(sources);
  if (matches.length !== 1 || matches[0].invite_id !== mapping.invite_id) {
    sources = await dependencies.run(
      "SELECT invite_id, source_json FROM invite_sources WHERE invite_id IN (SELECT value FROM json_each(?))",
      DATABASE,
      [JSON.stringify(candidates)],
    );
    matches = selectMatches(sources);
  }
  const declaration = exceptions?.get(
    exceptionIdentity({ inviteId: mapping.invite_id, actorUid, matchId }),
  );
  let exception: SourceExceptionProof | undefined;
  if (declaration) {
    const canonicalInvite = sources.find(
      (source) => source.invite_id === mapping.invite_id,
    );
    if (!canonicalInvite)
      throw new Error("reviewed exception canonical invite is missing");
    exception = await reconcileException(
      declaration,
      record(value),
      record(JSON.parse(String(canonicalInvite.source_json))),
      dependencies,
    );
  } else if (matches.length !== 1 || matches[0].invite_id !== mapping.invite_id)
    throw new Error(
      `missing, ambiguous or uncommitted canonical actor membership (record digest ${digest([actorUid, matchId])})`,
    );
  const source: Omit<SourceRow, "seedDigest"> = {
    inviteId: mapping.invite_id,
    matchId,
    actorUid,
    emojiId: match.emojiId,
    aura: match.aura,
  };
  return {
    ...source,
    seedDigest: seedDigest(source),
    ...(exception ? { exception } : {}),
  };
}

async function exportSource(
  directory: string,
  dependencies: Dependencies,
  sourceExceptions?: SourceExceptionFile,
): Promise<Manifest> {
  const control = await assertCapture(dependencies);
  if (sourceExceptions)
    writePrivateImmutable(
      artifactPath(directory, "source-exceptions.json"),
      sourceExceptions,
    );
  const declarations = retainedSourceExceptions(directory);
  const exceptions = new Map(
    declarations?.exceptions.map((row) => [exceptionIdentity(row), row]) || [],
  );
  if (existsSync(artifactPath(directory, "manifest.json"))) {
    const manifest = loadExport(directory);
    if (
      declarations &&
      manifest.sourceExceptions?.digest !== digest(declarations)
    )
      throw new Error(
        "reviewed source exceptions do not match the completed manifest",
      );
    await assertCapture(dependencies, manifest);
    return manifest;
  }
  await assertNoPendingCreations(dependencies);
  const sessionPath = artifactPath(directory, "export-session.json");
  if (!existsSync(sessionPath))
    writePrivateImmutable(sessionPath, {
      migrationId: control.migration_id,
      captureVersionId: control.candidate_version_id,
      captureStartedAtMs: control.capture_started_at_ms,
      createdAtMs: dependencies.now(),
    });
  const session = record(readPrivateJson(sessionPath));
  if (
    session.migrationId !== control.migration_id ||
    session.captureVersionId !== control.candidate_version_id ||
    session.captureStartedAtMs !== control.capture_started_at_ms
  )
    throw new Error("export capture generation changed");
  const invites = await d1Inventory(directory, "invites", dependencies);
  const discovery = await d1Inventory(directory, "discovery", dependencies);
  const local = spool(directory);
  try {
    for (const proof of invites)
      for (const row of readProof<JsonRecord[]>(directory, proof))
        addInvite(local.db, row);
    for (const proof of discovery)
      for (const row of readProof<JsonRecord[]>(directory, proof)) {
        if (
          !actor(row.login_uid) ||
          !key(row.match_id) ||
          row.resolution !== "resolved" ||
          !key(row.invite_id)
        )
          throw new Error(
            "unresolved or malformed D1 discovery inventory blocks appearance export",
          );
        local.db
          .prepare("INSERT INTO discovery VALUES (?, ?, ?, ?)")
          .run(row.login_uid, row.match_id, row.invite_id, row.resolution);
      }
    const players = await inventory(directory, "players", dependencies);
    const playerExports: PageProof[] = [];
    const hash = createHash("sha256");
    let sourceCount = 0;
    const exportPlayer = async (actorUid: string): Promise<PlayerExport> => {
      if (!actor(actorUid)) throw new Error("malformed Firebase player key");
      const prefix = `player-${digest(actorUid)}`;
      const complete = artifactPath(directory, `${prefix}-complete.json`);
      let player: PlayerExport;
      if (existsSync(complete))
        player = readPrivateJson(complete) as PlayerExport;
      else {
        const matches = await inventory(
          directory,
          `players/${actorUid}/matches`,
          dependencies,
        );
        const pages: PageProof[] = [];
        let group: string[] = [];
        const flush = async () => {
          const file = `${prefix}-${pages.length}.json`;
          let rows: SourceRow[];
          if (existsSync(artifactPath(directory, file))) {
            rows = (
              readPrivateJson(artifactPath(directory, file)) as unknown[]
            ).map(parseSourceRow);
            if (
              rows.length !== group.length ||
              rows.some(
                (row, index) =>
                  row.actorUid !== actorUid || row.matchId !== group[index],
              )
            )
              throw new Error("resumed source page coverage mismatch");
          } else {
            rows = [];
            for (let offset = 0; offset < group.length; offset += 8) {
              const outcomes = await Promise.allSettled(
                group
                  .slice(offset, offset + 8)
                  .map(async (matchId) =>
                    reconcileRow(
                      local.db,
                      actorUid,
                      matchId,
                      await dependencies.readMatch(actorUid, matchId),
                      dependencies,
                      exceptions,
                    ),
                  ),
              );
              const failure = outcomes.find(
                (value) => value.status === "rejected",
              );
              if (failure?.status === "rejected") throw failure.reason;
              for (const outcome of outcomes) {
                if (outcome.status !== "fulfilled")
                  throw new Error("incomplete appearance source batch");
                rows.push(outcome.value);
              }
            }
          }
          pages.push(publish(directory, file, rows, rows.length));
          group = [];
        };
        for (const matchId of inventoryKeys(directory, matches)) {
          group.push(matchId);
          if (group.length === PAGE_SIZE) await flush();
        }
        if (group.length) await flush();
        player = { actorUid, inventory: matches, pages };
        writePrivateImmutable(complete, player);
      }
      if (player.actorUid !== actorUid)
        throw new Error("resumed player identity mismatch");
      return player;
    };
    let actors: string[] = [];
    const flushActors = async () => {
      const outcomes = await Promise.allSettled(actors.map(exportPlayer));
      const failure = outcomes.find((value) => value.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const outcome of outcomes) {
        if (outcome.status !== "fulfilled")
          throw new Error("incomplete actor export group");
        const player = outcome.value;
        for (const proof of player.pages)
          for (const raw of readProof<unknown[]>(directory, proof)) {
            const row = parseSourceRow(raw);
            local.db
              .prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?)")
              .run(
                row.actorUid,
                row.matchId,
                row.inviteId,
                row.seedDigest,
                canonicalJson(row),
              );
            hash.update(canonicalJson(row) + "\n");
            sourceCount++;
          }
        playerExports.push({
          file: `player-${digest(player.actorUid)}-complete.json`,
          count: player.inventory.count,
          digest: digest(player),
        });
      }
      actors = [];
      if (
        playerExports.length % 100 < outcomes.length ||
        playerExports.length === players.count
      )
        dependencies.log({
          operation: "export",
          playerCount: playerExports.length,
          sourceCount,
        });
    };
    for (const actorUid of inventoryKeys(directory, players)) {
      actors.push(actorUid);
      if (actors.length === 4) await flushActors();
    }
    if (actors.length) await flushActors();
    const missing = local.db
      .prepare(
        "SELECT 1 FROM discovery d LEFT JOIN sources s ON s.actor_uid = d.actor_uid AND s.match_id = d.match_id AND s.invite_id = d.invite_id WHERE s.actor_uid IS NULL LIMIT 1",
      )
      .get();
    if (missing)
      throw new Error(
        "D1 discovery has no independently inventoried Firebase record; archive-only evidence cannot register an actor",
      );
    const absentMetadata = recordAbsentMetadata(directory, local.db);
    validateExceptionCoverage(local.db, declarations);
    await assertNoPendingCreations(dependencies);
    const sourceExceptionsProof = declarations
      ? publish(
          directory,
          "source-exceptions.json",
          declarations,
          declarations.exceptions.length,
        )
      : undefined;
    const manifest: Manifest = {
      schemaVersion: 1,
      migrationId: String(session.migrationId),
      captureVersionId: String(session.captureVersionId),
      captureStartedAtMs: Number(session.captureStartedAtMs),
      createdAtMs: Number(session.createdAtMs),
      players,
      playerExports,
      invites,
      discovery,
      sourceCount,
      sourceDigest: hash.digest("hex"),
      absentMetadata,
      ...(sourceExceptionsProof
        ? { sourceExceptions: sourceExceptionsProof }
        : {}),
    };
    await assertCapture(dependencies, manifest);
    writePrivateImmutable(artifactPath(directory, "manifest.json"), manifest);
    return loadExport(directory);
  } finally {
    local.close();
  }
}

function checkReadback(rows: SourceRow[], actual: ReadbackRow[]): void {
  if (!Array.isArray(actual) || actual.length !== rows.length)
    throw new Error("incomplete Durable Object readback");
  const seen = new Set<string>();
  for (const row of rows) {
    const value = actual.find(
      (item) =>
        item.inviteId === row.inviteId &&
        item.matchId === row.matchId &&
        item.actorUid === row.actorUid,
    );
    const identity = canonicalJson([row.inviteId, row.matchId, row.actorUid]);
    if (
      seen.has(identity) ||
      !value ||
      value.seedDigest !== row.seedDigest ||
      !["creation", "backfill"].includes(value.provenance) ||
      typeof value.sourceId !== "string" ||
      !value.sourceId ||
      !isMatchPresentation(value.presentation)
    )
      throw new Error(
        "registered seed or current Durable Object presentation is missing or invalid",
      );
    const presentation = record(value.presentation);
    if (
      presentation.actorUid !== row.actorUid ||
      presentation.matchId !== row.matchId
    )
      throw new Error("Durable Object readback actor isolation mismatch");
    seen.add(identity);
  }
}

async function checkBatch(
  rows: SourceRow[],
  manifest: Manifest,
  operation: BridgeRequest["operation"],
  dependencies: Dependencies,
): Promise<ReadbackRow[]> {
  const canonical = new Map<string, SourceRow>();
  for (const row of rows) {
    if (operation === "import" && row.exception) continue;
    const target = canonicalSourceRow(row);
    if (!target) continue;
    const identity = exceptionIdentity(target);
    const previous = canonical.get(identity);
    if (previous && previous.seedDigest !== target.seedDigest)
      throw new Error("physical sources disagree on canonical appearance");
    canonical.set(identity, target);
  }
  const targets = [...canonical.values()];
  const results: ReadbackRow[] = [];
  for (let offset = 0; offset < targets.length; offset += REQUEST_BATCH_SIZE) {
    const batch = targets.slice(offset, offset + REQUEST_BATCH_SIZE);
    const result = await dependencies.bridge({
      schemaVersion: 1,
      operation,
      migrationId: manifest.migrationId,
      sourceDigest: manifest.sourceDigest,
      rows: batch,
    });
    checkReadback(batch, result);
    results.push(...result);
  }
  return results;
}

function storedSourceException(row: SourceRow, manifest: Manifest): JsonRecord {
  if (!row.exception) throw new Error("source exception proof is required");
  const { source, ...evidence } = row.exception;
  return {
    migration_id: manifest.migrationId,
    invite_id: row.inviteId,
    match_id: row.matchId,
    actor_uid: row.actorUid,
    disposition: row.exception.disposition,
    seed_digest: row.seedDigest,
    source_digest: row.exception.sourceDigest,
    source_json: canonicalJson(source),
    evidence_json: canonicalJson(evidence),
    canonical_actor_uid: row.exception.canonicalActorUid,
    canonical_seed_digest: row.exception.canonicalSeedDigest,
    manifest_digest: manifest.sourceDigest,
  };
}

function assertStoredSourceException(
  expected: JsonRecord,
  actual: JsonRecord | undefined,
): void {
  if (
    !actual ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  )
    throw new Error(
      "source exception archive or evidence differs from the immutable physical source",
    );
}

async function saveSourceException(
  row: SourceRow,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  const expected = storedSourceException(row, manifest);
  const columns = Object.keys(expected);
  await checkBatch([row], manifest, "readback", dependencies);
  await dependencies.run(
    `INSERT INTO match_presentation_source_exceptions (${columns.join(", ")}, imported_at_ms) VALUES (${columns.map(() => "?").join(", ")}, ?) ON CONFLICT DO NOTHING`,
    DATABASE,
    [
      ...(Object.values(expected) as Array<string | number | null>),
      dependencies.now(),
    ],
  );
  const actual = await dependencies.run(
    "SELECT * FROM match_presentation_source_exceptions WHERE migration_id = ? AND actor_uid = ? AND match_id = ?",
    DATABASE,
    [manifest.migrationId, row.actorUid, row.matchId],
  );
  assertStoredSourceException(expected, actual[0]);
}

async function verifySourceExceptionCoverage(
  db: DatabaseSync,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<number> {
  const table = await dependencies.run(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'match_presentation_source_exceptions'",
    DATABASE,
  );
  const expectedRows = db
    .prepare(
      "SELECT row_json FROM baseline WHERE json_type(row_json, '$.exception') = 'object'",
    )
    .all();
  if (!table.length) {
    if (expectedRows.length)
      throw new Error("source exception archive schema is unavailable");
    return 0;
  }
  const count = await dependencies.run(
    "SELECT COUNT(*) AS count FROM match_presentation_source_exceptions",
    DATABASE,
  );
  if (count[0]?.count !== expectedRows.length)
    throw new Error(
      "source exception archive has missing or unreviewed extra physical records",
    );
  for (const value of expectedRows) {
    const row = parseSourceRow(JSON.parse(String(value.row_json)));
    const current = db
      .prepare(
        "SELECT row_json FROM verified WHERE actor_uid = ? AND match_id = ?",
      )
      .get(row.actorUid, row.matchId);
    if (
      !current ||
      canonicalJson(
        parseSourceRow(JSON.parse(String(current.row_json))).exception,
      ) !== canonicalJson(row.exception)
    )
      throw new Error(
        "source exception ownership or physical record changed since export",
      );
    const actual = await dependencies.run(
      "SELECT * FROM match_presentation_source_exceptions WHERE migration_id = ? AND actor_uid = ? AND match_id = ?",
      DATABASE,
      [manifest.migrationId, row.actorUid, row.matchId],
    );
    assertStoredSourceException(
      storedSourceException(row, manifest),
      actual[0],
    );
    const live = await dependencies.run(
      "SELECT 1 AS found FROM match_presentation_registrations WHERE actor_uid = ? AND match_id = ?",
      DATABASE,
      [row.actorUid, row.matchId],
    );
    if (live.length)
      throw new Error(
        "archived or alias physical source must never be a live registered actor",
      );
  }
  return expectedRows.length;
}

async function importSource(
  directory: string,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<void> {
  await assertCapture(dependencies, manifest);
  await dependencies.run(
    "UPDATE match_presentation_control SET source_digest = ?, source_count = ? WHERE singleton = 1 AND phase = 'capture' AND migration_id = ? AND (source_digest IS NULL OR (source_digest = ? AND source_count = ?))",
    DATABASE,
    [
      manifest.sourceDigest,
      manifest.sourceCount,
      manifest.migrationId,
      manifest.sourceDigest,
      manifest.sourceCount,
    ],
  );
  const control = await readControl(dependencies);
  if (
    control.source_digest !== manifest.sourceDigest ||
    control.source_count !== manifest.sourceCount
  )
    throw new Error(
      "a different immutable manifest is already bound to capture",
    );
  let rows: SourceRow[] = [];
  let batches: SourceRow[][] = [];
  let count = 0;
  const importBatch = async (batch: SourceRow[]): Promise<number> => {
    const batchId = digest(batch);
    const file = artifactPath(directory, `import-${batchId}.json`);
    if (existsSync(file)) {
      const receipt = record(readPrivateJson(file));
      if (
        receipt.migrationId !== manifest.migrationId ||
        receipt.sourceDigest !== manifest.sourceDigest ||
        receipt.batchDigest !== batchId ||
        receipt.count !== batch.length
      )
        throw new Error("invalid resumed import receipt");
      await checkBatch(batch, manifest, "readback", dependencies);
    } else {
      await checkBatch(batch, manifest, "import", dependencies);
      await checkBatch(batch, manifest, "readback", dependencies);
      writePrivateImmutable(file, {
        migrationId: manifest.migrationId,
        sourceDigest: manifest.sourceDigest,
        batchDigest: batchId,
        count: batch.length,
      });
    }
    count += batch.length;
    dependencies.log({ operation: "import", sourceCount: count });
    return batch.length;
  };
  const flushBatches = async () => {
    const outcomes = await Promise.allSettled(batches.map(importBatch));
    const failures: unknown[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }
    batches = [];
    if (failures.length) throw failures[0];
  };
  const exceptions: SourceRow[] = [];
  for (const row of exportedRows(directory, manifest)) {
    if (row.exception) exceptions.push(row);
    else rows.push(row);
    if (rows.length === PAGE_SIZE) {
      batches.push(rows);
      rows = [];
      if (batches.length === 4) await flushBatches();
    }
  }
  if (rows.length) batches.push(rows);
  if (batches.length) await flushBatches();
  for (const row of exceptions) {
    await saveSourceException(row, manifest, dependencies);
    count++;
  }
  if (count !== manifest.sourceCount)
    throw new Error("incomplete import coverage");
  writePrivateImmutable(artifactPath(directory, "import-complete.json"), {
    migrationId: manifest.migrationId,
    sourceDigest: manifest.sourceDigest,
    sourceCount: count,
  });
}

async function verifyRegistryCoverage(
  db: DatabaseSync,
  manifest: Manifest,
  dependencies: Dependencies,
): Promise<JsonRecord> {
  let actorCursor = "";
  let matchCursor = "";
  let count = 0;
  let lateCaptureCount = 0;
  const hash = createHash("sha256");
  for (;;) {
    const rows = await dependencies.run(
      "SELECT invite_id, match_id, actor_uid, seed_digest, provenance, source_id, registered_at_ms FROM match_presentation_registrations WHERE actor_uid > ? OR (actor_uid = ? AND match_id > ?) ORDER BY actor_uid, match_id LIMIT ?",
      DATABASE,
      [actorCursor, actorCursor, matchCursor, PAGE_SIZE],
    );
    if (!rows.length) break;
    for (const row of rows) {
      if (
        !actor(row.actor_uid) ||
        !key(row.match_id) ||
        !key(row.invite_id) ||
        typeof row.seed_digest !== "string" ||
        !HASH.test(row.seed_digest) ||
        !["creation", "backfill"].includes(String(row.provenance))
      )
        throw new Error("invalid registered appearance coverage row");
      const baseline = db
        .prepare("SELECT * FROM baseline WHERE actor_uid = ? AND match_id = ?")
        .get(row.actor_uid, row.match_id) as JsonRecord | undefined;
      const verified = db
        .prepare("SELECT * FROM verified WHERE actor_uid = ? AND match_id = ?")
        .get(row.actor_uid, row.match_id) as JsonRecord | undefined;
      if (
        (baseline &&
          parseSourceRow(JSON.parse(String(baseline.row_json))).exception) ||
        (verified &&
          parseSourceRow(JSON.parse(String(verified.row_json))).exception)
      )
        throw new Error(
          "archived or alias physical source must never be a live registered actor",
        );
      if (
        (baseline &&
          (baseline.invite_id !== row.invite_id ||
            baseline.seed_digest !== row.seed_digest)) ||
        (verified &&
          (verified.invite_id !== row.invite_id ||
            verified.seed_digest !== row.seed_digest))
      )
        throw new Error(
          "registration disagrees with independently verified source",
        );
      if (
        row.provenance === "backfill" &&
        (!baseline ||
          !verified ||
          row.source_id !==
            `backfill:${manifest.migrationId}:${row.seed_digest}`)
      )
        throw new Error(
          "unexpected backfill registration is outside the immutable source manifest",
        );
      if (!baseline && row.provenance === "creation") {
        const discovery = await dependencies.run(
          "SELECT invite_id, resolution, provenance FROM login_match_discovery WHERE login_uid = ? AND match_id = ?",
          DATABASE,
          [row.actor_uid, row.match_id],
        );
        if (
          Number(row.registered_at_ms) < manifest.captureStartedAtMs ||
          discovery[0]?.invite_id !== row.invite_id ||
          discovery[0]?.resolution !== "resolved" ||
          discovery[0]?.provenance !== "capture"
        )
          throw new Error(
            "registration outside the manifest lacks committed creation discovery proof",
          );
      }
      if (!verified) {
        if (row.provenance !== "creation")
          throw new Error(
            "registered actor is missing from independently verified source",
          );
        const current = await reconcileRow(
          db,
          row.actor_uid,
          row.match_id,
          await dependencies.readMatch(row.actor_uid, row.match_id),
          dependencies,
        );
        if (
          current.inviteId !== row.invite_id ||
          current.seedDigest !== row.seed_digest
        )
          throw new Error(
            "concurrent registration has no matching immutable Firebase record",
          );
        await checkBatch([current], manifest, "readback", dependencies);
        lateCaptureCount++;
      }
      hash.update(canonicalJson(row) + "\n");
      count++;
    }
    const last = rows.at(-1)!;
    if (last.actor_uid === actorCursor && last.match_id === matchCursor)
      throw new Error("registration audit cursor did not advance");
    actorCursor = String(last.actor_uid);
    matchCursor = String(last.match_id);
  }
  return { count, lateCaptureCount, digest: hash.digest("hex") };
}

async function verifyAbsentMetadata(
  directory: string,
  manifest: Manifest,
  db: DatabaseSync,
  dependencies: Dependencies,
): Promise<JsonRecord> {
  let absentCount = 0;
  let capturedCount = 0;
  for (const reference of absentMetadataReferences(directory, manifest)) {
    const value = await dependencies.readMatch(
      reference.actorUid,
      reference.matchId,
    );
    const discovery = await dependencies.run(
      "SELECT invite_id, resolution, provenance FROM login_match_discovery WHERE login_uid = ? AND match_id = ?",
      DATABASE,
      [reference.actorUid, reference.matchId],
    );
    const registrations = await dependencies.run(
      "SELECT invite_id, seed_digest, provenance, registered_at_ms FROM match_presentation_registrations WHERE actor_uid = ? AND match_id = ?",
      DATABASE,
      [reference.actorUid, reference.matchId],
    );
    if (value === null || value === undefined) {
      if (discovery.length || registrations.length)
        throw new Error(
          "absent metadata actor has creation evidence without a physical source",
        );
      absentCount++;
      continue;
    }
    const match = normalizeHistoricalMatchRecord(value);
    if (
      !match ||
      discovery[0]?.invite_id !== reference.inviteId ||
      discovery[0]?.resolution !== "resolved" ||
      discovery[0]?.provenance !== "capture" ||
      registrations.length !== 1 ||
      registrations[0]?.invite_id !== reference.inviteId ||
      registrations[0]?.provenance !== "creation" ||
      Number(registrations[0]?.registered_at_ms) < manifest.captureStartedAtMs
    )
      throw new Error(
        "formerly absent metadata actor lacks verified creation capture",
      );
    const source = { ...reference, emojiId: match.emojiId, aura: match.aura };
    const row = { ...source, seedDigest: seedDigest(source) };
    if (registrations[0].seed_digest !== row.seedDigest)
      throw new Error(
        "formerly absent metadata actor has conflicting immutable appearance",
      );
    await checkBatch([row], manifest, "readback", dependencies);
    capturedCount++;
  }
  return { absentCount, capturedCount };
}

async function verifyImport(
  directory: string,
  manifest: Manifest,
  versionId: string,
  dependencies: Dependencies,
): Promise<string> {
  const control = await assertCapture(dependencies, manifest);
  if (
    versionId !== manifest.captureVersionId ||
    control.source_digest !== manifest.sourceDigest ||
    control.source_count !== manifest.sourceCount
  )
    throw new Error("verification candidate or bound import manifest mismatch");
  const receipt = record(
    readPrivateJson(artifactPath(directory, "import-complete.json")),
  );
  if (
    receipt.migrationId !== manifest.migrationId ||
    receipt.sourceDigest !== manifest.sourceDigest ||
    receipt.sourceCount !== manifest.sourceCount
  )
    throw new Error("complete acknowledged import is required");
  const writerAudit = await dependencies.auditWriters(versionId);
  const freshDirectory = privateDirectory(
    resolve(directory, `verify-${randomUUID()}`),
  );
  const fresh = await exportSource(
    freshDirectory,
    dependencies,
    retainedSourceExceptions(directory, manifest),
  );
  const local = spool(freshDirectory);
  let captureCount = 0;
  try {
    for (const row of exportedRows(directory, manifest))
      local.db
        .prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?)")
        .run(
          row.actorUid,
          row.matchId,
          row.inviteId,
          row.seedDigest,
          canonicalJson(row),
        );
    local.db.exec(
      "CREATE TABLE baseline AS SELECT * FROM sources; CREATE UNIQUE INDEX baseline_actor ON baseline(actor_uid, match_id); CREATE TABLE verified AS SELECT * FROM sources WHERE 0; CREATE UNIQUE INDEX verified_actor ON verified(actor_uid, match_id);",
    );
    let rows: SourceRow[] = [];
    let batches: SourceRow[][] = [];
    let checkedCount = 0;
    const verifyBatch = async (batch: SourceRow[]): Promise<void> => {
      const readback = await checkBatch(
        batch,
        manifest,
        "readback",
        dependencies,
      );
      for (const row of batch) {
        local.db
          .prepare("INSERT INTO verified VALUES (?, ?, ?, ?, ?)")
          .run(
            row.actorUid,
            row.matchId,
            row.inviteId,
            row.seedDigest,
            canonicalJson(row),
          );
        const original = local.db
          .prepare("SELECT * FROM sources WHERE actor_uid = ? AND match_id = ?")
          .get(row.actorUid, row.matchId) as JsonRecord | undefined;
        if (original) {
          if (
            original.invite_id !== row.inviteId ||
            original.seed_digest !== row.seedDigest
          )
            throw new Error(
              "immutable Firebase seed or canonical mapping changed after export",
            );
          local.db
            .prepare("DELETE FROM sources WHERE actor_uid = ? AND match_id = ?")
            .run(row.actorUid, row.matchId);
        } else {
          if (row.exception)
            throw new Error(
              "new source exceptions cannot appear after the manifest is bound",
            );
          const target = readback.find(
            (value) =>
              value.actorUid === row.actorUid && value.matchId === row.matchId,
          )!;
          const registration = await dependencies.run(
            "SELECT provenance, registered_at_ms FROM match_presentation_registrations WHERE invite_id = ? AND match_id = ? AND actor_uid = ? AND seed_digest = ?",
            DATABASE,
            [row.inviteId, row.matchId, row.actorUid, row.seedDigest],
          );
          if (
            target.provenance !== "creation" ||
            registration[0]?.provenance !== "creation" ||
            Number(registration[0]?.registered_at_ms) <
              manifest.captureStartedAtMs
          )
            throw new Error(
              "new source record lacks acknowledged creation capture",
            );
          captureCount++;
        }
      }
      checkedCount += batch.length;
      dependencies.log({
        operation: "verify-readback",
        sourceCount: checkedCount,
      });
    };
    const flushBatches = async () => {
      const outcomes = await Promise.allSettled(batches.map(verifyBatch));
      const failures: unknown[] = [];
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") failures.push(outcome.reason);
      }
      batches = [];
      if (failures.length) throw failures[0];
    };
    for (const row of exportedRows(freshDirectory, fresh)) {
      rows.push(row);
      if (rows.length === PAGE_SIZE) {
        batches.push(rows);
        rows = [];
        if (batches.length === 4) await flushBatches();
      }
    }
    if (rows.length) batches.push(rows);
    if (batches.length) await flushBatches();
    if (local.db.prepare("SELECT 1 FROM sources LIMIT 1").get())
      throw new Error("an exported Firebase source record disappeared");
    const registryAudit = await verifyRegistryCoverage(
      local.db,
      manifest,
      dependencies,
    );
    const sourceExceptionCount = await verifySourceExceptionCoverage(
      local.db,
      manifest,
      dependencies,
    );
    const metadataReferenceAudit = await verifyAbsentMetadata(
      directory,
      manifest,
      local.db,
      dependencies,
    );
    await assertNoPendingCreations(dependencies);
    await assertCapture(dependencies, manifest);
    const verification = {
      migrationId: manifest.migrationId,
      sourceDigest: manifest.sourceDigest,
      sourceCount: manifest.sourceCount,
      verifiedSourceDigest: fresh.sourceDigest,
      verifiedSourceCount: fresh.sourceCount,
      captureCount,
      registryAudit,
      sourceExceptionCount,
      metadataReferenceAudit,
      writerAudit,
      verifiedAtMs: dependencies.now(),
    };
    const verificationDigest = digest(verification);
    writePrivateImmutable(
      artifactPath(freshDirectory, "verification.json"),
      verification,
    );
    const updated = await dependencies.run(
      "UPDATE match_presentation_control SET verification_digest = ?, verified_at_ms = ? WHERE singleton = 1 AND phase = 'capture' AND migration_id = ? AND source_digest = ? AND source_count = ? RETURNING singleton",
      DATABASE,
      [
        verificationDigest,
        verification.verifiedAtMs,
        manifest.migrationId,
        manifest.sourceDigest,
        manifest.sourceCount,
      ],
    );
    if (updated.length !== 1) throw new Error("verification control changed");
    dependencies.log({
      operation: "verify",
      sourceCount: manifest.sourceCount,
      captureCount,
      verificationDigest,
    });
    return verificationDigest;
  } finally {
    local.close();
  }
}

async function manageMatchPresentations(
  args: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  if (args.operation === "status") {
    const control = await readControl(dependencies);
    const counts = await dependencies.run(
      "SELECT provenance, count(*) AS count FROM match_presentation_registrations GROUP BY provenance",
      DATABASE,
    );
    const exceptionTable = await dependencies.run(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'match_presentation_source_exceptions'",
      DATABASE,
    );
    const sourceExceptions = exceptionTable.length
      ? await dependencies.run(
          "SELECT disposition, COUNT(*) AS count FROM match_presentation_source_exceptions GROUP BY disposition",
          DATABASE,
        )
      : [];
    dependencies.log({
      operation: "status",
      control,
      counts,
      sourceExceptions,
    });
    return;
  }
  const directory = privateDirectory(args.directory!);
  const suppliedExceptions = args.sourceExceptions
    ? parseSourceExceptions(readPrivateJson(args.sourceExceptions))
    : undefined;
  if (suppliedExceptions)
    writePrivateImmutable(
      artifactPath(directory, "source-exceptions.json"),
      suppliedExceptions,
    );
  if (args.operation === "preflight" || args.operation === "enable-capture") {
    const versionId = args.candidateVersionId!;
    await assertAuthority(dependencies);
    await dependencies.assertDeployment(versionId);
    const writerAudit = await dependencies.auditWriters(versionId);
    const evidence = { candidateVersionId: versionId, writerAudit };
    publish(directory, `preflight-${digest(evidence)}.json`, evidence, 1);
    if (args.operation === "enable-capture") {
      const current = await readControl(dependencies);
      if (current.phase === "durable")
        throw new Error("durable authority cannot be reverted");
      if (current.phase === "legacy")
        await dependencies.run(
          "UPDATE match_presentation_control SET phase = 'capture', candidate_version_id = ?, migration_id = ?, capture_started_at_ms = ? WHERE singleton = 1 AND phase = 'legacy'",
          DATABASE,
          [versionId, randomUUID(), dependencies.now()],
        );
      const control = await assertCapture(dependencies);
      if (control.candidate_version_id !== versionId)
        throw new Error("capture is bound to a different candidate");
      writePrivateImmutable(artifactPath(directory, "capture-evidence.json"), {
        candidateVersionId: versionId,
        migrationId: control.migration_id,
        captureStartedAtMs: control.capture_started_at_ms,
      });
    }
    dependencies.log({
      operation: args.operation,
      candidateVersionId: versionId,
      writerAudit,
    });
    return;
  }
  if (args.operation === "export") {
    const manifest = await exportSource(
      directory,
      dependencies,
      suppliedExceptions,
    );
    dependencies.log({
      operation: "export",
      playerCount: manifest.players.count,
      sourceCount: manifest.sourceCount,
      sourceDigest: manifest.sourceDigest,
      absentMetadataCount:
        manifest.absentMetadata?.reduce(
          (count, page) => count + page.count,
          0,
        ) || 0,
    });
    return;
  }
  const manifest = loadExport(directory);
  if (
    suppliedExceptions &&
    manifest.sourceExceptions?.digest !== digest(suppliedExceptions)
  )
    throw new Error(
      "reviewed source exceptions do not match the completed manifest",
    );
  if (args.operation === "import") {
    await importSource(directory, manifest, dependencies);
    dependencies.log({
      operation: "import",
      sourceCount: manifest.sourceCount,
    });
    return;
  }
  if (args.operation === "activate") {
    const current = await readControl(dependencies);
    if (current.phase === "durable") {
      if (
        current.migration_id !== manifest.migrationId ||
        current.source_digest !== manifest.sourceDigest ||
        current.source_count !== manifest.sourceCount ||
        current.candidate_version_id !== args.candidateVersionId
      )
        throw new Error(
          "activated authority does not match the retained migration evidence",
        );
      await dependencies.assertDeployment(args.candidateVersionId!);
      dependencies.log({
        operation: "activate",
        alreadyActivated: true,
        sourceCount: manifest.sourceCount,
      });
      return;
    }
  }
  const verificationDigest = await verifyImport(
    directory,
    manifest,
    args.candidateVersionId!,
    dependencies,
  );
  if (args.operation === "verify") return;
  await dependencies.assertDeployment(args.candidateVersionId!);
  const changed = await dependencies.run(
    "UPDATE match_presentation_control SET phase = 'durable', activated_at_ms = ? WHERE singleton = 1 AND phase = 'capture' AND migration_id = ? AND candidate_version_id = ? AND source_digest = ? AND source_count = ? AND verification_digest = ? AND verified_at_ms IS NOT NULL RETURNING singleton",
    DATABASE,
    [
      dependencies.now(),
      manifest.migrationId,
      args.candidateVersionId!,
      manifest.sourceDigest,
      manifest.sourceCount,
      verificationDigest,
    ],
  );
  const final = await readControl(dependencies);
  if (
    final.phase !== "durable" ||
    final.verification_digest !== verificationDigest ||
    changed.length !== 1
  )
    throw new Error(
      "activation outcome is uncertain; inspect status and retry with the same evidence",
    );
  writePrivateImmutable(artifactPath(directory, "activation.json"), final);
  dependencies.log({
    operation: "activate",
    sourceCount: manifest.sourceCount,
    verificationDigest,
    phase: final.phase,
  });
}

function signedMigrationRequest(
  request: BridgeRequest,
  secret: string,
  timestamp: number,
): { body: string; headers: Record<string, string> } {
  if (secret.length < 32 || !Number.isSafeInteger(timestamp))
    throw new Error("invalid migration signing credential or time");
  const body = JSON.stringify(request);
  if (
    Buffer.byteLength(body) > 256 * 1024 ||
    request.rows.length < 1 ||
    request.rows.length > 100
  )
    throw new Error("migration request exceeds bounded batch limits");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Mons-Migration-Timestamp": String(timestamp),
      "X-Mons-Migration-Signature": createHmac("sha256", secret)
        .update(`mons-match-presentations-v1\n${timestamp}\n${body}`)
        .digest("base64url"),
    },
  };
}

function providerModulesDigest(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10000)
    throw new Error(
      "provider writer modules are unavailable or exceed their bound",
    );
  const names = new Set<string>();
  const modules = value.map((raw) => {
    const module = record(raw);
    if (
      typeof module.name !== "string" ||
      !module.name ||
      names.has(module.name) ||
      typeof module.content_type !== "string" ||
      typeof module.content_base64 !== "string" ||
      module.content_base64.length % 4 !== 0
    )
      throw new Error("invalid or duplicate provider module");
    const content = Buffer.from(module.content_base64, "base64");
    if (content.toString("base64") !== module.content_base64)
      throw new Error("provider module has noncanonical base64 content");
    names.add(module.name);
    return {
      name: module.name,
      contentType: module.content_type,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  modules.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return digest(modules);
}

async function verifyWriterProof(
  proof: JsonRecord,
  cloudflare: (path: string) => Promise<JsonRecord>,
  candidate: boolean,
): Promise<void> {
  if (
    typeof proof.workerVersionId !== "string" ||
    !UUID.test(proof.workerVersionId) ||
    typeof proof.scriptEtag !== "string" ||
    !HASH.test(proof.scriptEtag)
  )
    throw new Error("invalid provider-bound worker evidence");
  const review = record(proof.review);
  if (
    review.guardCompatibleDiscovery !== true ||
    review.atomicEventPublication !== true ||
    review.recoverableIntent !== true ||
    (candidate && review.captureAware !== true)
  )
    throw new Error("writer source compatibility review is incomplete");
  const source = record(proof.source);
  if (
    typeof source.file !== "string" ||
    !isAbsolute(source.file) ||
    typeof source.sha256 !== "string" ||
    !HASH.test(source.sha256)
  )
    throw new Error(
      "reviewed writer source must be a protected absolute artifact",
    );
  const artifact = record(readPrivateJson(source.file));
  const retained =
    artifact.result === undefined ? artifact : record(artifact.result);
  if (
    retained.id !== proof.workerVersionId ||
    providerModulesDigest(retained.modules) !== source.sha256
  )
    throw new Error(
      "retained writer source digest or provider identity mismatch",
    );
  const deployed = record(
    (
      await cloudflare(
        `workers/workers/mons-link-api/versions/${proof.workerVersionId}?include=modules`,
      )
    ).result,
  );
  if (
    deployed.id !== proof.workerVersionId ||
    providerModulesDigest(deployed.modules) !== source.sha256
  )
    throw new Error(
      "reviewed writer source does not match the provider version modules",
    );
  const worker = record(
    (
      await cloudflare(
        `workers/scripts/mons-link-api/versions/${proof.workerVersionId}`,
      )
    ).result,
  );
  if (
    worker.id !== proof.workerVersionId ||
    record(record(worker.resources).script).etag !== proof.scriptEtag
  )
    throw new Error(
      "provider worker source etag changed or does not match reviewed evidence",
    );
  if (candidate) return;
  if (
    typeof proof.workflowVersionId !== "string" ||
    !UUID.test(proof.workflowVersionId) ||
    typeof proof.workflowId !== "string" ||
    !UUID.test(proof.workflowId) ||
    proof.className !== "EventProgressWorkflow" ||
    typeof proof.workflowCreatedOn !== "string"
  )
    throw new Error("invalid Workflow version compatibility evidence");
  const binding = record(proof.binding);
  if (
    typeof binding.file !== "string" ||
    !isAbsolute(binding.file) ||
    typeof binding.digest !== "string" ||
    !HASH.test(binding.digest)
  )
    throw new Error("protected Workflow registration receipt is required");
  const receipt = record(readPrivateJson(binding.file));
  if (digest(receipt) !== binding.digest)
    throw new Error("Workflow registration receipt digest mismatch");
  if (receipt.response !== undefined) {
    const response = record(receipt.response);
    const result = record(response.result);
    if (
      response.success !== true ||
      receipt.workerVersion !== proof.workerVersionId ||
      result.version_id !== proof.workflowVersionId ||
      result.id !== proof.workflowId ||
      result.script_name !== "mons-link-api" ||
      result.class_name !== proof.className
    )
      throw new Error(
        "provider registration receipt does not bind the reviewed Worker and Workflow versions",
      );
  } else if (
    receipt.versionId !== proof.workerVersionId ||
    receipt.workflowVersion !== proof.workflowVersionId
  ) {
    throw new Error(
      "retained registration acknowledgement does not bind Worker and Workflow versions",
    );
  }
  const workflow = record(
    (
      await cloudflare(
        `workflows/mons-link-event-progress/versions/${proof.workflowVersionId}`,
      )
    ).result,
  );
  if (
    workflow.id !== proof.workflowVersionId ||
    workflow.workflow_id !== proof.workflowId ||
    workflow.class_name !== proof.className ||
    workflow.created_on !== proof.workflowCreatedOn
  )
    throw new Error(
      "provider Workflow version identity does not match reviewed registration evidence",
    );
}

function createProductionDependencies(
  credentialsPath?: string,
  fetcher = fetch,
  writerEvidencePath?: string,
): Dependencies {
  const require = createRequire(import.meta.url);
  const typescript = require("typescript") as typeof import("typescript");
  const configPath = resolve(ROOT, "cloud/workers/api/wrangler.jsonc");
  const config = typescript.parseConfigFileTextToJson(
    configPath,
    readFileSync(configPath, "utf8"),
  );
  const accountId = record(config.config).account_id;
  if (
    config.error ||
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accountId)
  )
    throw new Error("invalid tracked Cloudflare account");
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const token = createFirebaseTokenProvider(
    credentialsPath || process.env.GOOGLE_APPLICATION_CREDENTIALS,
  );
  const cloudflare = async (path: string): Promise<JsonRecord> => {
    if (!apiToken)
      throw new Error(
        "CLOUDFLARE_API_TOKEN is required in the process environment for migration evidence and writes",
      );
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    const payload = record(await readResponseJson(response));
    if (payload.success !== true)
      throw new Error("Cloudflare migration evidence request failed");
    return payload;
  };
  const firebase = async (
    path: string,
    shallow: boolean,
  ): Promise<Response> => {
    if (
      path !== "players" &&
      !/^players\/[^/]+\/matches(?:\/[^/]+)?$/.test(path)
    )
      throw new Error(
        "unsupported appearance source path; Firebase invite reads are retired",
      );
    const url = new URL(
      `${FIREBASE_ROOT}/${path.split("/").map(encodeURIComponent).join("/")}.json`,
    );
    if (shallow) url.searchParams.set("shallow", "true");
    return fetcher(url, {
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  };
  return {
    run: createWranglerRunner({ apiToken, fetcher }),
    now: Date.now,
    log: (value) => console.log(JSON.stringify(value)),
    async assertDeployment(versionId) {
      const payload = await cloudflare(
        "workers/scripts/mons-link-api/deployments",
      );
      const deployments = record(payload.result).deployments;
      const latest = Array.isArray(deployments) ? record(deployments[0]) : {};
      const versions = latest.versions;
      if (
        !Array.isArray(versions) ||
        versions.length !== 1 ||
        record(versions[0]).version_id !== versionId ||
        record(versions[0]).percentage !== 100
      )
        throw new Error(
          "capture candidate must be the sole 100% deployed API version",
        );
      const subdomain = record(
        (await cloudflare("workers/scripts/mons-link-api/subdomain")).result,
      );
      if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
        throw new Error(
          "Worker subdomain and version previews must remain disabled",
        );
    },
    async auditWriters(versionId) {
      if (!writerEvidencePath)
        throw new Error(
          "--writer-evidence is required to prove active and version-pinned writer source compatibility",
        );
      const proof = record(readPrivateJson(writerEvidencePath));
      if (proof.schemaVersion !== 1 || !Array.isArray(proof.writers))
        throw new Error("invalid writer compatibility evidence");
      const candidate = record(proof.candidate);
      if (candidate.workerVersionId !== versionId)
        throw new Error("writer evidence belongs to a different candidate");
      await verifyWriterProof(candidate, cloudflare, true);
      const evidence: WorkflowEvidence[] = [];
      const seen = new Set<string>();
      const versions = new Set<string>();
      const current = record(
        (await cloudflare("workflows/mons-link-event-progress")).result,
      );
      if (
        current.script_name !== "mons-link-api" ||
        current.class_name !== "EventProgressWorkflow"
      )
        throw new Error("unexpected current event Workflow registration");
      const currentVersions = await cloudflare(
        "workflows/mons-link-event-progress/versions?per_page=100&page=1",
      );
      if (
        !Array.isArray(currentVersions.result) ||
        !currentVersions.result.length
      )
        throw new Error("current Workflow version is unavailable");
      const currentVersion = record(currentVersions.result[0]);
      if (
        typeof currentVersion.id !== "string" ||
        !UUID.test(currentVersion.id) ||
        currentVersion.workflow_id !== current.id ||
        currentVersion.class_name !== current.class_name
      )
        throw new Error("invalid current Workflow version identity");
      versions.add(currentVersion.id);
      let totalCount: number | null = null;
      for (let page = 1; ; page++) {
        if (page >= 10_000)
          throw new Error(
            "Workflow inventory exceeds its bound; audit is incomplete",
          );
        const query = new URLSearchParams({
          per_page: "100",
          page: String(page),
        });
        const payload = await cloudflare(
          `workflows/mons-link-event-progress/instances?${query}`,
        );
        if (!Array.isArray(payload.result))
          throw new Error("invalid Workflow inventory");
        const info = record(payload.result_info);
        if (
          info.count !== payload.result.length ||
          info.page !== page ||
          info.per_page !== 100 ||
          !Number.isSafeInteger(info.total_count) ||
          Number(info.total_count) < 0 ||
          (totalCount !== null && info.total_count !== totalCount)
        )
          throw new Error("incomplete or changing Workflow pagination proof");
        totalCount = Number(info.total_count);
        for (const value of payload.result) {
          const row = record(value);
          if (
            typeof row.id !== "string" ||
            typeof row.status !== "string" ||
            typeof row.version_id !== "string" ||
            seen.has(row.id)
          )
            throw new Error("invalid or duplicate Workflow instance evidence");
          seen.add(row.id);
          if (
            !["complete", "completed", "terminated", "errored"].includes(
              row.status,
            )
          ) {
            evidence.push({
              id: row.id,
              status: row.status,
              versionId: row.version_id,
            });
            versions.add(row.version_id);
          }
        }
        if (seen.size === totalCount) break;
        if (seen.size > totalCount || payload.result.length !== 100)
          throw new Error("Workflow page lacks complete continuation proof");
      }
      const verified = [];
      for (const workflowVersion of versions) {
        const matches = proof.writers
          .map(record)
          .filter((value) => value.workflowVersionId === workflowVersion);
        if (matches.length !== 1)
          throw new Error(
            `unproven version-pinned event writer ${workflowVersion}; retain its provider-bound source review before enabling capture`,
          );
        await verifyWriterProof(matches[0], cloudflare, false);
        verified.push({
          workflowVersionId: workflowVersion,
          workerVersionId: matches[0].workerVersionId,
          scriptEtag: matches[0].scriptEtag,
          sourceSha256: record(matches[0].source).sha256,
        });
      }
      return {
        candidateVersionId: versionId,
        evidenceDigest: digest(proof),
        workflowCount: seen.size,
        active: evidence,
        verified,
      };
    },
    async *streamKeys(path) {
      const response = await firebase(path, true);
      if (!response.ok || !response.body)
        throw new Error(
          "Firebase inventory failed; retained export is incomplete",
        );
      yield* parseShallowKeys(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ),
      );
    },
    async readMatch(actorUid, matchId) {
      if (!actor(actorUid) || !key(matchId))
        throw new Error("invalid Firebase match identity");
      return readResponseJson(
        await firebase(`players/${actorUid}/matches/${matchId}`, false),
      );
    },
    async bridge(request) {
      const secret = process.env.MATCH_PRESENTATION_MIGRATION_SECRET?.trim();
      if (!secret)
        throw new Error(
          "MATCH_PRESENTATION_MIGRATION_SECRET is required in the process environment",
        );
      const signed = signedMigrationRequest(
        request,
        secret,
        Math.floor(Date.now() / 1000),
      );
      const response = await fetcher(
        `${API_ROOT}/internal/match-presentations/migration`,
        {
          method: "POST",
          ...signed,
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
      );
      const payload = record(await readResponseJson(response, 256 * 1024));
      if (payload.ok !== true || !Array.isArray(payload.rows))
        throw new Error("invalid migration bridge response");
      return payload.rows as ReadbackRow[];
    },
  };
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "manage:match-presentations --status | --preflight|--enable-capture --directory /secure/appearances --candidate-version-id <deployed-version> | --export --directory /secure/appearances [--firebase-credentials /secure/firebase.json] [--source-exceptions /secure/source-exceptions.json] | --import --directory /secure/appearances | --verify|--activate --directory /secure/appearances --candidate-version-id <deployed-version> --writer-evidence /secure/writers.json [--firebase-credentials /secure/firebase.json] [--source-exceptions /secure/source-exceptions.json]",
    );
    return;
  }
  const args = parseArgs(argv);
  await manageMatchPresentations(
    args,
    createProductionDependencies(
      args.firebaseCredentials,
      fetch,
      args.writerEvidence,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "appearance migration failed; inspect retained evidence",
    );
    process.exitCode = 1;
  });

export {
  parseArgs,
  seedDigest,
  matchesCanonicalActor,
  parseSourceRow,
  exportedRows,
  loadExport,
  checkReadback,
  signedMigrationRequest,
  verifyWriterProof,
  providerModulesDigest,
  parseSourceExceptions,
  absentMetadataReferences,
  manageMatchPresentations,
  createProductionDependencies,
  type Arguments,
  type Dependencies,
  type SourceRow,
  type ReadbackRow,
  type BridgeRequest,
};
