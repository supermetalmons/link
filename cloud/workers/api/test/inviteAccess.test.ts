import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  resolveInviteParticipant,
  resolveInviteRole,
  resolveInviteRoleFromSnapshot,
} from "../src/inviteAccess.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipReader,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";

const request = { inviteId: "invite-one" };
const paired = { hostId: "host-login", guestId: "guest-login" };

function ownershipReader(owners: Readonly<Record<string, string | null>>) {
  const reads: ProfileOwnershipQuery[] = [];
  const snapshots: ProfileOwnershipSnapshot[] = [];
  const reader: ProfileOwnershipReader = {
    async readProfileOwnershipSnapshot(query) {
      reads.push(query);
      const profileIds = new Set(
        query.loginUids.flatMap((uid) => (owners[uid] ? [owners[uid]] : [])),
      );
      const snapshot: ProfileOwnershipSnapshot = {
        canonicalProfileIdByProfileId: new Map(),
        loginOwnerByUid: new Map(
          query.loginUids.map((uid) => [
            uid,
            owners[uid] ? { profileId: owners[uid], revision: 1 } : null,
          ]),
        ),
        loginUidsByProfileId: new Map(
          [...profileIds].map((profileId) => [
            profileId,
            Object.keys(owners).filter((uid) => owners[uid] === profileId),
          ]),
        ),
        profileById: new Map(
          [...profileIds].map((profileId) => [
            profileId,
            {
              profile: {
                profileId,
                aura: "",
                emoji: 1,
                eth: "",
                rating: 1500,
                sol: "",
                username: "",
              },
              revision: 1,
            },
          ]),
        ),
      };
      snapshots.push(snapshot);
      return snapshot;
    },
  };
  return { reader, reads, snapshots };
}

function failure(status: number, message: string) {
  return (error: unknown) =>
    error instanceof AuthApiFailure &&
    error.status === status &&
    error.message === message;
}

test("direct participants retain access without reading profile ownership", async () => {
  let ownershipReads = 0;
  let inviteReads = 0;
  const repository = {
    async readInviteMetadata(inviteId: string) {
      inviteReads++;
      assert.equal(inviteId, request.inviteId);
      return paired;
    },
    async readProfileOwnershipSnapshot(): Promise<ProfileOwnershipSnapshot> {
      ownershipReads++;
      throw new Error("ownership-unavailable");
    },
  };

  for (const role of ["host", "guest"] as const) {
    const actorUid = `${role}-login`;
    const identity = { uid: actorUid };
    const expected = { ok: true, ...request, ...paired, actorUid, role };
    assert.deepEqual(
      await resolveInviteRole(identity, request, repository),
      expected,
    );
    assert.deepEqual(
      await resolveInviteRoleFromSnapshot(
        identity,
        request,
        paired,
        repository,
      ),
      expected,
    );
    assert.deepEqual(
      await resolveInviteParticipant(identity, paired, repository),
      {
        actorUid,
        opponentUid: role === "host" ? paired.guestId : paired.hostId,
        ownership: null,
        role,
      },
    );
  }

  assert.equal(inviteReads, 2);
  assert.equal(ownershipReads, 0);
});

test("linked participants return the original actor and the single ownership snapshot", async () => {
  for (const role of ["host", "guest"] as const) {
    const { reader, reads, snapshots } = ownershipReader({
      "linked-login": `profile-${role}`,
      "host-login": "profile-host",
      "guest-login": "profile-guest",
    });
    const result = await resolveInviteParticipant(
      { uid: "linked-login" },
      paired,
      reader,
    );

    assert.equal(result.actorUid, `${role}-login`);
    assert.equal(
      result.opponentUid,
      role === "host" ? paired.guestId : paired.hostId,
    );
    assert.equal(result.role, role);
    assert.strictEqual(result.ownership, snapshots[0]);
    assert.deepEqual(reads, [
      {
        loginUids: ["linked-login", "host-login", "guest-login"],
        profileIds: [],
      },
    ]);
  }
});

