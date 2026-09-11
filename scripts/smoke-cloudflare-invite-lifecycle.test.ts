import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "mons-rules";
import {
  countMoveHistory,
  isMoveHistoryPrefix,
  isSubmitMoveRequest,
  normalizeMatchSnapshot,
} from "@mons/shared/game-sessions";
import {
  formatMatchTimer,
  MATCH_TIMER_DURATION_MS,
  parseStrictMatchTimer,
} from "@mons/shared/timers";
import { INVITE_METADATA_MAX_MESSAGE_BYTES } from "@mons/shared/invite-metadata";
import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_SOCKET_PROTOCOL,
  type MatchSyncSnapshot,
} from "@mons/shared/match-sync";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import { parseArgs, runSmoke } from "./smoke-cloudflare-invite-lifecycle.ts";
import type {
  Dependencies,
  SmokeSocket,
} from "./smoke-cloudflare-invite-lifecycle.ts";

const API = "https://api.mons.link";
const INVITE = "SmokeAbc123";
const HOST = "H".repeat(28);
const GUEST = "G".repeat(28);
const NOW = 1_800_000_000_000;
const jwt = (uid: string) =>
  `header.${Buffer.from(JSON.stringify({ sub: uid })).toString("base64url")}.signature`;
const TOKENS = new Map([
  [HOST, jwt(HOST)],
  [GUEST, jwt(GUEST)],
]);
const json = (
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "https://mons.link",
      ...headers,
    },
  });
type RequestRecord = {
  url: URL;
  method: string;
  body: unknown;
  headers: Headers;
};
type Source = {
  inviteId: string;
  revision: number;
  hostId: string;
  guestId: string | null;
  hostColor: "white";
  hostRematches: string;
  guestRematches: string;
  automatchStateHint: null;
  eventId: null;
  eventOwned: false;
};
type Match = {
  version: number;
  color: "white" | "black";
  emojiId: number;
  aura: string;
  gameVariant: string;
  fen: string;
  status: string;
  flatMovesString: string;
  timer: string;
  sessionCreation: string;
};

class FakeSocket extends EventEmitter implements SmokeSocket {
  terminated = false;
  sent: string[] = [];
  readonly protocol: string;
  readonly matchId: string | null;
  readonly suppressHeartbeat: boolean;
  constructor(
    protocol: string,
    matchId: string | null,
    suppressHeartbeat: boolean,
  ) {
    super();
    this.protocol = protocol;
    this.matchId = matchId;
    this.suppressHeartbeat = suppressHeartbeat;
  }
  send(data: string) {
    assert.equal(data, REACTION_HEARTBEAT_REQUEST);
    assert.equal(this.protocol, MATCH_SYNC_SOCKET_PROTOCOL);
    this.sent.push(data);
    if (!this.suppressHeartbeat)
      queueMicrotask(() =>
        this.emit("message", Buffer.from(REACTION_HEARTBEAT_RESPONSE), false),
      );
  }
  terminate() {
    this.terminated = true;
  }
}

