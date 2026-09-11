import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  readResponseJson,
  resolveCloudflareToken,
} from "./operator/runtime.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ROOT = resolve(import.meta.dirname, "..");
type JsonRecord = Record<string, unknown>;

export type PublishWorkflowArguments = {
  versionId: string;
  workflows: string[];
  dryRun: boolean;
};

export type OwnedWorkflowDefinition = {
  name: string;
  className: string;
};

export type WorkflowPublicationConfiguration = {
  accountId: string;
  workerName: string;
  workflows: OwnedWorkflowDefinition[];
};

type WorkflowOptions = {
  default_retention?: { error_retention?: number; success_retention?: number };
  limits?: { steps?: number };
  concurrency?: { limit?: number };
};

type WorkflowPublishBody = WorkflowOptions & {
  script_name: string;
  class_name: string;
  schedules?: Array<{ cron: string }>;
};

export type WorkflowPublicationPlan = {
  name: string;
  workflowId: string;
  previousWorkflowVersionId: string;
  publishBody: WorkflowPublishBody;
};

export type WorkflowPublication = WorkflowPublicationPlan & {
  workerVersionId: string;
  workflowVersionId: string;
};

export type WorkflowPublicationResult = {
  mode: "dry-run" | "published";
  workerName: string;
  workerVersionId: string;
  workflows: Array<WorkflowPublicationPlan | WorkflowPublication>;
};

export type WorkflowPublicationDependencies = {
  configuration: WorkflowPublicationConfiguration;
  request(
    path: string,
    method?: "GET" | "PUT",
    body?: WorkflowPublishBody,
  ): Promise<unknown>;
  log(value: unknown): void;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("workflow-publication-invalid-provider-record");
  return value as JsonRecord;
}

export function parsePublishWorkflowArgs(
  argv: string[],
): PublishWorkflowArguments {
  let versionId: string | undefined;
  let dryRun = false;
  const workflows: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--dry-run") {
      if (dryRun) throw new Error("duplicate --dry-run");
      dryRun = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error("missing Workflow publication argument");
    if (
      option === "--version-id" &&
      versionId === undefined &&
      UUID.test(value)
    ) {
      versionId = value;
    } else if (
      option === "--workflow" &&
      NAME.test(value) &&
      !workflows.includes(value)
    ) {
      workflows.push(value);
    } else {
      throw new Error(
        "invalid, unknown or duplicate Workflow publication argument",
      );
    }
  }
  if (!versionId)
    throw new Error(
      "Workflow publication requires an explicit --version-id Worker UUID",
    );
  return { versionId, workflows, dryRun };
}

export function parseWorkflowPublicationConfiguration(
  text: string,
): WorkflowPublicationConfiguration {
  const require = createRequire(import.meta.url);
  const typescript = require("typescript") as typeof import("typescript");
  const parsed = typescript.parseConfigFileTextToJson("wrangler.jsonc", text);
  if (parsed.error) throw new Error("invalid tracked Workflow configuration");
  const config = record(parsed.config);
  if (
    config.name !== "mons-link-api" ||
    typeof config.account_id !== "string" ||
    !/^[a-f0-9]{32}$/.test(config.account_id) ||
    !Array.isArray(config.workflows)
  )
    throw new Error("invalid tracked API Workflow configuration");
  const workflows: OwnedWorkflowDefinition[] = [];
  const names = new Set<string>();
  for (const raw of config.workflows) {
    const entry = record(raw);
    if (
      typeof entry.name !== "string" ||
      !NAME.test(entry.name) ||
      names.has(entry.name)
    )
      throw new Error("invalid or duplicate configured Workflow name");
    names.add(entry.name);
    if (entry.script_name !== undefined && entry.script_name !== config.name)
      continue;
    if (
      typeof entry.class_name !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]{0,254}$/.test(entry.class_name)
    )
      throw new Error("configured owned Workflow requires an exported class");
    workflows.push({ name: entry.name, className: entry.class_name });
  }
  if (!workflows.length)
    throw new Error("no owned Workflows are configured for this Worker");
  return { accountId: config.account_id, workerName: config.name, workflows };
}

