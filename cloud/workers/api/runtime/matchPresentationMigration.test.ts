import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMatchPresentationMigrationSignature } from "../src/matchPresentationMigrationAuth.ts";
import {
  handleMatchPresentationMigrationRoute,
  type MatchPresentationMigrationRequest,
} from "../src/matchPresentationMigrationRoute.ts";
import {
  matchPresentationSeedDigest,
  readRegisteredMatchPresentations,
} from "../src/matchPresentationRegistry.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const runtime = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const migrationEnv: Env = {
  ...env,
  MATCH_PRESENTATION_MIGRATION_SECRET: "runtime-migration-only-secret",
};
const migrationId = "00000000-0000-4000-8000-000000000002";
const sourceDigest = "a".repeat(64);

beforeAll(async () => {
  await applyD1Migrations(runtime.PROFILE_GAMES_DB, runtime.TEST_D1_MIGRATIONS);
});
beforeEach(async () => {
  await resetMatchPresentationTestState(
    runtime.PROFILE_GAMES_DB,
    runtime.TEST_D1_MIGRATIONS,
    true,
  );
  await runtime.PROFILE_GAMES_DB.prepare(
    "UPDATE match_presentation_control SET source_digest = ?, source_count = 2 WHERE singleton = 1",
  )
    .bind(sourceDigest)
    .run();
});

async function rows(
  inviteId: string,
): Promise<MatchPresentationMigrationRequest["rows"]> {
  return Promise.all(
    ["host", "guest"].map(async (actorUid, index) => {
      const row = {
        inviteId,
        matchId: inviteId,
        actorUid,
        emojiId: index + 1,
        aura: "",
      };
      return { ...row, seedDigest: await matchPresentationSeedDigest(row) };
    }),
  );
}

async function execute(
  value: MatchPresentationMigrationRequest,
): Promise<Response> {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return handleMatchPresentationMigrationRoute(
    new Request(
      "https://api.mons.link/internal/match-presentations/migration",
      {
        method: "POST",
        body,
        headers: {
          "X-Mons-Migration-Timestamp": timestamp,
          "X-Mons-Migration-Signature":
            await createMatchPresentationMigrationSignature(
              body,
              migrationEnv.MATCH_PRESENTATION_MIGRATION_SECRET,
              timestamp,
            ),
        },
      },
    ),
    migrationEnv,
  );
}

describe("appearance migration bridge with real D1 and Durable Objects", () => {
  it("resumes partial imports while preserving edited and frozen appearance", async () => {
    const inviteId = `migration-${crypto.randomUUID()}`;
    const source = await rows(inviteId);
    const room = env.INVITE_REACTIONS.getByName(inviteId);
    await room.ensurePresentations(inviteId, {
      host: { emojiId: 1, aura: "" },
    });
    const operation = {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      emojiId: 1000,
      aura: "rainbow",
    };
    await room.updatePresentation("host", inviteId, operation);
    await room.freezePresentations(inviteId, {
      host: { emojiId: 1, aura: "" },
    });
    const input: MatchPresentationMigrationRequest = {
      schemaVersion: 1,
      operation: "import",
      migrationId,
      sourceDigest,
      rows: [source[0]],
    };
    expect((await execute(input)).status).toBe(200);
    expect((await execute({ ...input, rows: source })).status).toBe(200);
    expect(
      (await execute({ ...input, operation: "readback", rows: source })).status,
    ).toBe(200);
    const snapshot = await readRegisteredMatchPresentations(
      env,
      inviteId,
      inviteId,
    );
    expect(snapshot.players.host).toMatchObject({
      emojiId: 1000,
      aura: "rainbow",
      revision: 1,
    });
    expect(snapshot.players.guest).toMatchObject({ emojiId: 2, revision: 0 });
    expect(
      (await room.getFrozenPresentationSnapshot(inviteId)).players.host,
    ).toEqual(snapshot.players.host);
    expect(
      (await room.updatePresentation("host", inviteId, operation)).status,
    ).toBe("duplicate");
  });

  it("does not register conflicting seed evidence and cannot import after activation", async () => {
    const inviteId = `migration-${crypto.randomUUID()}`;
    const source = await rows(inviteId);
    const input: MatchPresentationMigrationRequest = {
      schemaVersion: 1,
      operation: "import",
      migrationId,
      sourceDigest,
      rows: source,
    };
    expect((await execute(input)).status).toBe(200);
    const changed = { ...source[0], emojiId: 3 };
    changed.seedDigest = await matchPresentationSeedDigest(changed);
    expect((await execute({ ...input, rows: [changed] })).status).toBe(503);
    expect(
      (await readRegisteredMatchPresentations(env, inviteId, inviteId)).players
        .host.emojiId,
    ).toBe(1);
    await runtime.PROFILE_GAMES_DB.prepare(
      "UPDATE match_presentation_control SET phase = 'durable', verification_digest = ?, verified_at_ms = 1, activated_at_ms = 2 WHERE singleton = 1",
    )
      .bind("b".repeat(64))
      .run();
    expect((await execute(input)).status).toBe(410);
    expect((await execute({ ...input, operation: "readback" })).status).toBe(
      410,
    );
    await expect(
      runtime.PROFILE_GAMES_DB.prepare(
        "UPDATE match_presentation_control SET phase = 'capture' WHERE singleton = 1",
      ).run(),
    ).rejects.toThrow("match-presentation-authority-conflict");
  });
});
