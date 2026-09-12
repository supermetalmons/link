import { resolveCloudflareToken } from "../operator/runtime.ts";
import { migrationFetch } from "./transport.ts";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiRecord = Record<string, unknown>;
export type QueryParameter = string | number | null;

export class CloudflareRequestFailure extends Error {
  readonly status: number;
  readonly codes: number[];
  readonly operation: string;
  constructor(status: number, codes: number[], operation: string) {
    super(
      `Cloudflare ${operation} failed (HTTP ${status}; codes ${codes.join(",") || "none"})`,
    );
    this.status = status;
    this.codes = codes;
    this.operation = operation;
  }
}

export function apiRecord(value: unknown): ApiRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Cloudflare response object");
  return value as ApiRecord;
}

async function readApiJson(response: Response): Promise<unknown> {
  const maximum = 16 * 1024 * 1024;
  if (
    !response.body ||
    Number(response.headers.get("Content-Length")) > maximum
  )
    throw new Error("missing or oversized provider response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new Error("oversized provider response");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createCloudflareProvider(
  accountId: string,
  options: { token?: string; fetcher?: typeof fetch } = {},
) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("invalid account ID");
  const token = options.token || resolveCloudflareToken();
  const fetcher = options.fetcher || migrationFetch;
  const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/`;
  const envelope = async (
    path: string,
    method: ApiMethod = "GET",
    body?: unknown,
  ): Promise<ApiRecord> => {
    const decodedPath = decodeURIComponent(path.split("?")[0]);
    if (
      path.startsWith("/") ||
      path.includes("://") ||
      path.includes("#") ||
      decodedPath.split(/[\\/]/).some((part) => part === "." || part === "..")
    )
      throw new Error("invalid account-relative API path");
    const response = await fetcher(root + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const status = response.status;
    if (status === 204 && response.ok) return { success: true, result: null };
    let envelope: ApiRecord;
    try {
      envelope = apiRecord(await readApiJson(response));
    } catch {
      throw new CloudflareRequestFailure(
        status,
        [],
        `${method} ${path.split("?")[0]}`,
      );
    }
    if (!response.ok || envelope.success !== true) {
      const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
      throw new CloudflareRequestFailure(
        status,
        errors
          .map((error) => Number(apiRecord(error).code))
          .filter(Number.isFinite),
        `${method} ${path.split("?")[0]}`,
      );
    }
    return envelope;
  };

  const request = async (
    path: string,
    method: ApiMethod = "GET",
    body?: unknown,
  ): Promise<unknown> => (await envelope(path, method, body)).result;

  const query = async (
    databaseId: string,
    sql: string,
    params: QueryParameter[] = [],
  ): Promise<ApiRecord[]> => {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId))
      throw new Error("invalid manifest database UUID");
    if (Buffer.byteLength(sql) > 90 * 1024 || params.length > 100)
      throw new Error("D1 query exceeds bounded statement limits");
    if (
      params.some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          (typeof value !== "number" ||
            !Number.isFinite(value) ||
            (Number.isInteger(value) && !Number.isSafeInteger(value))),
      )
    )
      throw new Error("invalid D1 query parameter");
    const result = await request(`d1/database/${databaseId}/query`, "POST", {
      sql,
      params,
    });
    if (!Array.isArray(result) || !result.length)
      throw new Error("missing D1 results");
    return result.flatMap((raw) => {
      const entry = apiRecord(raw);
      if (entry.success !== true || !Array.isArray(entry.results))
        throw new Error("D1 operation was not confirmed");
      return entry.results.map(apiRecord);
    });
  };

  const list = async (path: string): Promise<ApiRecord[]> => {
    const rows: ApiRecord[] = [];
    for (let page = 1; ; page++) {
      const data = await request(
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=100`,
      );
      if (!Array.isArray(data))
        throw new Error("unexpected paginated API result");
      rows.push(...data.map(apiRecord));
      if (data.length < 100) return rows;
      if (page >= 1000)
        throw new Error("pagination exceeded bounded page count");
    }
  };

  return { request, query, list, envelope };
}

export type CloudflareProvider = ReturnType<typeof createCloudflareProvider>;
