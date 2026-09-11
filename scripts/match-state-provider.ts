import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createFirebaseTokenProvider,
  readPrivateJson,
  readResponseJson,
  resolveCloudflareToken,
  type SqlRunner,
} from "./operator/runtime.ts";
import { createMatchStateMigrationSignature } from "../cloud/workers/api/src/matchStateMigrationAuth.ts";
import {
  MATCH_STATE_MIGRATION_MAX_BYTES,
  MATCH_STATE_MIGRATION_PATH,
  type MatchStateMigrationRequest,
} from "../cloud/workers/api/src/matchStateMigration.ts";
import type { MatchStateImportSnapshot } from "../cloud/workers/api/src/matchStateTypes.ts";
import type { MatchStateInventory } from "./match-state-manifest.ts";
import { mapMatchStateBounded } from "./match-state-concurrency.ts";

const GAMEPLAY_DB = "mons-link-profile-games";
const EVENT_DB = "mons-link-events";
const ROOT = resolve(import.meta.dirname, "..");
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("match-state-invalid-provider-record");
  return value as JsonRecord;
}

function trackedConfig(): JsonRecord {
  const require = createRequire(import.meta.url);
  const typescript = require("typescript") as typeof import("typescript");
  const path = resolve(ROOT, "cloud/workers/api/wrangler.jsonc");
  const parsed = typescript.parseConfigFileTextToJson(
    path,
    readFileSync(path, "utf8"),
  );
  if (parsed.error) throw new Error("match-state-invalid-tracked-config");
  return record(parsed.config);
}

async function readRows(
  run: SqlRunner,
  sql: string,
  database: string,
): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await run(`${sql} LIMIT 500 OFFSET ?`, database, [offset]);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

