import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker, { handleFetch, handleScheduled } from "../src/workerHandler.ts";
import { InviteReactions } from "../src/inviteReactions.ts";
import { createTelegramBridgeSignature } from "../src/telegramBridgeAuth.ts";
import { D1_MIGRATION_BINDINGS } from "../src/d1MigrationControl.ts";
import { verifyD1MigrationDatabase } from "../src/d1MigrationDatabase.ts";
import { TELEGRAM_TEST_ENV } from "../test/testEnv.ts";

const runId = "migration-runtime-test";
const versionId = "11111111-1111-4111-8111-111111111111";
const otherVersion = "22222222-2222-4222-8222-222222222222";

function maintenanceEnv(base: Env = env): Env {
  const result = { ...base };
  Object.assign(result, {
    API_MAINTENANCE: "true",
    D1_MIGRATION_RUN_ID: runId,
    CF_VERSION_METADATA: {
      id: versionId,
      tag: "test",
      timestamp: "2026-09-12T00:00:00.000Z",
    },
    TELEGRAM_QUEUE_BRIDGE_SECRET: "migration-test-secret",
  });
  return result;
}

function noDatabaseEnv(): Env {
  return new Proxy(maintenanceEnv(), {
    get(target, property) {
      if (
        (D1_MIGRATION_BINDINGS as readonly string[]).includes(String(property))
      )
        throw new Error("unexpected-database-access");
      return Reflect.get(target, property);
    },
  });
}

async function command(
  input: Record<string, unknown>,
  options: { signature?: string; timestamp?: string } = {},
) {
  const body = JSON.stringify({
    schemaVersion: 1,
    kind: "d1-migration",
    runId,
    ...input,
  });
  const timestamp = options.timestamp || String(Math.floor(Date.now() / 1000));
  return new Request("https://api.mons.link/internal/d1-migration", {
    method: "POST",
    headers: {
      "X-Mons-Telegram-Timestamp": timestamp,
      "X-Mons-Telegram-Signature":
        options.signature ||
        (await createTelegramBridgeSignature(
          body,
          "migration-test-secret",
          timestamp,
        )),
    },
    body,
  });
}

