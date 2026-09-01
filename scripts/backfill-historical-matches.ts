import { spawnSync } from "node:child_process";
import { closeSync, fchmodSync, openSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  isReadHistoricalMatchResponse,
  type ReadHistoricalMatchResponse,
} from "@mons/shared/game-sessions";
import { getHistoricalMatchIds } from "@mons/shared/rematches";

const DEFAULT_PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 640 * 1024;
const ARCHIVE_CONCURRENCY = 4;

export type BackfillOptions = {
  baseUrl: string;
  execute: boolean;
  failureFile: string | null;
  pageSize: number;
  project: string;
  startAt: string | null;
};

type BackfillDependencies = {
  archive(inviteId: string, matchId: string): Promise<boolean>;
  log(message: string): void;
  readPage(
    startAt: string | null,
    limit: number,
  ): Promise<Array<{ inviteId: string; value: unknown }>>;
};

export type BackfillResult = {
  archived: number;
  discovered: number;
  failures: string[];
  invites: number;
  lastCursor: string | null;
};

export type BackfillSummary = {
  archived: number;
  cursor: string | null;
  discovered: number;
  failures: number;
  invites: number;
};

function usage(): string {
  return "Usage: npm run backfill:historical-matches -- --project <id> --base-url <https-url> [--start-at <invite-id>] [--page-size <1-500>] [--execute --failure-file <new-mode-0600-file>]";
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(usage());
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.hostname !== "api.mons.link" &&
      !/^[0-9a-f]{8}-mons-link-api\.lil-org\.workers\.dev$/.test(url.hostname))
  ) {
    throw new TypeError(usage());
  }
  return url.origin;
}