function harness(
  options: {
    intercept?: (
      request: RequestRecord,
      response: () => Response,
    ) => Promise<Response> | Response;
    socketFrame?: (snapshot: Source) => unknown;
    matchSocketFrame?: (snapshot: MatchSyncSnapshot) => unknown;
    suppressUpdates?: boolean;
    suppressMatchUpdates?: boolean;
    suppressHeartbeat?: boolean;
    failMatchReconnect?: boolean;
    reconnectMatchRevision?: (revision: number) => number;
    fastTimers?: boolean;
    delayFinalRematchUpdateMs?: number | "forever";
    advanceMs?: number;
    renewalFrame?: (
      snapshot: Source | MatchSyncSnapshot,
      protocol: string,
    ) => unknown;
  } = {},
) {
  let now = NOW;
  let source: Source | null = null;
  let signupCount = 0;
  let nextOperation = 0;
  const requests: RequestRecord[] = [];
  const logs: string[] = [];
  const sockets: FakeSocket[] = [];
  const connections: {
    url: string;
    options: import("ws").ClientOptions;
    protocol: string;
  }[] = [];
  const deleted: string[] = [];
  const sessionOwners = new Map<string, string>();
  const sessionExpiries = new Map<string, number>();
  const socketExpiries = new Map<FakeSocket, number>();
  let expiredSockets = 0;
  let delayedMatchFrames = 0;
  const receipts = new Map<
    string,
    { path: string; body: unknown; payload: unknown }
  >();
  const matches = new Map<string, { value: Match; revision: number }>();
  const syncSnapshots = new Map<string, MatchSyncSnapshot>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const timeoutDurations: number[] = [];
  const owner = (token: string | null) =>
    [...TOKENS].find(([, value]) => value === token)?.[0];
  const frame = (snapshot: Source) =>
    options.socketFrame?.(snapshot) ?? {
      schemaVersion: 1,
      type: "snapshot",
      snapshot,
    };
  const syncSnapshot = (matchId: string): MatchSyncSnapshot => {
    assert.ok(source);
    const previous = syncSnapshots.get(matchId);
    const next = {
      inviteId: INVITE,
      matchId,
      revision: previous?.revision ?? 1,
      hostPlayerId: HOST,
      guestPlayerId: source.guestId,
      hostMatch: normalizeMatchSnapshot(
        matches.get(`${HOST}/${matchId}`)?.value ?? null,
      ),
      guestMatch: normalizeMatchSnapshot(
        matches.get(`${GUEST}/${matchId}`)?.value ?? null,
      ),
    };
    if (previous && JSON.stringify(previous) !== JSON.stringify(next))
      next.revision++;
    syncSnapshots.set(matchId, next);
    return structuredClone(next);
  };
  const matchFrame = (snapshot: MatchSyncSnapshot) =>
    options.matchSocketFrame?.(snapshot) ?? {
      schemaVersion: 1,
      type: "snapshot",
      snapshot,
    };
  const broadcastMatches = (matchId?: string) => {
    if (options.suppressUpdates || options.suppressMatchUpdates) return;
    for (const socket of sockets) {
      if (
        socket.terminated ||
        !socket.matchId ||
        (matchId && socket.matchId !== matchId)
      )
        continue;
      const snapshot = syncSnapshot(socket.matchId);
      const deliver = () => {
        if (!socket.terminated)
          socket.emit(
            "message",
            Buffer.from(JSON.stringify(matchFrame(snapshot))),
            false,
          );
      };
      if (
        options.delayFinalRematchUpdateMs !== undefined &&
        socket.matchId === `${INVITE}1` &&
        snapshot.hostMatch?.status === "" &&
        snapshot.guestMatch?.status === "" &&
        [snapshot.hostMatch, snapshot.guestMatch].some(
          (match) =>
            match !== null && countMoveHistory(match.flatMovesString) === 5,
        )
      ) {
        delayedMatchFrames++;
        if (options.delayFinalRematchUpdateMs !== "forever")
          setTimeout(deliver, options.delayFinalRematchUpdateMs);
      } else queueMicrotask(deliver);
    }
  };
  const broadcast = () => {
    if (!source || options.suppressUpdates) return;
    const value = structuredClone(source);
    queueMicrotask(() => {
      for (const socket of sockets)
        if (!socket.terminated && !socket.matchId)
          socket.emit(
            "message",
            Buffer.from(JSON.stringify(frame(value))),
            false,
          );
    });
    broadcastMatches();
  };
  const seed = (uid: string, matchId: string, emojiId: number): Match => ({
    version: 2,
    color:
      uid === HOST
        ? matchId === INVITE
          ? "white"
          : "black"
        : matchId === INVITE
          ? "black"
          : "white",
    emojiId,
    aura: "",
    gameVariant: "Classic",
    fen: new Game().toFen(),
    status: "",
    flatMovesString: "",
    timer: "",
    sessionCreation: (uid === HOST ? "a" : "b").repeat(64),
  });
  const handle = (request: RequestRecord): Response => {
    const { url, body, method, headers } = request;
    if (url.pathname.startsWith("/auth/session/")) {
      assert.equal(method, "POST");
      assert.equal(headers.get("Origin"), "https://mons.link");
      if (url.pathname === "/auth/session/anonymous") {
        assert.ok(body && typeof body === "object" && "sessionId" in body);
        const sessionId = String(body.sessionId);
        const uid = signupCount++ === 0 ? HOST : GUEST;
        sessionOwners.set(sessionId, uid);
        sessionExpiries.set(uid, now + 300_000);
        return json({
          ok: true,
          uid,
          sessionId,
          accessToken: TOKENS.get(uid),
          accessExpiresAtMs: now + 300_000,
        });
      }
      if (url.pathname === "/auth/session/refresh") {
        const sessionId = headers.get("Authorization")?.split(".")[1] || "";
        const uid = sessionOwners.get(sessionId);
        assert.ok(uid);
        sessionExpiries.set(uid, now + 300_000);
        return json({
          ok: true,
          uid,
          sessionId,
          accessToken: TOKENS.get(uid),
          accessExpiresAtMs: now + 300_000,
        });
      }
      assert.equal(url.pathname, "/auth/session/logout");
      const uid = sessionOwners.get(
        headers.get("Authorization")?.split(".")[1] || "",
      );
      if (uid) deleted.push(uid);
      return new Response(null, { status: 204 });
    }
    assert.equal(url.origin, API);
    if (url.pathname === "/matches/snapshot") {
      assert.equal(method, "GET");
      assert.equal(headers.get("Authorization"), null);
      assert.equal(url.searchParams.size, 2);
      const playerId = url.searchParams.get("playerId");
      const matchId = url.searchParams.get("matchId");
      assert.ok(playerId === HOST || playerId === GUEST);
      assert.ok(matchId === INVITE || matchId === `${INVITE}1`);
      return json(
        {
          ok: true,
          playerId,
          matchId,
          match: normalizeMatchSnapshot(
            matches.get(`${playerId}/${matchId}`)?.value ?? null,
          ),
        },
        200,
        { "Access-Control-Allow-Origin": "*" },
      );
    }
    const uid = owner(
      headers.get("Authorization")?.replace(/^Bearer /, "") || null,
    );
    assert.ok(uid);
    if (url.pathname === `/invites/${INVITE}/metadata`) {
      assert.equal(method, "GET");
      assert.ok(source);
      return json({
        ok: true,
        snapshot: source,
        viewer: {
          role: uid === HOST ? "host" : "guest",
          actorUid: uid,
          automatchOperationId: null,
        },
      });
    }
    const syncPath = new RegExp(
      `^/invites/${INVITE}/matches/(${INVITE}1?)/snapshot$`,
    ).exec(url.pathname);
    if (syncPath) {
      assert.equal(method, "GET");
      return json({ ok: true, snapshot: syncSnapshot(syncPath[1]) });
    }
    assert.equal(method, "POST");
    if (url.pathname === "/matches/timer/start") {
      assert.ok(body && typeof body === "object" && "matchId" in body);
      assert.deepEqual(body, {
        inviteId: INVITE,
        matchId: body.matchId,
        playerId: uid,
        opponentId: uid === HOST ? GUEST : HOST,
      });
      const match = matches.get(`${uid}/${body.matchId}`)!;
      assert.ok(match);
      const game = Game.fromFen(match.value.fen)!;
      assert.notEqual(game.activeColor, match.value.color);
      const current = parseStrictMatchTimer(match.value.timer);
      if (current?.turnNumber !== game.turnNumber) {
        match.value.timer = formatMatchTimer(
          game.turnNumber,
          now + MATCH_TIMER_DURATION_MS + 500,
        );
        match.revision++;
        broadcastMatches(String(body.matchId));
      }
      return json({
        ok: true,
        timer: match.value.timer,
        duration: MATCH_TIMER_DURATION_MS,
      });
    }
    if (url.pathname === "/matches/move") {
      assert.ok(isSubmitMoveRequest(body));
      assert.equal(body.playerId, uid);
      assert.equal(body.inviteId, INVITE);
      const match = matches.get(`${uid}/${body.matchId}`)!;
      assert.ok(match);
      if (
        body.previousStates &&
        match.value.flatMovesString !== body.flatMovesString &&
        isMoveHistoryPrefix(body.flatMovesString, match.value.flatMovesString)
      ) {
        return json({
          ok: true,
          inviteId: INVITE,
          matchId: body.matchId,
          actorUid: uid,
          outcome: "superseded",
          fen: match.value.fen,
          flatMovesString: match.value.flatMovesString,
        });
      }
      let outcome = "already-applied";
      if (
        match.value.fen !== body.fen ||
        match.value.flatMovesString !== body.flatMovesString
      ) {
        if (body.previousStates) {
          assert.ok(
            isMoveHistoryPrefix(
              body.previousFlatMovesString,
              match.value.flatMovesString,
            ),
          );
          assert.ok(
            isMoveHistoryPrefix(
              match.value.flatMovesString,
              body.flatMovesString,
            ),
          );
          assert.equal(
            body.previousStates.find(
              (state) =>
                state.moveCount ===
                countMoveHistory(match.value.flatMovesString),
            )?.fen,
            match.value.fen,
          );
        } else
          assert.equal(
            match.value.flatMovesString,
            body.previousFlatMovesString,
          );
        const game = new Game();
        for (const move of body.flatMovesString.split("-")) {
          assert.equal(game.activeColor, match.value.color);
          assert.equal(game.playFen(move).kind, "complete");
        }
        assert.equal(body.fen, game.toFen());
        match.value = {
          ...match.value,
          fen: body.fen,
          flatMovesString: body.flatMovesString,
        };
        match.revision++;
        outcome = "applied";
        broadcastMatches(body.matchId);
      }
      return json({
        ok: true,
        inviteId: INVITE,
        matchId: body.matchId,
        actorUid: uid,
        outcome,
      });
    }
    if (url.pathname === "/matches/surrender") {
      assert.ok(body && typeof body === "object" && "matchId" in body);
      assert.deepEqual(body, {
        inviteId: INVITE,
        matchId: body.matchId,
        playerId: uid,
      });
      assert.ok(body.matchId === INVITE || body.matchId === `${INVITE}1`);
      const match = matches.get(`${uid}/${body.matchId}`)!;
      assert.ok(match);
      if (match.value.status !== "surrendered") {
        match.value.status = "surrendered";
        match.revision++;
        broadcastMatches(String(body.matchId));
      }
      return json({
        ok: true,
        inviteId: INVITE,
        matchId: body.matchId,
        actorUid: uid,
      });
    }
    assert.ok(
      body &&
        typeof body === "object" &&
        "operationId" in body &&
        "inviteId" in body,
    );
    assert.equal(body.inviteId, INVITE);
    const operationId = String(body.operationId);
    const prior = receipts.get(operationId);
    if (prior) {
      assert.equal(prior.path, url.pathname);
      assert.deepEqual(
        prior.body,
        body,
        "Retries retain every operation field",
      );
      return json(prior.payload);
    }
    let payload: unknown;
    if (url.pathname === "/invites/create") {
      assert.equal(uid, HOST);
      assert.equal(source, null);
      assert.deepEqual(Object.keys(body).sort(), [
        "aura",
        "emojiId",
        "inviteId",
        "operationId",
      ]);
      source = {
        inviteId: INVITE,
        revision: 1,
        hostId: HOST,
        guestId: null,
        hostColor: "white",
        hostRematches: "",
        guestRematches: "",
        automatchStateHint: null,
        eventId: null,
        eventOwned: false,
      };
      matches.set(`${HOST}/${INVITE}`, {
        value: seed(HOST, INVITE, 1),
        revision: 1,
      });
      payload = { ok: true, inviteId: INVITE, hostId: HOST, matchId: INVITE };
    } else {
      assert.ok(source);
      source.revision++;
      if (url.pathname === "/invites/join") {
        assert.equal(uid, GUEST);
        source.guestId = GUEST;
        matches.set(`${GUEST}/${INVITE}`, {
          value: seed(GUEST, INVITE, 2),
          revision: 1,
        });
        payload = {
          ok: true,
          inviteId: INVITE,
          guestId: GUEST,
          joined: true,
          matchId: INVITE,
        };
      } else if (url.pathname === "/rematches/propose") {
        assert.equal(
          matches.get(`${HOST}/${INVITE}`)?.value.status,
          "surrendered",
        );
        const key = uid === HOST ? "hostRematches" : "guestRematches";
        assert.equal(source[key], "");
        source[key] = "1";
        const match = seed(uid, `${INVITE}1`, uid === HOST ? 1 : 2);
        matches.set(`${uid}/${INVITE}1`, { value: match, revision: 1 });
        const { sessionCreation: _marker, ...publicMatch } = match;
        payload = {
          ok: true,
          inviteId: INVITE,
          actorUid: uid,
          matchId: `${INVITE}1`,
          rematches: "1",
          match: publicMatch,
        };
      } else {
        assert.equal(
          url.pathname,
          "/rematches/end",
          "No automatch, rating, prizes, or Telegram endpoints are called",
        );
        assert.equal(uid, HOST);
        if (!source.hostRematches.endsWith("x")) source.hostRematches += "x";
        payload = {
          ok: true,
          inviteId: INVITE,
          actorUid: uid,
          rematches: source.hostRematches,
        };
      }
    }
    receipts.set(operationId, {
      path: url.pathname,
      body: structuredClone(body),
      payload: structuredClone(payload),
    });
    broadcast();
    return json(payload);
  };
  const dependencies: Dependencies = {
    fetch: async (input, init) => {
      const request: RequestRecord = {
        url: new URL(String(input)),
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      };
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      requests.push(request);
      const uid = owner(request.headers.get("Authorization")?.slice(7) || null);
      if (uid && (sessionExpiries.get(uid) ?? 0) <= now)
        return json({ ok: false, error: "unauthenticated" }, 401);
      const response = await (options.intercept
        ? options.intercept(request, () => handle(request))
        : handle(request));
      if (!request.url.pathname.startsWith("/auth/session/")) {
        now += options.advanceMs ?? 0;
        for (const [socket, expiry] of socketExpiries) {
          if (!socket.terminated && expiry <= now) {
            expiredSockets++;
            socket.terminated = true;
            socket.emit("close", 4001);
          }
        }
      }
      return response;
    },
    connect: (url, socketOptions, protocol) => {
      connections.push({ url, options: socketOptions, protocol });
      const matchId =
        protocol === MATCH_SYNC_SOCKET_PROTOCOL
          ? new URL(url).pathname.split("/")[4]
          : null;
      if (!matchId)
        assert.equal(
          socketOptions.headers?.Authorization,
          `Bearer ${TOKENS.get(HOST)}`,
        );
      else {
        assert.equal(socketOptions.origin, "https://mons.link");
        assert.equal(socketOptions.maxPayload, MATCH_SYNC_MAX_MESSAGE_BYTES);
        assert.ok(
          !socketOptions.headers?.Authorization ||
            [...TOKENS.values()].some(
              (token) =>
                socketOptions.headers?.Authorization === `Bearer ${token}`,
            ),
        );
      }
      const socket = new FakeSocket(
        protocol,
        matchId,
        options.suppressHeartbeat ?? false,
      );
      const uid = owner(
        typeof socketOptions.headers?.Authorization === "string"
          ? socketOptions.headers.Authorization.slice(7)
          : null,
      );
      if (uid) {
        const expiry = sessionExpiries.get(uid)!;
        assert.ok(expiry > now, "socket authenticates with an unexpired token");
        socketExpiries.set(socket, expiry);
      }
      const renewed = connections
        .slice(0, -1)
        .some(
          (prior) =>
            prior.url === url &&
            prior.options.headers?.Authorization ===
              socketOptions.headers?.Authorization,
        );
      sockets.push(socket);
      queueMicrotask(() => {
        assert.ok(source);
        const reconnect =
          matchId &&
          matches.get(`${HOST}/${matchId}`)?.value.status === "surrendered";
        if (reconnect && options.failMatchReconnect) {
          socket.emit("error", new Error("Fixture reconnect failure"));
          return;
        }
        const snapshot = matchId ? syncSnapshot(matchId) : null;
        if (snapshot && reconnect && options.reconnectMatchRevision)
          snapshot.revision = options.reconnectMatchRevision(snapshot.revision);
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify(
              renewed && options.renewalFrame
                ? options.renewalFrame(
                    snapshot ?? structuredClone(source),
                    protocol,
                  )
                : snapshot
                  ? matchFrame(snapshot)
                  : frame(structuredClone(source)),
            ),
          ),
          false,
        );
      });
      return socket;
    },
    createInviteId: () => INVITE,
    createOperationId: () =>
      `00000000-0000-4000-8000-${String(++nextOperation).padStart(12, "0")}`,
    now: () => now,
    log: (message) => logs.push(message),
    setTimeout: ((callback: () => void, milliseconds: number) => {
      timeoutDurations.push(milliseconds);
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          callback();
        },
        options.fastTimers ? 0 : milliseconds,
      );
      timers.add(timer);
      return timer;
    }) as typeof setTimeout,
    clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer);
      clearTimeout(timer);
    }) as typeof clearTimeout,
  };
  return {
    dependencies,
    requests,
    logs,
    sockets,
    connections,
    deleted,
    receipts,
    matches,
    timers,
    timeoutDurations,
    source: () => source,
    elapsed: () => now - NOW,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    expiredSockets: () => expiredSockets,
    delayedMatchFrames: () => delayedMatchFrames,
  };
}

