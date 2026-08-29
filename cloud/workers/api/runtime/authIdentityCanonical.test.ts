import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { USERNAME_MAX_LENGTH } from "@mons/shared/usernames";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthIdentityService } from "../src/authIdentity.ts";
import { sweepExpiredCanonicalAuthCooldowns } from "../src/authIdentityCanonical.ts";
import { createMiningRepository } from "../src/miningRepository.ts";
import { createAuthRecoveryService } from "../src/authRecovery.ts";
import { createProfileCustomizationRepository } from "../src/profileCustomizationRepository.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalAuthOperation,
  readCanonicalMergeTarget,
  readCanonicalProfile,
  readCanonicalProfileAggregate,
  readCanonicalProfileByLogin,
} from "../src/profileCanonicalD1.ts";
import { createConfiguredProfileRepository } from "../src/profileReadRepository.ts";
import { createUsernameRepository } from "../src/usernameRepository.ts";
import { createAuthRepository } from "../src/firestore.ts";
import type { FirebaseAuthAdminClient } from "../src/firebaseAuthAdmin.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";

const testBindings = env as Env & {
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
const d1Env = testBindings;

async function readMergeSourceArchive(
  sourceProfileId: string,
): Promise<Record<string, unknown> | null> {
  const row = await testBindings.PROFILE_DB.prepare(
    `SELECT source_legacy_fields_json
     FROM profile_merge_targets WHERE source_profile_id = ?`,
  )
    .bind(sourceProfileId)
    .first<{ source_legacy_fields_json: string }>();
  if (!row) return null;
  const value = JSON.parse(row.source_legacy_fields_json) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firebaseState() {
  const claims = new Map<string, Record<string, unknown>>();
  const rtdbValues = new Map<string, unknown>();
  const authClient: FirebaseAuthAdminClient = {
    getUser: async (uid) => ({ uid, customClaims: claims.get(uid) || {} }),
    setCustomUserClaims: async (uid, value) => {
      claims.set(uid, value);
    },
  };
  const rtdb: FirebaseRtdbClient = {
    getPath: async (path) => rtdbValues.get(path) ?? null,
    patchRoot: async (updates) => {
      for (const [path, value] of Object.entries(updates)) {
        if (value === null) rtdbValues.delete(path);
        else rtdbValues.set(path, value);
      }
    },
    transactPath: async (path, updater) => {
      const current = rtdbValues.get(path) ?? null;
      const decision = updater(current) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      if (decision.value === null) rtdbValues.delete(path);
      else rtdbValues.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
  };
  return { authClient, claims, rtdb, rtdbValues };
}

function beforeMatchingBatch(
  database: D1Database,
  matches: (queries: readonly string[]) => boolean,
  action: () => Promise<void>,
): D1Database {
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const statementQueries = new WeakMap<object, string>();
  let fired = false;
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(wrapped, statement);
    statementQueries.set(wrapped, query);
    return wrapped;
  };
  return {
    prepare: (query) => wrap(database.prepare(query), query),
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const queries = statements.map(
        (statement) => statementQueries.get(statement) || "",
      );
      if (!fired && matches(queries)) {
        fired = true;
        await action();
      }
      return database.batch<T>(
        statements.map(
          (statement) => nativeStatements.get(statement) || statement,
        ),
      );
    },
    dump: () => database.dump(),
    exec: (query) => database.exec(query),
    withSession: (constraintOrBookmark) =>
      database.withSession(constraintOrBookmark),
  };
}

function failAfterMatchingBatch(
  database: D1Database,
  matches: (queries: readonly string[]) => boolean,
  onFailure: () => void,
): D1Database {
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const statementQueries = new WeakMap<object, string>();
  let fired = false;
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(wrapped, statement);
    statementQueries.set(wrapped, query);
    return wrapped;
  };
  return {
    prepare: (query) => wrap(database.prepare(query), query),
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const queries = statements.map(
        (statement) => statementQueries.get(statement) || "",
      );
      const results = await database.batch<T>(
        statements.map(
          (statement) => nativeStatements.get(statement) || statement,
        ),
      );
      if (!fired && matches(queries)) {
        fired = true;
        onFailure();
        throw new Error("ambiguous-d1-response");
      }
      return results;
    },
    dump: () => database.dump(),
    exec: (query) => database.exec(query),
    withSession: (constraintOrBookmark) =>
      database.withSession(constraintOrBookmark),
  };
}

function observeBatchSizes(database: D1Database, sizes: number[]): D1Database {
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(wrapped, statement);
    return wrapped;
  };
  return {
    prepare: (query) => wrap(database.prepare(query)),
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      sizes.push(statements.length);
      return database.batch<T>(
        statements.map(
          (statement) => nativeStatements.get(statement) || statement,
        ),
      );
    },
    dump: () => database.dump(),
    exec: (query) => database.exec(query),
    withSession: (constraintOrBookmark) =>
      database.withSession(constraintOrBookmark),
  };
}

async function resetCanonicalRows(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rating_updates"),
    db.prepare("DELETE FROM profile_auth_operations"),
    db.prepare("DELETE FROM profile_auth_method_revocations"),
    db.prepare("DELETE FROM profile_auth_method_cooldowns"),
    db.prepare("DROP TRIGGER profile_merge_targets_reject_delete"),
    db.prepare("DROP TRIGGER wager_settlements_reject_delete"),
    db.prepare("DROP TRIGGER profile_records_reject_active_delete"),
    db.prepare("DELETE FROM profile_merge_targets"),
    db.prepare("DELETE FROM wager_settlements"),
    db.prepare("DELETE FROM profile_records"),
    db.prepare(
      `CREATE TRIGGER profile_merge_targets_reject_delete
       BEFORE DELETE ON profile_merge_targets
       BEGIN
         SELECT RAISE(ABORT, 'profile merge mappings are permanent');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER wager_settlements_reject_delete
       BEFORE DELETE ON wager_settlements
       BEGIN
         SELECT RAISE(ABORT, 'wager settlements are permanent');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER profile_records_reject_active_delete
       BEFORE DELETE ON profile_records
       WHEN OLD.state = 'active'
       AND (
         SELECT state FROM profile_canonical_control WHERE singleton = 1
       ) != 'importing'
       BEGIN
         SELECT RAISE(ABORT, 'active profiles cannot be deleted');
       END`,
    ),
  ]);
}

async function setCanonicalUsername(
  profileId: string,
  username: string | null,
  updatedAtMs: number,
): Promise<void> {
  const snapshot = await readCanonicalProfile(
    testBindings.PROFILE_DB,
    profileId,
  );
  if (!snapshot) throw new Error("missing-username-profile");
  await commitCanonicalPlan(testBindings.PROFILE_DB, {
    expectations: [
      {
        kind: "profile-revision",
        profileId,
        revision: snapshot.revision,
      },
    ],
    mutations: [
      {
        kind: "update-active-profile",
        value: materializeCanonicalProfile({
          ...snapshot,
          profile: { ...snapshot.profile, username },
          updatedAtMs,
        }),
      },
    ],
  });
}