export function parseArgs(argv: string[]): BackfillOptions {
  let baseUrl = "";
  let execute = false;
  let failureFile: string | null = null;
  let pageSize = DEFAULT_PAGE_SIZE;
  let project = "";
  let startAt: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--execute") {
      if (execute) throw new TypeError(usage());
      execute = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !value ||
      value.startsWith("--") ||
      ![
        "--base-url",
        "--failure-file",
        "--page-size",
        "--project",
        "--start-at",
      ].includes(name)
    ) {
      throw new TypeError(usage());
    }
    index++;
    if (name === "--base-url") {
      if (baseUrl) throw new TypeError(usage());
      baseUrl = normalizeBaseUrl(value);
    } else if (name === "--failure-file") {
      if (failureFile) throw new TypeError(usage());
      failureFile = resolve(value);
    } else if (name === "--page-size") {
      pageSize = Number(value);
    } else if (name === "--project") {
      if (project) throw new TypeError(usage());
      project = value.trim();
    } else {
      if (startAt) throw new TypeError(usage());
      startAt = value.trim();
    }
  }
  if (
    !baseUrl ||
    !project ||
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(project) ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 500 ||
    execute !== (failureFile !== null)
  ) {
    throw new TypeError(usage());
  }
  return { baseUrl, execute, failureFile, pageSize, project, startAt };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firebaseIntegerKey(value: string): number | null {
  if (!/^-?0*\d{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= -2_147_483_648 && parsed <= 2_147_483_647 ? parsed : null;
}

export function compareFirebaseKeys(left: string, right: string): number {
  if (left === right) return 0;
  const leftInteger = firebaseIntegerKey(left);
  const rightInteger = firebaseIntegerKey(right);
  if (leftInteger !== null) {
    if (rightInteger !== null) {
      return leftInteger === rightInteger
        ? left.length - right.length
        : leftInteger - rightInteger;
    }
    return -1;
  }
  if (rightInteger !== null) return 1;
  return left < right ? -1 : 1;
}

export function summarizeBackfill(result: BackfillResult): BackfillSummary {
  return {
    archived: result.archived,
    cursor: result.lastCursor,
    discovered: result.discovered,
    failures: result.failures.length,
    invites: result.invites,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("historical-match-response-too-large");
  }
  if (!response.body) throw new Error("historical-match-response-empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("oversized-response");
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function firebasePage(
  project: string,
  startAt: string | null,
  limit: number,
): Array<{ inviteId: string; value: unknown }> {
  const args = [
    "database:get",
    "/invites",
    "--project",
    project,
    "--order-by-key",
    "--limit-to-first",
    String(limit),
    ...(startAt ? ["--start-at", JSON.stringify(startAt)] : []),
  ];
  const result = spawnSync(resolve("node_modules/.bin/firebase"), args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) throw new Error("firebase-invite-read-failed");
  const parsed = toRecord(JSON.parse(String(result.stdout)) as unknown) || {};
  return Object.entries(parsed).map(([inviteId, value]) => ({
    inviteId,
    value,
  }));
}

function reserveFailureFile(path: string): number {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function writeFailureReport(descriptor: number, failures: string[]): void {
  writeFileSync(descriptor, `${JSON.stringify({ failures })}\n`, "utf8");
}

export async function backfillHistoricalMatches(
  options: BackfillOptions,
  dependencies: BackfillDependencies,
): Promise<BackfillResult> {
  const failureDescriptor = options.failureFile
    ? reserveFailureFile(options.failureFile)
    : null;
  let scanCursor = options.startAt;
  let safeCursor = options.startAt;
  let invites = 0;
  let discovered = 0;
  let archived = 0;
  const failures: string[] = [];
  try {
    while (true) {
      const page = (
        await dependencies.readPage(scanCursor, options.pageSize + 1)
      ).sort((left, right) =>
        compareFirebaseKeys(left.inviteId, right.inviteId),
      );
      const pageCursor = scanCursor;
      const fresh = pageCursor
        ? page.filter(
            (entry) => compareFirebaseKeys(entry.inviteId, pageCursor) > 0,
          )
        : page;
      const current = fresh.slice(0, options.pageSize);
      if (current.length === 0) break;
      for (const entry of current) {
        invites++;
        const matchIds = getHistoricalMatchIds(
          entry.inviteId,
          toRecord(entry.value),
        );
        discovered += matchIds.length;
        if (options.execute) {
          const results = Array.from({ length: matchIds.length }, () => false);
          let nextMatchIndex = 0;
          const workers = Array.from(
            { length: Math.min(ARCHIVE_CONCURRENCY, matchIds.length) },
            async () => {
              while (nextMatchIndex < matchIds.length) {
                const index = nextMatchIndex++;
                try {
                  results[index] = await dependencies.archive(
                    entry.inviteId,
                    matchIds[index],
                  );
                } catch {
                  results[index] = false;
                }
              }
            },
          );
          await Promise.all(workers);
          results.forEach((succeeded, index) => {
            if (succeeded) {
              archived++;
            } else {
              failures.push(`${entry.inviteId}/${matchIds[index]}`);
            }
          });
        }
      }
      scanCursor = current.at(-1)?.inviteId || scanCursor;
      if (failures.length === 0) {
        safeCursor = scanCursor;
      }
      dependencies.log(
        JSON.stringify({
          archived,
          cursor: safeCursor,
          discovered,
          failures: failures.length,
          invites,
        }),
      );
      if (failures.length > 0) break;
      if (fresh.length < options.pageSize) break;
    }
    if (failureDescriptor !== null) {
      writeFailureReport(failureDescriptor, failures);
    }
    return {
      archived,
      discovered,
      failures,
      invites,
      lastCursor: safeCursor,
    };
  } finally {
    if (failureDescriptor !== null) {
      closeSync(failureDescriptor);
    }
  }
}

async function execute(options: BackfillOptions): Promise<BackfillResult> {
  return backfillHistoricalMatches(options, {
    archive: async (inviteId, matchId) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const url = new URL(`${options.baseUrl}/matches/history`);
        url.searchParams.set("inviteId", inviteId);
        url.searchParams.set("matchId", matchId);
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        const payload = (await readBoundedJson(
          response,
        )) as ReadHistoricalMatchResponse;
        if (response.status === 429 && attempt < 3) {
          const retrySeconds = Math.min(
            60,
            Math.max(1, Number(response.headers.get("Retry-After")) || 60),
          );
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, retrySeconds * 1_000),
          );
          continue;
        }
        return (
          response.ok &&
          isReadHistoricalMatchResponse(payload) &&
          !!payload.pair
        );
      }
      return false;
    },
    log: console.log,
    readPage: (startAt, limit) =>
      Promise.resolve(firebasePage(options.project, startAt, limit)),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await execute(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summarizeBackfill(result)));
    if (result.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "backfill-failed");
    process.exitCode = 1;
  }
}
