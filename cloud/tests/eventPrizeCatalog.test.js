"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const bs58 = require("bs58");
const {
  AAHNGEEZ_PRIZES_EVENT_ID,
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID,
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID,
  CAKES_PRIZES_EVENT_ID,
  CARD_NFT_2_PRIZES_EVENT_ID,
  COMPRESSED_PRIZES_EVENT_ID,
  EVENT_PRIZE_REVEAL_WINDOW_MS,
  FLOPAWRETTES_PRIZES_EVENT_ID,
  LEGACY_CORE_PRIZES_EVENT_ID,
  MI_NOTE_CARDS_PRIZES_EVENT_ID,
  PEER_STUDY_3_AFELLA_2_PRIZES_EVENT_ID,
  PICKME_PORTS_PRIZES_EVENT_ID,
  PLANET_PEPPA_PRIZES_EVENT_ID,
  PLASTIC_FOOLS_POCKET_PRIZES_EVENT_ID,
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
  for (const [remainingMs, expected] of /** @type {[number, boolean][]} */ ([
    [3_600_001, false],
    [3_600_000, false],
    [3_599_999, true],
    [0, true],
    [-1, true],
  ])) {
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

test("profile prize responses retain exact historical assignment records and reject extensions", () => {
  const assignment = {
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    profileId: "profile-1",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 100,
  };
  assert.equal(isEventPrizeAssignmentRecord(assignment), true);
  assert.equal(
    isEventPrizeAssignmentWireRecord({
      ...assignment,
      futureMetadata: { edition: 2 },
    }),
    false,
  );
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
  assert.ok(config);
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
  assert.ok(config);
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
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
  }
});

test("maps the Artifact Magazine 3 event to claimable Core prizes", () => {
  const config = getEventPrizeConfig(ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID);
  assert.ok(config);
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
  assert.ok(config);
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
  assert.ok(config);
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
  assert.ok(config);
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
  standard = "compressed",
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
  {
    eventId: FLOPAWRETTES_PRIZES_EVENT_ID,
    expectedEventId: "5ng5odunECw",
    collectionName: "Flopawrettes",
    imageWidth: 1320,
    imageHeight: 1320,
    collectionAddress: "GVQ4Zsd7jLZbVCxq9QsmQySuKekwT1XbMSjGbwt8UtcB",
    standard: "compressed",
    prizes: [
      {
        id: "3749",
        imageUrl: "https://cdn.lil.org/player/flopawrettes/mid/3749.webp",
        assetAddress: "75afTvStdxeBH9fu6yCqCA4KjCGBaTEBwrsBkDjw3XUp",
      },
      {
        id: "4174",
        imageUrl: "https://cdn.lil.org/player/flopawrettes/mid/4174.webp",
        assetAddress: "ANti2h6Kev9e7rwb5P4Ri6gzPQzLoYbn54u2H6j52G18",
      },
      {
        id: "1173",
        imageUrl: "https://cdn.lil.org/player/flopawrettes/mid/1173.webp",
        assetAddress: "E1p7AXeJuUhiifU8YzkXnG3XAc8HTJFUhozypgH3dNUx",
      },
    ],
    otherEventId: LEGACY_CORE_PRIZES_EVENT_ID,
    otherPrizeId: "1092",
  },
  {
    eventId: PEER_STUDY_3_AFELLA_2_PRIZES_EVENT_ID,
    expectedEventId: "qIU70H3CbPK",
    collectionName: "peer study 3: afella 2",
    imageWidth: 1280,
    imageHeight: 1350,
    collectionAddress: "Aa3Y3VDvEyLWqmy8DtBdWYp3oE9obkp3L1KjmAvpjCPs",
    standard: "core",
    prizes: [
      {
        id: "228",
        imageUrl:
          "https://cdn.lil.org/player/peer_study_3_afella_2/mid/228.webp",
        assetAddress: "3KE4xCWLFBgojg4cjS4W38RZ8qibcBhw8ZDVJoagxc5F",
      },
      {
        id: "184",
        imageUrl:
          "https://cdn.lil.org/player/peer_study_3_afella_2/mid/184.webp",
        assetAddress: "AZzKBZfWMZeEDkQ6RgsDCvcez6AZ3dXHURTNFx3t7E94",
      },
      {
        id: "339",
        imageUrl:
          "https://cdn.lil.org/player/peer_study_3_afella_2/mid/339.webp",
        assetAddress: "B78KRQDzFHC94d15Kb8SufGHU9yVLTNfamg4mDpRrv1q",
      },
    ],
    otherEventId: LEGACY_CORE_PRIZES_EVENT_ID,
    otherPrizeId: "1092",
  },
  {
    eventId: CAKES_PRIZES_EVENT_ID,
    expectedEventId: "2nsvrAIktOL",
    collectionName: "Cakes",
    imageWidth: 1254,
    imageHeight: 1254,
    collectionAddress: "FeMQ2kvc9m8F9QYY1xHjaAP1kbuqhjkUexEiV1GrXpdy",
    standard: "core",
    prizes: [
      {
        id: "17",
        imageUrl: "https://cdn.lil.org/player/cakes/mid/16.webp",
        assetAddress: "2DAqsy664vHq2iWu1P81tru1y7v5sBHmn5RmFwoZAihi",
      },
      {
        id: "13",
        imageUrl: "https://cdn.lil.org/player/cakes/mid/12.webp",
        assetAddress: "5mnW3aUjUv2suFxxW81uTB4xdvxp9d2P9ELH6m4obQG5",
      },
      {
        id: "15",
        imageUrl: "https://cdn.lil.org/player/cakes/mid/14.webp",
        assetAddress: "JDom93J7sekaYZJa5XGSZwC88pJzD1b8mtMSai7whtTP",
      },
    ],
    otherEventId: LEGACY_CORE_PRIZES_EVENT_ID,
    otherPrizeId: "1092",
  },
  {
    eventId: PLASTIC_FOOLS_POCKET_PRIZES_EVENT_ID,
    expectedEventId: "UwPzJ260AZK",
    collectionName: "Plastic Fools Pocket",
    imageWidth: 1024,
    imageHeight: 1024,
    collectionAddress: "3cWeEpg9FV1MKe7m13L75FWpo3Xppeegk8EpQDMcgRoB",
    standard: "core",
    prizes: [
      {
        id: "100",
        imageUrl: "https://cdn.lil.org/player/plastic_fools_pocket/mid/99.webp",
        assetAddress: "4EhpxbpmNsBoMn7nxPZmRg7jrNoN2Y16hw1PtBBGYpvx",
      },
      {
        id: "914",
        imageUrl:
          "https://cdn.lil.org/player/plastic_fools_pocket/mid/913.webp",
        assetAddress: "4Pp8BRXsLmdM2iHd6Fw2A2Ri7Yft4DUWd2vfmJV6qXad",
      },
      {
        id: "1015",
        imageUrl:
          "https://cdn.lil.org/player/plastic_fools_pocket/mid/1014.webp",
        assetAddress: "GLMB1sZQMGnRhcxAA6Qk9FaNzUVEyr3Np3Yd7FmGbhLp",
      },
    ],
    otherEventId: LEGACY_CORE_PRIZES_EVENT_ID,
    otherPrizeId: "1092",
  },
  {
    eventId: CARD_NFT_2_PRIZES_EVENT_ID,
    expectedEventId: "CkPMtNHthaT",
    collectionName: "Card NFT 2",
    imageWidth: 2000,
    imageHeight: 2800,
    collectionAddress: "EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu",
    standard: "core",
    prizes: [
      {
        id: "2046",
        imageUrl: "https://cdn.lil.org/nft/card_nft_2/fronts/2046.webp",
        assetAddress: "5mZxuSmp2EEeG7KLn9RdabnqkQyg1NWGYFNReQKkSG4",
      },
      {
        id: "5121",
        imageUrl: "https://cdn.lil.org/nft/card_nft_2/fronts/5121.webp",
        assetAddress: "7HYrooRJxz9sKr1ocoFEnq6xbxgupn4Y2HQoewZsgogM",
      },
      {
        id: "462",
        imageUrl: "https://cdn.lil.org/nft/card_nft_2/fronts/0462.webp",
        assetAddress: "8jgKBxfUY8wjTYVryFgqTomwb8aMzCwCysf8QCDKnhcT",
      },
    ],
    otherEventId: LEGACY_CORE_PRIZES_EVENT_ID,
    otherPrizeId: "1092",
  },
  {
    eventId: PICKME_PORTS_PRIZES_EVENT_ID,
    expectedEventId: "3m2w0beABCy",
    collectionName: "pick-me ports",
    imageWidth: 512,
    imageHeight: 512,
    collectionAddress: "8fV6BUnbh8cQ8EduumqG61SQqSepNeB5RFiZWJhYfi2L",
    standard: "compressed",
    prizes: [
      {
        id: "298",
        imageUrl: "https://cdn.lil.org/player/pickme_ports/mid/298.webp",
        assetAddress: "3yPKbXsVhcEuYSPXzPFisfwegv8QPDBCF9ArRLZnCxPn",
      },
      {
        id: "894",
        imageUrl: "https://cdn.lil.org/player/pickme_ports/mid/894.webp",
        assetAddress: "AYbsi5AuoRforjFUSBvnZCHyrPMV3m96GnZrUVTwwrJX",
      },
      {
        id: "1031",
        imageUrl: "https://cdn.lil.org/player/pickme_ports/mid/1031.webp",
        assetAddress: "C4ChjETrbuRUmh7Y9Nwbe9DF3PqVwUHuFsoAA3ncYUMm",
      },
    ],
    otherEventId: LEGACY_CORE_PRIZES_EVENT_ID,
    otherPrizeId: "1092",
  },
  {
    eventId: AAHNGEEZ_PRIZES_EVENT_ID,
    expectedEventId: "rNup5dmTakA",
    collectionName: "aahngeez!",
    imageWidth: 1024,
    imageHeight: 1024,
    collectionAddress: "CBNqKUciGnsJRhpDgfUbqu8XitKR2r5J3sUbXXSE7xwQ",
    standard: "core",
    prizes: [
      {
        id: "172",
        imageUrl: "https://cdn.lil.org/player/aahngeez/mid/171.webp",
        assetAddress: "Ba5ef8LsDe9RMUHN7NUM2nT2bKL7tGWUYzghPZYXqTTz",
      },
      {
        id: "104",
        imageUrl: "https://cdn.lil.org/player/aahngeez/mid/103.webp",
        assetAddress: "FpuTgMQmE7CgfydccVJUeqPSJ8FiWFV9fd7ZUHyAijVd",
      },
      {
        id: "149",
        imageUrl: "https://cdn.lil.org/player/aahngeez/mid/148.webp",
        assetAddress: "Gobt7FbyxbhnUNzQxT85sGrifJe9pqCNe1TZ8bePTgkB",
      },
    ],
    otherEventId: LEGACY_CORE_PRIZES_EVENT_ID,
    otherPrizeId: "1092",
  },
]) {
  test(`maps the ${collectionName} event to the supplied claimable ${standard} prizes`, () => {
    const config = getEventPrizeConfig(eventId);
    assert.ok(config);
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
        standard,
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
    assert.ok(prizes[0]);
    for (const prizeId of [otherPrizeId, "unknown", ` ${prizes[0].id} `]) {
      assert.equal(isEventPrizeId(eventId, prizeId), false);
      assert.equal(
        isToggleEventPrizeSelectionRequest({ eventId, prizeId }),
        false,
      );
      assert.equal(
        isEventPrizeWithdrawalRequest({
          eventId,
          prizeId,
          solanaAddress: "11111111111111111111111111111111",
        }),
        false,
      );
    }
  });
}

test("maps MI Note Cards to claimable Core prizes with separate Telegram images", () => {
  const eventId = MI_NOTE_CARDS_PRIZES_EVENT_ID;
  const config = getEventPrizeConfig(eventId);
  assert.ok(config);
  assert.equal(eventId, "vMBZ6dI1dQ5");
  assert.equal(config.eventId, eventId);
  assert.equal(config.collectionName, "Mi Note Cards");
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageUrl: prize.imageUrl,
      telegramImageUrl: prize.telegramImageUrl,
      imageWidth: prize.imageWidth,
      imageHeight: prize.imageHeight,
      assetAddress: prize.assetAddress,
      collectionAddress: prize.collectionAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "561",
        assetAddress: "hzyZZej6eMGC4GBUdwLR62g4jCLSKjQgMSh9nq8mroN",
      },
      {
        id: "1025",
        assetAddress: "DtLxbSoyneJRJBkmD3tGmBgeLLc34TMjX6MwSKHL6cVN",
      },
      {
        id: "1195",
        assetAddress: "GTqiGjNpMKaNJuTdzbyCMh7pC5SW6CGNyRJpjiBA3Xvv",
      },
    ].map((prize) => ({
      ...prize,
      imageUrl: `https://cdn.lil.org/nft/mi_note_cards/clean/${prize.id}.webp`,
      telegramImageUrl: `https://cdn.lil.org/nft/mi_note_cards/square/${prize.id}.jpg`,
      imageWidth: 1000,
      imageHeight: 1400,
      collectionAddress: "BtEknBg1b9ZLJHLTGJcadxeQhQwtdVsoPGDrc9cXwczG",
      standard: "core",
      claimAvailable: true,
    })),
  );
  assert.equal(isEventPrizeEvent(eventId), true);
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
    assert.equal(bs58.default.decode(prize.collectionAddress).length, 32);
    assert.equal(isEventPrizeId(eventId, prize.id), true);
    assert.equal(isEventPrizeId(LEGACY_CORE_PRIZES_EVENT_ID, prize.id), false);
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
  for (const prizeId of ["1092", "unknown", " 561 "]) {
    assert.equal(isEventPrizeId(eventId, prizeId), false);
    assert.equal(
      isToggleEventPrizeSelectionRequest({ eventId, prizeId }),
      false,
    );
    assert.equal(
      isEventPrizeWithdrawalRequest({
        eventId,
        prizeId,
        solanaAddress: "11111111111111111111111111111111",
      }),
      false,
    );
  }
});

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
