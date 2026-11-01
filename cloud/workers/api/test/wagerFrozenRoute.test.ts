import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyMaterials } from "@mons/shared/mining";
import {
  WAGER_STORAGE_VERSION,
  WAGER_STORAGE_VERSION_HEADER,
} from "@mons/shared/wagers";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleGameplayRoute } from "../src/gameplayRoute.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";
import type { WagerReservationRuntime } from "../src/wagerReservationRuntime.ts";
import { WagerReservationWritesDisabled } from "../src/wagerReservationControl.ts";
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
  repository.readInviteMetadata = async () => {
    throw new Error("unexpected-source-read");
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
              aura: "none",
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

test("missing and unsupported wager versions fail before profile gates, rate limits, body parsing, or admission", async () => {
  for (const path of ["send", "accept", "cancel", "decline"]
    .map((action) => `/wagers/proposals/${action}`)
    .concat("/wagers/outcomes/resolve")) {
    for (const version of [undefined, "0", "2", "1, 1"]) {
      const value = fixture();
      const logs: unknown[] = [];
      let admissions = 0;
      value.reservations.run = async () => {
        admissions++;
        throw new Error("unexpected-admission");
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
        request(
          {},
          path,
          version === undefined
            ? {}
            : { [WAGER_STORAGE_VERSION_HEADER]: version },
        ),
        guardedEnv,
        context,
        {
          ...value.dependencies,
          logFailure: (kind) => logs.push(kind),
          logCoordinationFailure: (record) => logs.push(record),
        },
      );
      assert.equal(response.status, 409);
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        "https://mons.link",
      );
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "client-update-required",
        message: "Reload this page to continue wagering.",
      });
      assert.equal(admissions, 0);
      assert.deepEqual(value.counts(), { reads: 0, snapshots: 0 });
      assert.deepEqual(logs, []);
    }
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

test("current wager clients still require reservation admission before domain work", async () => {
  const value = fixture();
  let admissions = 0;
  let domainReads = 0;
  value.repository.readInviteMetadata = async () => {
    domainReads++;
    throw new Error("unexpected-domain-work");
  };
  value.reservations.run = async () => {
    admissions++;
    throw new WagerReservationWritesDisabled();
  };
  const response = await handleGameplayRoute(
    request(
      { inviteId: "invite", matchId: "invite", material: "dust", count: 1 },
      "/wagers/proposals/send",
      { [WAGER_STORAGE_VERSION_HEADER]: WAGER_STORAGE_VERSION },
    ),
    environment,
    context,
    value.dependencies,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "wager-reservation-writes-disabled",
  });
  assert.equal(admissions, 1);
  assert.equal(domainReads, 0);
});

test("wager request validation finishes before unavailable reservation admission", async () => {
  for (const { body, rateLimited, status, admissions } of [
    { body: {}, rateLimited: false, status: 400, admissions: 0 },
    { body: {}, rateLimited: true, status: 429, admissions: 0 },
    {
      body: { inviteId: "invite", matchId: "invite" },
      rateLimited: false,
      status: 503,
      admissions: 1,
    },
  ]) {
    const value = fixture();
    let attempts = 0;
    value.reservations.run = async () => {
      attempts++;
      throw new AuthApiFailure(
        503,
        "unavailable",
        "wager-reservation-unavailable",
      );
    };
    const response = await handleGameplayRoute(
      request(body, "/wagers/outcomes/resolve", {
        [WAGER_STORAGE_VERSION_HEADER]: WAGER_STORAGE_VERSION,
      }),
      {
        ...environment,
        AUTH_RATE_LIMITER: { limit: async () => ({ success: !rateLimited }) },
      } as Env,
      context,
      value.dependencies,
    );
    assert.equal(response.status, status);
    assert.equal(attempts, admissions);
    assert.deepEqual(value.counts(), { reads: 0, snapshots: 0 });
  }
});

test("authentication still precedes wager client version validation", async () => {
  const value = fixture();
  const response = await handleGameplayRoute(
    request({}, "/wagers/proposals/send"),
    environment,
    context,
    {
      ...value.dependencies,
      verifyIdentity: async () => {
        throw new AuthApiFailure(401, "unauthenticated", "invalid-token");
      },
    },
  );
  assert.equal(response.status, 401);
  assert.equal(value.counts().reads, 0);
});

test("the initial match-state gate still precedes authentication and wager version validation", async () => {
  const value = fixture();
  let authentications = 0;
  const response = await handleGameplayRoute(
    request({}, "/wagers/proposals/send"),
    {
      ...environment,
      PROFILE_GAMES_DB: new Proxy(environment.PROFILE_GAMES_DB, {
        get(target, property) {
          if (property === "withSession")
            return () => {
              throw new Error("match-control-unavailable");
            };
          const current = Reflect.get(target, property, target);
          return typeof current === "function" ? current.bind(target) : current;
        },
      }),
    },
    context,
    {
      ...value.dependencies,
      verifyIdentity: async () => {
        authentications++;
        return { uid: "login" };
      },
    },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "match-state-control-unavailable",
  });
  assert.equal(authentications, 0);
  assert.deepEqual(value.counts(), { reads: 0, snapshots: 0 });
});