test("requires an explicit approved target and supports only the current lifecycle report", () => {
  assert.deepEqual(parseArgs(["--base-url", `${API}/`]), { baseUrl: API });
  assert.deepEqual(
    parseArgs([
      "--base-url",
      "https://abcd1234-mons-link-api.lil-org.workers.dev",
      "--output",
      "/tmp/report.json",
    ]),
    {
      baseUrl: "https://abcd1234-mons-link-api.lil-org.workers.dev",
      output: "/tmp/report.json",
    },
  );
  for (const args of [
    [],
    ["--base-url", API, "--base-url", API],
    ["--base-url", "http://api.mons.link"],
    ["--base-url", "https://other.example"],
    ["--base-url", "https://token@api.mons.link"],
    ["--base-url", `${API}/route`],
    ["--base-url", `${API}?token=secret`],
    ["--base-url", API, "--password", "invented"],
    ["--base-url", API, "--auth-token", "secret"],
    ["--base-url", API, "--match-storage", "durable"],
    ["--base-url", API, "--surrender-rules-pending"],
    ["--base-url", API, "--move-rules-pending"],
  ])
    assert.throws(() => parseArgs(args), /Usage:/);
});

test("default smoke verifies only Worker snapshots, original timer deadlines and isolated gameplay", async () => {
  const state = harness({});
  const report = await runSmoke({ baseUrl: API }, state.dependencies);
  assert.equal(report.matchStorage, "durable");
  assert.ok(
    report.checks.includes(
      "canonical-timer-start-and-original-deadline-replay",
    ),
  );
  assert.ok(report.checks.includes("canonical-rematch-timer-deadline-replay"));
  assert.ok(
    report.checks.includes("cumulative-moves-takebacks-and-reordered-replay"),
  );
  assert.ok(
    report.checks.includes(
      "live-match-moves-takebacks-surrender-and-reconnect",
    ),
  );
  assert.ok(report.checks.includes("terminal-replay-preserved-source"));
  const snapshots = state.requests.filter(
    (request) => request.url.pathname === "/matches/snapshot",
  );
  assert.ok(snapshots.length > 20);
  assert.ok(
    snapshots.every(
      (request) =>
        request.method === "GET" &&
        request.headers.get("Authorization") === null,
    ),
  );
  assert.ok(state.requests.every((request) => request.url.origin === API));
  const starts = state.requests.filter(
    (request) => request.url.pathname === "/matches/timer/start",
  );
  assert.equal(starts.length, 4);
  assert.deepEqual(starts[0].body, starts[1].body);
  assert.deepEqual(starts[2].body, starts[3].body);
  assert.equal(
    state.requests.filter(
      (request) => request.url.pathname === "/matches/timer/claim",
    ).length,
    0,
  );
  assert.ok(
    state.timeoutDurations.every(
      (milliseconds) => milliseconds === 15_000 || milliseconds === 30_000,
    ),
  );
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
  assert.equal(state.source()?.hostRematches, "1x");
  for (const token of TOKENS.values())
    assert.ok(!state.logs.join("\n").includes(token));
});