test("direct guest identity wins over shared ownership while linked identities prefer the host", async () => {
  const { reader, reads } = ownershipReader({
    "host-login": "shared-profile",
    "guest-login": "shared-profile",
    "linked-login": "shared-profile",
  });
  for (const uid of ["guest-login", "linked-login"]) {
    const role = uid === "guest-login" ? "guest" : "host";
    const read = await resolveInviteRoleFromSnapshot(
      { uid },
      request,
      paired,
      reader,
    );
    const participant = await resolveInviteParticipant({ uid }, paired, reader);
    assert.equal(read.role, role);
    assert.equal(read.actorUid, `${role}-login`);
    assert.equal(participant.role, role);
    assert.equal(participant.actorUid, `${role}-login`);
    assert.equal(reads.length, uid === "guest-login" ? 0 : 2);
  }
});

test("unrelated and unlinked identities may watch but cannot mutate as participants", async () => {
  for (const profileId of [null, "unrelated-profile"]) {
    const { reader } = ownershipReader({
      "viewer-login": profileId,
      "host-login": "profile-host",
      "guest-login": "profile-guest",
    });
    const identity = { uid: "viewer-login" };
    const read = await resolveInviteRoleFromSnapshot(
      identity,
      request,
      paired,
      reader,
    );
    assert.equal(read.role, "watch");
    assert.equal(read.actorUid, null);
    await assert.rejects(
      resolveInviteParticipant(identity, paired, reader),
      failure(403, "permission-denied"),
    );
  }
});

test("pending reads omit absent guests and treat any own password property as private", async () => {
  const { reader, reads } = ownershipReader({
    "linked-login": "profile-host",
    "host-login": "profile-host",
    "viewer-login": null,
  });
  const pending = { hostId: paired.hostId };
  const result = await resolveInviteRoleFromSnapshot(
    { uid: "linked-login" },
    request,
    pending,
    reader,
  );
  assert.equal(result.role, "host");
  assert.equal(result.guestId, null);
  assert.deepEqual(reads, [
    { loginUids: ["linked-login", "host-login"], profileIds: [] },
  ]);

  const identity = { uid: "viewer-login" };
  const open = await resolveInviteRoleFromSnapshot(
    identity,
    request,
    pending,
    reader,
  );
  assert.equal(open.role, "watch");
  await assert.rejects(
    resolveInviteRoleFromSnapshot(
      identity,
      request,
      { ...pending, password: undefined },
      reader,
    ),
    failure(403, "permission-denied"),
  );
  await assert.rejects(
    resolveInviteParticipant({ uid: paired.hostId }, pending, reader),
    failure(409, "missing-opponent"),
  );
});

test("read validation stays stricter than participant record-key validation without normalizing IDs", async () => {
  const { reader, reads } = ownershipReader({});
  for (const invite of [
    { hostId: " host-login ", guestId: "guest-login" },
    { hostId: "h".repeat(129), guestId: "guest-login" },
    { hostId: "same-login", guestId: "same-login" },
  ]) {
    const identity = { uid: invite.hostId };
    await assert.rejects(
      resolveInviteRoleFromSnapshot(identity, request, invite, reader),
      failure(409, "invite-invalid"),
    );
    const participant = await resolveInviteParticipant(
      identity,
      invite,
      reader,
    );
    assert.equal(participant.actorUid, invite.hostId);
    assert.equal(participant.opponentUid, invite.guestId);
    assert.equal(participant.role, "host");
    assert.equal(participant.ownership, null);
  }
  assert.equal(reads.length, 0);
});

test("ownership failures never degrade into spectator access or permission errors", async () => {
  const empty = ownershipReader({}).reader;
  const readers: ProfileOwnershipReader[] = [
    {
      async readProfileOwnershipSnapshot() {
        throw new Error("d1-unavailable");
      },
    },
    {
      async readProfileOwnershipSnapshot() {
        return empty.readProfileOwnershipSnapshot({
          loginUids: [],
          profileIds: [],
        });
      },
    },
  ];
  for (const reader of readers) {
    const identity = { uid: "linked-login" };
    await assert.rejects(
      resolveInviteRoleFromSnapshot(identity, request, paired, reader),
      failure(503, "profile-ownership-unavailable"),
    );
    await assert.rejects(
      resolveInviteParticipant(identity, paired, reader),
      failure(503, "profile-ownership-unavailable"),
    );
  }
});
