import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalAuthRecoveryJson,
  canonicalEventRepositoryJson,
  canonicalJson,
  canonicalReceiptJson,
  sha256Hex,
} from "../src/canonicalJson.ts";
import {
  canonical as sessionCanonical,
  digest as sessionDigest,
  GameSessionTransitionFailure,
} from "../src/gameSessionCodec.ts";
import {
  canonical as eventCanonical,
  digest as eventDigest,
} from "../src/eventTransitionCodec.ts";
import { canonicalMatchStateJson } from "../src/matchStateLogic.ts";

const codecs = [
  {
    name: "session",
    canonical: sessionCanonical,
    digest: sessionDigest,
    error: {
      constructor: GameSessionTransitionFailure,
      message: "game-session-transition-invalid-json",
    },
  },
  {
    name: "event",
    canonical: eventCanonical,
    digest: eventDigest,
    error: {
      constructor: Error,
      message: "event-transition-invalid-effect",
    },
  },
  {
    name: "match state",
    canonical: canonicalMatchStateJson,
    digest: async (value: unknown) => sha256Hex(canonicalMatchStateJson(value)),
    error: {
      constructor: TypeError,
      message: "match-state-invalid-json",
    },
  },
];

for (const { name, canonical, digest, error } of codecs) {
  test(`${name} serialization preserves deployed canonical bytes and digest`, async () => {
    const value = {
      z: { beta: -0, alpha: ["é", "\ud800", null, false] },
      "2": 2,
      "10": 10,
      a: [{ z: 2, a: 1 }, true, 1.25],
    };
    const expected =
      '{"10":10,"2":2,"a":[{"a":1,"z":2},true,1.25],"z":{"alpha":["é","\\ud800",null,false],"beta":0}}';
    assert.equal(canonical(value), expected);
    assert.equal(
      await digest(value),
      "020396243f932f576d40471a3267eaabd9194565ee0fe5197d0b2613bc474102",
    );
    assert.equal(
      canonical({
        a: [{ a: 1, z: 2 }, true, 1.25],
        "10": 10,
        "2": 2,
        z: { alpha: ["é", "\ud800", null, false], beta: 0 },
      }),
      expected,
    );
    assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  });

  test(`${name} serialization preserves sparse arrays and object prototypes`, () => {
    const sparse = new Array(3);
    sparse[1] = { z: 2, a: 1 };
    assert.equal(canonical(sparse), '[,{"a":1,"z":2},]');
    assert.equal(
      canonical(Object.assign(Object.create(null), { z: 2, a: 1 })),
      '{"a":1,"z":2}',
    );
    assert.equal(
      canonical(Object.assign(Object.create({ inherited: true }), { z: 2 })),
      '{"z":2}',
    );
    assert.equal(canonical(new Date(0)), "{}");
  });

  test(`${name} serialization retains domain errors for unsupported values`, async () => {
    for (const value of [
      undefined,
      () => null,
      Symbol("invalid"),
      1n,
      NaN,
      Infinity,
      -Infinity,
    ]) {
      for (const input of [value, { nested: [value] }]) {
        assert.throws(() => canonical(input), error);
        await assert.rejects(async () => digest(input), error);
      }
    }
  });

  test(`${name} serialization preserves failures while reading object properties`, () => {
    const failure = new Error("property-unavailable");
    const value = {
      get property() {
        throw failure;
      },
    };
    assert.throws(
      () => canonical(value),
      (error) => error === failure,
    );
  });
}