describe("canonical auth and profile runtime", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testBindings.PROFILE_DB,
      testBindings.TEST_PROFILE_D1_MIGRATIONS,
    );
    const importDigest = "b".repeat(64);
    await testBindings.PROFILE_DB.batch([
      testBindings.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'importing'
         WHERE singleton = 1 AND state = 'firestore'`,
      ),
      testBindings.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET import_digest = ?, import_plan_version = 1
         WHERE singleton = 1 AND state = 'importing'`,
      ).bind(importDigest),
      testBindings.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'frozen', imported_at_ms = 1
         WHERE singleton = 1 AND state = 'importing'`,
      ),
      testBindings.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'active'
         WHERE singleton = 1 AND state = 'frozen'`,
      ),
    ]);
  });

  beforeEach(async () => {
    await resetCanonicalRows(testBindings.PROFILE_DB);
  });

  it("creates, replays, links, unlinks, and enforces cooldowns in D1", async () => {
    const firebase = firebaseState();
    let nowMs = 1_000;
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const ethInput = {
      uid: "canonical-login",
      method: "eth" as const,
      methodValueRaw: "0x1111111111111111111111111111111111111111",
      normalizedMethodValue: "0x1111111111111111111111111111111111111111",
      intentId: "intent-eth",
      requestEmoji: 7,
      requestAura: "rainbow",
      opId: "operation-eth",
    };
    const first = await service.linkVerifiedMethod(ethInput);
    expect(first.profileId).toBeTruthy();
    expect(first.linkedMethods.eth).toBe(true);
    expect(first).toMatchObject({
      rating: null,
      nonce: null,
      totalManaPoints: null,
      emoji: 7,
    });
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          first.profileId,
        )
      ).profile?.sortPresence,
    ).toEqual({
      rating: false,
      mp: false,
      nonce: false,
      dust: true,
      slime: true,
      gum: true,
      metal: true,
      ice: true,
    });
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          first.profileId,
        )
      ).profile,
    ).toMatchObject({ winPresent: false, emojiPresent: true });
    expect((await service.linkVerifiedMethod(ethInput)).profileId).toBe(
      first.profileId,
    );

    const sparseSnapshot = await readCanonicalProfile(
      testBindings.PROFILE_DB,
      first.profileId,
    );
    expect(sparseSnapshot).not.toBeNull();
    if (!sparseSnapshot) throw new Error("missing sparse profile");
    await commitCanonicalPlan(testBindings.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: sparseSnapshot.profileId,
          revision: sparseSnapshot.revision,
        },
      ],
      mutations: [
        {
          kind: "update-active-profile",
          value: materializeCanonicalProfile({
            profile: sparseSnapshot.profile,
            state: sparseSnapshot.state,
            mergedIntoProfileId: sparseSnapshot.mergedIntoProfileId,
            legacyFields: sparseSnapshot.legacyFields,
            createdAtMs: sparseSnapshot.createdAtMs,
            updatedAtMs: 1_500,
            mergedAtMs: sparseSnapshot.mergedAtMs,
            sortPresence: {
              ...sparseSnapshot.sortPresence,
              rating: true,
              nonce: true,
            },
            sortValues: {
              ...sparseSnapshot.sortValues,
              rating: null,
              nonce: null,
            },
            winPresent: false,
            emojiPresent: false,
            gameplayEmoji: "",
          }),
        },
      ],
    });
    const sparseResponse = await service.linkVerifiedMethod({
      ...ethInput,
      opId: "operation-eth-sparse",
      intentId: "intent-eth-sparse",
    });
    expect(sparseResponse).toMatchObject({
      rating: null,
      nonce: null,
      totalManaPoints: null,
      emoji: 1,
    });
    expect(
      await readCanonicalProfile(testBindings.PROFILE_DB, first.profileId),
    ).toMatchObject({
      sortPresence: { rating: true, nonce: true, mp: false },
      sortValues: { rating: null, nonce: null, mp: null },
      winPresent: false,
      emojiPresent: false,
    });
    await expect(
      createProfileCustomizationRepository(d1Env).updateCustomization(
        ethInput.uid,
        { field: "emojiAndAura", value: { emoji: 9, aura: "" } },
        async () => undefined,
      ),
    ).resolves.toBe("updated");
    expect(
      await readCanonicalProfile(testBindings.PROFILE_DB, first.profileId),
    ).toMatchObject({ profile: { emoji: 9 }, emojiPresent: true });

    nowMs += 1_000;
    const solInput = {
      uid: ethInput.uid,
      method: "sol" as const,
      methodValueRaw: "11111111111111111111111111111111",
      normalizedMethodValue: "11111111111111111111111111111111",
      intentId: "intent-sol",
      requestEmoji: 7,
      requestAura: "rainbow",
      opId: "operation-sol",
    };
    const linked = await service.linkVerifiedMethod(solInput);
    expect(linked.linkedMethods).toMatchObject({ eth: true, sol: true });

    nowMs += 1_000;
    const unlinked = await service.unlinkMethod(
      ethInput.uid,
      "eth",
      "operation-unlink",
    );
    expect(unlinked.linkedMethods).toMatchObject({ eth: false, sol: true });
    await expect(
      service.linkVerifiedMethod({
        ...ethInput,
        opId: "operation-eth-relink",
        intentId: "intent-eth-relink",
      }),
    ).rejects.toThrow("method-reuse-cooldown");
    nowMs += 24 * 60 * 60 * 1_000 + 1;
    await expect(
      sweepExpiredCanonicalAuthCooldowns(testBindings.PROFILE_DB, nowMs),
    ).resolves.toEqual({ cooldowns: 1, revocations: 1 });
    await expect(
      service.linkVerifiedMethod({
        ...ethInput,
        opId: "operation-eth-relinked",
        intentId: "intent-eth-relinked",
      }),
    ).resolves.toMatchObject({ linkedMethods: { eth: true, sol: true } });

    const profile = await readCanonicalProfileByLogin(
      testBindings.PROFILE_DB,
      ethInput.uid,
    );
    expect(profile?.profileId).toBe(first.profileId);
    expect(firebase.claims.get(ethInput.uid)?.profileId).toBe(first.profileId);
    expect(firebase.rtdbValues.get(`players/${ethInput.uid}/profile`)).toBe(
      first.profileId,
    );
  });

  it("refreshes Apple and X linked timestamps on re-verification", async () => {
    const firebase = firebaseState();
    let nowMs = 1_000;
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const input = {
      uid: "provider-timestamp-login",
      method: "apple" as const,
      methodValueRaw: "provider-timestamp-apple",
      normalizedMethodValue: "provider-timestamp-apple",
      intentId: "provider-timestamp-intent-1",
      requestEmoji: 6,
      requestAura: null,
      opId: "provider-timestamp-operation-1",
    };
    const linked = await service.linkVerifiedMethod(input);
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          linked.profileId,
        )
      ).authMethods.find((method) => method.method === "apple")?.linkedAtMs,
    ).toBe(1_000);
    nowMs = 2_000;
    await service.linkVerifiedMethod({
      ...input,
      intentId: "provider-timestamp-intent-2",
      opId: "provider-timestamp-operation-2",
    });
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          linked.profileId,
        )
      ).authMethods.find((method) => method.method === "apple")?.linkedAtMs,
    ).toBe(2_000);
    nowMs = 3_000;
    const xInput = {
      ...input,
      method: "x" as const,
      methodValueRaw: "provider-timestamp-x",
      normalizedMethodValue: "provider-timestamp-x",
      intentId: "provider-timestamp-intent-x-1",
      opId: "provider-timestamp-operation-x-1",
      xUsername: "provider_timestamp",
    };
    await service.linkVerifiedMethod(xInput);
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          linked.profileId,
        )
      ).authMethods.find((method) => method.method === "x")?.linkedAtMs,
    ).toBe(3_000);
    nowMs = 4_000;
    await service.linkVerifiedMethod({
      ...xInput,
      intentId: "provider-timestamp-intent-x-2",
      opId: "provider-timestamp-operation-x-2",
    });
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          linked.profileId,
        )
      ).authMethods.find((method) => method.method === "x")?.linkedAtMs,
    ).toBe(4_000);
  });

  it("normalizes canonical auth response strings and owned methods", async () => {
    const firebase = firebaseState();
    let nowMs = 1_000;
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const uid = "normalized-auth-response-login";
    const eth = `0x${"a".repeat(40)}`;
    const sol = "1".repeat(32);
    const linked = await service.linkVerifiedMethod({
      uid,
      method: "eth",
      methodValueRaw: eth,
      normalizedMethodValue: eth,
      intentId: "normalized-auth-response-eth-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "normalized-auth-response-eth-operation",
    });
    nowMs += 1;
    await service.linkVerifiedMethod({
      uid,
      method: "sol",
      methodValueRaw: sol,
      normalizedMethodValue: sol,
      intentId: "normalized-auth-response-sol-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "normalized-auth-response-sol-operation",
    });
    const snapshot = await readCanonicalProfile(
      testBindings.PROFILE_DB,
      linked.profileId,
    );
    if (!snapshot) throw new Error("missing-normalized-auth-profile");
    await commitCanonicalPlan(testBindings.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: snapshot.profileId,
          revision: snapshot.revision,
        },
      ],
      mutations: [
        {
          kind: "update-active-profile",
          value: materializeCanonicalProfile({
            profile: {
              ...snapshot.profile,
              username: "  CanonicalName  ",
              eth: `  0x${"A".repeat(40)}  `,
              sol: `  ${sol}  `,
              aura: "  rainbow  ",
              profileCounter: "  gp  ",
            },
            state: snapshot.state,
            mergedIntoProfileId: snapshot.mergedIntoProfileId,
            legacyFields: snapshot.legacyFields,
            createdAtMs: snapshot.createdAtMs,
            updatedAtMs: nowMs,
            mergedAtMs: snapshot.mergedAtMs,
            sortPresence: snapshot.sortPresence,
            sortValues: snapshot.sortValues,
            winPresent: snapshot.winPresent,
            emojiPresent: snapshot.emojiPresent,
            gameplayEmoji: snapshot.gameplayEmoji,
          }),
        },
      ],
    });

    await expect(
      service.peekVerifyReplay(
        "normalized-auth-response-eth-operation",
        "eth",
        uid,
      ),
    ).resolves.toMatchObject({
      username: "CanonicalName",
      eth,
      sol,
      aura: "rainbow",
      profileCounter: "gp",
      linkedMethods: { eth: true, sol: true },
    });
  });

  it("repairs Firebase ownership before returning a successful replay after a merge", async () => {
    const firebase = firebaseState();
    let nowMs = 1_000;
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const xUserId = "successful-replay-x-user";
    const source = await service.linkVerifiedMethod({
      uid: "successful-replay-source-login",
      method: "x",
      methodValueRaw: xUserId,
      normalizedMethodValue: xUserId,
      intentId: "successful-replay-source-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "successful-replay-source-operation",
      xUsername: "ReplaySource",
    });
    nowMs = 2_000;
    const target = await service.linkVerifiedMethod({
      uid: "successful-replay-target-login",
      method: "eth",
      methodValueRaw: "0x7777777777777777777777777777777777777777",
      normalizedMethodValue: "0x7777777777777777777777777777777777777777",
      intentId: "successful-replay-target-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "successful-replay-target-operation",
    });
    nowMs += 60_001;
    const recovery = createAuthRecoveryService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      profileDb: testBindings.PROFILE_DB,
      rtdb: firebase.rtdb,
    });
    await recovery.recoverProfile(source.profileId);
    await recovery.recoverProfile(target.profileId);
    await expect(
      service.linkVerifiedMethod({
        uid: "successful-replay-target-login",
        method: "x",
        methodValueRaw: xUserId,
        normalizedMethodValue: xUserId,
        intentId: "successful-replay-merge-intent",
        requestEmoji: 4,
        requestAura: null,
        opId: "successful-replay-merge-operation",
        xUsername: "ReplaySource",
      }),
    ).resolves.toMatchObject({ profileId: target.profileId });
    firebase.claims.set("successful-replay-source-login", {
      profileId: source.profileId,
    });
    firebase.rtdbValues.set(
      "players/successful-replay-source-login/profile",
      source.profileId,
    );

    await expect(
      service.peekVerifyReplay(
        "successful-replay-source-operation",
        "x",
        "successful-replay-source-login",
      ),
    ).resolves.toMatchObject({ profileId: target.profileId });
    expect(
      firebase.claims.get("successful-replay-source-login")?.profileId,
    ).toBe(target.profileId);
    expect(
      firebase.rtdbValues.get("players/successful-replay-source-login/profile"),
    ).toBe(target.profileId);
  });

  it("heals a missing username before returning a successful X replay", async () => {
    const firebase = firebaseState();
    const uid = "successful-username-replay-login";
    const opId = "successful-username-replay-operation";
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => 2_500,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const linked = await service.linkVerifiedMethod({
      uid,
      method: "x",
      methodValueRaw: "successful-username-replay-x-user",
      normalizedMethodValue: "successful-username-replay-x-user",
      intentId: "successful-username-replay-intent",
      requestEmoji: 4,
      requestAura: null,
      opId,
      xUsername: "ReplayHandle",
    });
    await setCanonicalUsername(linked.profileId, null, 2_501);
    firebase.claims.set(uid, { profileId: "stale-profile" });

    await expect(
      service.peekVerifyReplay(opId, "x", uid),
    ).resolves.toMatchObject({
      profileId: linked.profileId,
      username: "ReplayHandle",
    });
    expect(
      (await readCanonicalProfile(testBindings.PROFILE_DB, linked.profileId))
        ?.profile.username,
    ).toBe("ReplayHandle");
    await expect(
      readCanonicalAuthOperation(testBindings.PROFILE_DB, opId),
    ).resolves.toMatchObject({ status: "success" });
  });

  it.each([
    ["reserved", "anon"],
    ["overlength", "X".repeat(USERNAME_MAX_LENGTH + 1)],
  ] as const)(
    "heals a %s social username through profile sync after replay expiry",
    async (kind, invalidUsername) => {
      const firebase = firebaseState();
      let nowMs = 1_000;
      const service = createAuthIdentityService(d1Env, {
        authClient: firebase.authClient,
        now: () => nowMs,
        randomInteger: () => 0,
        rtdb: firebase.rtdb,
      });
      const uid = `${kind}-social-username-login`;
      const opId = `${kind}-social-username-operation`;
      const xUserId = `${kind}-social-username-x-user`;
      const linked = await service.linkVerifiedMethod({
        uid,
        method: "x",
        methodValueRaw: xUserId,
        normalizedMethodValue: xUserId,
        intentId: `${kind}-social-username-intent`,
        requestEmoji: 4,
        requestAura: null,
        opId,
        xUsername: "SocialReplay",
      });
      await setCanonicalUsername(linked.profileId, invalidUsername, 2_000);
      nowMs += 10 * 60 * 1_000 + 1;

      await expect(
        service.peekVerifyReplay(opId, "x", uid),
      ).resolves.toBeNull();
      await expect(
        service.syncCurrentCallerProfile(uid),
      ).resolves.toMatchObject({
        profileId: linked.profileId,
        linkedMethods: { x: true },
      });
      expect(
        (await readCanonicalProfile(testBindings.PROFILE_DB, linked.profileId))
          ?.profile.username,
      ).toBe("SocialReplay");
    },
  );

  it("uses a generated username when the X handle exceeds the app limit", async () => {
    const firebase = firebaseState();
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => 2_500,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const preferred = "X".repeat(USERNAME_MAX_LENGTH + 1);

    const linked = await service.linkVerifiedMethod({
      uid: "overlong-x-username-login",
      method: "x",
      methodValueRaw: "overlong-x-username-user",
      normalizedMethodValue: "overlong-x-username-user",
      intentId: "overlong-x-username-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "overlong-x-username-operation",
      xUsername: preferred,
    });

    expect(linked.username).toBe("Aaaa000");
    expect(linked.username).not.toBe(preferred);
    if (!linked.username) throw new Error("missing-generated-username");
    expect(linked.username.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
  });

  it.each([
    "during repair",
    "before success commit",
    "profile change before success commit",
  ] as const)(
    "does not complete a failed replay across concurrent %s",
    async (timing) => {
      const firebase = firebaseState();
      const uid = "removed-during-replay-login";
      const xUserId = "removed-during-replay-x-user";
      const opId = "removed-during-replay-x-operation";
      const baseService = createAuthIdentityService(d1Env, {
        authClient: firebase.authClient,
        now: () => 3_000,
        randomInteger: () => 0,
        rtdb: firebase.rtdb,
      });
      const linked = await baseService.linkVerifiedMethod({
        uid,
        method: "eth",
        methodValueRaw: "0x8888888888888888888888888888888888888888",
        normalizedMethodValue: "0x8888888888888888888888888888888888888888",
        intentId: "removed-during-replay-eth-intent",
        requestEmoji: 4,
        requestAura: null,
        opId: "removed-during-replay-eth-operation",
      });
      const racedDb = failAfterMatchingBatch(
        testBindings.PROFILE_DB,
        (queries) =>
          queries.some((query) =>
            query.includes("INSERT INTO profile_auth_methods"),
          ),
        () => undefined,
      );
      const racedEnv = new Proxy(d1Env, {
        get(target, property, receiver) {
          return property === "PROFILE_DB"
            ? racedDb
            : Reflect.get(target, property, receiver);
        },
      });
      const failedService = createAuthIdentityService(racedEnv, {
        authClient: firebase.authClient,
        now: () => 3_001,
        randomInteger: () => 0,
        rtdb: firebase.rtdb,
      });
      await expect(
        failedService.linkVerifiedMethod({
          uid,
          method: "x",
          methodValueRaw: xUserId,
          normalizedMethodValue: xUserId,
          intentId: "removed-during-replay-x-intent",
          requestEmoji: 4,
          requestAura: null,
          opId,
          xUsername: "ReplayRemoval",
        }),
      ).rejects.toThrow("ambiguous-d1-response");
      await expect(
        readCanonicalAuthOperation(testBindings.PROFILE_DB, opId),
      ).resolves.toMatchObject({ status: "failed" });
      let removed = false;
      const removeMethod = async () => {
        if (removed) return;
        removed = true;
        const aggregate = await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          linked.profileId,
        );
        const method = aggregate.authMethods.find(
          (candidate) => candidate.method === "x",
        );
        if (!method) throw new Error("missing-replay-x-method");
        await commitCanonicalPlan(testBindings.PROFILE_DB, {
          expectations: [
            {
              kind: "auth-method-revision",
              method: "x",
              normalizedValue: method.normalizedValue,
              profileId: linked.profileId,
              revision: method.revision,
            },
          ],
          mutations: [
            {
              kind: "delete-auth-method",
              method: "x",
              normalizedValue: method.normalizedValue,
            },
          ],
        });
      };
      let profileChanged = false;
      const changeProfile = async () => {
        if (profileChanged) return;
        profileChanged = true;
        await setCanonicalUsername(linked.profileId, null, 3_003);
      };
      const authClient: FirebaseAuthAdminClient =
        timing === "during repair"
          ? {
              getUser: firebase.authClient.getUser,
              setCustomUserClaims: async (loginUid, claims) => {
                await firebase.authClient.setCustomUserClaims(loginUid, claims);
                await removeMethod();
              },
            }
          : firebase.authClient;
      if (timing === "during repair") {
        firebase.claims.set(uid, { profileId: "stale-profile" });
      }
      const replayDb =
        timing !== "during repair"
          ? beforeMatchingBatch(
              testBindings.PROFILE_DB,
              (queries) =>
                queries.some((query) =>
                  query.includes("UPDATE profile_auth_operations SET"),
                ),
              timing === "before success commit" ? removeMethod : changeProfile,
            )
          : testBindings.PROFILE_DB;
      const replayEnv = new Proxy(d1Env, {
        get(target, property, receiver) {
          return property === "PROFILE_DB"
            ? replayDb
            : Reflect.get(target, property, receiver);
        },
      });
      const replayService = createAuthIdentityService(replayEnv, {
        authClient,
        now: () => 3_002,
        randomInteger: () => 0,
        rtdb: firebase.rtdb,
      });

      await expect(
        replayService.peekVerifyReplay(opId, "x", uid),
      ).resolves.toBeNull();
      const aggregate = await readCanonicalProfileAggregate(
        testBindings.PROFILE_DB,
        linked.profileId,
      );
      if (timing === "profile change before success commit") {
        expect(profileChanged).toBe(true);
        expect(removed).toBe(false);
        expect(
          aggregate.authMethods.some((method) => method.method === "x"),
        ).toBe(true);
        expect(aggregate.profile?.profile.username).toBeNull();
      } else {
        expect(removed).toBe(true);
        expect(
          aggregate.authMethods.some((method) => method.method === "x"),
        ).toBe(false);
      }
      await expect(
        readCanonicalAuthOperation(testBindings.PROFILE_DB, opId),
      ).resolves.toMatchObject({ status: "failed" });
      if (timing === "profile change before success commit") {
        await expect(
          replayService.peekVerifyReplay(opId, "x", uid),
        ).resolves.toMatchObject({ username: null });
        await expect(
          readCanonicalAuthOperation(testBindings.PROFILE_DB, opId),
        ).resolves.toMatchObject({ status: "success" });
      }
    },
  );

  it("assigns the X username before completing an incomplete replay", async () => {
    const firebase = firebaseState();
    let ambiguities = 0;
    const racedDb = failAfterMatchingBatch(
      testBindings.PROFILE_DB,
      (queries) =>
        queries.some((query) =>
          query.includes("INSERT INTO profile_auth_methods"),
        ),
      () => {
        ambiguities++;
      },
    );
    const racedEnv = new Proxy(d1Env, {
      get(target, property, receiver) {
        return property === "PROFILE_DB"
          ? racedDb
          : Reflect.get(target, property, receiver);
      },
    });
    const service = createAuthIdentityService(racedEnv, {
      authClient: firebase.authClient,
      now: () => 4_000,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const input = {
      uid: "incomplete-x-login",
      method: "x" as const,
      methodValueRaw: "incomplete-x-user",
      normalizedMethodValue: "incomplete-x-user",
      intentId: "incomplete-x-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "incomplete-x-operation",
      xUsername: "RecoverHandle",
    };
    await expect(service.linkVerifiedMethod(input)).rejects.toThrow(
      "ambiguous-d1-response",
    );
    expect(ambiguities).toBe(1);
    expect(
      (await readCanonicalProfileByLogin(testBindings.PROFILE_DB, input.uid))
        ?.profile.username,
    ).toBeNull();

    await expect(
      service.peekVerifyReplay(input.opId, "x", input.uid),
    ).resolves.toMatchObject({ username: "RecoverHandle" });
    expect(firebase.claims.get(input.uid)?.profileId).toBeTruthy();
    expect(firebase.rtdbValues.get(`players/${input.uid}/profile`)).toBe(
      firebase.claims.get(input.uid)?.profileId,
    );
  });

  it("does not complete an expired incomplete replay", async () => {
    const firebase = firebaseState();
    let nowMs = 5_000;
    const racedDb = failAfterMatchingBatch(
      testBindings.PROFILE_DB,
      (queries) =>
        queries.some((query) =>
          query.includes("INSERT INTO profile_auth_methods"),
        ),
      () => undefined,
    );
    const racedEnv = new Proxy(d1Env, {
      get(target, property, receiver) {
        return property === "PROFILE_DB"
          ? racedDb
          : Reflect.get(target, property, receiver);
      },
    });
    const service = createAuthIdentityService(racedEnv, {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const input = {
      uid: "expired-incomplete-x-login",
      method: "x" as const,
      methodValueRaw: "expired-incomplete-x-user",
      normalizedMethodValue: "expired-incomplete-x-user",
      intentId: "expired-incomplete-x-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "expired-incomplete-x-operation",
      xUsername: "ExpiredHandle",
    };
    await expect(service.linkVerifiedMethod(input)).rejects.toThrow(
      "ambiguous-d1-response",
    );
    nowMs += 10 * 60 * 1_000 + 1;

    await expect(
      service.peekVerifyReplay(input.opId, "x", input.uid),
    ).resolves.toBeNull();
    expect(
      (await readCanonicalProfileByLogin(testBindings.PROFILE_DB, input.uid))
        ?.profile.username,
    ).toBeNull();
  });

  it("repairs Firebase state before returning an ambiguous unlink replay", async () => {
    const firebase = firebaseState();
    const uid = "ambiguous-unlink-login";
    const baseService = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => 2_000,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const linked = await baseService.linkVerifiedMethod({
      uid,
      method: "eth",
      methodValueRaw: "0x4444444444444444444444444444444444444444",
      normalizedMethodValue: "0x4444444444444444444444444444444444444444",
      intentId: "ambiguous-unlink-eth-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "ambiguous-unlink-eth-operation",
    });
    await baseService.linkVerifiedMethod({
      uid,
      method: "sol",
      methodValueRaw: "44444444444444444444444444444444",
      normalizedMethodValue: "44444444444444444444444444444444",
      intentId: "ambiguous-unlink-sol-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "ambiguous-unlink-sol-operation",
    });
    firebase.claims.delete(uid);
    firebase.rtdbValues.delete(`players/${uid}/profile`);
    let ambiguities = 0;
    const racedDb = failAfterMatchingBatch(
      testBindings.PROFILE_DB,
      (queries) =>
        queries.some((query) =>
          query.includes("DELETE FROM profile_auth_methods"),
        ),
      () => {
        ambiguities++;
      },
    );
    const racedEnv = new Proxy(d1Env, {
      get(target, property, receiver) {
        return property === "PROFILE_DB"
          ? racedDb
          : Reflect.get(target, property, receiver);
      },
    });
    const racedService = createAuthIdentityService(racedEnv, {
      authClient: firebase.authClient,
      now: () => 3_000,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    await expect(
      racedService.unlinkMethod(uid, "eth", "ambiguous-unlink-operation"),
    ).resolves.toMatchObject({
      profileId: linked.profileId,
      linkedMethods: { eth: false, sol: true },
    });
    expect(ambiguities).toBe(1);
    expect(firebase.claims.get(uid)?.profileId).toBe(linked.profileId);
    expect(firebase.rtdbValues.get(`players/${uid}/profile`)).toBe(
      linked.profileId,
    );
  });

  it("retries a profile revision change between resolve and aggregate reads", async () => {
    const firebase = firebaseState();
    const baseService = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => 3_000,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const linked = await baseService.linkVerifiedMethod({
      uid: "auth-revision-login",
      method: "sol",
      methodValueRaw: "33333333333333333333333333333333",
      normalizedMethodValue: "33333333333333333333333333333333",
      intentId: "auth-revision-intent",
      requestEmoji: 3,
      requestAura: null,
      opId: "auth-revision-operation",
    });
    let interleavings = 0;
    const racedDb = beforeMatchingBatch(
      testBindings.PROFILE_DB,
      (queries) =>
        queries.some((query) => query.includes("FROM profile_auth_methods")),
      async () => {
        interleavings++;
        const snapshot = await readCanonicalProfile(
          testBindings.PROFILE_DB,
          linked.profileId,
        );
        if (!snapshot) throw new Error("missing-auth-revision-profile");
        await commitCanonicalPlan(testBindings.PROFILE_DB, {
          expectations: [
            {
              kind: "profile-revision",
              profileId: snapshot.profileId,
              revision: snapshot.revision,
            },
          ],
          mutations: [
            {
              kind: "update-active-profile",
              value: materializeCanonicalProfile({
                profile: { ...snapshot.profile, emoji: 12 },
                createdAtMs: snapshot.createdAtMs,
                updatedAtMs: 3_001,
                legacyFields: snapshot.legacyFields,
                state: snapshot.state,
                mergedAtMs: snapshot.mergedAtMs,
                mergedIntoProfileId: snapshot.mergedIntoProfileId,
                sortPresence: snapshot.sortPresence,
                sortValues: snapshot.sortValues,
                winPresent: snapshot.winPresent,
                emojiPresent: snapshot.emojiPresent,
                gameplayEmoji: 12,
              }),
            },
          ],
        });
      },
    );
    const racedEnv = new Proxy(d1Env, {
      get(target, property, receiver) {
        return property === "PROFILE_DB"
          ? racedDb
          : Reflect.get(target, property, receiver);
      },
    });
    const racedService = createAuthIdentityService(racedEnv, {
      authClient: firebase.authClient,
      now: () => 3_001,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    await expect(
      racedService.syncCurrentCallerProfile("auth-revision-login"),
    ).resolves.toMatchObject({ profileId: linked.profileId });
    expect(interleavings).toBe(1);
    expect(
      (await readCanonicalProfile(testBindings.PROFILE_DB, linked.profileId))
        ?.profile.emoji,
    ).toBe(12);
  });

  it("retries auth method reads when the login owner moves during a merge", async () => {
    const firebase = firebaseState();
    let nowMs = 20_000;
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const source = await service.linkVerifiedMethod({
      uid: "auth-move-source-login",
      method: "sol",
      methodValueRaw: "55555555555555555555555555555555",
      normalizedMethodValue: "55555555555555555555555555555555",
      intentId: "auth-move-source-intent",
      requestEmoji: 5,
      requestAura: null,
      opId: "auth-move-source-operation",
    });
    const target = await service.linkVerifiedMethod({
      uid: "auth-move-target-login",
      method: "eth",
      methodValueRaw: "0x5555555555555555555555555555555555555555",
      normalizedMethodValue: "0x5555555555555555555555555555555555555555",
      intentId: "auth-move-target-intent",
      requestEmoji: 5,
      requestAura: null,
      opId: "auth-move-target-operation",
    });
    nowMs += 60_001;
    const recovery = createAuthRecoveryService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      profileDb: testBindings.PROFILE_DB,
      rtdb: firebase.rtdb,
    });
    await recovery.recoverProfile(source.profileId);
    await recovery.recoverProfile(target.profileId);
    let merges = 0;
    const racedDb = beforeMatchingBatch(
      testBindings.PROFILE_DB,
      (queries) =>
        queries.some((query) => query.includes("FROM profile_auth_methods")),
      async () => {
        merges++;
        await service.linkVerifiedMethod({
          uid: "auth-move-target-login",
          method: "sol",
          methodValueRaw: "55555555555555555555555555555555",
          normalizedMethodValue: "55555555555555555555555555555555",
          intentId: "auth-move-merge-intent",
          requestEmoji: 5,
          requestAura: null,
          opId: "auth-move-merge-operation",
        });
      },
    );
    await expect(
      createAuthRepository(d1Env, {
        d1: racedDb,
      }).getLinkedAuthMethods("auth-move-source-login", "unused"),
    ).resolves.toMatchObject({
      profileId: target.profileId,
      linkedMethods: { eth: true, sol: true },
    });
    expect(merges).toBe(1);
  });

  it("uses canonical readers and guarded profile mutations", async () => {
    const firebase = firebaseState();
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => 10_000,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const linked = await service.linkVerifiedMethod({
      uid: "profile-login",
      method: "sol",
      methodValueRaw: "11111111111111111111111111111111",
      normalizedMethodValue: "11111111111111111111111111111111",
      intentId: "profile-intent",
      requestEmoji: 9,
      requestAura: null,
      opId: "profile-operation",
    });
    expect(
      await createUsernameRepository(d1Env).editUsername(
        "profile-login",
        "CanonicalName",
      ),
    ).toBe("updated");
    let authorizations = 0;
    expect(
      await createProfileCustomizationRepository(d1Env).updateCustomization(
        "profile-login",
        { field: "cardBackgroundId", value: 4 },
        async () => {
          authorizations++;
          if (authorizations === 1) {
            await createUsernameRepository(d1Env).editUsername(
              "profile-login",
              "CanonicalRenamed",
            );
          }
        },
      ),
    ).toBe("updated");
    expect(authorizations).toBe(2);

    const mining = createMiningRepository(d1Env);
    const miningProfile = await mining.getProfile("profile-login", "unused");
    expect(miningProfile).not.toBeNull();
    expect(
      await mining.updateMining(
        linked.profileId,
        {
          lastRockDate: "2026-08-28",
          materials: { dust: 1, slime: 2, gum: 3, metal: 4, ice: 5 },
        },
        miningProfile?.updateTime || "",
      ),
    ).toBe("updated");

    const repository = createConfiguredProfileRepository(d1Env);
    const profile = await repository.getProfileByLoginId(
      "profile-login",
      "unused",
    );
    expect(profile).toMatchObject({
      id: linked.profileId,
      username: "CanonicalRenamed",
      cardBackgroundId: 4,
      mining: { materials: { ice: 5 } },
    });
    await expect(
      createAuthRepository(d1Env).getLinkedAuthMethods(
        "profile-login",
        "unused",
      ),
    ).resolves.toMatchObject({
      profileId: linked.profileId,
      linkedMethods: { sol: true },
    });
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          linked.profileId,
        )
      ).profile?.revision,
    ).toBeGreaterThan(1);
    expect(
      (
        await readCanonicalProfileAggregate(
          testBindings.PROFILE_DB,
          linked.profileId,
        )
      ).profile,
    ).toMatchObject({
      sortPresence: { rating: false, mp: false, nonce: false },
      sortValues: { rating: null, mp: null, nonce: null },
      winPresent: false,
      emojiPresent: true,
    });
  });

  it("merges canonical owners while preserving the target username", async () => {
    const firebase = firebaseState();
    let nowMs = 5_000;
    const targetEthRaw = "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
    const targetEthNormalized = targetEthRaw.toLowerCase();
    const targetLegacyFields = {
      authMetadata: {
        provider: "legacy-target",
        rawWallet: targetEthRaw,
      },
      retainedTarget: true,
    };
    const largeOpaqueArchive = "source-archive".repeat(16_384);
    const sourceLegacyFields = {
      authMetadata: {
        provider: "legacy-source",
        rawWallet: " 22222222222222222222222222222222 ",
      },
      largeOpaqueArchive,
    };
    const dependencies = {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    };
    const service = createAuthIdentityService(d1Env, dependencies);
    const target = await service.linkVerifiedMethod({
      uid: "merge-target-login",
      method: "eth",
      methodValueRaw: targetEthRaw,
      normalizedMethodValue: targetEthNormalized,
      intentId: "merge-target-intent",
      requestEmoji: 2,
      requestAura: null,
      opId: "merge-target-operation",
    });
    const source = await service.linkVerifiedMethod({
      uid: "merge-source-login",
      method: "sol",
      methodValueRaw: "22222222222222222222222222222222",
      normalizedMethodValue: "22222222222222222222222222222222",
      intentId: "merge-source-intent",
      requestEmoji: 3,
      requestAura: null,
      opId: "merge-source-operation",
    });
    await createUsernameRepository(d1Env).editUsername(
      "merge-target-login",
      "TargetName",
    );
    await createUsernameRepository(d1Env).editUsername(
      "merge-source-login",
      "SourceName",
    );
    nowMs += 60_001;
    const recovery = createAuthRecoveryService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      profileDb: testBindings.PROFILE_DB,
      rtdb: firebase.rtdb,
    });
    await expect(recovery.recoverProfile(target.profileId)).resolves.toBe(true);
    await expect(recovery.recoverProfile(source.profileId)).resolves.toBe(true);

    const targetSnapshot = await readCanonicalProfile(
      testBindings.PROFILE_DB,
      target.profileId,
    );
    const sourceSnapshot = await readCanonicalProfile(
      testBindings.PROFILE_DB,
      source.profileId,
    );
    expect(targetSnapshot).not.toBeNull();
    expect(sourceSnapshot).not.toBeNull();
    if (!targetSnapshot || !sourceSnapshot) {
      throw new Error("missing merge profiles");
    }
    await commitCanonicalPlan(testBindings.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: targetSnapshot.profileId,
          revision: targetSnapshot.revision,
        },
        {
          kind: "profile-revision",
          profileId: sourceSnapshot.profileId,
          revision: sourceSnapshot.revision,
        },
      ],
      mutations: [
        {
          kind: "update-active-profile",
          value: materializeCanonicalProfile({
            profile: { ...targetSnapshot.profile, aura: "   " },
            state: targetSnapshot.state,
            mergedIntoProfileId: targetSnapshot.mergedIntoProfileId,
            legacyFields: targetLegacyFields,
            createdAtMs: targetSnapshot.createdAtMs,
            updatedAtMs: nowMs,
            mergedAtMs: 4_000,
            sortPresence: {
              ...targetSnapshot.sortPresence,
              rating: true,
              nonce: true,
            },
            sortValues: {
              ...targetSnapshot.sortValues,
              rating: null,
              nonce: null,
            },
            winPresent: false,
            emojiPresent: false,
            gameplayEmoji: "",
          }),
        },
        {
          kind: "update-active-profile",
          value: materializeCanonicalProfile({
            profile: {
              ...sourceSnapshot.profile,
              win: false,
              emoji: 11,
              aura: "rainbow",
            },
            state: sourceSnapshot.state,
            mergedIntoProfileId: sourceSnapshot.mergedIntoProfileId,
            legacyFields: sourceLegacyFields,
            createdAtMs: sourceSnapshot.createdAtMs,
            updatedAtMs: nowMs,
            mergedAtMs: sourceSnapshot.mergedAtMs,
            sortPresence: sourceSnapshot.sortPresence,
            sortValues: sourceSnapshot.sortValues,
            winPresent: true,
            emojiPresent: true,
            gameplayEmoji: 11,
          }),
        },
      ],
    });

    nowMs += 1;
    const merged = await service.linkVerifiedMethod({
      uid: "merge-target-login",
      method: "sol",
      methodValueRaw: "22222222222222222222222222222222",
      normalizedMethodValue: "22222222222222222222222222222222",
      intentId: "merge-intent",
      requestEmoji: 2,
      requestAura: null,
      opId: "merge-operation",
    });
    expect(merged.profileId).toBe(target.profileId);
    expect(merged.username).toBe("TargetName");
    expect(merged.eth).toBe(targetEthNormalized);
    expect(merged.sol).toBe("22222222222222222222222222222222");
    expect(merged.linkedMethods).toMatchObject({ eth: true, sol: true });
    const mergedSnapshot = await readCanonicalProfile(
      testBindings.PROFILE_DB,
      target.profileId,
    );
    expect(mergedSnapshot).toMatchObject({
      profile: {
        win: false,
        emoji: 11,
        aura: "rainbow",
        eth: targetEthNormalized,
        sol: "22222222222222222222222222222222",
        rating: 1500,
        nonce: 0,
      },
      legacyFields: targetLegacyFields,
      winPresent: true,
      emojiPresent: true,
      gameplayEmoji: 11,
      mergedAtMs: nowMs,
      sortPresence: { rating: true, mp: true, nonce: true },
      sortValues: { rating: 0 },
    });
    const mergedAggregate = await readCanonicalProfileAggregate(
      testBindings.PROFILE_DB,
      target.profileId,
    );
    expect(
      mergedAggregate.authMethods.find((method) => method.method === "eth"),
    ).toMatchObject({
      normalizedValue: targetEthNormalized,
      rawValue: targetEthRaw,
    });
    await expect(
      readCanonicalMergeTarget(testBindings.PROFILE_DB, source.profileId),
    ).resolves.toEqual({
      sourceProfileId: source.profileId,
      targetProfileId: target.profileId,
      mergedAtMs: nowMs,
      opId: "merge-operation",
    });
    expect(await readMergeSourceArchive(source.profileId)).toEqual(
      sourceLegacyFields,
    );
    expect(
      JSON.stringify(mergedSnapshot?.legacyFields).includes(largeOpaqueArchive),
    ).toBe(false);
    const retiredSource = await readCanonicalProfile(
      testBindings.PROFILE_DB,
      source.profileId,
    );
    if (!retiredSource) throw new Error("missing retired source");
    expect(retiredSource.legacyFields).toEqual(sourceLegacyFields);
    await commitCanonicalPlan(testBindings.PROFILE_DB, {
      expectations: [
        {
          kind: "profile-revision",
          profileId: retiredSource.profileId,
          revision: retiredSource.revision,
        },
        {
          kind: "merge-target",
          sourceProfileId: source.profileId,
          targetProfileId: target.profileId,
        },
      ],
      mutations: [
        {
          kind: "delete-retired-profile",
          profileId: source.profileId,
          targetProfileId: target.profileId,
        },
      ],
    });
    expect(
      await readCanonicalProfile(testBindings.PROFILE_DB, source.profileId),
    ).toBeNull();
    expect(
      (await readCanonicalProfile(testBindings.PROFILE_DB, target.profileId))
        ?.legacyFields,
    ).toEqual(targetLegacyFields);
    expect(await readMergeSourceArchive(source.profileId)).toEqual(
      sourceLegacyFields,
    );
    expect(
      (
        await readCanonicalProfileByLogin(
          testBindings.PROFILE_DB,
          "merge-source-login",
        )
      )?.profileId,
    ).toBe(target.profileId);
  });

  it("keeps chained merge archives separate from active profiles", async () => {
    const firebase = firebaseState();
    let nowMs = 20_000;
    const service = createAuthIdentityService(d1Env, {
      authClient: firebase.authClient,
      now: () => nowMs,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    const ethRaw = "0xABCDEF0000000000000000000000000000000000";
    const ethNormalized = ethRaw.toLowerCase();
    const first = await service.linkVerifiedMethod({
      uid: "archive-chain-first-login",
      method: "eth",
      methodValueRaw: ethRaw,
      normalizedMethodValue: ethNormalized,
      intentId: "archive-chain-first-intent",
      requestEmoji: 2,
      requestAura: null,
      opId: "archive-chain-first-operation",
    });
    const second = await service.linkVerifiedMethod({
      uid: "archive-chain-second-login",
      method: "sol",
      methodValueRaw: "33333333333333333333333333333333",
      normalizedMethodValue: "33333333333333333333333333333333",
      intentId: "archive-chain-second-intent",
      requestEmoji: 3,
      requestAura: null,
      opId: "archive-chain-second-operation",
    });
    const final = await service.linkVerifiedMethod({
      uid: "archive-chain-final-login",
      method: "x",
      methodValueRaw: "archive-chain-x-user",
      normalizedMethodValue: "archive-chain-x-user",
      intentId: "archive-chain-final-intent",
      requestEmoji: 4,
      requestAura: null,
      xUsername: "ArchiveChainFinal",
      opId: "archive-chain-final-operation",
    });
    const firstLegacyFields = { first: "a".repeat(8_192) };
    const secondLegacyFields = { second: "b".repeat(8_192) };
    const finalLegacyFields = { final: "c".repeat(8_192) };
    for (const [profileId, legacyFields] of [
      [first.profileId, firstLegacyFields],
      [second.profileId, secondLegacyFields],
      [final.profileId, finalLegacyFields],
    ] as const) {
      const snapshot = await readCanonicalProfile(
        testBindings.PROFILE_DB,
        profileId,
      );
      if (!snapshot) throw new Error("missing archive-chain profile");
      await commitCanonicalPlan(testBindings.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId,
            revision: snapshot.revision,
          },
        ],
        mutations: [
          {
            kind: "update-active-profile",
            value: materializeCanonicalProfile({
              ...snapshot,
              legacyFields,
              updatedAtMs: nowMs,
            }),
          },
        ],
      });
    }
    await testBindings.PROFILE_DB.prepare(
      "DELETE FROM profile_auth_recovery_jobs",
    ).run();

    nowMs += 1;
    await expect(
      service.linkVerifiedMethod({
        uid: "archive-chain-first-login",
        method: "sol",
        methodValueRaw: "33333333333333333333333333333333",
        normalizedMethodValue: "33333333333333333333333333333333",
        intentId: "archive-chain-first-merge-intent",
        requestEmoji: 2,
        requestAura: null,
        opId: "archive-chain-first-merge-operation",
      }),
    ).resolves.toMatchObject({ profileId: first.profileId });
    await testBindings.PROFILE_DB.prepare(
      "DELETE FROM profile_auth_recovery_jobs",
    ).run();

    nowMs += 1;
    const chained = await service.linkVerifiedMethod({
      uid: "archive-chain-final-login",
      method: "eth",
      methodValueRaw: ethRaw,
      normalizedMethodValue: ethNormalized,
      intentId: "archive-chain-final-merge-intent",
      requestEmoji: 4,
      requestAura: null,
      opId: "archive-chain-final-merge-operation",
    });
    expect(chained).toMatchObject({
      profileId: final.profileId,
      eth: ethNormalized,
      sol: "33333333333333333333333333333333",
    });
    expect(await readMergeSourceArchive(second.profileId)).toEqual(
      secondLegacyFields,
    );
    expect(await readMergeSourceArchive(first.profileId)).toEqual(
      firstLegacyFields,
    );
    expect(
      (await readCanonicalProfile(testBindings.PROFILE_DB, final.profileId))
        ?.legacyFields,
    ).toEqual(finalLegacyFields);
    expect(
      JSON.stringify(await readMergeSourceArchive(first.profileId)),
    ).not.toContain(secondLegacyFields.second);

    for (const profileId of [second.profileId, first.profileId]) {
      const snapshot = await readCanonicalProfile(
        testBindings.PROFILE_DB,
        profileId,
      );
      if (!snapshot) throw new Error("missing retired archive-chain profile");
      if (!snapshot.mergedIntoProfileId) {
        throw new Error("missing archive-chain redirect");
      }
      await commitCanonicalPlan(testBindings.PROFILE_DB, {
        expectations: [
          {
            kind: "profile-revision",
            profileId,
            revision: snapshot.revision,
          },
          {
            kind: "merge-target",
            sourceProfileId: profileId,
            targetProfileId: snapshot.mergedIntoProfileId,
          },
        ],
        mutations: [
          {
            kind: "delete-retired-profile",
            profileId,
            targetProfileId: snapshot.mergedIntoProfileId,
          },
        ],
      });
    }
    expect(await readMergeSourceArchive(second.profileId)).toEqual(
      secondLegacyFields,
    );
    expect(await readMergeSourceArchive(first.profileId)).toEqual(
      firstLegacyFields,
    );
    expect(
      (
        await readCanonicalProfileByLogin(
          testBindings.PROFILE_DB,
          "archive-chain-second-login",
        )
      )?.profileId,
    ).toBe(final.profileId);
  });

  it("moves 366 and 110 owner sets within a bounded merge batch", async () => {
    const sourceProfileId = "owner-budget-source";
    const targetProfileId = "owner-budget-target";
    const sourceOwners = Array.from(
      { length: 366 },
      (_, index) => `owner-budget-source-login-${index}`,
    );
    const targetOwners = Array.from(
      { length: 110 },
      (_, index) => `owner-budget-target-login-${index}`,
    );
    const insertOwnedProfile = async (
      profileId: string,
      owners: string[],
      method: "eth" | "sol",
      normalizedValue: string,
    ) => {
      await commitCanonicalPlan(testBindings.PROFILE_DB, {
        expectations: [
          { kind: "profile-absent", profileId },
          { kind: "auth-method-absent", method, normalizedValue },
        ],
        mutations: [
          {
            kind: "insert-active-profile",
            value: materializeCanonicalProfile({
              profile: {
                id: profileId,
                nonce: -1,
                rating: 1500,
                totalManaPoints: 0,
                win: true,
                emoji: 6,
                username: `${profileId}Name`,
                eth: method === "eth" ? normalizedValue : null,
                sol: method === "sol" ? normalizedValue : null,
                feb2026UniqueOpponentsCount: 0,
                mining: {
                  lastRockDate: null,
                  materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
                },
              },
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
              gameplayEmoji: 6,
            }),
          },
          {
            kind: "insert-auth-method",
            value: {
              method,
              normalizedValue,
              profileId,
              rawValue: normalizedValue,
              appleEmailMasked: null,
              xUsername: null,
              linkedAtMs: null,
              consentAtMs: null,
              consentSource: null,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          },
        ],
      });
      for (let offset = 0; offset < owners.length; offset += 50) {
        const page = owners.slice(offset, offset + 50);
        await commitCanonicalPlan(testBindings.PROFILE_DB, {
          expectations: page.map((loginUid) => ({
            kind: "login-owner-absent" as const,
            loginUid,
          })),
          mutations: page.map((loginUid) => ({
            kind: "insert-login-owner" as const,
            value: {
              loginUid,
              profileId,
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
            },
          })),
        });
      }
    };
    const sourceMethod = "66666666666666666666666666666666";
    const targetMethod = "0x6666666666666666666666666666666666666666";
    await insertOwnedProfile(
      sourceProfileId,
      sourceOwners,
      "sol",
      sourceMethod,
    );
    await insertOwnedProfile(
      targetProfileId,
      targetOwners,
      "eth",
      targetMethod,
    );
    const batchSizes: number[] = [];
    const observedDb = observeBatchSizes(testBindings.PROFILE_DB, batchSizes);
    const observedEnv = new Proxy(d1Env, {
      get(target, property, receiver) {
        return property === "PROFILE_DB"
          ? observedDb
          : Reflect.get(target, property, receiver);
      },
    });
    const firebase = firebaseState();
    const service = createAuthIdentityService(observedEnv, {
      authClient: firebase.authClient,
      now: () => 9_000,
      randomInteger: () => 0,
      rtdb: firebase.rtdb,
    });
    await expect(
      service.linkVerifiedMethod({
        uid: targetOwners[0],
        method: "sol",
        methodValueRaw: sourceMethod,
        normalizedMethodValue: sourceMethod,
        intentId: "owner-budget-merge-intent",
        requestEmoji: 6,
        requestAura: null,
        opId: "owner-budget-merge-operation",
      }),
    ).resolves.toMatchObject({ profileId: targetProfileId });
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(20);
    const ownerCount = await testBindings.PROFILE_DB.prepare(
      "SELECT COUNT(*) AS count FROM profile_login_owners WHERE profile_id = ?",
    )
      .bind(targetProfileId)
      .first<{ count: number }>();
    expect(ownerCount?.count).toBe(476);
  });
});
