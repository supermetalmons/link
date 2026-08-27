import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type MigrationPhase = "dry-run" | "final";

type TelegramSnapshot = {
  announcements: JsonRecord;
  control: JsonRecord;
  messages: JsonRecord;
};

type MigrationOptions = {
  phase: MigrationPhase;
  project: string;
};

const TELEGRAM_DATABASE = "mons-link-telegram";
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const MESSAGE_KEY_FORBIDDEN_CHARACTERS = new Set([
  ".",
  "#",
  "$",
  "/",
  "[",
  "]",
]);
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function validMessageKey(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return (
        !MESSAGE_KEY_FORBIDDEN_CHARACTERS.has(character) &&
        code > 0x1f &&
        code !== 0x7f
      );
    })
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalize(object[key])]),
  );
}

function snapshotDigest(snapshot: TelegramSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

function normalizeAnnouncements(value: unknown): JsonRecord {
  const source = value === null ? {} : record(value);
  if (!source) throw new Error("invalid Telegram announcement export");
  return Object.fromEntries(
    Object.entries(source).map(([requestId, raw]) => {
      const announcement = record(raw);
      if (!REQUEST_ID_PATTERN.test(requestId) || !announcement) {
        throw new Error("invalid Telegram announcement record");
      }
      const payloadDigest =
        typeof announcement.payloadDigest === "string"
          ? announcement.payloadDigest
          : "";
      const status =
        typeof announcement.status === "string" ? announcement.status : "";
      const createdAtMs = Number(announcement.createdAtMs);
      const updatedAtMs = Number(announcement.updatedAtMs);
      const messageIds = announcement.messageIds;
      if (
        !payloadDigest ||
        !status ||
        !Number.isSafeInteger(createdAtMs) ||
        createdAtMs <= 0 ||
        !Number.isSafeInteger(updatedAtMs) ||
        updatedAtMs <= 0 ||
        (messageIds !== undefined &&
          (!Array.isArray(messageIds) ||
            messageIds.length === 0 ||
            !messageIds.every(
              (messageId) =>
                Number.isSafeInteger(messageId) && Number(messageId) > 0,
            )))
      ) {
        throw new Error("invalid Telegram announcement record");
      }
      return [
        requestId,
        {
          payloadDigest,
          status,
          createdAtMs,
          updatedAtMs,
          ...(messageIds === undefined ? {} : { messageIds }),
        },
      ];
    }),
  );
}

function normalizeSnapshot(input: {
  announcements: unknown;
  control: unknown;
  messages: unknown;
}): TelegramSnapshot {
  const messages = input.messages === null ? {} : record(input.messages);
  const control = input.control === null ? {} : record(input.control);
  if (!messages || !control) throw new Error("invalid Telegram RTDB export");
  for (const [messageKey, value] of Object.entries(messages)) {
    if (!validMessageKey(messageKey) || !record(value)) {
      throw new Error("invalid Telegram message record");
    }
  }
  return {
    messages,
    control,
    announcements: normalizeAnnouncements(input.announcements),
  };
}

function textHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function sqlText(value: string): string {
  return `CAST(X'${textHex(value)}' AS TEXT)`;
}

function buildImportSql(
  snapshot: TelegramSnapshot,
  exportedAtMs: number,
  phase: MigrationPhase,
): string {
  const statements: string[] = [];
  for (const [messageKey, value] of Object.entries(snapshot.messages).sort()) {
    statements.push(
      `INSERT INTO telegram_messages (message_key, record_json, version, updated_at_ms) VALUES (${sqlText(messageKey)}, ${sqlText(JSON.stringify(value))}, 1, ${exportedAtMs}) ON CONFLICT (message_key) DO UPDATE SET record_json = excluded.record_json, version = telegram_messages.version + 1, updated_at_ms = excluded.updated_at_ms;`,
    );
  }
  statements.push(
    `INSERT INTO telegram_delivery_control (singleton, record_json, version, updated_at_ms) VALUES (1, ${sqlText(JSON.stringify(snapshot.control))}, 1, ${exportedAtMs}) ON CONFLICT (singleton) DO UPDATE SET record_json = excluded.record_json, version = telegram_delivery_control.version + 1, updated_at_ms = excluded.updated_at_ms;`,
  );
  for (const [requestId, raw] of Object.entries(
    snapshot.announcements,
  ).sort()) {
    const value = raw as JsonRecord;
    const messageIds = Array.isArray(value.messageIds)
      ? sqlText(JSON.stringify(value.messageIds))
      : "NULL";
    statements.push(
      `INSERT INTO telegram_event_prize_announcements (request_id, payload_digest, status, message_ids_json, created_at_ms, updated_at_ms) VALUES (${sqlText(requestId)}, ${sqlText(String(value.payloadDigest))}, ${sqlText(String(value.status))}, ${messageIds}, ${Number(value.createdAtMs)}, ${Number(value.updatedAtMs)}) ON CONFLICT (request_id) DO UPDATE SET payload_digest = excluded.payload_digest, status = excluded.status, message_ids_json = excluded.message_ids_json, created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms;`,
    );
  }
  const digest = snapshotDigest(snapshot);
  statements.push(
    `UPDATE telegram_runtime_control SET source_digest = ${sqlText(digest)}, source_message_count = ${Object.keys(snapshot.messages).length}, source_announcement_count = ${Object.keys(snapshot.announcements).length}, source_exported_at_ms = ${exportedAtMs}, updated_at_ms = ${exportedAtMs}${phase === "final" ? " WHERE singleton = 1 AND storage_mode = 'frozen'" : " WHERE singleton = 1"};`,
  );
  return `${statements.join("\n")}\n`;
}

function parseArgs(argv: string[]): MigrationOptions {
  let phase: MigrationPhase = "dry-run";
  let project = "mons-link";
  let phaseSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--final") {
      if (phaseSet) throw new Error("choose one migration phase");
      phaseSet = true;
      phase = arg.slice(2) as MigrationPhase;
      continue;
    }
    if (arg === "--project") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("missing project");
      project = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { phase, project };
}

