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
import { parseStrictMatchTimer } from "@mons/shared/timers";
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
const HOST = "anonymous-host";
const GUEST = "anonymous-guest";
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
    directMovesAllowed?: boolean;
  } = {},
) {
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
      queueMicrotask(() => {
        if (!socket.terminated)
          socket.emit(
            "message",
            Buffer.from(JSON.stringify(matchFrame(snapshot))),
            false,
          );
      });
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
    if (url.hostname === "identitytoolkit.googleapis.com") {
      assert.equal(method, "POST");
      assert.equal(headers.get("Origin"), "https://mons.link");
      if (url.pathname === "/v1/accounts:signUp") {
        assert.deepEqual(body, { returnSecureToken: true });
        const uid = signupCount++ === 0 ? HOST : GUEST;
        return json({ localId: uid, idToken: TOKENS.get(uid) });
      }
      assert.equal(url.pathname, "/v1/accounts:delete");
      assert.ok(body && typeof body === "object" && "idToken" in body);
      const uid = owner(String(body.idToken));
      assert.ok(uid);
      deleted.push(uid);
      return json({});
    }
    if (url.hostname === "mons-link-default-rtdb.firebaseio.com") {
      const uid = owner(url.searchParams.get("auth"));
      assert.ok(
        uid,
        "Firebase requests use only the temporary participant tokens",
      );
      if (
        url.pathname === `/invites/${INVITE}.json` ||
        url.pathname === `/players/${uid}/profile.json`
      ) {
        assert.equal(method, "GET");
        return json({ error: "Permission denied" }, 401);
      }
      if (url.pathname === `/matchTimerClaims/${INVITE}.json`) {
        assert.equal(method, "PUT");
        assert.equal(body, null);
        return json({ error: "Permission denied" }, 401);
      }
      if (method !== "GET" && !options.directMovesAllowed) {
        assert.ok(method === "PUT" || method === "PATCH");
        assert.ok(
          url.pathname.startsWith("/players/") || url.pathname === "/.json",
        );
        return json({ error: "Permission denied" }, 401);
      }
      const parts =
        /^\/players\/([^/]+)\/matches\/([^/]+?)(\/status)?\.json$/.exec(
          url.pathname,
        );
      assert.ok(parts, "No unrelated Firebase paths are touched");
      const key = `${parts[1]}/${parts[2]}`;
      const match = matches.get(key);
      assert.ok(match);
      const etag = `"${match.revision}"`;
      if (method === "GET") {
        assert.equal(headers.get("X-Firebase-ETag"), "true");
        return json(match.value, 200, { ETag: etag });
      }
      assert.equal(method, "PUT");
      assert.equal(uid, parts[1], "A participant writes only their own match");
      if (
        parts[3] ||
        !body ||
        typeof body !== "object" ||
        !("status" in body) ||
        body.status !== match.value.status
      )
        return json({ error: "Permission denied" }, 401);
      assert.ok(body && typeof body === "object" && "timer" in body);
      if (headers.get("If-Match") !== etag)
        return json(match.value, 412, { ETag: etag });
      if (body.timer !== match.value.timer && body.timer !== "") {
        assert.deepEqual(parseStrictMatchTimer(body.timer), {
          turnNumber: 1,
          targetTimestamp: NOW + 90_000,
        });
        return json({ error: "Permission denied" }, 401);
      }
      const { status, timer, fen, flatMovesString, ...unchanged } =
        body as Match;
      const {
        status: _previous,
        timer: _previousTimer,
        fen: previousFen,
        flatMovesString: previousMoves,
        ...prior
      } = match.value;
      assert.deepEqual(
        unchanged,
        prior,
        "The transaction preserves presentation and creation markers",
      );
      assert.equal(status, match.value.status);
      if (flatMovesString !== previousMoves) {
        const game = Game.fromFen(previousFen)!;
        assert.equal(game.activeColor, match.value.color);
        assert.ok(flatMovesString.startsWith(previousMoves));
        assert.equal(
          game.playFen(flatMovesString.split("-").at(-1)!).kind,
          "complete",
        );
        assert.equal(fen, game.toFen());
      } else assert.equal(fen, previousFen);
      assert.ok(timer === match.value.timer || timer === "");
      match.value = structuredClone(body as Match);
      match.revision++;
      return json(match.value);
    }
    assert.equal(url.origin, API);
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
      return options.intercept
        ? options.intercept(request, () => handle(request))
        : handle(request);
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
              snapshot ? matchFrame(snapshot) : frame(structuredClone(source)),
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
    now: () => NOW,
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
  };
}

