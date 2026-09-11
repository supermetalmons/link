"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const bs58 = require("bs58");
const {
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID,
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID,
  COMPRESSED_PRIZES_EVENT_ID,
  EVENT_PRIZE_IDS,
  EVENT_PRIZE_REVEAL_WINDOW_MS,
  LEGACY_CORE_PRIZES_EVENT_ID,
  PLANET_PEPPA_PRIZES_EVENT_ID,
  RARE_WEITSMANS_PRIZES_EVENT_ID,
  SHELVES_PRIZES_EVENT_ID,
  VEHICLE_WAMMIN_PRIZES_EVENT_ID,
  getEventPrizeConfig,
  getEventPrizeDefinition,
  isEventPrizeAssignmentRecord,
  isEventPrizeAssignmentWireRecord,
  isEventPrizeEvent,
  isEventPrizeId,
  isEventPrizeRevealOpen,
  isProfileEventPrizesResponse,
  isEventPrizeStandard,
  isEventPrizeWithdrawalCompletedResponse,
  isEventPrizeWithdrawalProcessingResponse,
  isEventPrizeWithdrawalRequest,
  isEventPrizeWithdrawalStatusRequest,
  isToggleEventPrizeSelectionRequest,
} = require("@mons/shared/event-prizes");

test("reveals scheduled prizes only inside the final hour", () => {
  const nowMs = 10_000_000;
  assert.equal(EVENT_PRIZE_REVEAL_WINDOW_MS, 3_600_000);
  for (const [remainingMs, expected] of [
    [3_600_001, false],
    [3_600_000, false],
    [3_599_999, true],
    [0, true],
    [-1, true],
  ]) {
    assert.equal(
      isEventPrizeRevealOpen("scheduled", nowMs + remainingMs, nowMs),
      expected,
    );
  }
});

test("keeps active and ended prizes revealed and rejects invalid schedules", () => {
  for (const status of ["active", "ended"]) {
    assert.equal(isEventPrizeRevealOpen(status, 10_000_000, 0), true);
    assert.equal(isEventPrizeRevealOpen(status, null, 0), true);
  }
  for (const status of ["dismissed", "unknown", null, undefined]) {
    assert.equal(isEventPrizeRevealOpen(status, 0, 0), false);
  }
  for (const startAtMs of [null, undefined, "1000", NaN, Infinity]) {
    assert.equal(isEventPrizeRevealOpen("scheduled", startAtMs, 0), false);
  }
  assert.equal(isEventPrizeRevealOpen("scheduled", 1000, NaN), false);
  assert.equal(isEventPrizeRevealOpen("scheduled", 1000, Infinity), false);
});

test("withdrawal contracts require exact Worker request and response shapes", () => {
  const operationId = `epw_${"a".repeat(64)}`;
  const request = {
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    prizeId: "1092",
    solanaAddress: "11111111111111111111111111111111",
  };
  assert.equal(isEventPrizeWithdrawalRequest(request), true);
  assert.equal(
    isEventPrizeWithdrawalRequest({ ...request, extra: true }),
    false,
  );
  assert.equal(
    isEventPrizeWithdrawalStatusRequest({
      eventId: request.eventId,
      operationId,
      prizeId: request.prizeId,
    }),
    true,
  );
  const processing = {
    ok: true,
    status: "processing",
    operationId,
    eventId: request.eventId,
    prizeId: request.prizeId,
  };
  assert.equal(isEventPrizeWithdrawalProcessingResponse(processing), true);
  assert.equal(
    isEventPrizeWithdrawalCompletedResponse({
      ...processing,
      status: "completed",
      assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
      recipientAddress: request.solanaAddress,
      transactionSignature: "signature",
    }),
    true,
  );
});

test("profile prize responses preserve valid forward-compatible assignment fields", () => {
  const assignment = {
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    profileId: "profile-1",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 100,
    futureMetadata: { edition: 2, labels: ["winner"] },
  };
  assert.equal(isEventPrizeAssignmentRecord(assignment), true);
  assert.equal(
    isProfileEventPrizesResponse({
      ok: true,
      profileId: "profile-1",
      revision: 1,
      prizes: { [LEGACY_CORE_PRIZES_EVENT_ID]: assignment },
    }),
    true,
  );
  assert.equal(
    isEventPrizeAssignmentRecord({ ...assignment, prizeId: "unknown" }),
    false,
  );
  const futureAssignment = {
    ...assignment,
    eventId: "future-event",
    prizeId: "future-prize",
  };
  assert.equal(isEventPrizeAssignmentWireRecord(futureAssignment), true);
  assert.equal(
    isProfileEventPrizesResponse({
      ok: true,
      profileId: "profile-1",
      revision: 2,
      prizes: { "future-event": futureAssignment },
    }),
    true,
  );
  assert.equal(
    isEventPrizeAssignmentWireRecord({
      ...futureAssignment,
      prizeId: "bad/prize",
    }),
    false,
  );
  assert.equal(
    isEventPrizeAssignmentRecord({ ...assignment, futureMetadata: undefined }),
    false,
  );
});

