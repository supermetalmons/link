import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import { prepareSiweMessage } from "../../../../src/connection/siweMessage.ts";
import { parseSiweMessage } from "../src/siweAuth.ts";

const wallet = new Wallet(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const fields = {
  domain: "mons.link",
  address: wallet.address,
  statement: "mons ftw",
  uri: "https://mons.link",
  version: "1",
  chainId: 1,
  nonce: "nonceABC123456789012345",
  issuedAt: "2026-08-22T00:00:00.000Z",
};

test("parses the canonical siwe reference message", () => {
  const message = new SiweMessage(fields).prepareMessage();
  const parsed = parseSiweMessage(message);
  assert.equal(parsed.address, wallet.address);
  assert.equal(parsed.domain, fields.domain);
  assert.equal(parsed.nonce, fields.nonce);
  assert.equal(parsed.statement, fields.statement);
  assert.equal(
    parseSiweMessage(
      new SiweMessage({
        ...fields,
        requestId: "request:1",
        resources: ["https://mons.link/game/1", "urn:example:mons"],
      }).prepareMessage(),
    ).nonce,
    fields.nonce,
  );
});

test("rejects duplicate and noncanonical optional SIWE fields", () => {
  const message = prepareSiweMessage(fields);
  for (const invalid of [
    `${message}\nRequest ID: one\nRequest ID: two`,
    `${message}\nNot Before: 2026-08-21T23:00:00.000Z\nExpiration Time: 2026-08-22T01:00:00.000Z`,
    `${message}\nResources:`,
  ]) {
    assert.throws(() => parseSiweMessage(invalid), /invalid-siwe-message/);
  }
});

test("rejects malformed and credentialed SIWE authorities", () => {
  for (const domain of [
    "mons.link:443:evil",
    "https://attacker@mons.link",
    " mons.link",
  ]) {
    assert.throws(
      () => parseSiweMessage(prepareSiweMessage({ ...fields, domain })),
      /invalid-siwe-message/,
    );
  }
  assert.equal(
    parseSiweMessage(
      prepareSiweMessage({ ...fields, domain: "localhost:3000" }),
    ).domain,
    "localhost:3000",
  );
});
