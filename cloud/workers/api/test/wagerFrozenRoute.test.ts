import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyMaterials } from "@mons/shared/mining";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleGameplayRoute } from "../src/gameplayRoute.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";
import {
  WagerClientUpdateRequired,
  type WagerReservationRuntime,
} from "../src/wagerReservationRuntime.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const context = { waitUntil: () => undefined };
const environment = TELEGRAM_TEST_ENV as Env;
const frozen = { ...createEmptyMaterials(), dust: 3 };

function request(
  body: unknown = { playerUid: "login" },
  path = "/wagers/frozen/read",
  headers: Record<string, string> = {},
) {
  return new Request(`https://api.mons.link${path}`, {
    method: "POST",
    headers: {
      Origin: "https://mons.link",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function fixture(owners: Record<string, string | null> = {}) {
  const repository = createGameplayRepository(environment);
  let reads = 0;
  let snapshots = 0;
  repository.getRtdbPath = async () => {
    throw new Error("unexpected-rtdb-read");
  };
  repository.readProfileOwnershipSnapshot = async (query) => {
    snapshots++;
    const ownerIds = new Set(
      query.loginUids.flatMap((uid) => (owners[uid] ? [owners[uid]!] : [])),
    );
    return {
      loginOwnerByUid: new Map(
        query.loginUids.map((uid) => [
          uid,
          owners[uid] ? { profileId: owners[uid]!, revision: 1 } : null,
        ]),
      ),
      canonicalProfileIdByProfileId: new Map(),
      loginUidsByProfileId: new Map(
        [...ownerIds].map((id) => [
          id,
          Object.keys(owners).filter((uid) => owners[uid] === id),
        ]),
      ),
      profileById: new Map(
        [...ownerIds].map((id) => [
          id,
          {
            revision: 1,
            profile: {
              profileId: id,
              aura: "",
              emoji: 1,
              eth: "",
              rating: 0,
              sol: "",
              username: "",
            },
          },
        ]),
      ),
    } satisfies ProfileOwnershipSnapshot;
  };
  const reservations: WagerReservationRuntime = {
    assertClientVersion: async () => undefined,
    readBalance: async () => {
      reads++;
      return { frozen, revision: 1 };
    },
    run: async () => {
      throw new Error("unexpected-mutation");
    },
  };
  const dependencies = {
    repository,
    wagerReservations: reservations,
    verifyIdentity: async () => ({
      uid: "login",
      profileId: "untrusted-claim",
    }),
    logFailure: () => undefined,
  };
  return {
    dependencies,
    reservations,
    repository,
    counts: () => ({ reads, snapshots }),
  };
}

test("frozen balances read own actor while writes are frozen and do not use Firebase", async () => {
  const value = fixture();
  const response = await handleGameplayRoute(
    request(),
    withProfileControl(environment, "frozen"),
    context,
    value.dependencies,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    playerUid: "login",
    frozen,
    revision: 1,
  });
  assert.deepEqual(value.counts(), { reads: 1, snapshots: 0 });
});

test("alternate actor requires one canonical ownership snapshot", async () => {
  const value = fixture({ login: "merged-profile", actor: "merged-profile" });
  const response = await handleGameplayRoute(
    request({ playerUid: "actor" }),
    environment,
    context,
    value.dependencies,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    playerUid: "actor",
    frozen,
    revision: 1,
  });
  assert.deepEqual(value.counts(), { reads: 1, snapshots: 1 });
});

test("foreign and unresolved actors cannot read balances through misleading claims", async () => {
  for (const owners of [
    { login: "one", actor: "two" },
    { login: null, actor: null },
  ]) {
    const value = fixture(owners);
    const response = await handleGameplayRoute(
      request({ playerUid: "actor" }),
      environment,
      context,
      value.dependencies,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(value.counts(), { reads: 0, snapshots: 1 });
  }
});

test("missing, extra, and unsafe player arguments fail before reading storage", async () => {
  for (const body of [
    {},
    { playerUid: "login", profileId: "one" },
    { playerUid: "bad/key" },
    { playerUid: " login" },
  ]) {
    const value = fixture();
    const response = await handleGameplayRoute(
      request(body),
      environment,
      context,
      value.dependencies,
    );
    assert.equal(response.status, 400);
    assert.equal(value.counts().reads, 0);
  }
});

test("unavailable or malformed balances never become authoritative zeros", async () => {
  for (const failedRead of [
    async () => {
      throw new Error("d1-unavailable");
    },
    async () => ({ frozen: { ...frozen, dust: -1 }, revision: 1 }),
    async () => ({ frozen, revision: -1 }),
  ]) {
    const value = fixture();
    value.reservations.readBalance = failedRead;
    const response = await handleGameplayRoute(
      request(),
      environment,
      context,
      value.dependencies,
    );
    assert.equal(response.status, 503);
  }
  const value = fixture();
  value.repository.readProfileOwnershipSnapshot = async () => {
    throw new Error("ownership-unavailable");
  };
  const response = await handleGameplayRoute(
    request({ playerUid: "actor" }),
    environment,
    context,
    value.dependencies,
  );
  assert.equal(response.status, 503);
  assert.equal(value.counts().reads, 0);
});

test("verified absent balance remains a successful zero snapshot", async () => {
  const value = fixture();
  value.reservations.readBalance = async () => ({
    frozen: createEmptyMaterials(),
    revision: 0,
  });
  const response = await handleGameplayRoute(
    request(),
    environment,
    context,
    value.dependencies,
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { revision: number }).revision, 0);
});

test("old wager clients fail before write gates, rate limits, body parsing, or mutation", async () => {
  for (const path of ["send", "accept", "cancel", "decline"]
    .map((action) => `/wagers/proposals/${action}`)
    .concat("/wagers/outcomes/resolve")) {
    const value = fixture();
    value.reservations.assertClientVersion = async () => {
      throw new WagerClientUpdateRequired();
    };
    const guardedEnv = {
      ...withProfileControl(environment, "frozen"),
      AUTH_RATE_LIMITER: {
        limit: async () => {
          throw new Error("unexpected-rate-limit");
        },
      },
    } as Env;
    const response = await handleGameplayRoute(
      request({}, path),
      guardedEnv,
      context,
      value.dependencies,
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "client-update-required",
      message: "Reload this page to continue wagering.",
    });
  }
});

test("unauthenticated requests cannot read frozen balances", async () => {
  const value = fixture();
  const response = await handleGameplayRoute(request(), environment, context, {
    ...value.dependencies,
    verifyIdentity: async () => {
      throw new AuthApiFailure(401, "unauthenticated", "invalid-token");
    },
  });
  assert.equal(response.status, 401);
  assert.equal(value.counts().reads, 0);
});

test("rechecks client storage version after activation races admission dispatch", async () => {
  const value = fixture();
  let activated = false;
  let versionChecks = 0;
  let admissions = 0;
  let domainReads = 0;
  value.repository.getRtdbPath = async () => {
    domainReads++;
    throw new Error("unexpected-domain-work");
  };
  value.reservations.assertClientVersion = async (incoming) => {
    versionChecks++;
    assert.equal(incoming.headers.has("X-Mons-Wager-Storage-Version"), false);
    if (activated) throw new WagerClientUpdateRequired();
  };
  value.reservations.run = async (_kind, work) => {
    admissions++;
    activated = true;
    return work(value.repository, async () => undefined);
  };
  const response = await handleGameplayRoute(
    request(
      { inviteId: "invite", matchId: "invite", material: "dust", count: 1 },
      "/wagers/proposals/send",
    ),
    environment,
    context,
    value.dependencies,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "client-update-required",
    message: "Reload this page to continue wagering.",
  });
  assert.equal(versionChecks, 2);
  assert.equal(admissions, 1);
  assert.equal(domainReads, 0);
});