function options(value: JsonRecord): WorkflowOptions {
  const output: WorkflowOptions = {};
  const fields = {
    default_retention: ["error_retention", "success_retention"],
    limits: ["steps"],
    concurrency: ["limit"],
  };
  for (const [field, allowed] of Object.entries(fields)) {
    if (value[field] === undefined) continue;
    const setting = record(value[field]);
    if (
      Object.entries(setting).some(
        ([key, number]) =>
          !allowed.includes(key) ||
          !Number.isSafeInteger(number) ||
          (field !== "default_retention" && Number(number) < 1),
      )
    )
      throw new Error("workflow-publication-invalid-current-options");
    Object.assign(output, { [field]: structuredClone(setting) });
  }
  return output;
}

function schedules(value: JsonRecord): Array<{ cron: string }> | undefined {
  if (value.schedules === undefined) return undefined;
  if (!Array.isArray(value.schedules))
    throw new Error("workflow-publication-invalid-current-schedules");
  const seen = new Set<string>();
  return value.schedules.map((raw) => {
    const item = record(raw);
    if (
      typeof item.cron !== "string" ||
      !item.cron ||
      item.cron.length > 256 ||
      seen.has(item.cron)
    )
      throw new Error("workflow-publication-invalid-current-schedule");
    seen.add(item.cron);
    return { cron: item.cron };
  });
}

function checkOwnership(
  value: unknown,
  configuration: WorkflowPublicationConfiguration,
  definition: OwnedWorkflowDefinition,
): JsonRecord {
  const resource = record(value);
  if (
    typeof resource.id !== "string" ||
    !UUID.test(resource.id) ||
    (resource.version_id !== undefined &&
      (typeof resource.version_id !== "string" ||
        !UUID.test(resource.version_id))) ||
    resource.name !== definition.name ||
    resource.script_name !== configuration.workerName ||
    resource.class_name !== definition.className ||
    (resource.is_deleted !== undefined && resource.is_deleted !== 0) ||
    (resource.terminator_running !== undefined &&
      resource.terminator_running !== 0)
  )
    throw new Error(
      `workflow-publication-ownership-conflict:${definition.name}`,
    );
  return resource;
}

function checkVersion(
  value: unknown,
  workflowId: string,
  versionId: string,
  className: string,
): JsonRecord {
  const version = record(value);
  if (
    version.id !== versionId ||
    version.workflow_id !== workflowId ||
    version.class_name !== className
  )
    throw new Error("workflow-publication-version-metadata-conflict");
  return version;
}

async function assertDeployment(
  deps: WorkflowPublicationDependencies,
  versionId: string,
): Promise<void> {
  const payload = record(
    await deps.request(
      `/workers/scripts/${deps.configuration.workerName}/deployments`,
    ),
  );
  if (!Array.isArray(payload.deployments) || !payload.deployments.length)
    throw new Error("workflow-publication-deployment-unavailable");
  const deployments = payload.deployments.map(record);
  if (
    deployments.some(
      (value) =>
        typeof value.created_on !== "string" ||
        !Number.isFinite(Date.parse(value.created_on)),
    )
  )
    throw new Error("workflow-publication-invalid-deployment-history");
  deployments.sort((left, right) =>
    String(right.created_on).localeCompare(String(left.created_on)),
  );
  const versions = deployments[0].versions;
  const active =
    Array.isArray(versions) && versions.length === 1
      ? record(versions[0])
      : null;
  if (!active || active.version_id !== versionId || active.percentage !== 100)
    throw new Error(
      "workflow-publication-requires-exact-Worker-version-at-100-percent",
    );
  const uploaded = record(
    await deps.request(
      `/workers/scripts/${deps.configuration.workerName}/versions?page=1&per_page=1`,
    ),
  );
  if (
    !Array.isArray(uploaded.items) ||
    uploaded.items.length !== 1 ||
    record(uploaded.items[0]).id !== versionId
  )
    throw new Error(
      "workflow-publication-requires-target-as-latest-uploaded-Worker-version; publish before uploading another candidate and avoid concurrent uploads or deployments",
    );
}