beforeAll(async () => {
  const testEnv = env as Env & { TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(
    env.AUTH_STATE_DB,
    testEnv.TEST_AUTH_STATE_D1_MIGRATIONS,
  );
});

describe("full API maintenance", () => {
  it("blocks every HTTP route before accessing storage", async () => {
    for (const path of [
      "/sessions/anonymous",
      "/sessions/refresh",
      "/sessions/logout",
      "/matches/snapshot",
      "/auth/x/callback",
      "/internal/telegram/command",
      "/internal/telegram/delivery",
      "/unrecognized",
    ]) {
      const response = await handleFetch(
        new Request(`https://api.mons.link${path}`),
        noDatabaseEnv(),
        {} as ExecutionContext,
      );
      expect(response.status, path).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(await response.json()).toMatchObject({
        message: "api-maintenance",
        runId,
        versionId,
      });
    }
  });

  it("skips all Cron tasks and retries all five Queues without inspecting their payloads", async () => {
    const task = vi.fn(async () => {
      throw new Error("unexpected-task");
    });
    await handleScheduled(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} },
      noDatabaseEnv(),
      {
        authRecovery: task,
        authState: task,
        eventProgress: task,
        eventTransitions: task,
        gameSessionLocks: task,
        gameSessionReceipts: task,
        gameSessionTransitions: task,
        matchTimerStarts: task,
        profileGameProjection: task,
        telegramProjection: task,
      },
    );
    expect(task).not.toHaveBeenCalled();
    for (const queue of [
      "mons-link-auth-recovery",
      "mons-link-profile-game-projection",
      "mons-link-telegram-projection",
      "mons-link-telegram-delivery",
      "mons-link-wager-settlement",
    ]) {
      const ack = vi.fn();
      const retry = vi.fn();
      await worker.queue(
        {
          queue,
          messages: [
            {
              id: "message",
              timestamp: new Date(),
              attempts: 1,
              body: { kind: "wager-settlement" },
              ack,
              retry,
            },
          ],
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          ackAll: vi.fn(),
          retryAll: vi.fn(),
        },
        noDatabaseEnv(),
      );
      expect(ack, queue).not.toHaveBeenCalled();
      expect(retry, queue).toHaveBeenCalledExactlyOnceWith({
        delaySeconds: 300,
      });
    }
  });

  it("requires signed, version-pinned, run-matched allowlisted commands", async () => {
    for (const [request, expected] of [
      [
        await command(
          { operation: "status", binding: "AUTH_STATE_DB" },
          { signature: "invalid" },
        ),
        401,
      ],
      [
        await command(
          { operation: "status", binding: "AUTH_STATE_DB" },
          { timestamp: "1000000000" },
        ),
        401,
      ],
      [
        await command({
          operation: "status",
          binding: "AUTH_STATE_DB",
          runId: "other-run",
        }),
        409,
      ],
      [
        await command({
          operation: "status",
          binding: "AUTH_STATE_DB",
          expectedVersionId: otherVersion,
        }),
        409,
      ],
      [
        await command({
          operation: "status",
          binding: "AUTH_STATE_DB",
          sql: "DELETE FROM anonymous_sessions",
        }),
        400,
      ],
      [
        await command({
          operation: "fence",
          binding: "AUTH_STATE_DB",
          schemaDigest: "a".repeat(64),
        }),
        400,
      ],
      [await command({ operation: "status", binding: "unknown" }), 400],
      [await command({ operation: "status", bookmark: "token" }), 400],
      [
        await command({
          operation: "verify",
          expectedVersionId: versionId,
          bookmark: "",
        }),
        400,
      ],
      [
        await command({
          operation: "verify",
          expectedVersionId: versionId,
          bookmark: "x".repeat(4097),
        }),
        400,
      ],
    ] as const) {
      const result = await handleFetch(
        request,
        noDatabaseEnv(),
        {} as ExecutionContext,
      );
      expect(result.status).toBe(expected);
    }
    const disabled = await handleFetch(
      await command({ operation: "status" }),
      env,
      {} as ExecutionContext,
    );
    expect(disabled.status).toBe(409);
    const accepted = await handleFetch(
      await command({
        operation: "verify",
        binding: "AUTH_STATE_DB",
        expectedVersionId: versionId,
      }),
      maintenanceEnv(),
      {} as ExecutionContext,
    );
    expect(
      (await verifyD1MigrationDatabase(env.AUTH_STATE_DB, "AUTH_STATE_DB"))
        .valid,
    ).toBe(true);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      runId,
      versionId,
      databases: [
        {
          binding: "AUTH_STATE_DB",
          valid: true,
          foreignKeyViolations: 0,
          bookmarkAccepted: true,
        },
      ],
    });
  });

  it("resolves a single safe invite name for a version-pinned barrier", async () => {
    for (const target of [
      {},
      { objectId: "a".repeat(64), inviteId: "migration-rehearsal" },
      { inviteId: "unsafe/path" },
      { inviteId: " padded" },
      { inviteId: "" },
    ]) {
      const result = await handleFetch(
        await command({
          operation: "barrier",
          expectedVersionId: versionId,
          ...target,
        }),
        noDatabaseEnv(),
        {} as ExecutionContext,
      );
      expect(result.status).toBe(400);
    }
    const environment = maintenanceEnv();
    const objectId = "a".repeat(64);
    const idFromName = vi.fn(() => ({ toString: () => objectId }));
    const maintenanceBarrier = vi.fn(async () => ({
      runId,
      versionId,
      objectId,
      source: { status: "empty", inviteId: null },
    }));
    Reflect.set(environment, "INVITE_REACTIONS", {
      idFromName,
      get: () => ({ maintenanceBarrier }),
    });
    const result = await handleFetch(
      await command({
        operation: "barrier",
        expectedVersionId: versionId,
        inviteId: "migration-rehearsal",
      }),
      environment,
      {} as ExecutionContext,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ objectId, runId, versionId });
    expect(idFromName).toHaveBeenCalledExactlyOnceWith("migration-rehearsal");
    expect(maintenanceBarrier).toHaveBeenCalledExactlyOnceWith({
      runId,
      expectedVersionId: versionId,
    });
  });
});