test("preserves the legacy Core prize catalog", () => {
  const config = getEventPrizeConfig(LEGACY_CORE_PRIZES_EVENT_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageWidth: prize.imageWidth,
      imageHeight: prize.imageHeight,
      collectionAddress: prize.collectionAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "1092",
        imageWidth: 420,
        imageHeight: 525,
        collectionAddress: "2xF7dq3maFLud8FQUYAyLiWucdF7RePyzHJs7NkurkoD",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "1111",
        imageWidth: 420,
        imageHeight: 525,
        collectionAddress: "2xF7dq3maFLud8FQUYAyLiWucdF7RePyzHJs7NkurkoD",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "1514",
        imageWidth: 420,
        imageHeight: 525,
        collectionAddress: "2xF7dq3maFLud8FQUYAyLiWucdF7RePyzHJs7NkurkoD",
        standard: "core",
        claimAvailable: true,
      },
    ],
  );
});

test("maps the compressed event to the supplied prizes in fallback order", () => {
  const config = getEventPrizeConfig(COMPRESSED_PRIZES_EVENT_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageUrl: prize.imageUrl,
      imageWidth: prize.imageWidth,
      imageHeight: prize.imageHeight,
      assetAddress: prize.assetAddress,
      collectionAddress: prize.collectionAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "1866",
        imageUrl: "https://cdn.lil.org/nft/card_nft/1866.webp",
        imageWidth: 776,
        imageHeight: 1098,
        assetAddress: "2KNT8rbXC7G8w5AChbEHHi6i4FN7EAZCtdWX65ZSuQp6",
        collectionAddress: "HpGDYGz6aRUs5qbvp1dmWGKTicQctX4PixfcouAQDCHF",
        standard: "compressed",
        claimAvailable: true,
      },
      {
        id: "1682",
        imageUrl: "https://cdn.lil.org/nft/card_nft/1682.webp",
        imageWidth: 776,
        imageHeight: 1098,
        assetAddress: "AzQvo7HgBQYiP4bK314QQTsdRKCY98gK9bxrXNMZAeMA",
        collectionAddress: "HpGDYGz6aRUs5qbvp1dmWGKTicQctX4PixfcouAQDCHF",
        standard: "compressed",
        claimAvailable: true,
      },
      {
        id: "6793",
        imageUrl: "https://cdn.lil.org/nft/card_nft/6793.webp",
        imageWidth: 776,
        imageHeight: 1098,
        assetAddress: "CHDbyCecsFmLa9sQrMRz7xBbCs2JALbM4LXB35bv1CU",
        collectionAddress: "HpGDYGz6aRUs5qbvp1dmWGKTicQctX4PixfcouAQDCHF",
        standard: "compressed",
        claimAvailable: true,
      },
    ],
  );
  assert.equal(
    getEventPrizeDefinition(COMPRESSED_PRIZES_EVENT_ID, "1092"),
    null,
  );
  assert.deepEqual(EVENT_PRIZE_IDS, [
    "1092",
    "1111",
    "1514",
    "1866",
    "1682",
    "6793",
    "282",
    "283",
    "280",
    "281",
    "279",
    "284",
    "217",
    "220",
    "221",
    "3727",
    "3728",
    "3729",
    "865",
    "1643",
    "1213",
    "1241",
    "443",
    "1274",
  ]);
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
  }
});

