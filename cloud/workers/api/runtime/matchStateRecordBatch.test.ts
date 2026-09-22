import { env } from "cloudflare:workers";
import { runInDurableObject, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildMatchStateRouteStatements } from "../src/matchStateD1.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";
import { createMatchStateSource } from "../src/matchStateSource.ts";
import {
  MAX_MATCH_STATE_RECORD_READS,
  type MatchStateRecordsRequest,
} from "../src/matchStateTypes.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;

beforeAll(async () => {
  await applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db
    .prepare(
      "UPDATE match_state_control SET state = 'active' WHERE singleton = 1",
    )
    .run();
});

async function roomFixture() {
  const inviteId = `record-batch-${crypto.randomUUID()}`;
  const rpc = getMatchStateRpc(env, inviteId);
  const records = [
    {
      matchId: inviteId,
      playerId: "host-login",
      marker: "host-created",
      value: { color: "white", fen: "host-position" },
    },
    {
      matchId: inviteId,
      playerId: "guest-login",
      marker: "guest-created",
      value: { color: "black", fen: "guest-position" },
    },
    {
      matchId: `${inviteId}1`,
      playerId: "host-login",
      marker: "rematch-created",
      value: { color: "black", fen: "rematch-position" },
    },
  ];
  const created = unwrapMatchStateRpc(
    await rpc.createCanonicalMatch({ inviteId, epoch: 2, records }),
  );
  const targets = records.map(({ matchId, playerId }) => ({
    matchId,
    playerId,
  }));
  const values = created.records.map(({ value }) => value);
  const register = async (indices: number[]) => {
    await db.batch(
      buildMatchStateRouteStatements(
        db,
        indices.map((index) => ({
          actorUid: targets[index].playerId,
          matchId: targets[index].matchId,
          kind: "durable" as const,
          inviteId,
          epoch: 2,
        })),
      ),
    );
  };
  return { inviteId, rpc, targets, values, register };
}

function observedSource() {
  const calls: MatchStateRecordsRequest[] = [];
  const workerEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "INVITE_REACTIONS")
        return {
          getByName: (inviteId: string) => ({
            readCanonicalMatchRecords: (input: MatchStateRecordsRequest) => {
              expect(input.inviteId).toBe(inviteId);
              calls.push(structuredClone(input));
              return getMatchStateRpc(env, inviteId).readCanonicalMatchRecords(
                input,
              );
            },
          }),
        };
      return Reflect.get(target, property, receiver);
    },
  });
  return { source: createMatchStateSource(workerEnv), calls };
}

