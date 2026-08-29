"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const bs58 = require("bs58");
const {
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_2_ID,
  ARTIFACT_MAGAZINE_3_PRIZES_EVENT_ID,
  COMPRESSED_PRIZES_EVENT_ID,
  EVENT_PRIZE_IDS,
  LEGACY_CORE_PRIZES_EVENT_ID,
  getEventPrizeConfig,
  getEventPrizeDefinition,
  isEventPrizeEvent,
  isEventPrizeId,
  isEventPrizeStandard,
  isEventPrizeWithdrawalCompletedResponse,
  isEventPrizeWithdrawalProcessingResponse,
  isEventPrizeWithdrawalRequest,
  isEventPrizeWithdrawalStatusRequest,
} = require("@mons/shared/event-prizes");
const databaseRules = require("../database.rules.json");

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

test("database rules keep selection reads and close direct writes", () => {
  const selectionRules =
    databaseRules.rules.eventPrizeSelections.$eventId.$profileId;
  assert.equal(selectionRules[".write"], false);
  assert.equal(selectionRules[".validate"], undefined);
  assert.match(
    databaseRules.rules.eventPrizeSelections.$eventId[".read"],
    /auth != null/,
  );
});

test("retired Firestore rules are absent", () => {
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "..", "firestore.rules")),
    false,
  );
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
