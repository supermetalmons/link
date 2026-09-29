import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../src/canonicalJson.ts";
import {
  canonical as sessionCanonical,
  digest as sessionDigest,
  GameSessionTransitionFailure,
} from "../src/gameSessionCodec.ts";
import {
  canonical as eventCanonical,
  digest as eventDigest,
} from "../src/eventTransitionCodec.ts";

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
        await assert.rejects(digest(input), error);
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