export function createMatchStateProvider(input: {
  run: SqlRunner;
  firebaseCredentials?: string;
  secretFile?: string;
  firebaseToken?: () => Promise<string>;
  fetcher?: typeof fetch;
}) {
  const fetcher = input.fetcher || fetch;
  let token = input.firebaseToken;
  let pendingToken: Promise<string> | null = null;
  const accessToken = () => {
    token ||= createFirebaseTokenProvider(input.firebaseCredentials);
    return (pendingToken ||= token().finally(() => {
      pendingToken = null;
    }));
  };
  const readSource = async (
    path: string,
    shallow = false,
  ): Promise<unknown> => {
    const sourceUrl = "https://mons-link-default-rtdb.firebaseio.com";
    const url = new URL(
      `${sourceUrl}/${path.split("/").map(encodeURIComponent).join("/")}.json`,
    );
    if (shallow) url.searchParams.set("shallow", "true");
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("match-state-source-read-unavailable");
    return readResponseJson(response, 64 * 1024 * 1024);
  };
  const sourceKeys = async (path: string): Promise<string[]> => {
    const raw = await readSource(path, true);
    if (raw === null) return [];
    const keys = Object.keys(record(raw)).sort();
    if (keys.some((key) => !key || /[.#$[\]/]/.test(key)))
      throw new Error("match-state-invalid-source-key");
    return keys;
  };
  return {
    readSource,
    async deployment(): Promise<string> {
      const config = trackedConfig();
      const accountId = config.account_id;
      if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/.test(accountId))
        throw new Error("match-state-invalid-account-config");
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/mons-link-api/deployments`,
        {
          headers: { Authorization: `Bearer ${resolveCloudflareToken()}` },
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
      );
      const payload = record(await readResponseJson(response, 1024 * 1024));
      const deployments = record(payload.result).deployments;
      if (
        !response.ok ||
        payload.success !== true ||
        !Array.isArray(deployments) ||
        !deployments.length
      )
        throw new Error("match-state-deployment-unavailable");
      const versions = record(deployments[0]).versions;
      if (
        !Array.isArray(versions) ||
        versions.length !== 1 ||
        record(versions[0]).percentage !== 100 ||
        typeof record(versions[0]).version_id !== "string"
      )
        throw new Error("match-state-requires-one-full-deployment");
      return record(versions[0]).version_id as string;
    },
    async inventory(): Promise<MatchStateInventory> {
      const players = await sourceKeys("players");
      const records = (
        await mapMatchStateBounded(players, 16, async (actorUid) => {
          const source = await readSource(`players/${actorUid}/matches`);
          if (source === null) return [];
          const matches = record(source);
          return Object.keys(matches)
            .sort()
            .map((matchId) => {
              if (
                !matchId ||
                /[.#$[\]/]/.test(matchId) ||
                matches[matchId] === null
              )
                throw new Error("match-state-invalid-source-match-key");
              return { actorUid, matchId, value: matches[matchId] };
            });
        })
      ).flat();
      if (
        JSON.stringify(await sourceKeys("players")) !== JSON.stringify(players)
      )
        throw new Error("match-state-source-inventory-changed");
      const claimRoot = await readSource("matchTimerClaims");
      const claimValues = claimRoot === null ? {} : record(claimRoot);
      const claims = Object.keys(claimValues)
        .sort()
        .map((matchId) => ({ matchId, value: claimValues[matchId] }));
      const inviteRows = await readRows(
        input.run,
        "SELECT invite_id, source_json, revision FROM invite_sources ORDER BY invite_id",
        GAMEPLAY_DB,
      );
      const discoveryRows = await readRows(
        input.run,
        "SELECT login_uid, match_id, invite_id, resolution FROM login_match_discovery ORDER BY login_uid, match_id",
        GAMEPLAY_DB,
      );
      const timerMarkers = await readRows(
        input.run,
        "SELECT player_id, match_id, opponent_id, timer, turn_number FROM match_timer_starts ORDER BY player_id, match_id",
        GAMEPLAY_DB,
      );
      const sessionTransitions = await readRows(
        input.run,
        "SELECT transition_id, invite_id, payload_json, status FROM game_session_transitions WHERE status = 'pending' ORDER BY transition_id",
        GAMEPLAY_DB,
      );
      const eventTransitions = await readRows(
        input.run,
        "SELECT transition_id, event_id, status FROM event_transition_intents WHERE status = 'pending' ORDER BY transition_id",
        EVENT_DB,
      );
      if (sessionTransitions.length || eventTransitions.length)
        throw new Error("match-state-pending-transitions-prevent-export");
      return {
        records,
        claims,
        invites: inviteRows.map((row) => ({
          inviteId: String(row.invite_id),
          value: record(JSON.parse(String(row.source_json))),
          revision: Number(row.revision),
        })),
        discovery: discoveryRows.map((row) => ({
          actorUid: String(row.login_uid),
          matchId: String(row.match_id),
          inviteId: row.invite_id === null ? null : String(row.invite_id),
          resolution: row.resolution as "resolved" | "missing" | "ambiguous",
        })),
        crossChecks: { timerMarkers, sessionTransitions, eventTransitions },
      };
    },
    async migrate(
      request: MatchStateMigrationRequest,
    ): Promise<MatchStateImportSnapshot> {
      if (!input.secretFile)
        throw new Error("match-state-migration-secret-file-required");
      const credentials = record(readPrivateJson(input.secretFile, true));
      if (typeof credentials.secret !== "string" || !credentials.secret.trim())
        throw new Error("match-state-invalid-migration-secret-file");
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > MATCH_STATE_MIGRATION_MAX_BYTES)
        throw new Error("match-state-invite-exceeds-migration-request-limit");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = await createMatchStateMigrationSignature(
        body,
        credentials.secret,
        timestamp,
      );
      const response = await fetcher(
        `https://api.mons.link${MATCH_STATE_MIGRATION_PATH}`,
        {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "X-Mons-Match-State-Timestamp": timestamp,
            "X-Mons-Match-State-Signature": signature,
          },
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
      );
      const payload = record(
        await readResponseJson(response, MATCH_STATE_MIGRATION_MAX_BYTES),
      );
      if (!response.ok || payload.ok !== true || !payload.bundle)
        throw new Error(
          `match-state-migration-request-failed-${response.status}`,
        );
      return payload.bundle as MatchStateImportSnapshot;
    },
  };
}