async function inspect(
  deps: WorkflowPublicationDependencies,
  definition: OwnedWorkflowDefinition,
): Promise<WorkflowPublicationPlan> {
  const path = `/workflows/${definition.name}`;
  const resource = checkOwnership(
    await deps.request(path),
    deps.configuration,
    definition,
  );
  const workflowId = resource.id as string;
  let previousWorkflowVersionId = resource.version_id as string | undefined;
  if (previousWorkflowVersionId === undefined) {
    const currentVersions = await deps.request(`${path}/versions?per_page=1`);
    if (!Array.isArray(currentVersions) || currentVersions.length !== 1)
      throw new Error("workflow-publication-current-version-unavailable");
    const current = record(currentVersions[0]);
    if (typeof current.id !== "string" || !UUID.test(current.id))
      throw new Error("workflow-publication-invalid-current-version");
    previousWorkflowVersionId = current.id;
    checkVersion(
      current,
      workflowId,
      previousWorkflowVersionId,
      definition.className,
    );
  }
  const version = checkVersion(
    await deps.request(`${path}/versions/${previousWorkflowVersionId}`),
    workflowId,
    previousWorkflowVersionId,
    definition.className,
  );
  const currentSchedules = schedules(resource);
  return {
    name: definition.name,
    workflowId,
    previousWorkflowVersionId,
    publishBody: {
      script_name: deps.configuration.workerName,
      class_name: definition.className,
      ...options(version),
      ...(currentSchedules === undefined
        ? {}
        : { schedules: currentSchedules }),
    },
  };
}

async function allInspected<T>(operations: Array<Promise<T>>): Promise<T[]> {
  const outcomes = await Promise.allSettled(operations);
  const failures = outcomes.filter(
    (value): value is PromiseRejectedResult => value.status === "rejected",
  );
  if (failures.length === 1) throw failures[0].reason;
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `workflow-publication-inspection-failed: ${failures
        .map((failure) =>
          failure.reason instanceof Error
            ? failure.reason.message
            : "unavailable",
        )
        .join("; ")}`,
    );
  return outcomes.map((value) => (value as PromiseFulfilledResult<T>).value);
}