function run(
  executable: string,
  args: string[],
  { maxBuffer = 64 * 1024 * 1024 }: { maxBuffer?: number } = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return String(result.stdout);
}

function firebaseGet(project: string, path: string): unknown {
  const output = run(resolve("node_modules/.bin/firebase"), [
    "database:get",
    path,
    "--project",
    project,
  ]);
  return JSON.parse(output) as unknown;
}

function wranglerArgs(args: string[]): string[] {
  return [
    "d1",
    "execute",
    TELEGRAM_DATABASE,
    "--remote",
    "--config",
    CONFIG_PATH,
    "--env-file",
    RELEASE_ENV_PATH,
    ...args,
  ];
}

function d1Rows(command: string): JsonRecord[] {
  const output = run(resolve("node_modules/.bin/wrangler"), [
    ...wranglerArgs(["--command", command]),
    "--json",
  ]);
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid D1 JSON response");
  const entry = parsed.find(
    (value) => record(value) && Array.isArray(record(value)?.results),
  ) as JsonRecord | undefined;
  return entry && Array.isArray(entry.results)
    ? entry.results.filter((value): value is JsonRecord =>
        Boolean(record(value)),
      )
    : [];
}

function readD1Mode(): string {
  const rows = d1Rows(
    "SELECT storage_mode FROM telegram_runtime_control WHERE singleton = 1",
  );
  return typeof rows[0]?.storage_mode === "string" ? rows[0].storage_mode : "";
}