test("requires an explicit approved target and supports a report and pre-rule API verification", () => {
  assert.deepEqual(parseArgs(["--base-url", `${API}/`]), { baseUrl: API });
  assert.deepEqual(parseArgs(["--move-rules-pending", "--base-url", API]), {
    baseUrl: API,
    moveRulesPending: true,
  });
  assert.deepEqual(
    parseArgs(["--surrender-rules-pending", "--base-url", API]),
    {
      baseUrl: API,
      surrenderRulesPending: true,
    },
  );
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
    [
      "--base-url",
      API,
      "--surrender-rules-pending",
      "--surrender-rules-pending",
    ],
    ["--base-url", API, "--surrender-rules-pending", "true"],
    ["--base-url", API, "--move-rules-pending", "--move-rules-pending"],
    ["--base-url", API, "--move-rules-pending", "true"],
  ])
    assert.throws(() => parseArgs(args), /Usage:/);
});

test("runs the isolated lifecycle, API move/surrender replay and retired Firebase access denials", async () => {
  const state = harness();
  const report = await runSmoke({ baseUrl: API }, state.dependencies);
  assert.equal(report.inviteId, INVITE);
  assert.deepEqual(report.matchIds, [INVITE, `${INVITE}1`]);
  assert.equal(report.checks.length, 18);
  assert.ok(report.checks.includes("firebase-surrender-write-rules"));
  assert.ok(report.checks.includes("firebase-move-write-rules"));
  assert.ok(report.checks.includes("firebase-invite-and-profile-read-denials"));
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
  assert.ok(state.timeoutDurations.every((duration) => duration === 15_000));
  assert.equal(
    state.requests.filter(
      (request) => request.url.pathname === `/invites/${INVITE}.json`,
    ).length,
    2,
  );
  assert.equal(
    state.requests.filter(
      (request) => request.url.pathname === `/players/${HOST}/profile.json`,
    ).length,
    2,
  );
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

test("pre-rule verification skips only direct status probes and still verifies API surrender and legal moves", async () => {
  const state = harness();
  const report = await runSmoke(
    { baseUrl: API, surrenderRulesPending: true },
    state.dependencies,
  );
  assert.equal(report.checks.length, 17);
  assert.ok(!report.checks.includes("firebase-surrender-write-rules"));
  assert.equal(
    state.requests.filter(
      (request) => request.url.pathname === "/matches/surrender",
    ).length,
    4,
  );
  assert.ok(
    state.requests.every(
      (request) => !request.url.pathname.endsWith("/status.json"),
    ),
  );
  assert.ok(state.matches.get(`${HOST}/${INVITE}`)?.value.flatMovesString);
});

test("pre-move-cutover smoke verifies API moves and replay while old direct writes remain allowed", async () => {
  const state = harness({ directMovesAllowed: true });
  const report = await runSmoke(
    { baseUrl: API, moveRulesPending: true },
    state.dependencies,
  );
  assert.ok(!report.checks.includes("firebase-move-write-rules"));
  assert.ok(report.checks.includes("firebase-surrender-write-rules"));
  assert.equal(
    state.requests.filter((request) => request.url.pathname === "/matches/move")
      .length,
    10,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("post-cutover smoke fails if Firebase still accepts a direct legal move", async () => {
  const state = harness({ directMovesAllowed: true });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /move rule did not deny/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
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
        state.matches.get(`${HOST}/${INVITE}`)!.value.sessionCreation =
          "c".repeat(64);
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

test("each direct status-write shape must return an actual permission denial", async () => {
  for (let target = 1; target <= 4; target++) {
    let probes = 0;
    const state = harness({
      intercept(request, response) {
        if (
          request.url.pathname.startsWith("/players/") &&
          request.method === "PUT" &&
          !request.headers.has("If-Match") &&
          ++probes === target
        )
          return json(request.body);
        return response();
      },
    });
    await assert.rejects(
      runSmoke({ baseUrl: API }, state.dependencies),
      /surrender rule did not deny/,
    );
    assert.equal(probes, target);
    assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
    assert.equal(state.source()?.hostRematches, "x");
  }
});

test("replays an uncertain API surrender without issuing a direct Firebase fallback", async () => {
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
        state.matches.get(`${HOST}/${INVITE}`)!.value.sessionCreation =
          "c".repeat(64);
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

test("rejects readable retired paths and unrelated errors, then cleans up without service-account writes", async () => {
  for (const path of [
    `/invites/${INVITE}.json`,
    `/players/${HOST}/profile.json`,
  ]) {
    for (const [status, payload] of [
      [200, null],
      [200, "retained-copy"],
      [401, { error: "Invalid token" }],
      [503, { error: "Unavailable" }],
    ] as const) {
      const state = harness({
        intercept: (request, response) =>
          request.url.pathname === path ? json(payload, status) : response(),
      });
      await assert.rejects(
        runSmoke({ baseUrl: API }, state.dependencies),
        /retired Firebase invite\/profile read was not denied/,
      );
      assert.equal(state.source()?.hostRematches, "x");
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
      assert.ok(
        state.requests.every(
          (request) => !request.url.searchParams.has("access_token"),
        ),
      );
    }
  }
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
  assert.ok(state.timeoutDurations.every((duration) => duration === 15_000));
});

test("requires live match delivery before an HTTP refresh can repair a missed notification", async () => {
  const state = harness({ suppressMatchUpdates: true, fastTimers: true });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /match update timed out/,
  );
  assert.equal(
    state.requests.filter((request) =>
      request.url.pathname.endsWith("/snapshot"),
    ).length,
    1,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
  assert.ok(state.sockets.every((socket) => socket.terminated));
  assert.equal(state.timers.size, 0);
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
      assert.equal(report.checks.length, 18);
      assert.ok(state.source()?.hostRematches.endsWith("x"));
      assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
      assert.ok(state.sockets.every((socket) => socket.terminated));
      assert.equal(state.timers.size, 0);
    });
  }
});

test("does not mistake token failure for timer-rule permission denial", async () => {
  const state = harness({
    intercept(request, response) {
      if (
        request.url.hostname.endsWith("firebaseio.com") &&
        request.method === "PUT" &&
        request.body &&
        typeof request.body === "object" &&
        "timer" in request.body &&
        request.body.timer
      )
        return json({ error: "Could not parse auth token" }, 401);
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /timer rule did not return permission denial/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
});

test("treats a writable claim namespace as a failure even though its probe cannot create a fence", async () => {
  const state = harness({
    intercept(request, response) {
      if (request.url.pathname.startsWith("/matchTimerClaims/")) {
        assert.equal(request.body, null);
        return json(null);
      }
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /claim fence was writable/,
  );
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
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
      if (request.url.pathname === "/v1/accounts:signUp" && ++signups === 2)
        return json({ error: "unavailable" }, 503);
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /anonymous session request returned 503/,
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
        request.url.pathname === "/v1/accounts:delete" &&
        request.body &&
        typeof request.body === "object" &&
        "idToken" in request.body &&
        request.body.idToken === TOKENS.get(GUEST)
      )
        return json({ error: { message: TOKENS.get(GUEST) } }, 403);
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /could not delete every temporary anonymous session/,
  );
  assert.deepEqual(state.deleted, [HOST]);
  assert.equal(
    state.requests.filter(
      (request) => request.url.pathname === "/v1/accounts:delete",
    ).length,
    2,
  );
  assert.ok(!state.logs.join("\n").includes(TOKENS.get(GUEST)!));
});

test("restores the original timer before failing when the client timer rule is broken", async () => {
  let forged = false;
  const state = harness({
    directMovesAllowed: true,
    intercept(request, response) {
      if (
        !forged &&
        request.url.hostname.endsWith("firebaseio.com") &&
        request.method === "PUT" &&
        request.body &&
        typeof request.body === "object" &&
        "timer" in request.body &&
        request.body.timer
      ) {
        forged = true;
        const match = state.matches.get(`${HOST}/${INVITE}`)!;
        match.value = structuredClone(request.body as Match);
        match.revision++;
        return json(match.value);
      }
      return response();
    },
  });
  await assert.rejects(
    runSmoke({ baseUrl: API }, state.dependencies),
    /allowed a client to forge a timer/,
  );
  assert.equal(forged, true);
  assert.equal(state.matches.get(`${HOST}/${INVITE}`)?.value.timer, "");
  assert.equal(state.source()?.hostRematches, "x");
  assert.deepEqual(state.deleted.sort(), [GUEST, HOST]);
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