describe("routed match record batches", () => {
  it("reads only requested records in order despite an unrelated corrupt claim", async () => {
    const fixture = await roomFixture();
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(fixture.inviteId),
      (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
          fixture.inviteId,
          "invalid-json",
        );
      },
    );
    const missing = { matchId: fixture.inviteId, playerId: "missing-login" };
    expect(
      unwrapMatchStateRpc(
        await fixture.rpc.readCanonicalMatchRecords({
          inviteId: fixture.inviteId,
          epoch: 2,
          requests: [
            fixture.targets[1],
            fixture.targets[0],
            missing,
            fixture.targets[1],
          ],
        }),
      ),
    ).toEqual([fixture.values[1], fixture.values[0], null, fixture.values[1]]);
    expect(
      unwrapMatchStateRpc(
        await fixture.rpc.readCanonicalMatchRecords({
          inviteId: fixture.inviteId,
          epoch: 2,
          requests: Array.from(
            { length: MAX_MATCH_STATE_RECORD_READS },
            () => fixture.targets[0],
          ),
        }),
      ),
    ).toEqual(Array(MAX_MATCH_STATE_RECORD_READS).fill(fixture.values[0]));
    await fixture.register([0]);
    const { source } = observedSource();
    expect(await source.readMatchRecord(fixture.targets[0])).toEqual(
      fixture.values[0],
    );
  });

  it("rejects malformed and oversized RPC batches and preserves authority checks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = await roomFixture();
    for (const requests of [
      null,
      {},
      [],
      Array(MAX_MATCH_STATE_RECORD_READS + 1).fill(fixture.targets[0]),
    ]) {
      expect(
        await fixture.rpc.readCanonicalMatchRecords({
          inviteId: fixture.inviteId,
          epoch: 2,
          requests,
        } as MatchStateRecordsRequest),
      ).toMatchObject({ ok: false, message: "match-state-unavailable" });
    }
    expect(
      await fixture.rpc.readCanonicalMatchRecords({
        inviteId: fixture.inviteId,
        epoch: 3,
        requests: [fixture.targets[0]],
      }),
    ).toMatchObject({
      ok: false,
      message: "match-state-authority-unavailable",
    });
    expect(
      await fixture.rpc.readCanonicalMatchRecords({
        inviteId: fixture.inviteId,
        epoch: 2,
        requests: [{ playerId: "host-login", matchId: "different-invite" }],
      }),
    ).toMatchObject({ ok: false, message: "match-state-unavailable" });
  });

  it("groups base matches and rematches by their stored room route and preserves order", async () => {
    const first = await roomFixture();
    const second = await roomFixture();
    await first.register([0, 1, 2]);
    await second.register([0]);
    const { source, calls } = observedSource();
    const requests = [
      first.targets[2],
      second.targets[0],
      first.targets[1],
      first.targets[0],
    ];
    expect(await source.readMatchRecords(requests)).toEqual([
      first.values[2],
      second.values[0],
      first.values[1],
      first.values[0],
    ]);
    expect(calls).toHaveLength(2);
    expect(
      calls.find((call) => call.inviteId === first.inviteId)?.requests,
    ).toEqual([first.targets[2], first.targets[1], first.targets[0]]);
    expect(calls.every((call) => call.epoch === 2)).toBe(true);
    expect(await source.readMatchRecord(first.targets[2])).toEqual(
      first.values[2],
    );
    expect(calls.at(-1)).toEqual({
      inviteId: first.inviteId,
      epoch: 2,
      requests: [first.targets[2]],
    });
  });

  it("preserves mixed legacy values, duplicate requests and durable records in order", async () => {
    const fixture = await roomFixture();
    await fixture.register([0]);
    const legacyValues = [[1, { legacy: true }], null, false];
    const legacy = legacyValues.map(() => ({
      playerId: "legacy-login",
      matchId: `legacy-${crypto.randomUUID()}`,
    }));
    await db.batch([
      ...buildMatchStateRouteStatements(
        db,
        legacy.map(({ playerId, matchId }) => ({
          actorUid: playerId,
          matchId,
          kind: "legacy",
          inviteId: null,
          epoch: 2,
        })),
      ),
      ...legacy.map(({ playerId, matchId }, index) =>
        db
          .prepare(
            "INSERT INTO match_state_legacy_records VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            playerId,
            matchId,
            JSON.stringify(legacyValues[index]),
            "a".repeat(64),
            "record-batch-import",
            "malformed",
          ),
      ),
    ]);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-fetch"));
    const { source, calls } = observedSource();
    expect(
      await source.readMatchRecords([
        legacy[2],
        fixture.targets[0],
        legacy[0],
        fixture.targets[1],
        legacy[1],
        legacy[2],
        fixture.targets[0],
        legacy[0],
      ]),
    ).toEqual([
      false,
      fixture.values[0],
      legacyValues[0],
      null,
      null,
      false,
      fixture.values[0],
      legacyValues[0],
    ]);
    for (let index = 0; index < legacy.length; index++) {
      expect(await source.readMatchRecord(legacy[index])).toEqual(
        legacyValues[index],
      );
    }
    expect(await source.readMatchRecord(fixture.targets[1])).toBeNull();
    expect(
      await source.readMatchRecord({
        playerId: "missing-login",
        matchId: `missing-${crypto.randomUUID()}`,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].requests).toEqual([fixture.targets[0], fixture.targets[0]]);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["durable", "legacy"] as const)(
    "fails closed when a %s route has no physical record",
    async (kind) => {
      const fixture = await roomFixture();
      const missing = { playerId: "missing-login", matchId: fixture.inviteId };
      await db.batch(
        buildMatchStateRouteStatements(db, [
          {
            actorUid: missing.playerId,
            matchId: missing.matchId,
            kind,
            inviteId: kind === "durable" ? fixture.inviteId : null,
            epoch: 2,
          },
        ]),
      );
      const { source } = observedSource();
      await expect(source.readMatchRecords([missing])).rejects.toThrow(
        kind === "durable"
          ? "match-state-record-unavailable"
          : "match-state-legacy-record-unavailable",
      );
      await expect(source.readMatchRecord(missing)).rejects.toThrow(
        kind === "durable"
          ? "match-state-record-unavailable"
          : "match-state-legacy-record-unavailable",
      );
    },
  );

  it("allows frozen reads while rejecting stale route epochs before room calls", async () => {
    const fixture = await roomFixture();
    await fixture.register([0]);
    const stale = { playerId: "stale-login", matchId: fixture.inviteId };
    await db.batch(
      buildMatchStateRouteStatements(db, [
        {
          actorUid: stale.playerId,
          matchId: stale.matchId,
          kind: "durable",
          inviteId: fixture.inviteId,
          epoch: 1,
        },
      ]),
    );
    await db
      .prepare(
        "UPDATE match_state_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    const { source, calls } = observedSource();
    expect(await source.readMatchRecords([fixture.targets[0]])).toEqual([
      fixture.values[0],
    ]);
    expect(await source.readMatchRecord(fixture.targets[0])).toEqual(
      fixture.values[0],
    );
    const callsBefore = calls.length;
    await expect(source.readMatchRecords([stale])).rejects.toThrow(
      "match-state-route-epoch-conflict",
    );
    await expect(source.readMatchRecord(stale)).rejects.toThrow(
      "match-state-route-epoch-conflict",
    );
    expect(calls).toHaveLength(callsBefore);
  });
});