function readD1Snapshot(): TelegramSnapshot {
  const messages = Object.fromEntries(
    d1Rows(
      "SELECT message_key, record_json FROM telegram_messages ORDER BY message_key",
    ).map((row) => [
      String(row.message_key),
      JSON.parse(String(row.record_json)),
    ]),
  );
  const controlRows = d1Rows(
    "SELECT record_json FROM telegram_delivery_control WHERE singleton = 1",
  );
  const control = controlRows[0]
    ? JSON.parse(String(controlRows[0].record_json))
    : {};
  const announcements = Object.fromEntries(
    d1Rows(
      "SELECT request_id, payload_digest, status, message_ids_json, created_at_ms, updated_at_ms FROM telegram_event_prize_announcements ORDER BY request_id",
    ).map((row) => [
      String(row.request_id),
      {
        payloadDigest: String(row.payload_digest),
        status: String(row.status),
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
        ...(row.message_ids_json === null
          ? {}
          : { messageIds: JSON.parse(String(row.message_ids_json)) }),
      },
    ]),
  );
  return normalizeSnapshot({ messages, control, announcements });
}

function summarize(snapshot: TelegramSnapshot) {
  const statuses: Record<string, number> = {};
  let activeLeases = 0;
  let sendInFlight = 0;
  let pendingRecovery = 0;
  for (const raw of Object.values(snapshot.messages)) {
    const message = record(raw) || {};
    const delivery = record(message.delivery) || {};
    const status =
      typeof delivery.status === "string" ? delivery.status : "missing";
    statuses[status] = (statuses[status] || 0) + 1;
    if (
      status === "processing" &&
      Number(delivery.leaseExpiresAtMs) > Date.now()
    ) {
      activeLeases += 1;
    }
    if (record(delivery.sendInFlight)) sendInFlight += 1;
    const request = record(message.manualRecovery) || {};
    if (
      typeof request.requestId === "string" &&
      request.requestId !== delivery.lastRecoveryRequestId
    ) {
      pendingRecovery += 1;
    }
  }
  return {
    messages: Object.keys(snapshot.messages).length,
    announcements: Object.keys(snapshot.announcements).length,
    statuses,
    activeLeases,
    sendInFlight,
    pendingRecovery,
    hasApiGate: Boolean(record(snapshot.control.apiGate)),
    digest: snapshotDigest(snapshot),
  };
}

function assertFinalSnapshotSafe(summary: ReturnType<typeof summarize>): void {
  if (
    summary.activeLeases !== 0 ||
    summary.sendInFlight !== 0 ||
    summary.pendingRecovery !== 0 ||
    summary.hasApiGate
  ) {
    throw new Error("final Telegram export is not quiescent");
  }
}

function execute(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  const exportedAtMs = Date.now();
  const snapshot = normalizeSnapshot({
    messages: firebaseGet(options.project, "/telegramMessages"),
    control: firebaseGet(options.project, "/telegramDeliveryControl"),
    announcements: firebaseGet(
      options.project,
      "/telegramEventPrizeAnnouncements",
    ),
  });
  const summary = summarize(snapshot);
  const runDirectory = resolve(
    ".cache",
    "telegram-migration",
    `${exportedAtMs}-${process.pid}`,
  );
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(runDirectory, "source.json"),
    `${JSON.stringify(snapshot)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(runDirectory, "import.sql"),
    buildImportSql(snapshot, exportedAtMs, options.phase),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ phase: options.phase, ...summary }));
  if (options.phase === "dry-run") return;
  assertFinalSnapshotSafe(summary);
  const mode = readD1Mode();
  if (options.phase === "final" && mode !== "frozen") {
    throw new Error("final import requires frozen Telegram storage mode");
  }
  run(
    resolve("node_modules/.bin/wrangler"),
    wranglerArgs(["--file", resolve(runDirectory, "import.sql"), "--yes"]),
  );
  const imported = readD1Snapshot();
  const importedSummary = summarize(imported);
  if (
    importedSummary.digest !== summary.digest ||
    importedSummary.messages !== summary.messages ||
    importedSummary.announcements !== summary.announcements
  ) {
    throw new Error("Telegram D1 verification mismatch");
  }
  console.log(
    JSON.stringify({
      phase: options.phase,
      verified: true,
      messages: importedSummary.messages,
      announcements: importedSummary.announcements,
      digest: importedSummary.digest,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  }
}

export {
  buildImportSql,
  assertFinalSnapshotSafe,
  canonicalize,
  execute,
  normalizeSnapshot,
  parseArgs,
  snapshotDigest,
  summarize,
};
