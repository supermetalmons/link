import assert from "node:assert/strict";
import test from "node:test";
import { decodeAutomatchEntry } from "../../../runtime/automatchRecords.js";
import { AuthApiFailure } from "../src/authErrors.ts";
import { selectAutomatchAttempt } from "../src/automatch/selection.ts";
import type { GameplayProfile } from "../src/gameplayRepository.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";

const requesterUid = "requester-uid";
const hostUid = "host-uid";
const profile: GameplayProfile = {
  aura: "blue",
  emoji: 7,
  eth: "",
  profileId: "requester-profile",
  rating: 1500,
  sol: "",
  username: "Requester",
};
const hostProfile: GameplayProfile = {
  ...profile,
  profileId: "host-profile",
  username: "Host",
};
type OwnerGroup = { profile: GameplayProfile; loginUids: readonly string[] };
const separateOwners: OwnerGroup[] = [
  { profile, loginUids: [requesterUid] },
  { profile: hostProfile, loginUids: [hostUid] },
];

function ownershipSnapshot(
  query: ProfileOwnershipQuery,
  owners: readonly OwnerGroup[],
): ProfileOwnershipSnapshot {
  assert.deepEqual(query, {
    loginUids: [requesterUid, hostUid],
    profileIds: [],
  });
  return {
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(
      query.loginUids.map((uid) => {
        const owner = owners.find(({ loginUids }) => loginUids.includes(uid));
        return [
          uid,
          owner ? { profileId: owner.profile.profileId, revision: 1 } : null,
        ];
      }),
    ),
    loginUidsByProfileId: new Map(
      owners.map(({ profile, loginUids }) => [profile.profileId, loginUids]),
    ),
    profileById: new Map(
      owners.map(({ profile }) => [
        profile.profileId,
        { profile, revision: 1 },
      ]),
    ),
  };
}

function queueFixture(
  uid = hostUid,
  inviteId = "auto-selected",
  fields: Record<string, unknown> = {},
) {
  const entry = decodeAutomatchEntry({
    uid,
    timestamp: 100,
    hostColor: "white",
    password: "original-password",
    ...fields,
  });
  assert.ok(entry.record);
  return {
    head: { [inviteId]: entry },
    queued: { inviteId, data: entry.record },
  };
}

function fixture(
  queue: ReturnType<typeof queueFixture> | null = queueFixture(),
  owners: readonly OwnerGroup[] = separateOwners,
) {
  const calls: string[] = [];
  const input: Parameters<typeof selectAutomatchAttempt>[0] = {
    requesterUid,
    request: {
      operationId: "00000000-0000-4000-8000-000000000001",
      emojiId: 0,
      aura: "request-aura",
    },
    requester: { loginUids: [requesterUid], profile },
    signal: new AbortController().signal,
  };
  const dependencies: Parameters<typeof selectAutomatchAttempt>[1] = {
    repository: {
      async readFirstAutomatchEntry(signal) {
        calls.push("queue");
        assert.equal(signal, input.signal);
        return queue?.head ?? null;
      },
      async readProfileOwnershipSnapshot(query) {
        calls.push("ownership");
        return ownershipSnapshot(query, owners);
      },
    },
    async convergeOwnedQueues(loginUids, signal) {
      calls.push("converge");
      assert.equal(signal, input.signal);
      assert.deepEqual(
        loginUids,
        owners.find(({ loginUids }) => loginUids.includes(hostUid))
          ?.loginUids ?? [hostUid],
      );
      return queue?.queued ?? null;
    },
  };
  return { input, dependencies, calls };
}

test("an empty queue creates pending selection with the requester fallback", async () => {
  const { input, dependencies, calls } = fixture(null);
  input.requester = { loginUids: [requesterUid], profile: null };
  const selection = await selectAutomatchAttempt(input, dependencies);
  assert.equal(selection.kind, "create-pending");
  if (selection.kind !== "create-pending") assert.fail("expected-pending");
  assert.equal(selection.profile.profileId, "");
  assert.equal(selection.profile.emoji, 0);
  assert.equal(selection.profile.aura, "request-aura");
  assert.deepEqual(selection.display, {
    emojiId: 0,
    aura: "request-aura",
    name: "anon",
  });
  assert.deepEqual(calls, ["queue"]);
});

test("a queue for the same login is reused without pair ownership or convergence", async () => {
  const { input, dependencies, calls } = fixture(queueFixture(requesterUid));
  assert.deepEqual(await selectAutomatchAttempt(input, dependencies), {
    kind: "reuse-owned",
    inviteId: "auto-selected",
    ownerUids: [requesterUid],
  });
  assert.deepEqual(calls, ["queue"]);
});

test("a shared profile reuses its replacement invite and complete owner set", async () => {
  const aliases = [hostUid, "linked-host", requesterUid];
  const { input, dependencies, calls } = fixture(queueFixture(), [
    { profile, loginUids: aliases },
  ]);
  dependencies.convergeOwnedQueues = async (loginUids, signal) => {
    calls.push("converge");
    assert.deepEqual(loginUids, aliases);
    assert.equal(signal, input.signal);
    return queueFixture("linked-host", "auto-replacement").queued;
  };
  assert.deepEqual(await selectAutomatchAttempt(input, dependencies), {
    kind: "reuse-owned",
    inviteId: "auto-replacement",
    ownerUids: aliases,
  });
  assert.deepEqual(calls, ["queue", "ownership", "converge"]);
});

