"use strict";

const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const test = require("node:test");

const requireFromFunctions = createRequire(
  require.resolve("../functions/package.json"),
);
const { SiweMessage } = requireFromFunctions("siwe");

const loadPrepareSiweMessage = async () => {
  const module = await import("../../src/connection/siweMessage.ts");
  return module.prepareSiweMessage;
};

const CASES = [
  {
    domain: "mons.link",
    address: "0x52908400098527886E0F7030069857D2E4169EE7",
    statement: "mons ftw",
    uri: "https://mons.link",
    version: "1",
    chainId: 1,
    nonce: "abc123XYZdef456UVWghi78",
    issuedAt: "2026-08-05T00:00:00.000Z",
  },
  {
    domain: "localhost:3000",
    address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    statement: "mons ftw",
    uri: "http://localhost:3000",
    version: "1",
    chainId: 8453,
    nonce: "Zk9QmT2wLp7Rv4Xy1Nc8Bd6H",
    issuedAt: "2026-01-31T23:59:59.999Z",
  },
  {
    domain: "www.mons.link",
    address: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    statement: "mons ftw",
    uri: "https://www.mons.link",
    version: "1",
    chainId: 42161,
    nonce: "n0nc3W1thD1g1ts0nly999",
    issuedAt: "2026-12-25T12:34:56.789Z",
  },
];

test("prepareSiweMessage matches the siwe reference serialization", async () => {
  const prepareSiweMessage = await loadPrepareSiweMessage();
  for (const fields of CASES) {
    const reference = new SiweMessage({ ...fields }).prepareMessage();
    assert.equal(prepareSiweMessage(fields), reference);
  }
});

test("prepareSiweMessage output parses and round-trips server side", async () => {
  const prepareSiweMessage = await loadPrepareSiweMessage();
  for (const fields of CASES) {
    const message = prepareSiweMessage(fields);
    const parsed = new SiweMessage(message);
    assert.equal(parsed.address, fields.address);
    assert.equal(parsed.domain, fields.domain);
    assert.equal(parsed.uri, fields.uri);
    assert.equal(parsed.statement, fields.statement);
    assert.equal(parsed.nonce, fields.nonce);
    assert.equal(parsed.chainId, fields.chainId);
    assert.equal(parsed.issuedAt, fields.issuedAt);
    assert.equal(parsed.prepareMessage(), message);
  }
});

test("prepareSiweMessage keeps the statement verifyEthAddress requires", async () => {
  const prepareSiweMessage = await loadPrepareSiweMessage();
  const message = prepareSiweMessage(CASES[0]);
  assert.equal(new SiweMessage(message).statement, "mons ftw");
});