test("SHA-256 uses UTF-8 text and lowercase hexadecimal", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

const receiptFailure = new Error("invalid-event-transition-receipt");
const receiptCanonical = (value: unknown) =>
  canonicalReceiptJson(value, () => {
    throw receiptFailure;
  });

for (const [name, canonical] of [
  ["receipt", receiptCanonical],
  ["event repository", canonicalEventRepositoryJson],
  ["auth recovery", canonicalAuthRecoveryJson],
] as const) {
  test(`${name} retains independently specified JSON bytes and digest`, async () => {
    const value = {
      z: { beta: -0, alpha: ["é", "\ud800", null, false] },
      "2": 2,
      "10": 10,
      a: [{ z: 2, a: 1 }, true, 1.25],
    };
    const serialized = canonical(value);
    assert.equal(
      serialized,
      '{"10":10,"2":2,"a":[{"a":1,"z":2},true,1.25],"z":{"alpha":["é","\\ud800",null,false],"beta":0}}',
    );
    assert.equal(
      await sha256Hex(serialized!),
      "020396243f932f576d40471a3267eaabd9194565ee0fe5197d0b2613bc474102",
    );
  });
}

for (const [name, canonical, unsupported, objectValue] of [
  ["event repository", canonicalEventRepositoryJson, undefined, "undefined"],
  ["auth recovery", canonicalAuthRecoveryJson, "", ""],
] as const) {
  test(`${name} preserves native scalar fallbacks at every nesting level`, () => {
    for (const value of [undefined, () => null, Symbol("unsupported")]) {
      assert.equal(canonical(value), unsupported);
      assert.equal(
        canonical({ a: value, b: [value, value, value] }),
        `{"a":${objectValue},"b":[,,]}`,
      );
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(canonical(value), "null");
      assert.equal(canonical({ a: [value] }), '{"a":[null]}');
    }
    assert.throws(() => canonical(1n), TypeError);
    assert.throws(() => canonical({ a: [1n] }), TypeError);
    assert.equal(canonical(new Date(0)), "{}");
    assert.equal(canonical(Object(1)), "{}");
    assert.equal(
      canonical(
        Object.assign(Object.create({ inherited: true }), { z: 2, a: 1 }),
      ),
      '{"a":1,"z":2}',
    );
    const toJSON = () => {
      throw new Error("toJSON-must-not-run");
    };
    assert.equal(
      canonical(Object.defineProperty({ z: 2 }, "toJSON", { value: toJSON })),
      '{"z":2}',
    );
    assert.equal(
      canonical({ z: 2, toJSON }),
      `{"toJSON":${objectValue},"z":2}`,
    );
  });
}

test("serialization policies retain sparse, inherited and custom-iterator array behavior", () => {
  const sparse = new Array(3);
  sparse[1] = 2;
  const inherited = Object.setPrototypeOf(
    new Array(2),
    Object.assign(Object.create(Array.prototype), { 0: 1 }),
  );
  inherited[1] = 2;
  const customIterator = Object.defineProperty([1], Symbol.iterator, {
    value: function* () {
      yield 2;
    },
  });
  for (const canonical of [
    sessionCanonical,
    canonicalEventRepositoryJson,
    canonicalAuthRecoveryJson,
  ]) {
    assert.equal(canonical(sparse), "[,2,]");
    assert.equal(canonical(inherited), "[1,2]");
    assert.equal(canonical(customIterator), "[1]");
  }
  assert.throws(
    () => receiptCanonical(sparse),
    (error) => error === receiptFailure,
  );
  assert.equal(receiptCanonical(inherited), "[1,2]");
  assert.equal(receiptCanonical(customIterator), "[2]");
});

test("serialization policies preserve property reads and thrown error identity", () => {
  for (const canonical of [
    sessionCanonical,
    receiptCanonical,
    canonicalEventRepositoryJson,
    canonicalAuthRecoveryJson,
  ]) {
    const failure = new Error("property-unavailable");
    const reads: string[] = [];
    const value = {
      get z() {
        reads.push("z");
        return 1;
      },
      get a() {
        reads.push("a");
        throw failure;
      },
    };
    assert.throws(
      () => canonical(value),
      (error) => error === failure,
    );
    assert.deepEqual(reads, ["a"]);
  }
});

test("strict serializers invoke invalid-value callbacks without a receiver", () => {
  const failure = new Error("invalid-value");
  for (const canonical of [canonicalJson, canonicalReceiptJson]) {
    for (const value of [undefined, NaN, { nested: Infinity }]) {
      assert.throws(
        () =>
          canonical(value, function (this: unknown) {
            assert.equal(this, undefined);
            throw failure;
          }),
        (error) => error === failure,
      );
    }
  }
  assert.throws(
    () =>
      canonicalReceiptJson(new Date(0), function (this: unknown) {
        assert.equal(this, undefined);
        throw failure;
      }),
    (error) => error === failure,
  );
});
