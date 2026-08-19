import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_PROFILE_FIELDS,
  createProfileRepository,
  LEADERBOARD_ENTRY_LIMIT,
  MAX_PROFILE_RESPONSE_BODY_BYTES,
  PROFILE_CARD_FIELDS,
  PROFILE_LOOKUP_FIELDS,
  PROFILE_MERGE_REDIRECT_LIMIT,
  parseProfileDocument,
  ProfileRepositoryFailure,
} from "../src/profileRepository.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stringValue(value: string) {
  return { stringValue: value };
}

function integerValue(value: number) {
  return { integerValue: String(value) };
}

function profileDocument(
  profileId = "profile-1",
  fields: Record<string, unknown> = {},
) {
  return {
    name: `projects/mons-link/databases/(default)/documents/users/${profileId}`,
    fields,
  };
}

function completeProfileDocument(profileId = "profile-1") {
  return profileDocument(profileId, {
    username: stringValue("alice"),
    eth: stringValue("0xabc"),
    sol: stringValue("solana"),
    rating: { doubleValue: 1512.5 },
    nonce: integerValue(4),
    totalManaPoints: integerValue(91),
    win: { booleanValue: false },
    feb2026UniqueOpponentsCount: integerValue(7),
    custom: {
      mapValue: {
        fields: {
          emoji: stringValue("12"),
          aura: stringValue("rainbow"),
          cardBackgroundId: integerValue(3),
          cardSubtitleId: integerValue(4),
          profileCounter: stringValue("mp"),
          profileMons: stringValue("1,2"),
          cardStickers: stringValue("{}"),
          completedProblems: {
            arrayValue: { values: [stringValue("one"), stringValue("two")] },
          },
          tutorialCompleted: { booleanValue: true },
        },
      },
    },
    mining: {
      mapValue: {
        fields: {
          lastRockDate: stringValue("2026-08-18"),
          materials: {
            mapValue: {
              fields: {
                dust: integerValue(1),
                slime: integerValue(2),
                gum: integerValue(3),
                metal: integerValue(4),
                ice: integerValue(5),
              },
            },
          },
        },
      },
    },
  });
}

test("parses exact profile fields, defaults, and tutorial visibility", () => {
  assert.deepEqual(parseProfileDocument(completeProfileDocument(), true), {
    mergedIntoProfileId: null,
    profile: {
      id: "profile-1",
      nonce: 4,
      rating: 1512.5,
      totalManaPoints: 91,
      win: false,
      emoji: "12",
      aura: "rainbow",
      cardBackgroundId: 3,
      cardSubtitleId: 4,
      profileCounter: "mp",
      profileMons: "1,2",
      cardStickers: "{}",
      username: "alice",
      eth: "0xabc",
      sol: "solana",
      feb2026UniqueOpponentsCount: 7,
      completedProblemIds: ["one", "two"],
      isTutorialCompleted: true,
      mining: {
        lastRockDate: "2026-08-18",
        materials: { dust: 1, slime: 2, gum: 3, metal: 4, ice: 5 },
      },
    },
  });

  const fallback = parseProfileDocument(profileDocument("A"), false).profile;
  assert.deepEqual(fallback, {
    id: "A",
    nonce: -1,
    rating: 1500,
    totalManaPoints: 0,
    win: true,
    emoji: "66",
    username: null,
    eth: null,
    sol: null,
    feb2026UniqueOpponentsCount: 0,
    mining: {
      lastRockDate: null,
      materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
    },
  });
  assert.equal(Object.hasOwn(fallback, "completedProblemIds"), false);
  assert.deepEqual(
    parseProfileDocument(
      profileDocument("empty-array", {
        custom: {
          mapValue: {
            fields: { completedProblems: { arrayValue: {} } },
          },
        },
      }),
      true,
    ).profile.completedProblemIds,
    [],
  );
  assert.throws(() => parseProfileDocument({}, true), ProfileRepositoryFailure);
});