export async function publishCloudflareWorkflows(
  args: PublishWorkflowArguments,
  deps: WorkflowPublicationDependencies,
): Promise<WorkflowPublicationResult> {
  if (!UUID.test(args.versionId))
    throw new Error("Workflow publication requires an explicit Worker UUID");
  const selected = args.workflows.length
    ? args.workflows.map((name) => {
        const definition = deps.configuration.workflows.find(
          (workflow) => workflow.name === name,
        );
        if (!definition)
          throw new Error(
            "selected Workflow is not owned by the tracked Worker",
          );
        return definition;
      })
    : deps.configuration.workflows;
  if (
    new Set(selected.map((definition) => definition.name)).size !==
    selected.length
  )
    throw new Error("duplicate Workflow publication selection");
  await assertDeployment(deps, args.versionId);
  const plans = await allInspected(
    selected.map((definition) => inspect(deps, definition)),
  );
  if (args.dryRun) {
    await assertDeployment(deps, args.versionId);
    return {
      mode: "dry-run",
      workerName: deps.configuration.workerName,
      workerVersionId: args.versionId,
      workflows: plans,
    };
  }
  const published: WorkflowPublication[] = [];
  for (let index = 0; index < selected.length; index++) {
    const definition = selected[index];
    const plan = plans[index];
    const before = await inspect(deps, definition);
    if (canonicalJson(before) !== canonicalJson(plan))
      throw new Error(
        "Workflow resource changed after preparation; inspect before retrying",
      );
    await assertDeployment(deps, args.versionId);
    const updated = record(
      await deps.request(
        `/workflows/${definition.name}`,
        "PUT",
        plan.publishBody,
      ),
    );
    if (
      (updated.id !== undefined && updated.id !== plan.workflowId) ||
      (updated.name !== undefined && updated.name !== definition.name) ||
      (updated.script_name !== undefined &&
        updated.script_name !== deps.configuration.workerName) ||
      (updated.class_name !== undefined &&
        updated.class_name !== definition.className)
    )
      throw new Error("workflow-publication-resource-identity-changed");
    const workflowVersionId = updated.version_id;
    if (typeof workflowVersionId !== "string" || !UUID.test(workflowVersionId))
      throw new Error(
        "workflow-publication-version-acknowledgment-unavailable",
      );
    const readback = await inspect(deps, definition);
    if (
      readback.workflowId !== plan.workflowId ||
      readback.previousWorkflowVersionId !== workflowVersionId ||
      canonicalJson(readback.publishBody) !== canonicalJson(plan.publishBody)
    )
      throw new Error("workflow-publication-current-version-readback-conflict");
    await assertDeployment(deps, args.versionId);
    const result = {
      ...plan,
      workerVersionId: args.versionId,
      workflowVersionId,
    };
    published.push(result);
    deps.log({
      name: result.name,
      workerVersionId: result.workerVersionId,
      workflowVersionId: result.workflowVersionId,
      previousWorkflowVersionId: result.previousWorkflowVersionId,
    });
  }
  const final = await allInspected(
    selected.map((definition) => inspect(deps, definition)),
  );
  for (let index = 0; index < final.length; index++) {
    if (
      final[index].workflowId !== published[index].workflowId ||
      final[index].previousWorkflowVersionId !==
        published[index].workflowVersionId ||
      canonicalJson(final[index].publishBody) !==
        canonicalJson(published[index].publishBody)
    )
      throw new Error("workflow-publication-changed-during-final-verification");
  }
  await assertDeployment(deps, args.versionId);
  return {
    mode: "published",
    workerName: deps.configuration.workerName,
    workerVersionId: args.versionId,
    workflows: published,
  };
}

export function createWorkflowPublicationDependencies(input: {
  configuration: WorkflowPublicationConfiguration;
  token: string;
  fetcher?: typeof fetch;
  log?: (value: unknown) => void;
}): WorkflowPublicationDependencies {
  if (!input.token || !/^[a-f0-9]{32}$/.test(input.configuration.accountId))
    throw new Error(
      "Workflow publication requires Cloudflare authentication and a valid tracked account",
    );
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.configuration.accountId}`;
  const fetcher = input.fetcher || fetch;
  return {
    configuration: input.configuration,
    log: input.log || ((value) => console.log(JSON.stringify(value))),
    async request(path, method = "GET", body) {
      let response: Response;
      try {
        response = await fetcher(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${input.token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error(`workflow-publication-request-unconfirmed:${method}`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `workflow-publication-provider-failed:${method}:${response.status}`,
        );
      }
      let envelope: JsonRecord;
      try {
        envelope = record(await readResponseJson(response, 1024 * 1024));
      } catch {
        throw new Error("workflow-publication-invalid-provider-response");
      }
      if (envelope.success !== true || !Object.hasOwn(envelope, "result"))
        throw new Error(
          "workflow-publication-provider-did-not-confirm-success",
        );
      return envelope.result;
    },
  };
}

export async function executePublishWorkflows(
  argv = process.argv.slice(2),
): Promise<void> {
  const args = parsePublishWorkflowArgs(argv);
  const configuration = parseWorkflowPublicationConfiguration(
    readFileSync(resolve(ROOT, "cloud/workers/api/wrangler.jsonc"), "utf8"),
  );
  const deps = createWorkflowPublicationDependencies({
    configuration,
    token: resolveCloudflareToken(),
  });
  const result = await publishCloudflareWorkflows(args, deps);
  deps.log(result);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  executePublishWorkflows().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Workflow publication failed; inspect provider state before retrying",
    );
    process.exitCode = 1;
  });
