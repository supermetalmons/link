import { createHash } from "node:crypto";
import { isSafeRecordKey } from "@mons/shared/ids";
import { isEventSnapshotResponse } from "@mons/shared/events";
import { isProfileEventPrizesResponse } from "@mons/shared/event-prizes";
import { isReadHistoricalMatchResponse } from "@mons/shared/game-sessions";
import { isProfileLookupResponse } from "@mons/shared/profiles";
import {
  createToolSession,
  refreshToolSession,
  revokeToolSession,
  type ToolSession,
} from "../cloudflare/sessions.ts";
import { canonicalJson, readResponseJson } from "../operator/runtime.ts";
import type { SqlQuery } from "./workflows.ts";
import {
  eventBookmarkConstraint,
  MAX_EVENT_BOOKMARK_LENGTH,
} from "../../cloud/workers/api/src/eventBookmarks.ts";

type JsonRecord = Record<string, unknown>;

export type ReadSmokeDatabases = {
  gameplayDatabaseId: string;
  eventDatabaseId: string;
  profileDatabaseId: string;
};

export type ReadSmokeEvidence = {
  sourceSha256: string;
  destinationSha256: string;
  responseSha256: string;
  liveRevisionAdvanced: boolean;
};

export type MigrationReadSmokeResult = {
  history: 1;
  currentEvents: 1;
  endedEvents: 1;
  publicProfiles: 1;
  anonymousPrizeIsolation: true;
  sessionRevoked: true;
  userPrizeOwnershipChecked: false;
  oldEventBookmarkRecovered?: true;
  evidence: {
    history: ReadSmokeEvidence;
    currentEvent: ReadSmokeEvidence;
    endedEvent: ReadSmokeEvidence;
    publicProfile: ReadSmokeEvidence;
  };
};

type Dependencies = {
  source: ReadSmokeDatabases;
  destination: ReadSmokeDatabases;
  query: SqlQuery;
  fetcher?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  oldEventBookmark?: EventBookmarkProbe;
  log?: (counts: Omit<MigrationReadSmokeResult, "evidence">) => void;
};

export type EventBookmarkProbe = {
  eventId: string;
  bookmark: string;
  etag: string;
};

const BASE_URL = "https://api.mons.link";
const ORIGIN = "https://mons.link";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(code: string): never {
  throw new Error(`migration-read-smoke-${code}`);
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid-record");
  return value as JsonRecord;
}

function one(rows: JsonRecord[]): JsonRecord {
  if (rows.length !== 1) fail("fixture-missing-or-ambiguous");
  return record(rows[0]);
}

function json(value: unknown): unknown {
  if (typeof value !== "string") fail("invalid-database-json");
  try {
    return JSON.parse(value);
  } catch {
    fail("invalid-database-json");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function revision(row: JsonRecord): number {
  if (
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  )
    fail("invalid-revision");
  return row.revision;
}

function evidence(
  source: JsonRecord,
  destination: JsonRecord,
  body: unknown,
): ReadSmokeEvidence {
  return {
    sourceSha256: digest(source),
    destinationSha256: digest(destination),
    responseSha256: digest(body),
    liveRevisionAdvanced: revision(destination) > revision(source),
  };
}

function assertSourceContinuity(
  source: JsonRecord,
  destination: JsonRecord,
): void {
  if (revision(destination) < revision(source))
    fail("destination-revision-regressed");
  if (
    revision(destination) === revision(source) &&
    canonicalJson(source) !== canonicalJson(destination)
  )
    fail("unchanged-revision-data-mismatch");
}

async function stableRead(
  source: JsonRecord,
  readDestination: () => Promise<JsonRecord>,
  readHttp: () => Promise<unknown>,
  expected: (row: JsonRecord) => unknown,
): Promise<ReadSmokeEvidence> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readDestination();
    const body = await readHttp();
    const after = await readDestination();
    if (canonicalJson(before) !== canonicalJson(after)) continue;
    assertSourceContinuity(source, after);
    if (canonicalJson(body) !== canonicalJson(expected(after)))
      fail("http-database-snapshot-mismatch");
    return evidence(source, after, body);
  }
  fail("live-snapshot-kept-changing");
}