test("runs exact authenticated login and leaderboard queries", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const responses = [
    jsonResponse([{ document: completeProfileDocument() }]),
    jsonResponse([{ document: completeProfileDocument("profile-2") }]),
    jsonResponse([{ document: completeProfileDocument("profile-3") }]),
    jsonResponse([{ document: completeProfileDocument("profile-4") }]),
  ];
  const repository = createProfileRepository({
    fetcher: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  });

  assert.equal(
    (await repository.getProfileByLoginId("login-1", "firebase-token"))?.id,
    "profile-1",
  );
  assert.equal(
    (await repository.readLeaderboard("rating", "firebase-token"))[0].id,
    "profile-2",
  );
  assert.equal(
    (await repository.readLeaderboard("mp", "firebase-token"))[0].id,
    "profile-3",
  );
  assert.equal(
    (await repository.readLeaderboard("dust", "firebase-token"))[0].id,
    "profile-4",
  );

  for (const request of requests) {
    assert.equal(
      new Headers(request.init.headers).get("Authorization"),
      "Bearer firebase-token",
    );
    assert.ok(request.init.signal instanceof AbortSignal);
  }
  const loginQuery = JSON.parse(String(requests[0].init.body)).structuredQuery;
  assert.deepEqual(loginQuery.select.fields, [
    ...PROFILE_LOOKUP_FIELDS.map((fieldPath) => ({ fieldPath })),
  ]);
  assert.deepEqual(loginQuery.where, {
    fieldFilter: {
      field: { fieldPath: "logins" },
      op: "ARRAY_CONTAINS",
      value: { stringValue: "login-1" },
    },
  });
  assert.equal(loginQuery.limit, 1);

  const expectedOrders = ["rating", "totalManaPoints", "mining.materials.dust"];
  assert.equal(
    BASE_PROFILE_FIELDS.some((field) =>
      PROFILE_CARD_FIELDS.includes(field as never),
    ),
    false,
  );
  assert.equal(
    PROFILE_CARD_FIELDS.every((field) => PROFILE_LOOKUP_FIELDS.includes(field)),
    true,
  );
  for (let index = 1; index < requests.length; index++) {
    const query = JSON.parse(String(requests[index].init.body)).structuredQuery;
    assert.deepEqual(query.select.fields, [
      ...BASE_PROFILE_FIELDS.map((fieldPath) => ({ fieldPath })),
    ]);
    assert.deepEqual(query.orderBy, [
      {
        field: { fieldPath: expectedOrders[index - 1] },
        direction: "DESCENDING",
      },
    ]);
    assert.equal(query.limit, LEADERBOARD_ENTRY_LIMIT);
  }
});

test("follows bounded profile redirects and returns null for missing or cyclic data", async () => {
  const requestedIds: string[] = [];
  const documents = new Map<string, Response>([
    [
      "source",
      jsonResponse(
        profileDocument("source", {
          mergedIntoProfileId: stringValue("target"),
        }),
      ),
    ],
    ["target", jsonResponse(completeProfileDocument("target"))],
  ]);
  const repository = createProfileRepository({
    fetcher: async (input) => {
      const pathname = new URL(String(input)).pathname;
      const id = pathname.split("/").pop() || "";
      requestedIds.push(id);
      return documents.get(id) || new Response(null, { status: 404 });
    },
  });
  assert.equal(
    (await repository.getProfileById("source", "token"))?.id,
    "target",
  );
  assert.deepEqual(requestedIds, ["source", "target"]);
  assert.equal(await repository.getProfileById("missing", "token"), null);

  const cycle = createProfileRepository({
    fetcher: async (input) => {
      const id = new URL(String(input)).pathname.split("/").pop() || "";
      const next = id === "a" ? "b" : "a";
      return jsonResponse(
        profileDocument(id, { mergedIntoProfileId: stringValue(next) }),
      );
    },
  });
  assert.equal(await cycle.getProfileById("a", "token"), null);

  let reads = 0;
  const excessive = createProfileRepository({
    fetcher: async () => {
      const id = `profile-${reads}`;
      reads++;
      return jsonResponse(
        profileDocument(id, {
          mergedIntoProfileId: stringValue(`profile-${reads}`),
        }),
      );
    },
  });
  assert.equal(await excessive.getProfileById("profile-0", "token"), null);
  assert.equal(reads, PROFILE_MERGE_REDIRECT_LIMIT + 1);
});

test("fails closed for rejected, oversized, malformed, and unavailable Firestore reads", async () => {
  const fetchers: Array<typeof fetch> = [
    async () => new Response("private", { status: 403 }),
    async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Length": String(MAX_PROFILE_RESPONSE_BODY_BYTES + 1),
        },
      }),
    async () => jsonResponse({}),
    async () => {
      throw new Error("private-network-detail");
    },
  ];
  for (const fetcher of fetchers) {
    const repository = createProfileRepository({ fetcher });
    await assert.rejects(
      repository.readLeaderboard("rating", "token"),
      ProfileRepositoryFailure,
    );
  }
});