test("durable smoke rejects changed timer deadlines and still ends the series and revokes sessions", async () => {
  let starts = 0;
  const state = harness({
    intercept: async (request, respond) => {
      const response = respond();
      if (request.url.pathname === "/matches/timer/start" && ++starts === 2) {
        const value: {
          ok: true;
          timer: string;
          duration: number;
        } = await response.json();
        const timer = parseStrictMatchTimer(value.timer)!;
        return json({
          ...value,
          timer: formatMatchTimer(timer.turnNumber, timer.targetTimestamp + 1),
        });
      }
      return response;
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /timer retry changed its original deadline/,
  );
  assert.equal(starts, 2);
  assert.ok(state.source()?.hostRematches.endsWith("x"));
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
});

test("durable smoke retries transient canonical reads through the same endpoint", async () => {
  let failed = false;
  const state = harness({
    intercept: (request, respond) => {
      if (request.url.pathname === "/matches/snapshot" && !failed) {
        failed = true;
        return json({ ok: false, error: "unavailable" }, 503, {
          "Access-Control-Allow-Origin": "*",
        });
      }
      return respond();
    },
  });
  await runSmoke({ baseUrl: API }, state.dependencies);
  assert.equal(failed, true);
  const snapshots = state.requests.filter(
    (request) => request.url.pathname === "/matches/snapshot",
  );
  assert.equal(snapshots[0].url.href, snapshots[1].url.href);
  assert.ok(state.requests.every((request) => request.url.origin === API));
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("durable smoke rejects malformed, private or mismatched canonical snapshots without leaking payloads", async (t) => {
  for (const change of [
    { playerId: "another-player" },
    { matchId: "another-match" },
    { match: null },
    { extra: TOKENS.get(HOST) },
  ])
    await t.test(Object.keys(change)[0], async () => {
      const state = harness({
        intercept: async (request, respond) => {
          const response = respond();
          if (request.url.pathname !== "/matches/snapshot") return response;
          return json({ ...(await response.json()), ...change }, 200, {
            "Access-Control-Allow-Origin": "*",
          });
        },
      });
      await assert.rejects(
        runSmoke({ baseUrl: API }, state.dependencies),
        /canonical match snapshot was invalid/,
      );
      assert.ok(state.source()?.hostRematches.endsWith("x"));
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
      assert.ok(!state.logs.join("\n").includes(TOKENS.get(HOST)!));
    });
});

test("durable smoke keeps reconnect revision checks and cleanup enabled", async () => {
  const state = harness({
    reconnectMatchRevision: () => 1,
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /match socket received an invalid snapshot/,
  );
  assert.ok(state.source()?.hostRematches.endsWith("x"));
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.equal(state.timers.size, 0);
});

test("runs the isolated lifecycle with API move and surrender replay", async () => {
  const state = harness();
  const report = await runSmoke({ baseUrl: API }, state.dependencies);
  assert.equal(report.inviteId, INVITE);
  assert.deepEqual(report.matchIds, [INVITE, `${INVITE}1`]);
  assert.equal(report.checks.length, 16);
  assert.ok(report.checks.includes("pending-match-http-socket-and-heartbeat"));
  assert.ok(report.checks.includes("join-live-match-and-public-spectator"));
  assert.ok(
    report.checks.includes(
      "live-match-moves-takebacks-surrender-and-reconnect",
    ),
  );
  assert.ok(
    report.checks.includes(
      "rematch-live-creation-moves-surrender-and-reconnect",
    ),
  );
  const gameplaySockets = state.connections.filter(
    (connection) => connection.protocol === MATCH_SYNC_SOCKET_PROTOCOL,
  );
  assert.equal(gameplaySockets.length, 8);
  assert.equal(
    gameplaySockets.filter((connection) => !connection.options.headers).length,
    2,
  );
  assert.equal(
    state.sockets.reduce((count, socket) => count + socket.sent.length, 0),
    3,
  );
  assert.equal(
    state.requests.filter((request) => request.url.pathname === "/matches/move")
      .length,
    10,
  );
  assert.equal(
    state.requests.filter(
      (request) => request.url.pathname === "/matches/surrender",
    ).length,
    4,
  );
  assert.ok(state.matches.get(`${HOST}/${INVITE}`)?.value.flatMovesString);
  assert.ok(state.matches.get(`${GUEST}/${INVITE}1`)?.value.flatMovesString);
  assert.equal(state.receipts.size, 5);
  assert.equal(state.source()?.hostRematches, "1x");
  assert.equal(state.source()?.guestRematches, "1");
  assert.equal(state.source()?.revision, 5);
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.equal(state.timers.size, 0);
  assert.ok(
    state.timeoutDurations.every(
      (duration) => duration === 15_000 || duration === 30_000,
    ),
  );
  assert.ok(state.timeoutDurations.includes(30_000));
  const hostReplays = state.requests.filter(
    (request) =>
      request.url.pathname === "/rematches/propose" &&
      request.headers.get("Authorization") === `Bearer ${TOKENS.get(HOST)}`,
  );
  assert.equal(hostReplays.length, 3);
  assert.deepEqual(hostReplays[0].body, hostReplays[2].body);
  assert.equal(
    state.matches.get(`${HOST}/${INVITE}1`)?.value.status,
    "surrendered",
  );
  assert.ok(!state.logs.join("\n").includes("idToken"));
  for (const token of TOKENS.values())
    assert.ok(!state.logs.join("\n").includes(token));
});

test("uncertain API move replays the identical request without applying it twice", async () => {
  let uncertain = false;
  const state = harness({
    intercept(request, response) {
      const result = response();
      if (request.url.pathname === "/matches/move" && !uncertain) {
        uncertain = true;
        throw new Error("lost move response");
      }
      return result;
    },
  });
  await runSmoke({ baseUrl: API }, state.dependencies);
  const moves = state.requests.filter(
    (request) => request.url.pathname === "/matches/move",
  );
  assert.equal(moves.length, 11);
  assert.deepEqual(moves[0].body, moves[1].body);
  assert.deepEqual(moves[0].body, moves[3].body);
  assert.equal(state.matches.get(`${HOST}/${INVITE}`)?.revision, 4);
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("older cumulative move must acknowledge superseded and match the original participant", async () => {
  for (const fault of ["replay", "actor"] as const) {
    let moves = 0;
    const state = harness({
      intercept(request, response) {
        const result = response();
        if (request.url.pathname === "/matches/move" && ++moves === 2) {
          return json({
            ok: true,
            inviteId: INVITE,
            matchId: INVITE,
            actorUid: fault === "actor" ? GUEST : HOST,
            outcome: fault === "replay" ? "applied" : "already-applied",
          });
        }
        return result;
      },
    });
    await assert.rejects(
      runSmoke({ baseUrl: API }, state.dependencies),
      /unexpected acknowledgement/,
    );
    assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  }
});

test("move smoke rejects changes to unrelated stored fields", async () => {
  const state = harness({
    intercept(request, response) {
      const result = response();
      if (request.url.pathname === "/matches/move") {
        state.matches.get(`${HOST}/${INVITE}`)!.value.aura = "changed";
      }
      return result;
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /API move changed other state/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("replays an uncertain API surrender through the same endpoint", async () => {
  let uncertain = false;
  const state = harness({
    intercept(request, response) {
      const result = response();
      if (request.url.pathname === "/matches/surrender" && !uncertain) {
        uncertain = true;
        throw new Error("lost surrender response");
      }
      return result;
    },
  });
  await runSmoke({ baseUrl: API }, state.dependencies);
  const surrenders = state.requests.filter(
    (request) => request.url.pathname === "/matches/surrender",
  );
  assert.equal(surrenders.length, 5);
  assert.deepEqual(surrenders[0].body, surrenders[1].body);
  assert.deepEqual(surrenders[0].body, surrenders[2].body);
  assert.equal(state.matches.get(`${HOST}/${INVITE}`)?.revision, 4);
});

test("rejects a surrender response for another participant and retains isolated cleanup", async () => {
  const state = harness({
    intercept(request, response) {
      const result = response();
      if (request.url.pathname === "/matches/surrender")
        return json({
          ok: true,
          inviteId: INVITE,
          matchId: INVITE,
          actorUid: GUEST,
        });
      return result;
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /unexpected receipt/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("rejects API surrender that changes another persisted match field", async () => {
  let changed = false;
  const state = harness({
    intercept(request, response) {
      const result = response();
      if (request.url.pathname === "/matches/surrender" && !changed) {
        changed = true;
        state.matches.get(`${HOST}/${INVITE}`)!.value.aura = "changed";
      }
      return result;
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /API surrender changed other state/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("retries an uncertain mutation with the identical operation and never creates another fixture", async () => {
  let uncertain = false;
  const state = harness({
    intercept(request, response) {
      const result = response();
      if (request.url.pathname === "/invites/join" && !uncertain) {
        uncertain = true;
        throw new Error(`provider details ${TOKENS.get(GUEST)}`);
      }
      return result;
    },
  });
  await runSmoke({ baseUrl: API }, state.dependencies);
  const joins = state.requests.filter(
    (request) => request.url.pathname === "/invites/join",
  );
  assert.equal(joins.length, 3);
  assert.ok(
    joins.every(
      (request) =>
        JSON.stringify(request.body) === JSON.stringify(joins[0].body),
    ),
  );
  assert.equal(state.receipts.size, 5);
  assert.equal(state.source()?.revision, 5);
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("rejects a changed replay receipt, settles the same isolated series, and deletes both sessions", async () => {
  let joins = 0;
  const state = harness({
    intercept(request, response) {
      const result = response();
      if (request.url.pathname === "/invites/join" && ++joins === 2)
        return json({
          ok: true,
          inviteId: INVITE,
          guestId: GUEST,
          joined: false,
          matchId: null,
        });
      return result;
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /replay changed its receipt/,
  );
  assert.equal(state.source()?.hostRematches, "x");
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
});

test("rejects invalid socket metadata without exposing its payload and cleans up sessions", async () => {
  const state = harness({
    socketFrame: (snapshot) => ({
      schemaVersion: 1,
      type: "snapshot",
      snapshot: { ...snapshot, password: TOKENS.get(HOST) },
    }),
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /invalid snapshot/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.source()?.hostRematches, "x");
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.ok(!state.logs.join("\n").includes(TOKENS.get(HOST)!));
});

test("bounds each missing socket update without an overall release deadline", async () => {
  const state = harness({ suppressUpdates: true, fastTimers: true });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /metadata update timed out/,
  );
  assert.equal(state.source()?.hostRematches, "x");
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
  assert.ok(
    state.timeoutDurations.every(
      (duration) => duration === 15_000 || duration === 30_000,
    ),
  );
  assert.ok(
    state.connections.every(
      (connection) => connection.options.handshakeTimeout === 15_000,
    ),
  );
});

test("requires live match delivery before an HTTP refresh can repair a missed notification", async () => {
  const state = harness({ suppressMatchUpdates: true, fastTimers: true });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /match update timed out/,
  );
  assert.equal(
    state.requests.filter(
      (request) =>
        request.url.pathname.startsWith("/invites/") &&
        request.url.pathname.endsWith("/snapshot"),
    ).length,
    1,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.equal(state.timers.size, 0);
});

const flushSmoke = () => new Promise<void>((resolve) => setImmediate(resolve));

test("accepts the final rematch update after sixteen simulated seconds without relaxing state checks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = harness({ delayFinalRematchUpdateMs: 16_000 });
  let settled = false;
  const pending = runSmoke({ baseUrl: API }, state.dependencies).then(
    (report) => {
      settled = true;
      return { report };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  for (
    let attempt = 0;
    attempt < 20 && state.delayedMatchFrames() === 0 && !settled;
    attempt++
  )
    await flushSmoke();
  assert.ok(state.delayedMatchFrames() > 0);
  await flushSmoke();
  t.mock.timers.tick(15_000);
  state.advance(15_000);
  await flushSmoke();
  assert.equal(
    settled,
    false,
    "The healthy retry window remains open after fifteen seconds",
  );
  t.mock.timers.tick(1_000);
  state.advance(1_000);
  const result = await pending;
  assert.ok(
    "report" in result,
    "The exact final snapshot must complete the smoke",
  );
  assert.ok(
    result.report.checks.includes(
      "rematch-live-creation-moves-surrender-and-reconnect",
    ),
  );
  assert.equal(state.source()?.hostRematches, "1x");
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.equal(state.timers.size, 0);
});

test("bounds a permanently withheld final update at thirty simulated seconds and reports only safe state summaries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = harness({ delayFinalRematchUpdateMs: "forever" });
  let settled = false;
  const pending = runSmoke({ baseUrl: API }, state.dependencies).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  for (
    let attempt = 0;
    attempt < 20 && state.delayedMatchFrames() === 0 && !settled;
    attempt++
  )
    await flushSmoke();
  assert.ok(state.delayedMatchFrames() > 0);
  await flushSmoke();
  t.mock.timers.tick(29_999);
  state.advance(29_999);
  await flushSmoke();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  state.advance(1);
  const error = await pending;
  assert.ok(error instanceof Error);
  assert.match(error.message, /Lifecycle match update timed out\./);
  assert.ok(error.message.includes(`matchId=${INVITE}1`));
  assert.match(error.message, /currentRevision=\d+/);
  assert.ok(error.message.includes("expectedGuestMoves=5"));
  assert.ok(error.message.includes("currentGuestMoves=4"));
  assert.ok(!error.message.includes(HOST));
  assert.ok(!error.message.includes(GUEST));
  for (const token of TOKENS.values())
    assert.ok(!error.message.includes(token));
  for (const entry of state.matches.values()) {
    assert.ok(!error.message.includes(entry.value.fen));
    if (entry.value.flatMovesString)
      assert.ok(!error.message.includes(entry.value.flatMovesString));
  }
  assert.ok(state.source()?.hostRematches.endsWith("x"));
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.equal(state.timers.size, 0);
});

test("renews an authenticated match channel with twenty seconds remaining before a thirty-second wait", async () => {
  let advanced = false;
  const state = harness({
    intercept: (request, respond) => {
      const response = respond();
      if (
        !advanced &&
        request.method === "GET" &&
        request.url.pathname === "/matches/snapshot" &&
        request.url.searchParams.get("playerId") === GUEST &&
        request.url.searchParams.get("matchId") === `${INVITE}1` &&
        countMoveHistory(
          state.matches.get(`${GUEST}/${INVITE}1`)?.value.flatMovesString || "",
        ) === 5
      ) {
        advanced = true;
        state.advance(280_000);
      }
      return response;
    },
  });
  await runSmoke({ baseUrl: API }, state.dependencies);
  assert.equal(advanced, true);
  assert.ok(
    state.connections.filter(
      (connection) =>
        connection.url.endsWith(`/matches/${INVITE}1/socket`) &&
        connection.options.headers?.Authorization,
    ).length >= 5,
  );
  assert.ok(
    state.requests.filter(
      (request) => request.url.pathname === "/auth/session/refresh",
    ).length >= 2,
  );
  assert.equal(state.expiredSockets(), 0);
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
});

test("redacts arbitrary status payloads from match timeout diagnostics", async () => {
  const state = harness({
    fastTimers: true,
    matchSocketFrame: (snapshot) => ({
      schemaVersion: 1,
      type: "snapshot",
      snapshot:
        countMoveHistory(snapshot.hostMatch?.flatMovesString || "") === 4
          ? {
              ...snapshot,
              hostMatch: { ...snapshot.hostMatch, status: TOKENS.get(HOST) },
            }
          : snapshot,
    }),
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /currentHostStatus=other/);
      assert.ok(!error.message.includes(TOKENS.get(HOST)!));
      assert.ok(!error.message.includes(new Game().toFen()));
      return true;
    },
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
});

test("socket close diagnostics expose only numeric codes and known server reasons", async () => {
  for (const reason of ["Match source unavailable", TOKENS.get(HOST)!]) {
    const state = harness();
    const connect = state.dependencies.connect;
    state.dependencies.connect = (url, options, protocol) => {
      const socket = connect(url, options, protocol);
      if (protocol === MATCH_SYNC_SOCKET_PROTOCOL)
        queueMicrotask(() =>
          (socket as FakeSocket).emit("close", 1011, Buffer.from(reason)),
        );
      return socket;
    };
    await assert.rejects(
      runSmoke({ baseUrl: API }, state.dependencies),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("1011") &&
        error.message.includes(
          reason === "Match source unavailable"
            ? reason
            : "unrecognized reason",
        ) &&
        !error.message.includes(TOKENS.get(HOST)!),
    );
  }
});

test("lifecycle observations renew expiring match and metadata sockets during long runs", async () => {
  const state = harness({ advanceMs: 9_000 });
  const report = await runSmoke({ baseUrl: API }, state.dependencies);
  assert.ok(state.elapsed() > 300_000);
  assert.ok(state.expiredSockets() > 0);
  assert.ok(
    state.requests.filter(
      (request) => request.url.pathname === "/auth/session/refresh",
    ).length > 2,
  );
  assert.ok(
    state.connections.filter((connection) =>
      connection.url.endsWith("/metadata/socket"),
    ).length > 1,
  );
  assert.ok(
    state.connections.filter(
      (connection) =>
        connection.url.includes("/matches/") &&
        connection.options.headers?.Authorization,
    ).length > 4,
  );
  assert.ok(report.checks.includes("terminal-replay-preserved-source"));
  assert.ok(
    state.sockets.some((socket) =>
      socket.sent.includes(REACTION_HEARTBEAT_REQUEST),
    ),
  );
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
});

test("pending participant socket admission refreshes a token aged during source checks", async () => {
  let advanced = false;
  const state = harness({
    intercept: (request, respond) => {
      const response = respond();
      if (!advanced && request.url.pathname === `/invites/${INVITE}/metadata`) {
        advanced = true;
        state.advance(300_000);
      }
      return response;
    },
  });
  const report = await runSmoke({ baseUrl: API }, state.dependencies);
  assert.equal(advanced, true);
  assert.ok(report.checks.includes("pending-http-and-authenticated-socket"));
  assert.ok(report.checks.includes("pending-match-http-socket-and-heartbeat"));
  assert.ok(
    state.requests.some(
      (request) => request.url.pathname === "/auth/session/refresh",
    ),
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("token renewal preserves snapshot revision and target validation", async (t) => {
  for (const [protocol, patch] of [
    [MATCH_SYNC_SOCKET_PROTOCOL, { revision: 1 }],
    [MATCH_SYNC_SOCKET_PROTOCOL, { matchId: "wrong-target" }],
    ["mons-invite-metadata-v1", { revision: 1 }],
    ["mons-invite-metadata-v1", { inviteId: "OtherInvite" }],
  ] as const) {
    await t.test(`${protocol}-${Object.keys(patch)[0]}`, async () => {
      let changed = 0;
      const state = harness({
        advanceMs: 9_000,
        renewalFrame: (snapshot, actualProtocol) => {
          const modify = actualProtocol === protocol;
          if (modify) changed++;
          return {
            schemaVersion: 1,
            type: "snapshot",
            snapshot: modify ? { ...snapshot, ...patch } : snapshot,
          };
        },
      });
      await assert.rejects(
        runSmoke({ baseUrl: API }, state.dependencies),
        /socket received an invalid snapshot/,
      );
      assert.ok(changed > 0);
      assert.ok(state.sockets.every((socket) => socket.terminated));
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
    });
  }
});

test("rejects malformed and wrong-target match socket snapshots without exposing contents", async (t) => {
  for (const change of [
    { matchId: "unrelated-match" },
    { inviteId: "Unrelated1" },
    { revision: -1 },
    { secret: TOKENS.get(HOST) },
    { hostMatch: { fen: TOKENS.get(HOST) } },
  ]) {
    await t.test(Object.keys(change)[0], async () => {
      const state = harness({
        matchSocketFrame: (snapshot) => ({
          schemaVersion: 1,
          type: "snapshot",
          snapshot: { ...snapshot, ...change },
        }),
      });
      await assert.rejects(
        runSmoke({ baseUrl: API }, state.dependencies),
        /match socket received an invalid snapshot/,
      );
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
      assert.ok(state.sockets.every((socket) => socket.terminated));
      assert.ok(!state.logs.join("\n").includes(TOKENS.get(HOST)!));
    });
  }
});

test("rejects changed match state at an unchanged revision", async () => {
  const state = harness({
    matchSocketFrame: (snapshot) => ({
      schemaVersion: 1,
      type: "snapshot",
      snapshot: { ...snapshot, revision: 1 },
    }),
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /match socket received an invalid snapshot/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
});

test("requires a match heartbeat and a fresh reconnect snapshot and cleans up on failure", async (t) => {
  for (const options of [
    { suppressHeartbeat: true, fastTimers: true },
    { failMatchReconnect: true },
  ]) {
    await t.test(Object.keys(options)[0], async () => {
      const state = harness(options);
      await assert.rejects(
        runSmoke({ baseUrl: API }, state.dependencies),
        /match (heartbeat timed out|socket failed)/,
      );
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
      assert.ok(state.sockets.every((socket) => socket.terminated));
      assert.equal(state.timers.size, 0);
    });
  }
});

test("rejects revision resets only on reconnect and cleans up every fixture", async () => {
  const revisions: number[] = [];
  const state = harness({
    reconnectMatchRevision: (revision) => {
      revisions.push(revision);
      return 1;
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /match socket received an invalid snapshot/,
  );
  assert.equal(revisions.length, 1);
  assert.ok(revisions[0] > 1);
  assert.ok(state.source()?.hostRematches.endsWith("x"));
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.equal(state.timers.size, 0);
});

test("accepts unchanged or advancing reconnect revisions without changing match comparisons", async (t) => {
  for (const advance of [0, 1]) {
    await t.test(advance ? "higher revision" : "same revision", async () => {
      let reconnects = 0;
      const state = harness({
        reconnectMatchRevision: (revision) => {
          reconnects++;
          return revision + advance;
        },
      });
      const report = await runSmoke({ baseUrl: API }, state.dependencies);
      assert.equal(reconnects, 2);
      assert.equal(report.checks.length, 16);
      assert.ok(state.source()?.hostRematches.endsWith("x"));
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
      assert.ok(state.sockets.every((socket) => socket.terminated));
      assert.equal(state.timers.size, 0);
    });
  }
});

test("cancels oversized responses, sanitizes failures, and deletes the known sessions", async () => {
  let canceled = false;
  let injected = false;
  const state = harness({
    intercept(request, response) {
      if (request.url.pathname.endsWith("/metadata") && !injected) {
        injected = true;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new Uint8Array(INVITE_METADATA_MAX_MESSAGE_BYTES + 1),
              );
            },
            cancel() {
              canceled = true;
            },
          }),
        );
      }
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /invalid or oversized response/,
  );
  assert.equal(canceled, true);
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("bounds a nonresponsive request and preserves the same mutation IDs during cleanup", async () => {
  let pendingRequests = 0;
  const state = harness({
    fastTimers: true,
    intercept(request, response) {
      if (request.url.pathname.endsWith("/metadata")) {
        pendingRequests++;
        return new Promise<Response>(() => undefined);
      }
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /request timed out/,
  );
  assert.equal(pendingRequests, 3);
  assert.equal(state.source()?.hostRematches, "x");
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.equal(state.timers.size, 0);
  const creates = state.requests.filter(
    (request) => request.url.pathname === "/invites/create",
  );
  assert.ok(
    creates.every(
      (request) =>
        JSON.stringify(request.body) === JSON.stringify(creates[0].body),
    ),
  );
});

test("deletes the first session when the second signup fails without retrying account creation", async () => {
  let signups = 0;
  const state = harness({
    intercept(request, response) {
      if (request.url.pathname === "/auth/session/anonymous" && ++signups === 2)
        return json({ error: "unavailable" }, 503);
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /Cloudflare session anonymous returned 503/,
  );
  assert.equal(signups, 2);
  assert.deepEqual(state.deleted, [HOST]);
  assert.equal(state.source(), null);
  assert.ok(state.logs.some((value) => JSON.parse(value).hostUid === HOST));
});

test("attempts both account deletions and reports cleanup failure without returning tokens", async () => {
  const state = harness({
    intercept(request, response) {
      if (
        request.url.pathname === "/auth/session/logout" &&
        request.headers.get("Authorization")?.split(".")[1] ===
          (
            state.requests.filter(
              (value) => value.url.pathname === "/auth/session/anonymous",
            )[1].body as { sessionId: string }
          ).sessionId
      )
        return json({ error: { message: TOKENS.get(GUEST) } }, 403);
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /could not revoke every temporary anonymous session/,
  );
  assert.deepEqual(state.deleted, [HOST]);
  assert.equal(
    state.requests.filter(
      (request) => request.url.pathname === "/auth/session/logout",
    ).length,
    2,
  );
  assert.ok(!state.logs.join("\n").includes(TOKENS.get(GUEST)!));
});

test("retries transient session revocation failures with the same capability", async (t) => {
  for (const failure of ["server", "network"]) {
    await t.test(failure, async () => {
      const attempts = new Map<string, number>();
      let failedCapability: string | undefined;
      const state = harness({
        intercept(request, response) {
          if (request.url.pathname === "/auth/session/logout") {
            const capability = request.headers.get("Authorization")!;
            attempts.set(capability, (attempts.get(capability) || 0) + 1);
            if (!failedCapability) {
              failedCapability = capability;
              if (failure === "network") throw new TypeError("fetch failed");
              return json({ error: "temporarily-unavailable" }, 503);
            }
          }
          return response();
        },
      });
      const report = await runSmoke({ baseUrl: API }, state.dependencies);
      assert.equal(attempts.get(failedCapability!), 2);
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
      assert.ok(report.checks.includes("temporary-anonymous-sessions-revoked"));
    });
  }
});

test("bounds persistent revocation failures and rejects non-204 acknowledgements", async (t) => {
  for (const status of [503, 200]) {
    await t.test(String(status), async () => {
      let attempts = 0;
      let failedCapability: string | undefined;
      const state = harness({
        intercept(request, response) {
          if (request.url.pathname === "/auth/session/logout") {
            const capability = request.headers.get("Authorization")!;
            failedCapability ||= capability;
            if (capability === failedCapability) {
              attempts++;
              return json({}, status);
            }
          }
          return response();
        },
      });
      await assert.rejects(
        runSmoke({ baseUrl: API }, state.dependencies),
        /could not revoke every temporary anonymous session/,
      );
      assert.equal(attempts, status === 503 ? 3 : 1);
      assert.equal(state.deleted.length, 1);
    });
  }
});

test("retries a transient API move failure with the identical move payload", async () => {
  let conflicted = false;
  const state = harness({
    intercept(request, response) {
      if (
        !conflicted &&
        request.url.pathname === "/matches/move" &&
        request.method === "POST" &&
        request.body &&
        typeof request.body === "object" &&
        "flatMovesString" in request.body &&
        request.body.flatMovesString
      ) {
        conflicted = true;
        return json({ ok: false, error: "unavailable" }, 503);
      }
      return response();
    },
  });
  await runSmoke({ baseUrl: API }, state.dependencies);
  assert.equal(conflicted, true);
  const moves = state.requests.filter(
    (request) => request.url.pathname === "/matches/move",
  );
  assert.equal(moves.length, 11);
  assert.deepEqual(moves[0].body, moves[1].body);
  assert.equal(
    state.matches.get(`${HOST}/${INVITE}`)?.value.status,
    "surrendered",
  );
  assert.equal(
    state.matches.get(`${HOST}/${INVITE}`)?.value.sessionCreation,
    "a".repeat(64),
  );
});

test("writes an exclusive report containing only fixture IDs and passed checks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "invite-lifecycle-smoke-"));
  const path = join(directory, "report.json");
  try {
    const state = harness();
    const report = await runSmoke(
      { baseUrl: API, output: path },
      state.dependencies,
    );
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), report);
    assert.equal(statSync(path).mode & 0o077, 0);
    for (const token of TOKENS.values())
      assert.ok(!readFileSync(path, "utf8").includes(token));
    writeFileSync(path, "existing-report");
    await assert.rejects(
      runSmoke({ baseUrl: API, output: path }, harness().dependencies),
      /could not create its report file/,
    );
    assert.equal(readFileSync(path, "utf8"), "existing-report");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