async function eventRow(
  query: SqlQuery,
  databaseId: string,
  eventId: string,
): Promise<JsonRecord> {
  return one(
    await query(
      databaseId,
      `SELECT event_id, status, revision, record_json,
    (SELECT json_group_array(json_object('profile_id', selected.profile_id, 'prize_id', selected.prize_id))
     FROM (SELECT profile_id, prize_id FROM event_prize_selections
           WHERE event_id = ? ORDER BY profile_id) AS selected) AS selections_json
    FROM event_records WHERE event_id = ?`,
      [eventId, eventId],
    ),
  );
}

function eventBody(
  row: JsonRecord,
  expectedStatus: "current" | "ended",
): unknown {
  const event = record(json(row.record_json));
  const selections = json(row.selections_json);
  if (
    !isSafeRecordKey(row.event_id) ||
    event.eventId !== row.event_id ||
    event.status !== row.status ||
    (expectedStatus === "ended"
      ? row.status !== "ended"
      : row.status !== "scheduled" && row.status !== "active") ||
    !Array.isArray(selections)
  )
    fail("invalid-event-ground-truth");
  const prizeSelections = Object.fromEntries(
    selections.map((value) => {
      const selection = record(value);
      if (
        !isSafeRecordKey(selection.profile_id) ||
        !isSafeRecordKey(selection.prize_id)
      )
        fail("invalid-event-selection");
      return [selection.profile_id, selection.prize_id];
    }),
  );
  if (Object.keys(prizeSelections).length !== selections.length)
    fail("duplicate-event-selection");
  const body = {
    ok: true,
    eventId: row.event_id,
    revision: revision(row),
    event,
    prizeSelections,
  };
  if (!isEventSnapshotResponse(body)) fail("invalid-event-ground-truth");
  return body;
}

function profileBody(row: JsonRecord): unknown {
  const profile = record(json(row.payload_json));
  const body = { ok: true, profile };
  if (
    row.state !== "active" ||
    profile.id !== row.profile_id ||
    !isProfileLookupResponse(body)
  )
    fail("invalid-profile-ground-truth");
  return body;
}

function validateBookmarkProbe(probe: EventBookmarkProbe): void {
  if (
    !isSafeRecordKey(probe.eventId) ||
    typeof probe.bookmark !== "string" ||
    !probe.bookmark.trim() ||
    probe.bookmark.length > MAX_EVENT_BOOKMARK_LENGTH ||
    typeof probe.etag !== "string" ||
    !probe.etag.trim() ||
    probe.etag.length > 1_024 ||
    /[\r\n]/.test(probe.bookmark + probe.etag)
  )
    fail("invalid-old-bookmark-probe");
}

