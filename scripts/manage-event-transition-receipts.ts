import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createWranglerRunner,
  resolveCloudflareToken,
  readResponseJson,
  type SqlRunner,
} from "./operator/runtime.ts";

type JsonRecord = Record<string, unknown>;

type Arguments = { operation: "status" };

type Gate = { storageMode: "d1" | "frozen"; freezeGeneration: number };

type Maintenance = Gate & {
  admissions: number;
  leases: number;
  intents: number;
  effectAdmissions: number;
  otherGates: JsonRecord;
};

type Control = {
  state: "absent" | "importing" | "active";
  [key: string]: unknown;
};

type Workflow = {
  id: string;
  version_id: string;
  status: string;
  [key: string]: unknown;
};

type Dependencies = {
  log(value: JsonRecord): void;
  run: SqlRunner;
  maintenance(): Promise<Maintenance>;
  control(): Promise<Control>;
  deployment(): Promise<string>;
  workflowPage(
    page: number,
  ): Promise<{ rows: Workflow[]; totalPages: number; totalCount: number }>;
};

const ROOT = resolve(import.meta.dirname, "..");

const GAMEPLAY_DB = "mons-link-profile-games";

const EVENT_DB = "mons-link-events";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const MAX_PAGES = 100_000;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseArgs(argv: string[]): Arguments {
  if (argv.length !== 1 || argv[0] !== "--status")
    throw new Error(
      "event transition receipts supports only --status; initial migration commands are retired",
    );
  return { operation: "status" };
}

async function listWorkflows(deps: Dependencies): Promise<Workflow[]> {
  const result: Workflow[] = [],
    ids = new Set<string>();
  let totalPages = 1,
    totalCount = -1;
  for (let page = 1; page <= totalPages; page++) {
    const response = await deps.workflowPage(page);
    if (
      !integer(response.totalCount) ||
      (page > 1 && response.totalCount !== totalCount) ||
      !integer(response.totalPages) ||
      response.totalPages < page ||
      response.totalPages > MAX_PAGES ||
      (page > 1 && response.totalPages !== totalPages)
    )
      throw new Error("Workflow pagination changed or is invalid");
    totalPages = response.totalPages;
    totalCount = response.totalCount;
    for (const row of response.rows) {
      if (ids.has(row.id))
        throw new Error("Workflow pagination returned duplicate instances");
      ids.add(row.id);
      result.push(row);
    }
  }
  if (result.length !== totalCount)
    throw new Error("Workflow pagination returned incomplete coverage");
  return result;
}

function parseWorkflow(value: unknown): Workflow {
  const row = record(value);
  if (
    !row ||
    typeof row.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) ||
    typeof row.version_id !== "string" ||
    !UUID.test(row.version_id) ||
    typeof row.status !== "string"
  )
    throw new Error("invalid Workflow response");
  return row as Workflow;
}

async function manageEventTransitionReceipts(
  args: Arguments,
  deps: Dependencies,
): Promise<void> {
  if (args.operation !== "status")
    throw new Error("initial receipt migration commands are retired");
  const maintenance = await deps.maintenance(),
    control = await deps.control(),
    versionId = await deps.deployment();
  const workflows = await listWorkflows(deps);
  deps.log({
    operation: "status",
    maintenance,
    state: control.state,
    versionId,
    workflows: workflows.length,
    operatorLock: await readOperatorLock(deps),
  });
}

async function readOperatorLock(
  deps: Dependencies,
): Promise<JsonRecord | null> {
  const tables = await deps.run(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_transition_receipt_operator_lock'",
    GAMEPLAY_DB,
  );
  if (!tables.length) return null;
  return (
    (
      await deps.run(
        "SELECT owner_token, operation, created_at_ms FROM event_transition_receipt_operator_lock WHERE singleton = 1",
        GAMEPLAY_DB,
      )
    )[0] ?? null
  );
}

