import { canonicalMatch, required } from "./fixtures/canonicalData.mjs";
import { createConnectionWagerClientHarness } from "./wagerClientHarness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import ts from "typescript";
import { isCompletedMatchPair } from "../src/connection/matchCompletion.ts";
import {
  MoveDelivery,
  moveDeliveryStorageKey,
} from "../src/connection/moveDelivery.ts";
import {
  RematchEndDelivery,
  rematchEndDeliveryStorageKey,
  REMATCH_END_STORAGE_PREFIX,
} from "../src/connection/rematchEndDelivery.ts";
import { rematchSeriesEnded } from "@mons/shared/rematches";
import { MATCH_TIMER_DURATION_MS } from "@mons/shared/timers";

registerTypeScriptTestHooks();

const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
assert.ok(declaration && ts.isClassDeclaration(declaration));
const names = [
  "moveDeliveryScope",
  "isCurrentMoveBoard",
  "recoverMoveBoard",
  "getMoveDelivery",
  "flushPendingMoves",
  "refreshMoveDeliveries",
  "sendMove",
  "createSessionGuard",
  "createMatchContextGuard",
  "isSessionEpochActive",
  "isContextActive",
  "isCurrentAuthUser",
  "requireWritableContext",
  "surrender",
  "startTimer",
  "claimVictoryByTimer",
  "updateRatings",
  "resolveWagerOutcome",
  "getRematchEndDelivery",
  "isRematchEndPending",
  "refreshRematchEndDeliveries",
  "submitRematchEnd",
  "sendEndMatchIndicator",
  "sendRematchProposal",
];
const methods = names.map((name) => {
  const method = required(declaration).members.find(
    (node) => node.name?.getText(source) === name,
  );
  assert.ok(method, `missing Connection.${name}`);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`.replaceAll(
    "import.meta.env.DEV",
    "false",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
class GameplayApiError extends Error {
  /**
   * @param {string} code
   * @param {string | undefined} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
/** @template [T=void] @returns {PromiseWithResolvers<T>} */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const pending = Promise.withResolvers();
  return {
    promise: pending.promise,
    resolve: pending.resolve,
    reject: pending.reject,
  };
};
const settle = () => new Promise(setImmediate);
const scope = {
  loginUid: "login",
  inviteId: "abcdefghijk",
  matchId: "abcdefghijk1",
  playerId: "actor",
};
/**
 * @typedef {typeof import("../src/connection/connection.ts").connection} SourceConnection
 * @typedef {typeof import("../src/services/gameplayApi.ts")} GameplayApi
 * @typedef {import("../src/session/sessionAuth.ts").SessionUser} SessionUser
 * @typedef {import("../src/services/authApi.ts").AuthTokenProvider} TokenProvider
 * @typedef {import("@mons/shared/game-sessions").SubmitMoveResponse} MoveResponse
 * @typedef {import("@mons/shared/game-sessions").SubmitMoveRequest} MoveRequest
 * @typedef {{fen: string; status?: string; timer?: string; emojiId?: number; flatMovesString?: string; gameVariant?: string}} LocalMatchProbe
 * @typedef {{inviteId: string; matchId?: string; playerId?: string; opponentId?: string; operationId?: string}} TerminalRequest
 * @typedef {"surrender" | "timer" | "claim" | "rating" | "wager" | "end" | "rematch"} TerminalKind
 * @typedef {import("@mons/shared/game-sessions").SurrenderMatchResponse & import("@mons/shared/game-sessions").EndRematchResponse & import("@mons/shared/timers").StartMatchTimerResponse & {mining: null}} TerminalReceipt
 * @typedef {{request: MoveRequest; bearer: string; options: {signal: AbortSignal; timeoutMs: number}; pending: PromiseWithResolvers<MoveResponse>}} MoveCall
 * @typedef {{moveDeliveryScope: SourceConnection["moveDeliveryScope"]; isCurrentMoveBoard: SourceConnection["isCurrentMoveBoard"]; recoverMoveBoard: SourceConnection["recoverMoveBoard"]; getMoveDelivery: SourceConnection["getMoveDelivery"]; flushPendingMoves: SourceConnection["flushPendingMoves"]; refreshMoveDeliveries: SourceConnection["refreshMoveDeliveries"]; sendMove: SourceConnection["sendMove"]; createSessionGuard: SourceConnection["createSessionGuard"]; createMatchContextGuard: SourceConnection["createMatchContextGuard"]; isSessionEpochActive: SourceConnection["isSessionEpochActive"]; isContextActive: SourceConnection["isContextActive"]; isCurrentAuthUser: SourceConnection["isCurrentAuthUser"]; requireWritableContext: SourceConnection["requireWritableContext"]; surrender: SourceConnection["surrender"]; startTimer: SourceConnection["startTimer"]; claimVictoryByTimer: SourceConnection["claimVictoryByTimer"]; updateRatings: SourceConnection["updateRatings"]; resolveWagerOutcome: SourceConnection["resolveWagerOutcome"]; getRematchEndDelivery: SourceConnection["getRematchEndDelivery"]; isRematchEndPending: SourceConnection["isRematchEndPending"]; refreshRematchEndDeliveries: SourceConnection["refreshRematchEndDeliveries"]; submitRematchEnd: SourceConnection["submitRematchEnd"]; sendEndMatchIndicator: SourceConnection["sendEndMatchIndicator"]; sendRematchProposal: SourceConnection["sendRematchProposal"]; getUserBoundAuthTokenProvider: SourceConnection["getUserBoundAuthTokenProvider"]; ensureAuthenticated: SourceConnection["ensureAuthenticated"]; getOpponentId: SourceConnection["getOpponentId"]; getCurrentInviteEventId: SourceConnection["getCurrentInviteEventId"]; notifyNavigationGamesChanged: SourceConnection["notifyNavigationGamesChanged"]; logContextEvent: SourceConnection["logContextEvent"]; reconnectAfterMatchUpdateFailure: SourceConnection["reconnectAfterMatchUpdateFailure"]; rematchSeriesEndIsIndicated: SourceConnection["rematchSeriesEndIsIndicated"]; getRematchIndexAvailableForNewProposal: SourceConnection["getRematchIndexAvailableForNewProposal"]; getCachedHistoricalMatchPair: SourceConnection["getCachedHistoricalMatchPair"]; sessionEpoch: SourceConnection["sessionEpoch"]; activeContext: SourceConnection["activeContext"]; moveDeliveries: SourceConnection["moveDeliveries"]; rematchEndDeliveries: SourceConnection["rematchEndDeliveries"]; confirmedSurrenders: SourceConnection["confirmedSurrenders"]; pendingSurrenders: SourceConnection["pendingSurrenders"]; pendingMatchCompletions: SourceConnection["pendingMatchCompletions"]; reconcilingMoveKeys: SourceConnection["reconcilingMoveKeys"]; moveRecoveryTimers: SourceConnection["moveRecoveryTimers"]; moveReconnectCooldownMs: SourceConnection["moveReconnectCooldownMs"]; moveReconnectLastAttemptAt: SourceConnection["moveReconnectLastAttemptAt"]; moveReconnectInFlight: SourceConnection["moveReconnectInFlight"]; wagerClient: SourceConnection["wagerClient"]; auth: {currentUser: SessionUser | null; getTokenRemainingMs(token: string): number}; myMatch: LocalMatchProbe; latestInvite: {hostId: string; guestId: string}}} FixtureConnection
 */
/** @param {string} uid @param {SessionUser["getIdToken"]} [getIdToken] @returns {SessionUser} */
const user = (uid, getIdToken = async () => "login-token") => ({
  uid,
  sessionId: "session",
  generation: "generation",
  getIdToken,
});
const initialMatch = {
  status: "",
  timer: "timer",
  emojiId: 3,
  fen: "base-fen",
  flatMovesString: "first",
  gameVariant: "Classic",
};
/** @param {{token?: SessionUser["getIdToken"]; records?: Map<string, string>; onTerminal?: (kind: TerminalKind, request: TerminalRequest) => Promise<{ok: true} | void>; onReconnect?: FixtureConnection["reconnectAfterMatchUpdateFailure"]}} [options] */
function harness({ token, records = new Map(), onTerminal, onReconnect } = {}) {
  /** @type {FixtureConnection} */
  let instance;
  /** @type {MoveCall[]} */
  const calls = [];
  /** @type {Array<{kind: TerminalKind; request: TerminalRequest}>} */
  const terminal = [];
  /** @type {Array<{inviteId: string | null; guard: () => boolean}>} */
  const reconnects = [];
  /** @type {unknown[][]} */
  const errors = [];
  /** @type {Array<string | null | undefined>} */
  const bindings = [];
  /** @type {Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">} */
  const localStorage = {
    get length() {
      return records.size;
    },
    key: (/** @type {number} */ index) => [...records.keys()][index] ?? null,
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  /** @param {TerminalKind} kind @returns {(request: TerminalRequest, provider: TokenProvider) => Promise<TerminalReceipt>} */
  const terminalCall = (kind) => async (request, provider) => {
    await provider(false);
    assert.ok(provider.assertCurrentUser);
    provider.assertCurrentUser();
    terminal.push({ kind, request });
    /** @returns {TerminalReceipt} */
    const receipt = () => ({
      ok: true,
      inviteId: request.inviteId,
      matchId: request.matchId ?? scope.matchId,
      actorUid: scope.playerId,
      rematches: { state: "ended", indices: [] },
      timer: {
        state: "running",
        turnNumber: 1,
        deadlineAtMs: Date.now() + MATCH_TIMER_DURATION_MS,
      },
      duration: MATCH_TIMER_DURATION_MS,
      mining: null,
    });
    if (onTerminal) {
      const response = await onTerminal(kind, request);
      provider.assertCurrentUser();
      if (response !== undefined) return { ...receipt(), ...response };
    }
    if (kind === "rematch") return new Promise(() => {});
    return receipt();
  };
  /** @type {GameplayApi["submitMoveViaApi"]} */
  const submitMoveViaApi = async (request, provider, options) => {
    const bearer = await provider(false);
    assert.ok(provider.assertCurrentUser);
    provider.assertCurrentUser();
    const signal = required(options?.signal);
    const timeoutMs = required(options?.timeoutMs);
    if (signal.aborted)
      throw new GameplayApiError("aborted", "request-aborted");
    /** @type {PromiseWithResolvers<MoveResponse>} */
    const pending = deferred();
    calls.push({ request, bearer, options: { signal, timeoutMs }, pending });
    const value = await pending.promise;
    provider.assertCurrentUser();
    return value;
  };
  const dependencies = {
    isCompletedMatchPair,
    MoveDelivery,
    moveDeliveryStorageKey,
    RematchEndDelivery,
    rematchEndDeliveryStorageKey,
    REMATCH_END_STORAGE_PREFIX,
    rematchSeriesEnded,
    GameplayApiError,
    window: { sessionStorage: localStorage },
    navigator: { onLine: true },
    storage: {
      getProfileId: () => "profile",
      getPlayerEmojiAura: () => "",
      getPlayerEmojiId: () => "3",
    },
    getPlayersEmojiId: () => 3,
    console: {
      log() {},
      warn() {},
      error: (/** @type {unknown[]} */ ...args) => errors.push(args),
    },
    submitMoveViaApi,
    readMatchSnapshotViaApi:
      /** @satisfies {GameplayApi["readMatchSnapshotViaApi"]} */ (
        async (request) => ({
          ok: true,
          ...request,
          match: canonicalMatch({
            fen: initialMatch.fen,
            flatMovesString: initialMatch.flatMovesString,
            emojiId: initialMatch.emojiId,
            gameVariant: initialMatch.gameVariant,
          }),
        })
      ),
    readInviteMetadataViaApi:
      /** @satisfies {typeof import("../src/services/inviteMetadataApi.ts").readInviteMetadataViaApi} */ (
        async (inviteId, provider) => {
          assert.ok(provider);
          await provider(false);
          assert.ok(provider.assertCurrentUser);
          provider.assertCurrentUser();
          return {
            ok: true,
            snapshot: {
              inviteId,
              revision: 1,
              hostId: scope.playerId,
              guestId: "opponent",
              hostColor: "white",
              automatchStateHint: null,
              eventId: null,
              eventOwned: false,
              hostRematches: { state: "open", indices: [] },
              guestRematches: { state: "open", indices: [] },
            },
            viewer: {
              role: "host",
              actorUid: scope.playerId,
              automatchOperationId: null,
            },
          };
        }
      ),
    surrenderMatchViaApi: terminalCall("surrender"),
    startMatchTimerViaApi: terminalCall("timer"),
    claimMatchVictoryByTimerViaApi: terminalCall("claim"),
    updateRatingsViaApi: terminalCall("rating"),
    resolveWagerOutcomeViaApi: terminalCall("wager"),
    endRematchViaApi: terminalCall("end"),
    proposeRematchViaApi: terminalCall("rematch"),
  };
  const Constructor = /** @type {new () => FixtureConnection} */ (
    new Function(
      ...Object.keys(dependencies),
      `${outputText}\nreturn Connection;`,
    )(...Object.values(dependencies))
  );
  instance = Object.assign(
    new Constructor(),
    /** @satisfies {Partial<FixtureConnection>} */ ({
      auth: {
        currentUser: user("login", token),
        getTokenRemainingMs: () => 60_000,
      },
      sessionEpoch: 2,
      activeContext: {
        contextId: 4,
        sessionEpoch: 2,
        ...scope,
        actorUid: scope.playerId,
        canWrite: true,
        role: "host",
        createdAtMs: 0,
      },
      myMatch: { ...initialMatch },
      latestInvite: { hostId: scope.playerId, guestId: "opponent" },
      moveDeliveries: new Map(),
      rematchEndDeliveries: new Map(),
      confirmedSurrenders: new Set(),
      pendingSurrenders: new Map(),
      pendingMatchCompletions: new Map(),
      reconcilingMoveKeys: new Set(),
      moveRecoveryTimers: new Map(),
      moveReconnectCooldownMs: 3000,
      moveReconnectLastAttemptAt: 0,
      moveReconnectInFlight: false,
      getUserBoundAuthTokenProvider: (uid) => {
        bindings.push(uid);
        assert.equal(instance.auth.currentUser?.uid, uid);
        return createUserBoundAuthTokenProvider(
          required(instance.auth.currentUser),
          () => instance.auth.currentUser,
        );
      },
      ensureAuthenticated: async () => {},
      getOpponentId: () => "opponent",
      getCurrentInviteEventId: () => null,
      notifyNavigationGamesChanged() {},
      logContextEvent() {},
      reconnectAfterMatchUpdateFailure: (inviteId, guard) => {
        reconnects.push({ inviteId, guard });
        onReconnect?.(inviteId, guard);
      },
      rematchSeriesEndIsIndicated: () => false,
      getRematchIndexAvailableForNewProposal: () => "1",
      getCachedHistoricalMatchPair: () => null,
    }),
  );
  const wagerHarness = createConnectionWagerClientHarness(instance);
  wagerHarness.dependencies.api.resolveWagerOutcomeViaApi =
    dependencies.resolveWagerOutcomeViaApi;
  instance.wagerClient = wagerHarness.client;
  return {
    instance,
    calls,
    terminal,
    reconnects,
    errors,
    bindings,
    records,
    send: (move = "second", fen = "second-fen") =>
      instance.sendMove(move, fen, scope.matchId),
    acknowledge: (/** @type {number} */ index) => {
      const call = required(calls[index]);
      call.pending.resolve({
        ok: true,
        inviteId: call.request.inviteId,
        matchId: call.request.matchId,
        actorUid: call.request.playerId,
        outcome: "applied",
      });
    },
  };
}

test("rapid actions keep one journal and retain both predecessors while authentication is pending", async () => {
  /** @type {PromiseWithResolvers<string>} */
  const token = deferred();
  const h = harness({ token: () => token.promise });
  h.send();
  h.send("z", "base-fen");
  h.send("third", "third-fen");
  assert.equal(h.calls.length, 0);
  assert.equal(h.instance.myMatch.flatMovesString, "first-second-z-third");
  const stored = storedObject(
    JSON.parse(required(h.records.get(moveDeliveryStorageKey(scope)))),
  );
  assert.ok(Array.isArray(stored.pending));
  /** @type {unknown[]} */
  const pendingMoves = stored.pending;
  assert.deepEqual(
    pendingMoves.map((entry) => storedObject(entry).moveFen),
    ["second", "z", "third"],
  );
  required(token.resolve)("login-token");
  await settle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.calls.map(({ request }) => request.flatMovesString),
    ["first-second", "first-second-z"],
  );
  h.acknowledge(1);
  await settle();
  assert.equal(h.calls.length, 3);
  assert.equal(
    required(h.calls[2]).request.flatMovesString,
    "first-second-z-third",
  );
  h.acknowledge(2);
  h.acknowledge(0);
  await settle();
  assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
  assert.equal(h.instance.myMatch.fen, "third-fen");
  assert.deepEqual(h.bindings, ["login", "login", "login"]);
  assert.equal(h.reconnects.length, 0);
});

test("navigation keeps accepted delivery alive without changing the newly displayed match", async () => {
  const h = harness();
  h.send();
  await settle();
  h.instance.sessionEpoch++;
  h.instance.activeContext = null;
  const otherMatch = { fen: "other", flatMovesString: "other" };
  h.instance.myMatch = otherMatch;
  h.acknowledge(0);
  await settle();
  assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
  assert.equal(h.instance.myMatch, otherMatch);
  assert.equal(h.reconnects.length, 0);
});

test("auth change cancels dispatch and retains the original UID journal for safe resume", async () => {
  /** @type {PromiseWithResolvers<string>} */
  const token = deferred();
  const h = harness({ token: () => token.promise });
  h.send();
  h.instance.auth.currentUser = user("other", async () => "other-token");
  h.instance.refreshMoveDeliveries();
  required(token.resolve)("old-token");
  await settle();
  assert.equal(h.calls.length, 0);
  assert.ok(h.records.has(moveDeliveryStorageKey(scope)));
  h.instance.auth.currentUser = user("login", async () => "replacement-token");
  h.instance.refreshMoveDeliveries();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(required(h.calls[0]).bearer, "replacement-token");
  h.acknowledge(0);
  await settle();
  assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
});

test("the wrong authenticated account cannot enqueue into the prior board", async () => {
  const h = harness();
  h.instance.auth.currentUser = user("other");
  h.send();
  await settle();
  assert.equal(h.instance.myMatch.fen, initialMatch.fen);
  assert.equal(h.records.size, 0);
  assert.equal(h.calls.length, 0);
});

for (const [method, kind] of /** @type {const} */ ([
  ["surrender", "surrender"],
  ["startTimer", "timer"],
  ["claimVictoryByTimer", "claim"],
  ["updateRatings", "rating"],
  ["resolveWagerOutcome", "wager"],
  ["sendEndMatchIndicator", "end"],
  ["sendRematchProposal", "rematch"],
])) {
  test(`${kind} waits until accepted moves are confirmed`, async () => {
    const h = harness();
    h.send();
    const result = h.instance[method]();
    if (kind === "end") {
      assert.equal(result, true);
      assert.ok(h.records.has(rematchEndDeliveryStorageKey(scope)));
    }
    if (kind === "surrender")
      assert.equal(h.instance.myMatch.status, "surrendered");
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.terminal.length, 0);
    h.acknowledge(0);
    await settle();
    assert.equal(h.terminal.length, 1);
    assert.equal(required(h.terminal[0]).kind, kind);
    if (result instanceof Promise) await result;
    if (kind === "end")
      assert.equal(h.records.has(rematchEndDeliveryStorageKey(scope)), false);
    if (kind === "surrender")
      assert.equal(h.instance.myMatch.status, "surrendered");
  });
}

const endingActions = /** @type {const} */ ([
  [
    "surrender",
    "surrender",
    {
      inviteId: scope.inviteId,
      matchId: scope.matchId,
      playerId: scope.playerId,
    },
  ],
  ["sendEndMatchIndicator", "end", { inviteId: scope.inviteId }],
  [
    "updateRatings",
    "rating",
    {
      inviteId: scope.inviteId,
      matchId: scope.matchId,
      playerId: scope.playerId,
      opponentId: "opponent",
    },
  ],
  [
    "resolveWagerOutcome",
    "wager",
    { inviteId: scope.inviteId, matchId: scope.matchId },
  ],
]);

for (const [method, kind, expectedRequest] of endingActions) {
  for (const change of ["navigation", "reconnect"]) {
    test(`accepted ${kind} stays with its original match after ${change}`, async () => {
      const h = harness();
      h.send();
      const result = h.instance[method]();
      const acceptedEnd =
        kind === "end"
          ? storedObject(
              storedObject(
                JSON.parse(
                  required(h.records.get(rematchEndDeliveryStorageKey(scope))),
                ),
              ).record,
            )
          : null;
      if (kind === "end") assert.equal(result, true);
      const completed =
        result instanceof Promise ? result.catch((error) => error) : result;
      await settle();
      assert.equal(h.terminal.length, 0);
      h.instance.sessionEpoch++;
      h.instance.activeContext =
        change === "navigation"
          ? null
          : {
              ...required(h.instance.activeContext),
              contextId: 5,
              sessionEpoch: h.instance.sessionEpoch,
            };
      const replacement = { fen: "replacement", status: "" };
      h.instance.myMatch = replacement;
      h.acknowledge(0);
      await settle();
      assert.ok(!((await completed) instanceof Error));
      assert.equal(h.terminal.length, 1);
      assert.equal(required(h.terminal[0]).kind, kind);
      const { operationId, ...request } = required(h.terminal[0]).request;
      if (kind === "end") {
        assert.equal(operationId, required(acceptedEnd).operationId);
        assert.equal(h.records.has(rematchEndDeliveryStorageKey(scope)), false);
      } else assert.equal(operationId, undefined);
      assert.deepEqual(request, expectedRequest);
      assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
      assert.equal(h.instance.myMatch, replacement);
      assert.equal(
        replacement.status,
        kind === "surrender" && change === "reconnect" ? "surrendered" : "",
      );
      assert.equal(
        h.reconnects.length,
        kind === "surrender" && change === "reconnect" ? 1 : 0,
      );
    });
  }

  for (const uid of ["other", "login"]) {
    test(`accepted ${kind} rejects a replacement auth object with UID ${uid}`, async () => {
      const h = harness();
      h.send();
      const result = h.instance[method]();
      const completed =
        result instanceof Promise ? result.catch(() => undefined) : result;
      await settle();
      h.instance.auth.currentUser = user(uid, async () => "replacement-token");
      h.acknowledge(0);
      await settle();
      for (let index = 1; index < h.calls.length; index++) {
        h.acknowledge(index);
        await settle();
      }
      await completed;
      assert.equal(h.terminal.length, 0);
      assert.equal(h.reconnects.length, 0);
      if (kind === "end")
        assert.ok(h.records.has(rematchEndDeliveryStorageKey(scope)));
      h.instance.refreshMoveDeliveries();
      for (const delivery of h.instance.moveDeliveries.values())
        delivery.pause();
      for (const delivery of h.instance.rematchEndDeliveries.values())
        delivery.pause();
    });
  }
}

test("rating settlement captures its match before authentication waits", async () => {
  const authenticationReady = deferred();
  const h = harness();
  h.instance.ensureAuthenticated = () => authenticationReady.promise;
  h.send();
  const completed = h.instance.updateRatings();
  h.instance.sessionEpoch++;
  h.instance.activeContext = {
    ...required(h.instance.activeContext),
    contextId: 5,
    sessionEpoch: h.instance.sessionEpoch,
    inviteId: "zyxwvutsrqp",
    matchId: "zyxwvutsrqp1",
  };
  h.instance.getOpponentId = () => "new-opponent";
  required(authenticationReady.resolve)();
  await settle();
  assert.equal(h.terminal.length, 0);
  h.acknowledge(0);
  await completed;
  assert.deepEqual(h.terminal, [
    {
      kind: "rating",
      request: {
        inviteId: scope.inviteId,
        matchId: scope.matchId,
        playerId: scope.playerId,
        opponentId: "opponent",
      },
    },
  ]);
});

for (const [method, kind] of /** @type {const} */ ([
  ["startTimer", "timer"],
  ["claimVictoryByTimer", "timer claim"],
  ["sendRematchProposal", "rematch proposal"],
])) {
  test(`a move barrier cannot dispatch a dependent ${kind} after its board context changes`, async () => {
    const h = harness();
    h.send();
    const result = h.instance[method]();
    const rejected =
      result instanceof Promise
        ? assert.rejects(result, /request-aborted/)
        : undefined;
    await settle();
    h.instance.sessionEpoch++;
    h.acknowledge(0);
    await rejected;
    await settle();
    assert.equal(h.terminal.length, 0);
    assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
  });
}

test("returning to the same game reconciles a surrender only after the server commits it", async () => {
  const pendingSurrender = deferred();
  let serverMatch = { ...initialMatch };
  /** @type {({ status: string; timer: string; emojiId: number; fen: string; flatMovesString: string; gameVariant: string; })[]} */
  const recovered = [];
  const h = harness({
    onTerminal: async (kind) => {
      assert.equal(kind, "surrender");
      await pendingSurrender.promise;
      serverMatch = { ...serverMatch, status: "surrendered" };
      return { ok: true };
    },
    onReconnect: (inviteId, guard) => {
      assert.equal(inviteId, scope.inviteId);
      assert.equal(guard(), true);
      assert.equal(serverMatch.status, "surrendered");
      recovered.push({ ...serverMatch });
      h.instance.myMatch = { ...serverMatch };
    },
  });
  h.send();
  assert.equal(h.instance.surrender(), true);
  await settle();
  h.instance.sessionEpoch++;
  h.instance.activeContext = {
    ...required(h.instance.activeContext),
    contextId: 5,
    sessionEpoch: h.instance.sessionEpoch,
  };
  const delivery = h.instance.moveDeliveries.get(moveDeliveryStorageKey(scope));
  h.instance.myMatch = { ...initialMatch, ...required(delivery).latest };
  serverMatch = { ...initialMatch, ...required(delivery).latest };
  h.acknowledge(0);
  await settle();
  assert.equal(h.terminal.length, 1);
  assert.equal(serverMatch.status, "");
  assert.equal(h.instance.myMatch.status, "");
  assert.equal(recovered.length, 0);
  assert.equal(h.instance.confirmedSurrenders.size, 0);

  required(pendingSurrender.resolve)();
  await settle();
  assert.equal(h.instance.myMatch.status, "surrendered");
  assert.equal(recovered.length, 1);
  assert.ok(h.instance.confirmedSurrenders.has(moveDeliveryStorageKey(scope)));
  h.send("third", "third-fen");
  await settle();
  assert.equal(h.calls.length, 1);
});

for (const change of ["another match", "another account"]) {
  test(`a surrender response cannot reconcile ${change}`, async () => {
    /** @type {PromiseWithResolvers<{ok: true}>} */
    const pendingSurrender = deferred();
    const h = harness({ onTerminal: () => pendingSurrender.promise });
    h.send();
    h.instance.surrender();
    await settle();
    h.acknowledge(0);
    await settle();
    assert.equal(h.terminal.length, 1);
    h.instance.sessionEpoch++;
    h.instance.activeContext = {
      ...required(h.instance.activeContext),
      contextId: 5,
      sessionEpoch: h.instance.sessionEpoch,
      ...(change === "another match" ? { matchId: "abcdefghijk2" } : {}),
    };
    if (change === "another account") {
      h.instance.auth.currentUser = user("other", async () => "other-token");
    }
    const replacement = { fen: "replacement", status: "" };
    h.instance.myMatch = replacement;
    required(pendingSurrender.resolve)({ ok: true });
    await settle();
    assert.equal(h.instance.myMatch, replacement);
    assert.equal(replacement.status, "");
    assert.equal(h.reconnects.length, 0);
  });
}

test("surrender recovery rechecks the displayed match and account after its cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const change of ["none", "match", "account"]) {
    const h = harness();
    h.instance.moveReconnectLastAttemptAt = Date.now();
    h.send();
    h.instance.surrender();
    await settle();
    h.instance.sessionEpoch++;
    h.instance.activeContext = {
      ...required(h.instance.activeContext),
      contextId: 5,
      sessionEpoch: h.instance.sessionEpoch,
    };
    h.instance.myMatch = { ...initialMatch };
    h.acknowledge(0);
    await settle();
    assert.equal(h.instance.myMatch.status, "surrendered");
    assert.equal(h.reconnects.length, 0);
    assert.equal(h.instance.moveRecoveryTimers.size, 1);
    if (change === "match") {
      h.instance.activeContext = {
        ...required(h.instance.activeContext),
        matchId: "abcdefghijk2",
      };
    } else if (change === "account") {
      h.instance.auth.currentUser = user("other", async () => "other-token");
    }
    t.mock.timers.tick(3000);
    assert.equal(h.reconnects.length, change === "none" ? 1 : 0);
    assert.equal(h.instance.moveRecoveryTimers.size, 0);
  }
});

test("confirmed terminal cancellation releases ending actions without calling the move delivered", async () => {
  const h = harness();
  h.send();
  const rating = h.instance.updateRatings();
  await settle();
  const delivery = h.instance.moveDeliveries.get(moveDeliveryStorageKey(scope));
  const revision = required(delivery).confirmationVersion;
  required(h.calls[0]).pending.reject(
    new GameplayApiError("failed-precondition", "match-move-finished"),
  );
  await rating;
  assert.equal(required(h.terminal.at(-1)).kind, "rating");
  assert.equal(required(delivery).confirmationVersion, revision);
  assert.ok(h.records.has(`${moveDeliveryStorageKey(scope)}:finished`));
  h.send("another", "another-fen");
  await settle();
  assert.equal(h.calls.length, 1);
});

test("own-state recovery waits out reconnect cooldown and still respects navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const navigate of [false, true]) {
    const h = harness();
    h.instance.moveReconnectLastAttemptAt = Date.now();
    h.send();
    await settle();
    const delivery = h.instance.moveDeliveries.get(
      moveDeliveryStorageKey(scope),
    );
    required(delivery).reconcile({
      fen: "remote-next",
      flatMovesString: "first-second-third",
    });
    assert.equal(h.reconnects.length, 0);
    assert.equal(h.instance.moveRecoveryTimers.size, 1);
    if (navigate) h.instance.activeContext = null;
    t.mock.timers.tick(3000);
    assert.equal(h.reconnects.length, navigate ? 0 : 1);
    assert.equal(h.instance.moveRecoveryTimers.size, 0);
    h.acknowledge(0);
    await settle();
  }
});

/** @param {unknown} value @returns {Record<string, unknown>} */
function storedObject(value) {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}
