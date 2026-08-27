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
    uid: "firebase-uid",
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
    uid: "firebase-uid",
    updatedAtMs: 1_000_000,
    xUserId: null,
    xUsername: null,
    ...overrides,
  };
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
      uid: "firebase-uid",
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

  it("fails closed on malformed rows and binding failures", async () => {
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

    const failingDb = {
      batch: async () => [],
      dump: async () => new ArrayBuffer(0),
      exec: async () => {
        throw new Error("private-binding-detail");
      },
      prepare: () => {
        throw new Error("private-binding-detail");
      },
      withSession: () => {
        throw new Error("private-binding-detail");
      },
    } satisfies D1Database;
    await expect(
      createAuthStateRepository(failingDb).getAuthIntent("intent"),
    ).rejects.toBeInstanceOf(AuthStateFailure);
  });

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
});