function createSqlDependencies(
  run: SqlRunner,
  provider: Pick<Dependencies, "deployment" | "workflowPage">,
  now = Date.now,
): Dependencies {
  return {
    ...provider,
    run,
    log: (value) => console.log(JSON.stringify(value)),
    async maintenance() {
      const event = (
        await run(
          "SELECT storage_mode, freeze_generation, (SELECT COUNT(*) FROM event_write_admissions) AS admissions, (SELECT COUNT(*) FROM event_leases WHERE expires_at_ms > ?) AS leases, (SELECT COUNT(*) FROM event_transition_intents) AS intents FROM event_runtime_control WHERE singleton = 1",
          EVENT_DB,
          [now()],
        )
      )[0];
      const effect = (
        await run(
          "SELECT COUNT(*) AS count FROM invite_source_write_admissions WHERE kind IN ('event-effects', 'event-effects-d1-receipts')",
          GAMEPLAY_DB,
        )
      )[0];
      if (
        !event ||
        !["d1", "frozen"].includes(String(event.storage_mode)) ||
        !integer(event.freeze_generation) ||
        !integer(event.admissions) ||
        !integer(event.leases) ||
        !integer(event.intents) ||
        !integer(effect?.count)
      )
        throw new Error("invalid event maintenance state");
      const otherGates: JsonRecord = {};
      for (const [key, db, sql] of [
        [
          "profiles",
          "mons-link-profiles",
          "SELECT state FROM profile_canonical_control WHERE singleton = 1",
        ],
        [
          "wagers",
          "mons-link-profiles",
          "SELECT storage_mode, freeze_generation FROM wager_reservation_runtime_control WHERE singleton = 1",
        ],
        [
          "invites",
          GAMEPLAY_DB,
          "SELECT backend, state, epoch, freeze_generation FROM invite_source_control WHERE singleton = 1",
        ],
        [
          "automatch",
          GAMEPLAY_DB,
          "SELECT backend, state, epoch, freeze_generation FROM automatch_runtime_control WHERE singleton = 1",
        ],
        [
          "withdrawals",
          "mons-link-event-prize-withdrawals",
          "SELECT storage_mode, previous_storage_mode FROM event_prize_withdrawal_runtime_control WHERE singleton = 1",
        ],
        [
          "telegram",
          "mons-link-telegram",
          "SELECT storage_mode FROM telegram_runtime_control WHERE singleton = 1",
        ],
      ]) {
        const rows = await run(sql, db);
        if (rows.length !== 1)
          throw new Error("unrelated maintenance control is missing");
        otherGates[key] = rows[0];
      }
      return {
        storageMode: event.storage_mode as Gate["storageMode"],
        freezeGeneration: event.freeze_generation,
        admissions: event.admissions,
        leases: event.leases,
        intents: event.intents,
        effectAdmissions: effect.count,
        otherGates,
      };
    },
    async control() {
      const tables = await run(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_transition_receipt_control'",
        GAMEPLAY_DB,
      );
      if (!tables.length) return { state: "absent" };
      const row = (
        await run(
          "SELECT * FROM event_transition_receipt_control WHERE singleton = 1",
          GAMEPLAY_DB,
        )
      )[0];
      if (!row || !["importing", "active"].includes(String(row.state)))
        throw new Error(
          "receipt migration control is missing; apply the additive schema first",
        );
      return row as Control;
    },
  };
}

function createProvider({
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  fetcher = fetch,
}: { apiToken?: string; fetcher?: typeof fetch } = {}): Pick<
  Dependencies,
  "deployment" | "workflowPage"
> {
  if (!apiToken)
    throw new Error("Cloudflare authentication is required for receipt status");
  const require = createRequire(import.meta.url),
    typescript = require("typescript") as typeof import("typescript");
  const parsed = typescript.parseConfigFileTextToJson(
    resolve(ROOT, "cloud/workers/api/wrangler.jsonc"),
    readFileSync(resolve(ROOT, "cloud/workers/api/wrangler.jsonc"), "utf8"),
  );
  const config = record(parsed.config),
    accountId = config?.account_id;
  if (
    parsed.error ||
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    config?.name !== "mons-link-api"
  )
    throw new Error("invalid tracked API configuration");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
    workflowPath = "/workflows/mons-link-event-progress",
    workerPath = "/workers/scripts/mons-link-api";
  async function request(path: string): Promise<JsonRecord> {
    const response = await fetcher(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const payload = record(await readResponseJson(response));
    if (!payload || payload.success !== true)
      throw new Error(
        "Cloudflare status query failed; credentials and response were not logged",
      );
    return payload;
  }
  return {
    async deployment() {
      const result = record(
          (await request(`${workerPath}/deployments`))?.result,
        ),
        deployments = result?.deployments;
      if (!Array.isArray(deployments) || !deployments.length)
        throw new Error("API deployment history is unavailable");
      const latest = deployments
          .map(record)
          .sort((a, b) =>
            String(b?.created_on).localeCompare(String(a?.created_on)),
          )[0],
        versions = latest?.versions;
      const version =
        Array.isArray(versions) && versions.length === 1
          ? record(versions[0])
          : null;
      if (
        !version ||
        version.percentage !== 100 ||
        typeof version.version_id !== "string" ||
        !UUID.test(version.version_id)
      )
        throw new Error("API requires exactly one deployment at 100%");
      return version.version_id;
    },
    async workflowPage(page) {
      const payload = await request(
          `${workflowPath}/instances?page=${page}&per_page=100`,
        ),
        info = record(payload?.result_info);
      if (
        !Array.isArray(payload?.result) ||
        !info ||
        !integer(info.total_count) ||
        info.per_page !== 100 ||
        (info.page !== undefined && info.page !== page) ||
        payload.result.length > 100 ||
        info.count !== payload.result.length
      )
        throw new Error("invalid Workflow page or pagination metadata");
      return {
        rows: payload.result.map(parseWorkflow),
        totalPages: Math.max(1, Math.ceil(info.total_count / 100)),
        totalCount: info.total_count,
      };
    },
  };
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const apiToken = resolveCloudflareToken();
  await manageEventTransitionReceipts(
    args,
    createSqlDependencies(
      createWranglerRunner({ apiToken }),
      createProvider({ apiToken }),
    ),
  );
}

export {
  parseArgs,
  parseWorkflow,
  listWorkflows,
  createProvider,
  createSqlDependencies,
  manageEventTransitionReceipts,
  execute,
  type Arguments,
  type Dependencies,
  type Workflow,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "receipt status operation failed; inspect status",
    );
    process.exitCode = 1;
  });
