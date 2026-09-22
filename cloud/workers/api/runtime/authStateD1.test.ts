import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  AUTH_STATE_NONTERMINAL_RETENTION_MS,
  AUTH_STATE_TERMINAL_RETENTION_MS,
  AuthStateConflict,
  AuthStateFailure,
  createAuthStateRepository,
  decodeFlow,
  decodeIntent,
  sweepExpiredAuthState,
  type AuthIntentDocument,
  type XRedirectFlowDocument,
} from "../src/authStateD1.ts";

const testEnv = env as Env & {
  TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[];
};

function failingDatabase(error: Error): D1Database {
  const fail = async () => {
    throw error;
  };
  const statement: D1PreparedStatement = {
    bind: () => statement,
    first: fail,
    run: fail,
    all: fail,
    raw: fail,
  };
  return {
    batch: fail,
    dump: fail,
    exec: fail,
    prepare: () => statement,
    withSession: () => {
      throw error;
    },
  };
}

function authIntent(
  overrides: Partial<AuthIntentDocument> = {},
): AuthIntentDocument {
  return {
    consumedAtMs: null,
    createdAtMs: 1_000_000,
    expiresAtMs: 1_300_000,
    intentId: "abcdefghijklmnopqrstuvwx",
    method: "x",
    nonce: "nonce",
    state: "state",
    uid: "login-uid",
    ...overrides,
  };
}

function xFlow(
  overrides: Partial<XRedirectFlowDocument> = {},
): XRedirectFlowDocument {
  return {
    callbackUri: "https://api.mons.link/auth/x/callback",
    codeChallenge: "challenge",
    codeVerifier: "verifier",
    consentSource: "signin",
    createdAtMs: 1_000_000,
    errorCode: null,
    expiresAtMs: 1_300_000,
    flowId: "zyxwvutsrqponmlkjihgfedc",
    intentId: "abcdefghijklmnopqrstuvwx",
    method: "x",
    returnUrl: "https://mons.link/",
    status: "created",
    uid: "login-uid",
    updatedAtMs: 1_000_000,
    xUserId: null,
    xUsername: null,
    ...overrides,
  };
}

type CleanupCounter = keyof Awaited<ReturnType<typeof sweepExpiredAuthState>>;

async function seedCleanupBacklog(counter: CleanupCounter, nowMs: number) {
  const db = testEnv.AUTH_STATE_DB;
  const statements = [
    db
      .prepare(
        `WITH RECURSIVE items(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM items WHERE n < 1003
         )
         INSERT INTO auth_intents (
           intent_id, uid, method, nonce, state, created_at_ms,
           expires_at_ms, consumed_at_ms, consumed_by_op_id
         )
         SELECT printf('cleanup-%04d', n), 'login-uid', 'x',
                CASE WHEN ? OR n % 2 = 0 THEN 'retired' ELSE 'nonce' END,
                CASE WHEN ? OR n % 2 = 1 THEN 'retired' ELSE 'state' END,
                1, ? - CASE WHEN n = 1003 THEN 2 ELSE 1 END,
                1, 'operation-1'
         FROM items`,
      )
      .bind(
        counter === "flowsCompacted" ? 1 : 0,
        counter === "flowsCompacted" ? 1 : 0,
        nowMs - AUTH_STATE_NONTERMINAL_RETENTION_MS,
      ),
  ];
  if (counter !== "intentsDeleted") {
    statements.push(
      db
        .prepare(
          `INSERT INTO x_redirect_flows (
             flow_id, intent_id, uid, method, callback_uri, code_challenge,
             code_verifier, consent_source, return_url, status,
             result_profile_id, result_op_id, created_at_ms, expires_at_ms,
             updated_at_ms, revision
           )
           SELECT intent_id, intent_id, uid, 'x',
                  'https://api.mons.link/auth/x/callback',
                  CASE WHEN ? OR CAST(substr(intent_id, -4) AS INTEGER) % 2 = 0
                       THEN 'retired' ELSE 'challenge' END,
                  CASE WHEN ? OR CAST(substr(intent_id, -4) AS INTEGER) % 2 = 1
                       THEN 'retired' ELSE 'verifier' END,
                  'signin', 'https://mons.link/', ?, 'profile-1', 'operation-1',
                  created_at_ms, expires_at_ms,
                  ? - CASE WHEN intent_id = 'cleanup-1003' THEN 2 ELSE 1 END,
                  4
           FROM auth_intents`,
        )
        .bind(
          counter === "intentsCompacted" ? 1 : 0,
          counter === "intentsCompacted" ? 1 : 0,
          counter === "flowsDeleted" ? "created" : "completed",
          counter === "terminalFlowsDeleted"
            ? nowMs - AUTH_STATE_TERMINAL_RETENTION_MS
            : nowMs,
        ),
    );
  }
  await db.batch(statements);
}