describe("Durable Object migration barrier", () => {
  it("blocks canonical and presentation mutations and preserves pending effects across alarms", async () => {
    const room = env.INVITE_REACTIONS.getByName(
      `migration-${crypto.randomUUID()}`,
    );
    await runInDurableObject(room, async (_existing, ctx) => {
      const config = maintenanceEnv();
      const instance = new InviteReactions(ctx, config);
      ctx.storage.sql.exec(
        "INSERT INTO match_state_source(singleton, invite_id, active_epoch) VALUES (1, 'migration-invite', 2)",
      );
      ctx.storage.sql.exec(
        "INSERT INTO match_state_effects(effect_id, payload_json, next_at_ms, attempts) VALUES ('effect', '{}', 1, 3)",
      );
      const mutation = {
        inviteId: "migration-invite",
        epoch: 2,
        matchId: "migration-invite",
        playerId: "host-login",
      };
      for (const method of [
        "readCanonicalMatchRecord",
        "readCanonicalMatchPair",
        "createCanonicalMatch",
        "submitCanonicalMove",
        "surrenderCanonicalMatch",
        "startCanonicalMatchTimer",
        "claimCanonicalMatchTimer",
        "applyCanonicalMatchEventEffects",
      ]) {
        const result = await Reflect.apply(
          Reflect.get(instance, method),
          instance,
          [null],
        );
        expect(result, method).toMatchObject({
          ok: false,
          status: 503,
          message: "api-maintenance",
        });
      }
      for (const method of [
        "readMetadata",
        "readWagers",
        "readMatches",
        "notifyMatchesChanged",
        "notifyMetadataChanged",
        "notifyWagersChanged",
        "publish",
        "ensurePresentations",
        "getPresentationSnapshot",
        "registerPresentationSeeds",
        "getRegisteredPresentationSnapshot",
        "getFrozenPresentationSnapshot",
        "freezeRegisteredPresentations",
        "freezePresentations",
        "updatePresentation",
      ]) {
        await expect(
          Reflect.apply(Reflect.get(instance, method), instance, []),
        ).rejects.toThrow("api-maintenance");
      }
      expect(
        await instance.submitCanonicalMove({
          ...mutation,
          fen: "invalid",
          previousFlatMovesString: "",
          flatMovesString: "invalid",
        }),
      ).toMatchObject({ ok: false, status: 503, message: "api-maintenance" });
      expect(
        await instance.createCanonicalMatch({
          inviteId: mutation.inviteId,
          epoch: 2,
          records: [],
        }),
      ).toMatchObject({ ok: false, status: 503 });
      await expect(
        instance.publish("host-login", {
          uuid: crypto.randomUUID(),
          kind: "yo",
          variation: 1,
          matchId: mutation.matchId,
        }),
      ).rejects.toThrow("api-maintenance");
      await expect(
        instance.ensurePresentations(mutation.matchId, {}),
      ).rejects.toThrow("api-maintenance");
      await expect(instance.readMetadata(mutation.inviteId)).rejects.toThrow(
        "api-maintenance",
      );
      const upgrade = await instance.fetch(
        new Request("https://reactions.internal/socket", {
          headers: { Upgrade: "websocket" },
        }),
      );
      expect(upgrade.status).toBe(503);
      await expect(
        instance.maintenanceBarrier({ runId, expectedVersionId: otherVersion }),
      ).rejects.toThrow("d1-migration-version-conflict");
      const before = await instance.maintenanceBarrier({
        runId,
        expectedVersionId: versionId,
      });
      await instance.alarm();
      const after = await instance.maintenanceBarrier({
        runId,
        expectedVersionId: versionId,
      });
      expect(after).toMatchObject({
        source: { epoch: 2 },
        pendingEffects: 1,
        nextEffectAt: 1,
        canonicalDigest: before.canonicalDigest,
        effectDigest: before.effectDigest,
      });
      expect(after.alarmAt).toBeGreaterThan(Date.now());
      expect(
        ctx.storage.sql
          .exec("SELECT attempts, completed_at_ms FROM match_state_effects")
          .toArray(),
      ).toEqual([{ attempts: 3, completed_at_ms: null }]);
    });
  });

  it("waits for already admitted reads before acknowledging the storage barrier", async () => {
    const inviteId = `migration-drain-${crypto.randomUUID()}`;
    const room = env.INVITE_REACTIONS.getByName(inviteId);
    await runInDurableObject(room, async (_existing, ctx) => {
      const config = maintenanceEnv(TELEGRAM_TEST_ENV as Env);
      Object.assign(config, { API_MAINTENANCE: "false" });
      const instance = new InviteReactions(ctx, config);
      let release!: (value: unknown) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const source = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      Reflect.set(instance, "inviteReader", () => {
        entered();
        return source;
      });
      const reading = instance.readMetadata(inviteId);
      await started;
      Object.assign(config, { API_MAINTENANCE: "true" });
      let acknowledged = false;
      const barrier = instance
        .maintenanceBarrier({ runId, expectedVersionId: versionId })
        .then((result) => {
          acknowledged = true;
          return result;
        });
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      release({ hostId: "host-login", guestId: "guest-login" });
      await reading;
      const result = await barrier;
      expect(acknowledged).toBe(true);
      expect(result.canonicalDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.versionId).toBe(versionId);
    });
  });
});