test("maps the Artifact Magazine 3 event to claimable Core prizes", () => {
  const config = getEventPrizeConfig(ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageUrl: prize.imageUrl,
      imageWidth: prize.imageWidth,
      imageHeight: prize.imageHeight,
      assetAddress: prize.assetAddress,
      collectionAddress: prize.collectionAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "282",
        imageUrl: "https://cdn.lil.org/player/artifact_magazine_3/mid/282.webp",
        imageWidth: 1320,
        imageHeight: 1320,
        assetAddress: "88taYXAaCEmStoLNYiZC6sRSsakDrATpiVtviBTqebxi",
        collectionAddress: "36NQDyvCBqg4N1z5mZi2i4nW1K9ELdzmntMMKnqbChVZ",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "283",
        imageUrl: "https://cdn.lil.org/player/artifact_magazine_3/mid/283.webp",
        imageWidth: 1320,
        imageHeight: 1320,
        assetAddress: "29e8p9KMcZgaMZmmMseptz3pAdvQwT4hzhvr5C9NxUbu",
        collectionAddress: "36NQDyvCBqg4N1z5mZi2i4nW1K9ELdzmntMMKnqbChVZ",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "280",
        imageUrl: "https://cdn.lil.org/player/artifact_magazine_3/mid/280.webp",
        imageWidth: 1320,
        imageHeight: 1320,
        assetAddress: "6H1UzLgUm3yW6nzFQVFnsMs3MTRpv5BtyDMfp97XcqqV",
        collectionAddress: "36NQDyvCBqg4N1z5mZi2i4nW1K9ELdzmntMMKnqbChVZ",
        standard: "core",
        claimAvailable: true,
      },
    ],
  );
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
  }
});

test("maps the second Artifact Magazine 3 event to claimable Core prizes", () => {
  const config = getEventPrizeConfig(ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageUrl: prize.imageUrl,
      imageWidth: prize.imageWidth,
      imageHeight: prize.imageHeight,
      assetAddress: prize.assetAddress,
      collectionAddress: prize.collectionAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "281",
        imageUrl: "https://cdn.lil.org/player/artifact_magazine_3/mid/281.webp",
        imageWidth: 1320,
        imageHeight: 1320,
        assetAddress: "7Bx4AxqugjJUYvR2AS8ggduSEjbf2kMcLP5T6dSVZLP9",
        collectionAddress: "36NQDyvCBqg4N1z5mZi2i4nW1K9ELdzmntMMKnqbChVZ",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "279",
        imageUrl: "https://cdn.lil.org/player/artifact_magazine_3/mid/279.webp",
        imageWidth: 1320,
        imageHeight: 1320,
        assetAddress: "FQhpFRVkJAg2hMoQn62Xo9UjuJuzideuiKB22nbNrQr9",
        collectionAddress: "36NQDyvCBqg4N1z5mZi2i4nW1K9ELdzmntMMKnqbChVZ",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "284",
        imageUrl: "https://cdn.lil.org/player/artifact_magazine_3/mid/284.webp",
        imageWidth: 1320,
        imageHeight: 1320,
        assetAddress: "H7SFR6CSyZYcfpvF4rSoDDfuj2TMiwfqUuyXzS2tLvXa",
        collectionAddress: "36NQDyvCBqg4N1z5mZi2i4nW1K9ELdzmntMMKnqbChVZ",
        standard: "core",
        claimAvailable: true,
      },
    ],
  );
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
  }
});

test("maps the Rare Weitsmans event to claimable Core prizes", () => {
  const config = getEventPrizeConfig(RARE_WEITSMANS_PRIZES_EVENT_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageUrl: prize.imageUrl,
      imageWidth: prize.imageWidth,
      imageHeight: prize.imageHeight,
      assetAddress: prize.assetAddress,
      collectionAddress: prize.collectionAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "217",
        imageUrl: "https://cdn.lil.org/player/rare_weitsmans/mid/217.webp",
        imageWidth: 1024,
        imageHeight: 1024,
        assetAddress: "EW4bmQognpFTCuM28UcZAk2BWkXZuyDroWXEcKPbZxBg",
        collectionAddress: "3Rb9mG22dkAFVA8PVRgD76SiHUwUTK38Kq55NkrZuR2k",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "220",
        imageUrl: "https://cdn.lil.org/player/rare_weitsmans/mid/220.webp",
        imageWidth: 1024,
        imageHeight: 1024,
        assetAddress: "qkG4PiwDKbpYiVorrvPyGCi7163EpPbk9xHw5rincmu",
        collectionAddress: "3Rb9mG22dkAFVA8PVRgD76SiHUwUTK38Kq55NkrZuR2k",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "221",
        imageUrl: "https://cdn.lil.org/player/rare_weitsmans/mid/221.webp",
        imageWidth: 1024,
        imageHeight: 1024,
        assetAddress: "Ag6U9kBe6aPJyMtEzEqDpnGnmejBvAjPGFSPhXCW9Ba4",
        collectionAddress: "3Rb9mG22dkAFVA8PVRgD76SiHUwUTK38Kq55NkrZuR2k",
        standard: "core",
        claimAvailable: true,
      },
    ],
  );
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
  }
});