for (const survivor of [null, queueFixture(hostUid, "auto-replacement")]) {
  test(`a different owner's ${survivor ? "replacement" : "missing survivor"} requests reselection`, async () => {
    const { input, dependencies, calls } = fixture();
    dependencies.convergeOwnedQueues = async (loginUids, signal) => {
      calls.push("converge");
      assert.deepEqual(loginUids, [hostUid]);
      assert.equal(signal, input.signal);
      return survivor?.queued ?? null;
    };
    assert.deepEqual(await selectAutomatchAttempt(input, dependencies), {
      kind: "reselect",
    });
    assert.deepEqual(calls, ["queue", "ownership", "converge"]);
  });
}

test("a same-ID survivor retains the original queue data and uses the pair profile for display", async () => {
  const original = queueFixture();
  const currentProfile = {
    ...profile,
    aura: "",
    emoji: 0,
    username: "Updated requester",
    rating: 1700,
  };
  const { input, dependencies, calls } = fixture(original, [
    { profile: currentProfile, loginUids: [requesterUid] },
    { profile: hostProfile, loginUids: [hostUid] },
  ]);
  const replacement = queueFixture(hostUid, original.queued.inviteId, {
    password: "new-password",
    hostColor: "black",
    timestamp: 200,
  });
  dependencies.convergeOwnedQueues = async () => {
    calls.push("converge");
    return replacement.queued;
  };
  const selection = await selectAutomatchAttempt(input, dependencies);
  assert.equal(selection.kind, "match");
  if (selection.kind !== "match") assert.fail("expected-match");
  assert.equal(selection.queued.data, original.queued.data);
  assert.notEqual(selection.queued.data, replacement.queued.data);
  assert.equal(selection.existingUid, hostUid);
  assert.deepEqual(selection.display, {
    emojiId: 0,
    aura: null,
    name: "Updated requester (1700)",
  });
  assert.deepEqual(calls, ["queue", "ownership", "converge"]);
});

test("a missing requester in the pair snapshot uses request appearance instead of stale profile data", async () => {
  const { input, dependencies, calls } = fixture(queueFixture(), [
    { profile: hostProfile, loginUids: [hostUid] },
  ]);
  const selection = await selectAutomatchAttempt(input, dependencies);
  assert.equal(selection.kind, "match");
  if (selection.kind !== "match") assert.fail("expected-match");
  assert.deepEqual(selection.display, {
    emojiId: 0,
    aura: "request-aura",
    name: "anon",
  });
  assert.deepEqual(calls, ["queue", "ownership", "converge"]);
});

test("unavailable ownership fails before convergence", async () => {
  const { input, dependencies, calls } = fixture();
  dependencies.repository.readProfileOwnershipSnapshot = async () => {
    calls.push("ownership");
    throw new Error("ownership-read-failed");
  };
  await assert.rejects(
    selectAutomatchAttempt(input, dependencies),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
  assert.deepEqual(calls, ["queue", "ownership"]);
});

for (const count of [512, 513]) {
  test(`${count} owner aliases ${count === 512 ? "can converge" : "fail before convergence"}`, async () => {
    const loginUids = [
      hostUid,
      ...Array.from({ length: count - 1 }, (_, index) => `host-alias-${index}`),
    ];
    const { input, dependencies, calls } = fixture(queueFixture(), [
      { profile, loginUids: [requesterUid] },
      { profile: hostProfile, loginUids },
    ]);
    if (count === 512) {
      assert.equal(
        (await selectAutomatchAttempt(input, dependencies)).kind,
        "match",
      );
      assert.deepEqual(calls, ["queue", "ownership", "converge"]);
    } else {
      await assert.rejects(
        selectAutomatchAttempt(input, dependencies),
        (error) =>
          error instanceof AuthApiFailure &&
          error.status === 503 &&
          error.message === "profile-ownership-unavailable",
      );
      assert.deepEqual(calls, ["queue", "ownership"]);
    }
  });
}

for (const sameLogin of [true, false]) {
  test(`${sameLogin ? "direct login reuse evaluates" : "linked profile reuse skips"} requester display at its original position`, async () => {
    const { input, dependencies, calls } = fixture(
      queueFixture(sameLogin ? requesterUid : hostUid),
      [{ profile, loginUids: [requesterUid, hostUid] }],
    );
    const failure = new Error("display-getter-failed");
    input.requester = {
      loginUids: [requesterUid],
      profile: {
        ...profile,
        get username(): string {
          calls.push("display");
          throw failure;
        },
      },
    };
    if (sameLogin) {
      await assert.rejects(
        selectAutomatchAttempt(input, dependencies),
        (error) => error === failure,
      );
      assert.deepEqual(calls, ["queue", "display"]);
    } else {
      assert.deepEqual(await selectAutomatchAttempt(input, dependencies), {
        kind: "reuse-owned",
        inviteId: "auto-selected",
        ownerUids: [requesterUid, hostUid],
      });
      assert.deepEqual(calls, ["queue", "ownership", "converge"]);
    }
  });
}
