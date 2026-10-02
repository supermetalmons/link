import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createWranglerRunner,
  resolveCloudflareToken,
  type SqlRunner,
} from "./operator/runtime.ts";
import { inspectMatchDiscovery } from "./operator/inspect/matchDiscovery.ts";
import { inspectMatchPresentations } from "./operator/inspect/matchPresentations.ts";
import {
  inspectWagers,
  createSqlDependencies as createWagerDependencies,
} from "./operator/inspect/wagers.ts";
import {
  inspectEventReceipts,
  createSqlDependencies as createReceiptDependencies,
  createProvider,
} from "./operator/inspect/eventReceipts.ts";

const domains = [
  "match-discovery",
  "match-presentations",
  "wagers",
  "event-receipts",
] as const;
type Domain = (typeof domains)[number];
type Arguments = { domain: Domain };
type Dependencies = {
  run: SqlRunner;
  log(value: Record<string, unknown>): void;
  receiptProvider?: ReturnType<typeof createProvider>;
};

function parseArgs(argv: string[]): Arguments {
  if (
    argv.length !== 2 ||
    argv[0] !== "--domain" ||
    !domains.some((domain) => domain === argv[1])
  )
    throw new Error(
      `Usage: npm run inspect:state -- --domain <${domains.join("|")}>`,
    );
  return { domain: argv[1] as Domain };
}

async function inspectState(
  { domain }: Arguments,
  dependencies: Dependencies,
): Promise<void> {
  const { run, log } = dependencies;
  switch (domain) {
    case "match-discovery":
      return inspectMatchDiscovery({ run, log });
    case "match-presentations":
      return inspectMatchPresentations({ run, log });
    case "wagers":
      return inspectWagers({ ...createWagerDependencies(run), log });
    case "event-receipts":
      if (!dependencies.receiptProvider)
        throw new Error(
          "receipt inspection requires deployment and Workflow reads",
        );
      return inspectEventReceipts({
        ...createReceiptDependencies(run, dependencies.receiptProvider),
        log,
      });
  }
}

async function execute(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const apiToken =
    args.domain === "event-receipts" ? resolveCloudflareToken() : undefined;
  await inspectState(args, {
    run: createWranglerRunner({ apiToken }),
    log: (value) => console.log(JSON.stringify(value)),
    ...(args.domain === "event-receipts"
      ? { receiptProvider: createProvider({ apiToken }) }
      : {}),
  });
}

export { parseArgs, inspectState, execute };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  execute().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "state inspection failed",
    );
    process.exitCode = 1;
  });