test("maps the Planet Peppa event to claimable Core prizes", () => {
  const config = getEventPrizeConfig(PLANET_PEPPA_PRIZES_EVENT_ID);
  assert.equal(PLANET_PEPPA_PRIZES_EVENT_ID, "z3oj52Iiime");
  assert.equal(config.eventId, PLANET_PEPPA_PRIZES_EVENT_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageUrl: prize.imageUrl,
      imageWidth: prize.imageWidth,
      imageHeight: prize.imageHeight,
      assetAddress: prize.assetAddress,
      collectionAddress: prize.collectionAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "3727",
        imageUrl: "https://cdn.lil.org/player/planet_peppa/3727.webp",
        imageWidth: 1200,
        imageHeight: 1200,
        assetAddress: "DL9oCFuvGJghtzQLkffqgAMXGJadvCDYqzEVLYhazhHj",
        collectionAddress: "9irtKRLZkY4MjFFQNZPX3o6ZTszfR8kXFJXPBUvEDo9v",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "3728",
        imageUrl: "https://cdn.lil.org/player/planet_peppa/3728.webp",
        imageWidth: 1200,
        imageHeight: 1200,
        assetAddress: "4UAXpjnE67yzhNhm8k4VpSTWX8ssPTv3AzBmd9qLPnDM",
        collectionAddress: "9irtKRLZkY4MjFFQNZPX3o6ZTszfR8kXFJXPBUvEDo9v",
        standard: "core",
        claimAvailable: true,
      },
      {
        id: "3729",
        imageUrl: "https://cdn.lil.org/player/planet_peppa/3729.webp",
        imageWidth: 1200,
        imageHeight: 1200,
        assetAddress: "2M3NjoXRpK1irpGhwz65GHNeryv5TwqfAovEPCA5SX8A",
        collectionAddress: "9irtKRLZkY4MjFFQNZPX3o6ZTszfR8kXFJXPBUvEDo9v",
        standard: "core",
        claimAvailable: true,
      },
    ],
  );
  assert.equal(isEventPrizeEvent(PLANET_PEPPA_PRIZES_EVENT_ID), true);
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
    assert.equal(bs58.default.decode(prize.collectionAddress).length, 32);
    assert.equal(isEventPrizeId(PLANET_PEPPA_PRIZES_EVENT_ID, prize.id), true);
    assert.equal(
      isEventPrizeId(RARE_WEITSMANS_PRIZES_EVENT_ID, prize.id),
      false,
    );
    assert.equal(
      isToggleEventPrizeSelectionRequest({
        eventId: PLANET_PEPPA_PRIZES_EVENT_ID,
        prizeId: prize.id,
      }),
      true,
    );
  }
  for (const prizeId of ["217", "unknown", " 3727 "]) {
    assert.equal(isEventPrizeId(PLANET_PEPPA_PRIZES_EVENT_ID, prizeId), false);
    assert.equal(
      isToggleEventPrizeSelectionRequest({
        eventId: PLANET_PEPPA_PRIZES_EVENT_ID,
        prizeId,
      }),
      false,
    );
  }
});