describe("auth state D1 repository", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.AUTH_STATE_DB,
      testEnv.TEST_AUTH_STATE_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.AUTH_STATE_DB.batch([
      testEnv.AUTH_STATE_DB.prepare("DELETE FROM x_redirect_flows"),
      testEnv.AUTH_STATE_DB.prepare("DELETE FROM auth_intents"),
    ]);
  });

  it("indexes scheduled cleanup predicates", async () => {
    const indexes = await testEnv.AUTH_STATE_DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'index'
         AND name IN (
           'idx_auth_intents_uncompacted_expires',
           'idx_x_redirect_flows_terminal_updated',
           'idx_x_redirect_flows_uncompacted_expires'
         )
       ORDER BY name`,
    ).all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual([
      "idx_auth_intents_uncompacted_expires",
      "idx_x_redirect_flows_terminal_updated",
      "idx_x_redirect_flows_uncompacted_expires",
    ]);
  });

  it("creates and reads exact intents while bounding ID collisions", async () => {
    const repository = createAuthStateRepository(testEnv.AUTH_STATE_DB);
    const document = authIntent();
    await expect(repository.createAuthIntent(document)).resolves.toBe(
      "created",
    );
    await expect(repository.createAuthIntent(document)).resolves.toBe("exists");
    await expect(repository.getAuthIntent(document.intentId)).resolves.toEqual({
      ...document,
      consumedAtMs: 0,
      consumedByOpId: "",
    });
    await expect(
      repository.getAuthIntent("missing-intent"),
    ).resolves.toBeNull();
  });

  it("consumes an intent once under concurrent updates and retains replay identity", async () => {
    const repository = createAuthStateRepository(testEnv.AUTH_STATE_DB);
    await repository.createAuthIntent(authIntent({ method: "sol" }));
    const input = {
      consumedAtMs: 1_100_000,
      consumedByOpId: "intent:abcdefghijklmnopqrstuvwx",
      intentId: "abcdefghijklmnopqrstuvwx",
      method: "sol" as const,
      uid: "login-uid",
    };
    const outcomes = await Promise.all([
      repository.consumeAuthIntent(input),
      repository.consumeAuthIntent(input),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await repository.getAuthIntent(input.intentId)).toMatchObject({
      consumedAtMs: input.consumedAtMs,
      consumedByOpId: input.consumedByOpId,
    });
    await expect(
      repository.consumeAuthIntent({ ...input, uid: "other-user" }),
    ).resolves.toBe(false);
  });

  it("creates X flows and applies revision-fenced state transitions", async () => {
    const repository = createAuthStateRepository(testEnv.AUTH_STATE_DB);
    await repository.createAuthIntent(authIntent());
    const document = xFlow();
    await expect(repository.createXFlow(document)).resolves.toBe("created");
    await expect(repository.createXFlow(document)).resolves.toBe("exists");
    const created = await repository.getXFlow(document.flowId);
    expect(created).toMatchObject({
      ...document,
      completedAtMs: 0,
      errorCode: "",
      processingStartedAtMs: 0,
      result: null,
      revision: 1,
      xUserId: "",
      xUsername: "",
    });

    await expect(
      repository.updateXFlow(
        document.flowId,
        {
          status: "processing",
          processingStartedAtMs: 1_010_000,
          updatedAtMs: 1_010_000,
        },
        1,
      ),
    ).resolves.toBe(2);
    await expect(
      repository.updateXFlow(
        document.flowId,
        { status: "failed", updatedAtMs: 1_020_000 },
        1,
      ),
    ).rejects.toBeInstanceOf(AuthStateConflict);
    await expect(
      repository.updateXFlow(
        document.flowId,
        {
          status: "verified",
          processingStartedAtMs: null,
          xUserId: "2244994945",
          xUsername: "mons",
          updatedAtMs: 1_020_000,
        },
        2,
      ),
    ).resolves.toBe(3);
    await expect(
      repository.updateXFlow(
        document.flowId,
        {
          status: "completed",
          completedAtMs: 1_030_000,
          result: { profileId: "profile-1", opId: "operation-1" },
          updatedAtMs: 1_030_000,
        },
        3,
      ),
    ).resolves.toBe(4);
    await expect(repository.getXFlow(document.flowId)).resolves.toMatchObject({
      completedAtMs: 1_030_000,
      processingStartedAtMs: 0,
      result: { profileId: "profile-1", opId: "operation-1" },
      revision: 4,
      status: "completed",
      xUserId: "2244994945",
      xUsername: "mons",
    });
  });

  it("fails closed on malformed rows", () => {
    expect(() =>
      decodeIntent({
        consumed_at_ms: null,
        consumed_by_op_id: null,
        created_at_ms: 1,
        expires_at_ms: 2,
        intent_id: "intent",
        method: "invalid",
        nonce: "nonce",
        state: "state",
        uid: "uid",
      } as never),
    ).toThrow(AuthStateFailure);
    expect(() =>
      decodeFlow({
        flow_id: "flow",
        method: "x",
        result_profile_id: "profile",
        result_op_id: null,
      } as never),
    ).toThrow(AuthStateFailure);
  });

  it.each([
    [
      "intent read",
      (db: D1Database) => createAuthStateRepository(db).getAuthIntent("intent"),
    ],
    [
      "flow read",
      (db: D1Database) => createAuthStateRepository(db).getXFlow("flow"),
    ],
    [
      "intent creation",
      (db: D1Database) =>
        createAuthStateRepository(db).createAuthIntent(authIntent()),
    ],
    [
      "flow creation",
      (db: D1Database) => createAuthStateRepository(db).createXFlow(xFlow()),
    ],
    [
      "intent consumption",
      (db: D1Database) =>
        createAuthStateRepository(db).consumeAuthIntent({
          consumedAtMs: 1_100_000,
          consumedByOpId: "operation-1",
          intentId: "intent",
          method: "x",
          uid: "login-uid",
        }),
    ],
    [
      "flow update",
      (db: D1Database) =>
        createAuthStateRepository(db).updateXFlow(
          "flow",
          { status: "processing" },
          1,
        ),
    ],
    [
      "expiry sweep",
      (db: D1Database) =>
        sweepExpiredAuthState(db, AUTH_STATE_NONTERMINAL_RETENTION_MS + 1),
    ],
  ] as const)(
    "preserves the original failure through %s",
    async (_, operation) => {
      const cause = new Error("private-binding-detail");
      const failure: unknown = await operation(failingDatabase(cause)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AuthStateFailure);
      expect(failure).toHaveProperty("message", "auth-state-unavailable");
      expect(failure instanceof Error && failure.cause).toBe(cause);

      for (const domainFailure of [
        new AuthStateFailure({ cause }),
        new AuthStateConflict({ cause }),
      ]) {
        await expect(operation(failingDatabase(domainFailure))).rejects.toBe(
          domainFailure,
        );
      }
    },
  );

  it("removes expired nonterminal state without deleting terminal replays", async () => {
    const repository = createAuthStateRepository(testEnv.AUTH_STATE_DB);
    await repository.createAuthIntent(authIntent());
    await repository.createXFlow(xFlow());
    await repository.createAuthIntent(
      authIntent({ intentId: "orphaned-intent-12345678", method: "eth" }),
    );
    await repository.createAuthIntent(
      authIntent({ intentId: "terminal-intent-12345678" }),
    );
    await repository.createXFlow(
      xFlow({
        flowId: "terminal-flow-1234567890",
        intentId: "terminal-intent-12345678",
      }),
    );
    await repository.updateXFlow(
      "terminal-flow-1234567890",
      {
        completedAtMs: 1_200_000,
        result: { profileId: "profile-1", opId: "operation-1" },
        status: "completed",
        updatedAtMs: 1_200_000,
      },
      1,
    );
    await repository.createAuthIntent(
      authIntent({ intentId: "verified-intent-12345678" }),
    );
    await repository.createXFlow(
      xFlow({
        flowId: "verified-flow-1234567890",
        intentId: "verified-intent-12345678",
      }),
    );
    await repository.updateXFlow(
      "verified-flow-1234567890",
      {
        processingStartedAtMs: null,
        status: "verified",
        updatedAtMs: 1_200_000,
        xUserId: "2244994945",
      },
      1,
    );

    await expect(
      sweepExpiredAuthState(
        testEnv.AUTH_STATE_DB,
        1_300_000 + AUTH_STATE_NONTERMINAL_RETENTION_MS + 1,
      ),
    ).resolves.toEqual({
      flowsCompacted: 2,
      flowsDeleted: 1,
      intentsCompacted: 2,
      intentsDeleted: 2,
      terminalFlowsDeleted: 0,
    });
    await expect(
      repository.getXFlow("terminal-flow-1234567890"),
    ).resolves.toMatchObject({
      codeChallenge: "retired",
      codeVerifier: "retired",
      status: "completed",
    });
    await expect(
      repository.getAuthIntent("terminal-intent-12345678"),
    ).resolves.not.toBeNull();
    await expect(
      repository.getXFlow("verified-flow-1234567890"),
    ).resolves.toMatchObject({
      codeChallenge: "retired",
      codeVerifier: "retired",
      status: "verified",
    });
    await expect(
      repository.getAuthIntent("verified-intent-12345678"),
    ).resolves.toMatchObject({ nonce: "retired", state: "retired" });

    await expect(
      sweepExpiredAuthState(
        testEnv.AUTH_STATE_DB,
        1_200_000 + AUTH_STATE_TERMINAL_RETENTION_MS + 1,
      ),
    ).resolves.toMatchObject({ terminalFlowsDeleted: 2 });
    await expect(
      repository.getXFlow("terminal-flow-1234567890"),
    ).resolves.toBeNull();
    await expect(
      repository.getXFlow("verified-flow-1234567890"),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "flowsDeleted",
      "SELECT flow_id AS id FROM x_redirect_flows ORDER BY flow_id",
    ],
    [
      "terminalFlowsDeleted",
      "SELECT flow_id AS id FROM x_redirect_flows ORDER BY flow_id",
    ],
    [
      "intentsDeleted",
      "SELECT intent_id AS id FROM auth_intents ORDER BY intent_id",
    ],
    [
      "flowsCompacted",
      `SELECT flow_id AS id FROM x_redirect_flows
       WHERE code_challenge <> 'retired' OR code_verifier <> 'retired'
       ORDER BY flow_id`,
    ],
    [
      "intentsCompacted",
      `SELECT intent_id AS id FROM auth_intents
       WHERE nonce <> 'retired' OR state <> 'retired'
       ORDER BY intent_id`,
    ],
  ] as const)(
    "bounds %s and progresses oldest records first",
    async (counter, pendingSql) => {
      const db = testEnv.AUTH_STATE_DB;
      const nowMs = AUTH_STATE_TERMINAL_RETENTION_MS + 10_000_000;
      await seedCleanupBacklog(counter, nowMs);
      const repository = createAuthStateRepository(db);
      const beforeFlow = await repository.getXFlow("cleanup-0001");
      const beforeIntent = await repository.getAuthIntent("cleanup-0001");
      const first = await sweepExpiredAuthState(db, nowMs);
      expect(first[counter]).toBe(1_000);
      expect(Object.values(first).every((count) => count <= 1_000)).toBe(true);
      expect(
        (await db.prepare(pendingSql).all<{ id: string }>()).results,
      ).toEqual([
        { id: "cleanup-1000" },
        { id: "cleanup-1001" },
        { id: "cleanup-1002" },
      ]);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
      if (counter === "flowsCompacted" || counter === "intentsCompacted") {
        expect(await repository.getXFlow("cleanup-0001")).toEqual({
          ...beforeFlow,
          codeChallenge: "retired",
          codeVerifier: "retired",
        });
        expect(await repository.getAuthIntent("cleanup-0001")).toEqual({
          ...beforeIntent,
          nonce: "retired",
          state: "retired",
        });
      }
      expect((await sweepExpiredAuthState(db, nowMs))[counter]).toBe(3);
      expect((await db.prepare(pendingSql).all()).results).toEqual([]);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
      expect(await sweepExpiredAuthState(db, nowMs)).toEqual({
        flowsCompacted: 0,
        flowsDeleted: 0,
        intentsCompacted: 0,
        intentsDeleted: 0,
        terminalFlowsDeleted: 0,
      });
    },
  );

  it.each([-1, 0, 1])(
    "preserves expiry eligibility at cutoff offset %i",
    async (offsetMs) => {
      const db = testEnv.AUTH_STATE_DB;
      const repository = createAuthStateRepository(db);
      const nowMs = AUTH_STATE_TERMINAL_RETENTION_MS + 10_000_000;
      const expiresAtMs =
        nowMs - AUTH_STATE_NONTERMINAL_RETENTION_MS + offsetMs;
      const statuses = [
        "created",
        "processing",
        "verified",
        "completed",
        "failed",
      ] as const;
      for (const status of statuses) {
        await repository.createAuthIntent(
          authIntent({ intentId: status, expiresAtMs }),
        );
        await repository.createXFlow(
          xFlow({ flowId: status, intentId: status, expiresAtMs }),
        );
        await repository.updateXFlow(status, { status, updatedAtMs: nowMs }, 1);
      }
      await repository.createAuthIntent(
        authIntent({ intentId: "orphan", expiresAtMs }),
      );
      await repository.createAuthIntent(
        authIntent({ intentId: "protected", expiresAtMs: 1_300_000 }),
      );
      await repository.createXFlow(
        xFlow({
          flowId: "protected",
          intentId: "protected",
          expiresAtMs: nowMs + 1,
        }),
      );
      const before = await Promise.all(
        statuses.map(async (status) => ({
          flow: await repository.getXFlow(status),
          intent: await repository.getAuthIntent(status),
        })),
      );

      expect(await sweepExpiredAuthState(db, nowMs)).toEqual({
        flowsCompacted: offsetMs < 0 ? 3 : 0,
        flowsDeleted: offsetMs < 0 ? 2 : 0,
        intentsCompacted: offsetMs < 0 ? 3 : 0,
        intentsDeleted: offsetMs < 0 ? 3 : 0,
        terminalFlowsDeleted: 0,
      });
      for (const [index, status] of statuses.entries()) {
        const deleted =
          offsetMs < 0 && (status === "created" || status === "processing");
        expect(await repository.getXFlow(status)).toEqual(
          deleted
            ? null
            : {
                ...before[index].flow,
                ...(offsetMs < 0
                  ? { codeChallenge: "retired", codeVerifier: "retired" }
                  : {}),
              },
        );
        expect(await repository.getAuthIntent(status)).toEqual(
          deleted
            ? null
            : {
                ...before[index].intent,
                ...(offsetMs < 0 ? { nonce: "retired", state: "retired" } : {}),
              },
        );
      }
      expect(await repository.getAuthIntent("protected")).toMatchObject({
        nonce: "nonce",
        state: "state",
      });
      expect(await repository.getXFlow("protected")).toMatchObject({
        status: "created",
        codeChallenge: "challenge",
        codeVerifier: "verifier",
      });
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );

  it.each([-1, 0, 1])(
    "preserves terminal retention at cutoff offset %i",
    async (offsetMs) => {
      const db = testEnv.AUTH_STATE_DB;
      const repository = createAuthStateRepository(db);
      const nowMs = AUTH_STATE_TERMINAL_RETENTION_MS + 10_000_000;
      for (const status of ["verified", "completed", "failed"] as const) {
        await repository.createAuthIntent(
          authIntent({ intentId: status, expiresAtMs: nowMs + 1 }),
        );
        await repository.createXFlow(
          xFlow({ flowId: status, intentId: status, expiresAtMs: nowMs + 1 }),
        );
        await repository.updateXFlow(
          status,
          {
            status,
            updatedAtMs: nowMs - AUTH_STATE_TERMINAL_RETENTION_MS + offsetMs,
          },
          1,
        );
      }
      expect(await sweepExpiredAuthState(db, nowMs)).toEqual({
        flowsCompacted: 0,
        flowsDeleted: 0,
        intentsCompacted: 0,
        intentsDeleted: 0,
        terminalFlowsDeleted: offsetMs < 0 ? 3 : 0,
      });
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM x_redirect_flows")
          .first("count"),
      ).toBe(offsetMs < 0 ? 0 : 3);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM auth_intents")
          .first("count"),
      ).toBe(3);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );
});
