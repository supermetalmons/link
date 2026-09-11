import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleMatchStateMigrationRoute } from "../src/matchStateMigrationRoute.ts";
import { createMatchStateMigrationSignature } from "../src/matchStateMigrationAuth.ts";
import { createMatchPresentationMigrationSignature } from "../src/matchPresentationMigrationAuth.ts";
import {
  matchStateDigest,
  type MatchStateMigrationRequest,
} from "../src/matchStateMigration.ts";
import { readMatchStateRoute } from "../src/matchStateD1.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";
import type { MatchStateImportRequest } from "../src/matchStateTypes.ts";

const runtime = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const sourceDigest = "a".repeat(64);
const importId = "00000000-0000-4000-8000-000000000011";
const ownerToken = "00000000-0000-4000-8000-000000000012";
const migrationEnv: Env = {
  ...env,
  MATCH_STATE_MIGRATION_SECRET: "match-state-local-test-secret",
};

beforeAll(async () => {
  await applyD1Migrations(db, runtime.TEST_D1_MIGRATIONS);
});

beforeEach(async () => {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'match_state_%'",
    )
    .all<{ name: string }>();
  for (const { name } of tables.results)
    await db.prepare(`DROP TABLE ${name}`).run();
  const migration = runtime.TEST_D1_MIGRATIONS.find((item) =>
    item.name.startsWith("0024_"),
  );
  if (!migration) throw new Error("match-state-test-migration-missing");
  await db.batch(migration.queries.map((query) => db.prepare(query)));
  await db
    .prepare(
      "UPDATE match_state_control SET state = 'frozen', freeze_generation = 1, import_id = ?, source_digest = ? WHERE singleton = 1",
    )
    .bind(importId, sourceDigest)
    .run();
  await db
    .prepare(
      "INSERT INTO match_state_operator_lock VALUES (1, ?, ?, 'import', 1)",
    )
    .bind(ownerToken, importId)
    .run();
});

async function input(empty = false): Promise<MatchStateMigrationRequest> {
  const inviteId = `migration-${crypto.randomUUID()}`;
  const bundle: MatchStateImportRequest = {
    inviteId,
    epoch: 2,
    importId,
    records: empty
      ? []
      : [
          {
            matchId: inviteId,
            playerId: "host",
            value: {
              color: "white",
              fen: "fen",
              timer: "2;90000",
              unknown: { "2": "two", "10": "ten" },
            },
          },
        ],
    claims: [],
  };
  return {
    schemaVersion: 1,
    operation: "import",
    ownerToken,
    sourceDigest,
    bundle: {
      ...bundle,
      digest: await matchStateDigest(bundle),
      recordCount: bundle.records.length,
      claimCount: 0,
    },
  };
}

async function request(
  value: MatchStateMigrationRequest,
  targetEnv = migrationEnv,
  wrongDomain = false,
): Promise<Response> {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await (
    wrongDomain
      ? createMatchPresentationMigrationSignature
      : createMatchStateMigrationSignature
  )(body, migrationEnv.MATCH_STATE_MIGRATION_SECRET, timestamp);
  return handleMatchStateMigrationRoute(
    new Request("https://api.mons.link/internal/match-state/migration", {
      method: "POST",
      body,
      headers: {
        "X-Mons-Match-State-Timestamp": timestamp,
        "X-Mons-Match-State-Signature": signature,
      },
    }),
    targetEnv,
  );
}

describe("signed match-state migration with real D1 and Durable Objects", () => {
  it("imports exact records, verifies and activates without changing deadlines or unknown keys", async () => {
    const value = await input();
    expect((await request(value)).status).toBe(200);
    expect((await request(value)).status).toBe(200);
    expect(
      await readMatchStateRoute(db, "host", value.bundle.inviteId),
    ).toMatchObject({
      kind: "durable",
      inviteId: value.bundle.inviteId,
      epoch: 2,
    });
    expect((await request({ ...value, operation: "readback" })).status).toBe(
      200,
    );
    expect((await request({ ...value, operation: "activate" })).status).toBe(
      200,
    );
    const actual = unwrapMatchStateRpc(
      await getMatchStateRpc(
        env,
        value.bundle.inviteId,
      ).readCanonicalMatchRecord({
        inviteId: value.bundle.inviteId,
        epoch: 2,
        matchId: value.bundle.inviteId,
        playerId: "host",
      }),
    );
    expect(actual).toEqual(value.bundle.records[0].value);
    expect(
      (
        await db
          .prepare("SELECT phase FROM match_state_import_receipts")
          .first<{ phase: string }>()
      )?.phase,
    ).toBe("active");
  });

  it("initializes empty rooms and requires a readback receipt before activation", async () => {
    const value = await input(true);
    expect((await request(value)).status).toBe(200);
    expect((await request({ ...value, operation: "activate" })).status).toBe(
      503,
    );
    expect((await request({ ...value, operation: "readback" })).status).toBe(
      200,
    );
    expect((await request({ ...value, operation: "activate" })).status).toBe(
      200,
    );
  });

  it("rejects wrong signature purposes and stale operator ownership", async () => {
    const value = await input();
    expect((await request(value, migrationEnv, true)).status).toBe(401);
    expect(
      (
        await request({
          ...value,
          ownerToken: "00000000-0000-4000-8000-000000000099",
        })
      ).status,
    ).toBe(503);
    expect(
      await readMatchStateRoute(db, "host", value.bundle.inviteId),
    ).toBeNull();
  });

  it("replays a staged room after the D1 registration response fails", async () => {
    const value = await input();
    let calls = 0;
    const brokenDb = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            calls++;
            if (calls === 2) throw new Error("simulated-registration-outage");
            return target.batch(statements);
          };
        const original = Reflect.get(target, property, target);
        return typeof original === "function"
          ? original.bind(target)
          : original;
      },
    });
    expect(
      (await request(value, { ...migrationEnv, PROFILE_GAMES_DB: brokenDb }))
        .status,
    ).toBe(503);
    expect(
      await readMatchStateRoute(db, "host", value.bundle.inviteId),
    ).toBeNull();
    expect((await request(value)).status).toBe(200);
    expect((await request({ ...value, operation: "readback" })).status).toBe(
      200,
    );
  });

  it("conflicting imports cannot overwrite a staged record", async () => {
    const value = await input();
    expect((await request(value)).status).toBe(200);
    const changed = structuredClone(value);
    changed.bundle.records[0].value.fen = "changed";
    changed.bundle.digest = await matchStateDigest({
      inviteId: changed.bundle.inviteId,
      epoch: 2,
      importId,
      records: changed.bundle.records,
      claims: [],
    });
    expect((await request(changed)).status).toBe(503);
    expect((await request({ ...value, operation: "readback" })).status).toBe(
      200,
    );
  });

  it("retires the import endpoint once global durable authority is active", async () => {
    const value = await input(true);
    await db
      .prepare(
        `UPDATE match_state_control SET backend = 'durable', epoch = 2,
      candidate_version_id = 'candidate', verified_digest = source_digest, fence_digest = ?,
      source_record_count = 0, source_claim_count = 0, source_bundle_count = 0, verified_at_ms = 1, activated_at_ms = 2 WHERE singleton = 1`,
      )
      .bind("b".repeat(64))
      .run();
    expect((await request(value)).status).toBe(410);
  });
});