for (const {
  eventId,
  expectedEventId,
  collectionName,
  imageWidth,
  imageHeight,
  collectionAddress,
  prizes,
  otherEventId,
  otherPrizeId,
} of [
  {
    eventId: SHELVES_PRIZES_EVENT_ID,
    expectedEventId: "Q7uRdLXyVKF",
    collectionName: "Shelves",
    imageWidth: 1320,
    imageHeight: 1951,
    collectionAddress: "BsnjB6xDv2HNenoZiNFDE1uMZVj86ciXwYAX75nUTDSt",
    prizes: [
      {
        id: "865",
        imageUrl: "https://cdn.lil.org/player/shelves/mid/865.webp",
        assetAddress: "BuAjut5Ks3Yz3PKsrCjKxsk7B5bDBSJzjXQRTarbwkwD",
      },
      {
        id: "1643",
        imageUrl: "https://cdn.lil.org/player/shelves/mid/1643.webp",
        assetAddress: "7H1vUoGWLxpgGqDJsH1Nr1tmQTFQKE7yWnRqyXAuFuvj",
      },
      {
        id: "1213",
        imageUrl: "https://cdn.lil.org/player/shelves/mid/1213.webp",
        assetAddress: "2bRdHBoJUtYfYBzpmWbQD5hqkpypjk43i2AiGJwc2UaN",
      },
    ],
    otherEventId: VEHICLE_WAMMIN_PRIZES_EVENT_ID,
    otherPrizeId: "1241",
  },
  {
    eventId: VEHICLE_WAMMIN_PRIZES_EVENT_ID,
    expectedEventId: "wjFa2d03Ciu",
    collectionName: "Vehicle Wammin",
    imageWidth: 1000,
    imageHeight: 1000,
    collectionAddress: "BBkMWyu4RRrNSdjGDV27FGgZZ58o7jfvQY1MrD2iTfs6",
    prizes: [
      {
        id: "1241",
        imageUrl: "https://cdn.lil.org/player/vehicle_wammin/mid/1241.webp",
        assetAddress: "5hNqZsyBS4fJvUAyUEmmD1mn23B8D8nQQKJ9b55ZZSJE",
      },
      {
        id: "443",
        imageUrl: "https://cdn.lil.org/player/vehicle_wammin/mid/443.webp",
        assetAddress: "Bvr7KVjxHvbx91Y6oXDqZFuVh88Amtwpy5MHPYhvrjX4",
      },
      {
        id: "1274",
        imageUrl: "https://cdn.lil.org/player/vehicle_wammin/mid/1274.webp",
        assetAddress: "Fzz4SWp9LDbMv17MmL1KV4odb1DJ4sJys6w91NaWLsEW",
      },
    ],
    otherEventId: SHELVES_PRIZES_EVENT_ID,
    otherPrizeId: "865",
  },
]) {
  test(`maps the ${collectionName} event to the supplied claimable compressed prizes`, () => {
    const config = getEventPrizeConfig(eventId);
    assert.equal(eventId, expectedEventId);
    assert.equal(config.eventId, eventId);
    assert.equal(config.collectionName, collectionName);
    assert.deepEqual(
      config.prizes.map((prize) => ({
        id: prize.id,
        imageUrl: prize.imageUrl,
        imageWidth: prize.imageWidth,
        imageHeight: prize.imageHeight,
        assetAddress: prize.assetAddress,
        collectionAddress: prize.collectionAddress,
        standard: prize.standard,
        claimAvailable: prize.claimAvailable,
      })),
      prizes.map((prize) => ({
        ...prize,
        imageWidth,
        imageHeight,
        collectionAddress,
        standard: "compressed",
        claimAvailable: true,
      })),
    );
    assert.equal(isEventPrizeEvent(eventId), true);
    for (const prize of config.prizes) {
      assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
      assert.equal(bs58.default.decode(prize.collectionAddress).length, 32);
      assert.equal(isEventPrizeId(eventId, prize.id), true);
      assert.equal(isEventPrizeId(otherEventId, prize.id), false);
      assert.equal(
        isToggleEventPrizeSelectionRequest({ eventId, prizeId: prize.id }),
        true,
      );
      assert.equal(
        isEventPrizeWithdrawalRequest({
          eventId,
          prizeId: prize.id,
          solanaAddress: "11111111111111111111111111111111",
        }),
        true,
      );
    }
    for (const prizeId of [otherPrizeId, "unknown", ` ${prizes[0].id} `]) {
      assert.equal(isEventPrizeId(eventId, prizeId), false);
      assert.equal(
        isToggleEventPrizeSelectionRequest({ eventId, prizeId }),
        false,
      );
    }
  });
}

test("catalog membership rejects inherited keys and padded IDs", () => {
  for (const eventId of ["constructor", "toString", "__proto__"]) {
    assert.equal(getEventPrizeConfig(eventId), null);
    assert.equal(isEventPrizeEvent(eventId), false);
  }
  assert.equal(isEventPrizeEvent(` ${COMPRESSED_PRIZES_EVENT_ID} `), false);
  assert.equal(isEventPrizeId(COMPRESSED_PRIZES_EVENT_ID, " 1866 "), false);
  assert.equal(
    getEventPrizeDefinition(COMPRESSED_PRIZES_EVENT_ID, " 1866 ")?.id,
    "1866",
  );
});

test("recognizes only supported event prize standards", () => {
  assert.equal(isEventPrizeStandard("core"), true);
  assert.equal(isEventPrizeStandard("compressed"), true);
  assert.equal(isEventPrizeStandard(" core "), false);
  assert.equal(isEventPrizeStandard("unknown"), false);
  assert.equal(isEventPrizeStandard(null), false);
});