async function readBookmarkProbe(
  baseUrl: string,
  fetcher: typeof fetch,
  session: ToolSession,
  eventId: string,
  previous?: EventBookmarkProbe,
): Promise<EventBookmarkProbe> {
  if (previous) validateBookmarkProbe(previous);
  const response = await fetcher(
    `${baseUrl}/events/snapshot?${new URLSearchParams({ eventId })}`,
    {
      method: "GET",
      headers: {
        Origin: ORIGIN,
        Accept: "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        ...(previous
          ? {
              "X-D1-Bookmark": previous.bookmark,
              "If-None-Match": previous.etag,
            }
          : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (
    (response.status !== 200 && !(previous && response.status === 304)) ||
    response.headers.get("Access-Control-Allow-Origin") !== ORIGIN
  ) {
    await response.body?.cancel();
    fail("bookmark-probe-response-invalid");
  }
  const probe = {
    eventId,
    bookmark: response.headers.get("X-D1-Bookmark") || "",
    etag: response.headers.get("ETag") || "",
  };
  validateBookmarkProbe(probe);
  if (response.status === 304) {
    await response.body?.cancel();
    if (probe.etag !== previous!.etag)
      fail("bookmark-probe-etag-changed-on-304");
  } else {
    const body = await readResponseJson(response, 1024 * 1024);
    if (
      !isEventSnapshotResponse(body) ||
      body.eventId !== eventId ||
      !body.event
    )
      fail("bookmark-probe-event-invalid");
  }
  return probe;
}

export async function captureEventBookmarkProbe(dependencies: {
  query: SqlQuery;
  eventDatabaseId: string;
  fetcher?: typeof fetch;
  baseUrl?: string;
}): Promise<EventBookmarkProbe> {
  const baseUrl = dependencies.baseUrl || BASE_URL;
  if (baseUrl !== BASE_URL) fail("untrusted-api-origin");
  if (!UUID.test(dependencies.eventDatabaseId))
    fail("invalid-database-identities");
  const candidate = one(
    await dependencies.query(
      dependencies.eventDatabaseId,
      "SELECT event_id FROM event_records WHERE status IN ('scheduled', 'active') ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, start_at_ms, event_id LIMIT 1",
    ),
  );
  if (!isSafeRecordKey(candidate.event_id)) fail("invalid-event-fixtures");
  const fetcher = dependencies.fetcher || fetch;
  const session = await createToolSession(baseUrl, fetcher);
  try {
    return await readBookmarkProbe(
      baseUrl,
      fetcher,
      session,
      candidate.event_id,
    );
  } finally {
    await revokeToolSession(baseUrl, session.revokeToken, fetcher);
  }
}

export async function runMigrationReadSmokes(
  dependencies: Dependencies,
): Promise<MigrationReadSmokeResult> {
  const baseUrl = dependencies.baseUrl || BASE_URL;
  if (baseUrl !== BASE_URL) fail("untrusted-api-origin");
  for (const key of [
    "gameplayDatabaseId",
    "eventDatabaseId",
    "profileDatabaseId",
  ] as const) {
    if (
      !UUID.test(dependencies.source[key]) ||
      !UUID.test(dependencies.destination[key]) ||
      dependencies.source[key] === dependencies.destination[key]
    )
      fail("invalid-database-identities");
  }
  const { query, source, destination } = dependencies;
  const fetcher = dependencies.fetcher || fetch;
  const now = dependencies.now || Date.now;
  if (dependencies.oldEventBookmark)
    validateBookmarkProbe(dependencies.oldEventBookmark);
  const [history, currentCandidate, endedCandidate, profile] =
    await Promise.all([
      query(
        source.gameplayDatabaseId,
        "SELECT invite_id, match_id, revision, snapshot_json FROM historical_match_pairs ORDER BY invite_id, match_id LIMIT 1",
      ).then(one),
      query(
        source.eventDatabaseId,
        "SELECT event_id FROM event_records WHERE status IN ('scheduled', 'active') ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, start_at_ms, event_id LIMIT 1",
      ).then(one),
      query(
        source.eventDatabaseId,
        "SELECT event_id FROM event_records WHERE status = 'ended' ORDER BY start_at_ms DESC, event_id LIMIT 1",
      ).then(one),
      query(
        source.profileDatabaseId,
        "SELECT profile_id, state, revision, payload_json FROM profile_records WHERE state = 'active' ORDER BY updated_at_ms, profile_id LIMIT 1",
      ).then(one),
    ]);
  if (
    !isSafeRecordKey(currentCandidate.event_id) ||
    !isSafeRecordKey(endedCandidate.event_id) ||
    currentCandidate.event_id === endedCandidate.event_id
  )
    fail("invalid-event-fixtures");
  const [currentEvent, endedEvent, destinationHistory] = await Promise.all([
    eventRow(query, source.eventDatabaseId, currentCandidate.event_id),
    eventRow(query, source.eventDatabaseId, endedCandidate.event_id),
    query(
      destination.gameplayDatabaseId,
      "SELECT invite_id, match_id, revision, snapshot_json FROM historical_match_pairs WHERE invite_id = ? AND match_id = ?",
      [history.invite_id, history.match_id],
    ).then(one),
  ]);
  const historyBody = { ok: true, pair: json(history.snapshot_json) };
  if (
    !isReadHistoricalMatchResponse(historyBody) ||
    !historyBody.pair ||
    historyBody.pair.matchId !== history.match_id ||
    !isSafeRecordKey(history.invite_id) ||
    canonicalJson(history) !== canonicalJson(destinationHistory)
  )
    fail("historical-copy-mismatch");
  eventBody(currentEvent, "current");
  eventBody(endedEvent, "ended");
  profileBody(profile);
  const session: ToolSession = await createToolSession(baseUrl, fetcher);
  let result: MigrationReadSmokeResult | undefined;
  let failure: unknown;
  async function request(
    path: string,
    options: { authenticated?: boolean; body?: unknown } = {},
  ) {
    if (options.authenticated && session.accessExpiresAtMs <= now() + 30_000)
      Object.assign(
        session,
        await refreshToolSession(baseUrl, session, fetcher),
      );
    const response = await fetcher(baseUrl + path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        Origin: ORIGIN,
        Accept: "application/json",
        ...(options.authenticated
          ? { Authorization: `Bearer ${session.accessToken}` }
          : {}),
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      fail(`http-${response.status}`);
    }
    if (
      response.headers.get("Access-Control-Allow-Origin") !==
      (options.authenticated ? ORIGIN : "*")
    ) {
      await response.body?.cancel();
      fail("cors-mismatch");
    }
    if (
      path.startsWith("/events/") &&
      (!response.headers.get("ETag") || !response.headers.get("X-D1-Bookmark"))
    ) {
      await response.body?.cancel();
      fail("event-version-headers-missing");
    }
    return readResponseJson(response, 1024 * 1024);
  }
  try {
    const actualHistory = await request(
      `/matches/history?${new URLSearchParams({ inviteId: String(history.invite_id), matchId: String(history.match_id) })}`,
    );
    if (canonicalJson(actualHistory) !== canonicalJson(historyBody))
      fail("historical-http-mismatch");
    const current = await stableRead(
      currentEvent,
      () =>
        eventRow(
          query,
          destination.eventDatabaseId,
          String(currentEvent.event_id),
        ),
      () =>
        request(
          `/events/snapshot?${new URLSearchParams({ eventId: String(currentEvent.event_id) })}`,
          { authenticated: true },
        ),
      (row) => eventBody(row, "current"),
    );
    const ended = await stableRead(
      endedEvent,
      () =>
        eventRow(
          query,
          destination.eventDatabaseId,
          String(endedEvent.event_id),
        ),
      () =>
        request(
          `/events/snapshot?${new URLSearchParams({ eventId: String(endedEvent.event_id) })}`,
          { authenticated: true },
        ),
      (row) => eventBody(row, "ended"),
    );
    const publicProfile = await stableRead(
      profile,
      () =>
        query(
          destination.profileDatabaseId,
          "SELECT profile_id, state, revision, payload_json FROM profile_records WHERE profile_id = ?",
          [profile.profile_id],
        ).then(one),
      () =>
        request("/profiles/lookup", {
          authenticated: true,
          body: { kind: "profile", id: profile.profile_id },
        }),
      profileBody,
    );
    const prizes = await request("/events/prizes", { authenticated: true });
    if (
      !isProfileEventPrizesResponse(prizes) ||
      prizes.profileId !== null ||
      prizes.revision !== 0 ||
      Object.keys(prizes.prizes).length !== 0
    )
      fail("anonymous-prize-isolation-failed");
    if (dependencies.oldEventBookmark) {
      if (session.accessExpiresAtMs <= now() + 30_000)
        Object.assign(
          session,
          await refreshToolSession(baseUrl, session, fetcher),
        );
      const recovered = await readBookmarkProbe(
        baseUrl,
        fetcher,
        session,
        dependencies.oldEventBookmark.eventId,
        dependencies.oldEventBookmark,
      );
      if (
        eventBookmarkConstraint(
          recovered.bookmark,
          destination.eventDatabaseId,
        ) === "first-primary"
      )
        fail("old-event-bookmark-not-recovered");
    }
    result = {
      history: 1,
      currentEvents: 1,
      endedEvents: 1,
      publicProfiles: 1,
      anonymousPrizeIsolation: true,
      sessionRevoked: true,
      userPrizeOwnershipChecked: false,
      ...(dependencies.oldEventBookmark
        ? { oldEventBookmarkRecovered: true as const }
        : {}),
      evidence: {
        history: evidence(history, destinationHistory, actualHistory),
        currentEvent: current,
        endedEvent: ended,
        publicProfile,
      },
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      await revokeToolSession(baseUrl, session.revokeToken, fetcher);
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "migration-read-smoke-and-session-cleanup-failed",
          )
        : error;
    }
  }
  if (failure) throw failure;
  if (!result) fail("result-missing");
  const { evidence: _evidence, ...counts } = result;
  dependencies.log?.(counts);
  return result;
}
