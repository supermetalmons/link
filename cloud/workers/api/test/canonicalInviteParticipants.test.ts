import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalInviteParticipants } from "../src/canonicalInviteParticipants.ts";

const paired = inviteDocumentFixture({
  hostId: "host-login",
  guestId: "guest-login",
});

test("canonical participants distinguish missing sources from invalid records", () => {
  for (const value of [null, undefined]) {
    assert.deepEqual(decodeCanonicalInviteParticipants(value), {
      status: "missing",
    });
  }
  for (const value of [false, 0, "invite", [], {}, [paired]]) {
    assert.deepEqual(decodeCanonicalInviteParticipants(value), {
      status: "invalid",
    });
  }
});

test("canonical participants reject malformed IDs without trimming or coercion", () => {
  for (const field of ["hostId", "guestId"]) {
    for (const value of [
      "",
      " login ",
      "invalid/login",
      "x".repeat(129),
      "\ud800",
      1,
      false,
      ["login"],
      { uid: "login" },
    ]) {
      assert.deepEqual(
        decodeCanonicalInviteParticipants({ ...paired, [field]: value }),
        { status: "invalid" },
      );
    }
  }
  assert.deepEqual(
    decodeCanonicalInviteParticipants({ ...paired, guestId: paired.hostId }),
    { status: "invalid" },
  );
});

test("canonical participants preserve complete source identity and valid IDs", () => {
  const source = Object.freeze(
    inviteDocumentFixture({ hostId: "Høst-login", guestId: "Guest-login" }),
  );
  const before = structuredClone(source);
  const result = decodeCanonicalInviteParticipants(source);
  assert.ok(result.status === "ok");
  assert.equal(result.source, source);
  assert.equal(result.hostId, source.hostId);
  assert.equal(result.guestId, source.guestId);
  assert.equal(result.passwordProtected, false);
  assert.deepEqual(source, before);
  assert.equal(
    decodeCanonicalInviteParticipants({ ...source, custom: {} }).status,
    "invalid",
  );
});

test("pending participants require an explicit null guest", () => {
  const source = inviteDocumentFixture({ hostId: paired.hostId });
  const result = decodeCanonicalInviteParticipants(source);
  assert.ok(result.status === "ok");
  assert.equal(result.guestId, null);
  assert.equal(result.source, source);
  for (const value of [
    { hostId: paired.hostId },
    { ...source, guestId: undefined },
  ])
    assert.equal(decodeCanonicalInviteParticipants(value).status, "invalid");
});

test("password protection requires a canonical automatch password", () => {
  const source = inviteDocumentFixture({
    hostId: paired.hostId,
    password: "private",
  });
  const result = decodeCanonicalInviteParticipants(source);
  assert.ok(result.status === "ok");
  assert.equal(result.passwordProtected, true);
  for (const password of [undefined, null, false, ""])
    assert.equal(
      decodeCanonicalInviteParticipants({ ...source, password }).status,
      "invalid",
    );
});

test("participant reads require own fields and ignore inherited password values", () => {
  assert.equal(
    decodeCanonicalInviteParticipants(Object.create(paired)).status,
    "invalid",
  );
  const source = Object.assign(
    Object.create({ password: "inherited" }),
    paired,
  );
  const result = decodeCanonicalInviteParticipants(source);
  assert.ok(result.status === "ok");
  assert.equal(result.source, source);
  assert.equal(result.passwordProtected, false);
});
