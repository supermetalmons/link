import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMatchStateSource } from "../src/matchStateSource.ts";
import { canonicalMatchOperations } from "../src/matchStateClient.ts";
import { readMatchStateRecord } from "../src/matchStateRouting.ts";
import { readMatchStateRoute } from "../src/matchStateD1.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";

const db = env.PROFILE_GAMES_DB;
const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

beforeAll(async () => {
  await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  await db
    .prepare(
      `UPDATE match_state_control SET backend = 'durable', state = 'active', epoch = 2,
    candidate_version_id = 'strict', import_id = 'import',
    source_digest = ?, verified_digest = ?, fence_digest = ?,
    source_record_count = 0, source_claim_count = 0, source_bundle_count = 0,
    verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`,
    )
    .bind("a".repeat(64), "a".repeat(64), "b".repeat(64))
    .run();
  await db
    .prepare(
      `INSERT INTO match_state_write_admissions
    (admission_id, backend, epoch, freeze_generation, kind, resources_json, phase, created_at_ms)
    VALUES ('retained-evidence', 'rtdb', 1, 0, 'historical', '[]', 'uncertain', 1)`,
    )
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db
    .prepare(
      "UPDATE match_state_control SET state = 'active' WHERE singleton = 1",
    )
    .run();
});

function strictEnv(overrides: Partial<Env> = {}): Env {
  return new Proxy(
    { ...env, ...overrides },
    {
      get(target, property, receiver) {
        if (
          [
            "FIREBASE_RTDB_URL",
            "GAMEPLAY_SERVICE_ACCOUNT_EMAIL",
            "GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY",
          ].includes(String(property))
        ) {
          throw new Error(`retired-firebase-configuration:${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
}

async function admissions() {
  return (
    await db
      .prepare(
        "SELECT * FROM match_state_write_admissions ORDER BY admission_id",
      )
      .all()
  ).results;
}

function input() {
  const inviteId = `strict-${crypto.randomUUID()}`;
  return { inviteId, matchId: inviteId, playerId: "strict-player" };
}

describe("strict match runtime", () => {
  it("rejects retained Firebase authority without reading credentials or making a request", async () => {
    const before = await admissions();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-outbound-request"));
    const retiredDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "withSession")
          return () => ({
            prepare: () => ({
              first: async () => ({
                backend: "rtdb",
                state: "active",
                epoch: 1,
                freeze_generation: 0,
              }),
            }),
          });
        return Reflect.get(target, property, receiver);
      },
    });
    const workerEnv = strictEnv({ PROFILE_GAMES_DB: retiredDb });
    const source = createMatchStateSource(workerEnv);
    await expect(
      source.getPath("players/player/matches/invite"),
    ).rejects.toThrow("match-state-durable-authority-required");
    await expect(canonicalMatchOperations(workerEnv)).rejects.toThrow(
      "match-state-durable-authority-required",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(await admissions()).toEqual(before);
  });
  it("constructs defaults and persists canonical records without Firebase or cutover admission writes", async () => {
    const before = await admissions();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-outbound-request"));
    const workerEnv = strictEnv();
    createGameplayRepository(workerEnv);
    const source = createMatchStateSource(workerEnv);
    const request = input();
    await source.createMatchRecords!({
      inviteId: request.inviteId,
      transitionId: "create",
      records: [
        {
          ...request,
          marker: "created",
          value: { color: "white", fen: "initial", flatMovesString: "" },
        },
      ],
    });
    const operations = await canonicalMatchOperations(workerEnv);
    expect(
      await operations.submitCanonical({
        ...request,
        previousFlatMovesString: "",
        flatMovesString: "a",
        fen: "first",
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await source.getPath(
        `players/${request.playerId}/matches/${request.matchId}`,
      ),
    ).toMatchObject({ fen: "first", sessionCreation: "created" });
    expect(await admissions()).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows reads while frozen and blocks writes without changing retained evidence", async () => {
    const before = await admissions();
    const request = input();
    const workerEnv = strictEnv();
    const source = createMatchStateSource(workerEnv);
    await source.createMatchRecords!({
      inviteId: request.inviteId,
      transitionId: "create",
      records: [
        {
          ...request,
          marker: "created",
          value: { color: "white", fen: "initial" },
        },
      ],
    });
    await db
      .prepare(
        "UPDATE match_state_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    expect(
      await readMatchStateRecord(workerEnv, {
        playerId: request.playerId,
        matchId: request.matchId,
      }),
    ).toMatchObject({ fen: "initial" });
    await expect(canonicalMatchOperations(workerEnv)).rejects.toThrow(
      "match-state-writes-disabled",
    );
    await expect(
      source.createMatchRecords!({
        inviteId: request.inviteId,
        transitionId: "retry",
        records: [],
      }),
    ).rejects.toThrow("match-state-writes-disabled");
    expect(await admissions()).toEqual(before);
  });

  for (const operation of ["move", "surrender"] as const) {
    it(`replays a committed ${operation} after a lost DO reply without another revision`, async () => {
      const before = await admissions();
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unexpected-outbound-request"));
      const request = input();
      const source = createMatchStateSource(strictEnv());
      await source.createMatchRecords!({
        inviteId: request.inviteId,
        transitionId: "create",
        records: [
          {
            ...request,
            marker: "created",
            value: {
              color: "white",
              fen: "initial",
              flatMovesString: "",
              status: "",
              timer: "4;12345",
              aura: "retained",
              extra: { retained: true },
            },
          },
        ],
      });
      const rpc = getMatchStateRpc(env, request.inviteId);
      const readPair = async () =>
        unwrapMatchStateRpc(
          await rpc.readCanonicalMatchPair({
            ...request,
            epoch: 2,
            opponentId: null,
          }),
        );
      const initial = await readPair();
      let loseReply = true;
      const loseFirstReply = async <T>(work: Promise<T>): Promise<T> => {
        const result = await work;
        expect(result).toMatchObject({ ok: true });
        if (loseReply) {
          loseReply = false;
          throw new Error("injected-lost-do-response");
        }
        return result;
      };
      const workerEnv = new Proxy(strictEnv(), {
        get(target, property, receiver) {
          if (property === "INVITE_REACTIONS")
            return {
              getByName: () => ({
                submitCanonicalMove: (
                  value: Parameters<typeof rpc.submitCanonicalMove>[0],
                ) => loseFirstReply(rpc.submitCanonicalMove(value)),
                surrenderCanonicalMatch: (
                  value: Parameters<typeof rpc.surrenderCanonicalMatch>[0],
                ) => loseFirstReply(rpc.surrenderCanonicalMatch(value)),
              }),
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const operations = await canonicalMatchOperations(workerEnv);
      const execute = () =>
        operation === "move"
          ? operations.submitCanonical({
              ...request,
              previousFlatMovesString: "",
              flatMovesString: "a",
              fen: "first",
            })
          : operations.surrenderCanonical(request);
      await expect(execute()).rejects.toThrow("injected-lost-do-response");
      const committed = await readPair();
      expect(committed).toEqual({
        ...initial,
        revision: initial.revision + 1,
        playerMatch: {
          ...initial.playerMatch,
          ...(operation === "move"
            ? { fen: "first", flatMovesString: "a" }
            : { status: "surrendered" }),
        },
      });
      await expect(execute()).resolves.toEqual({
        ok: true,
        inviteId: request.inviteId,
        matchId: request.matchId,
        actorUid: request.playerId,
        ...(operation === "move" ? { outcome: "already-applied" } : {}),
      });
      expect(await readPair()).toEqual(committed);
      expect(await admissions()).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    });
  }

  for (const control of [
    { state: "frozen", epoch: 2, message: "match-state-writes-disabled" },
    {
      state: "active",
      epoch: 3,
      message: "match-state-durable-authority-required",
    },
  ]) {
    it(`rechecks ${control.state} authority at epoch ${control.epoch} before every canonical command`, async () => {
      const before = await admissions();
      let changed = false;
      const authorityDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "withSession")
            return () => ({
              prepare: (query: string) => ({
                first: async () => {
                  const row = await db
                    .withSession("first-primary")
                    .prepare(query)
                    .first();
                  return changed
                    ? { ...row, state: control.state, epoch: control.epoch }
                    : row;
                },
              }),
            });
          return Reflect.get(target, property, receiver);
        },
      });
      const getByName = vi.fn(() => {
        throw new Error("unexpected-do-call");
      });
      const workerEnv = new Proxy(
        strictEnv({ PROFILE_GAMES_DB: authorityDb }),
        {
          get(target, property, receiver) {
            if (property === "INVITE_REACTIONS") return { getByName };
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const operations = await canonicalMatchOperations(workerEnv);
      changed = true;
      const request = input();
      const timerRequest = { ...request, opponentId: "strict-opponent" };
      for (const execute of [
        () =>
          operations.submitCanonical({
            ...request,
            previousFlatMovesString: "",
            flatMovesString: "a",
            fen: "first",
          }),
        () => operations.surrenderCanonical(request),
        () => operations.startCanonical(timerRequest),
        () =>
          operations.claimCanonical(timerRequest, {
            eventOwned: true,
            eventId: "event-one",
          }),
      ]) {
        await expect(execute()).rejects.toThrow(control.message);
      }
      expect(getByName).not.toHaveBeenCalled();
      expect(await admissions()).toEqual(before);
    });
  }

  it("guards route registration after creation and leaves a failed registration replayable", async () => {
    const before = await admissions();
    const request = input();
    let calls = 0;
    let freeze = true;
    const workerEnv = new Proxy(strictEnv(), {
      get(target, property, receiver) {
        if (property === "INVITE_REACTIONS")
          return {
            getByName: () => ({
              createCanonicalMatch: async () => {
                calls++;
                if (freeze)
                  await db
                    .prepare(
                      "UPDATE match_state_control SET state = 'frozen' WHERE singleton = 1",
                    )
                    .run();
                return {
                  ok: true,
                  value: { records: [], changedMatchIds: [] },
                };
              },
            }),
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const creation = {
      inviteId: request.inviteId,
      transitionId: "create",
      records: [
        {
          ...request,
          marker: "created",
          value: { color: "white", fen: "initial" },
        },
      ],
    };
    const source = createMatchStateSource(workerEnv);
    await expect(source.createMatchRecords!(creation)).rejects.toThrow();
    expect(
      await readMatchStateRoute(db, request.playerId, request.matchId),
    ).toBeNull();
    expect(await admissions()).toEqual(before);
    freeze = false;
    await db
      .prepare(
        "UPDATE match_state_control SET state = 'active' WHERE singleton = 1",
      )
      .run();
    await source.createMatchRecords!(creation);
    expect(calls).toBe(2);
    expect(
      await readMatchStateRoute(db, request.playerId, request.matchId),
    ).toMatchObject({ kind: "durable", epoch: 2, inviteId: request.inviteId });
    expect(await admissions()).toEqual(before);
  });
});
