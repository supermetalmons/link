import assert from "node:assert/strict";
import test from "node:test";
import type { SubmitMoveRequest } from "@mons/shared/game-sessions";
import { AuthApiFailure } from "../src/authErrors.ts";
import { submitMove } from "../src/matchMove.ts";
import type { MatchMutationRepository } from "../src/matchMutationAdmission.ts";
import { surrenderMatch } from "../src/matchSurrender.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";

const request: SubmitMoveRequest = {
  inviteId: "invite",
  matchId: "invite1",
  playerId: "actor",
  previousFlatMovesString: "",
  flatMovesString: "move",
  fen: "position",
};
const invite = {
  hostId: "actor",
  guestId: "opponent",
  hostRematches: "1",
  guestRematches: "2",
};

function ownershipSnapshot(
  loginUids: readonly string[],
  owners: Record<string, string | null>,
): ProfileOwnershipSnapshot {
  const loginUidsByProfileId = new Map<string, string[]>();
  for (const uid of loginUids) {
    const profileId = owners[uid];
    if (profileId) {
      const logins = loginUidsByProfileId.get(profileId) || [];
      logins.push(uid);
      loginUidsByProfileId.set(profileId, logins);
    }
  }
  return {
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(
      loginUids.map((uid) => [
        uid,
        owners[uid] ? { profileId: owners[uid], revision: 1 } : null,
      ]),
    ),
    loginUidsByProfileId,
    profileById: new Map(
      [...loginUidsByProfileId.keys()].map((profileId) => [
        profileId,
        {
          revision: 1,
          profile: {
            profileId,
            aura: "",
            emoji: 0,
            eth: "",
            sol: "",
            username: "",
            rating: 1500,
          },
        },
      ]),
    ),
  };
}

function harness(
  command: "move" | "surrender",
  {
    uid = "actor",
    body = request,
    inviteValue = invite,
    owners = { actor: "profile", linked: "profile" },
    signal,
    onRead = () => {},
    guardFailure,
  }: {
    uid?: string;
    body?: SubmitMoveRequest;
    inviteValue?: Record<string, unknown> | null;
    owners?: Record<string, string | null>;
    signal?: AbortSignal;
    onRead?: () => void;
    guardFailure?: Error;
  } = {},
) {
  const steps: string[] = [];
  const repository: MatchMutationRepository = {
    async readInviteMetadata(inviteId, readSignal) {
      assert.equal(inviteId, body.inviteId);
      assert.ok(readSignal);
      readSignal.throwIfAborted();
      steps.push("invite");
      onRead();
      return inviteValue;
    },
    async readProfileOwnershipSnapshot(query) {
      steps.push("ownership");
      assert.deepEqual(query, {
        loginUids: [uid, body.playerId],
        profileIds: [],
      });
      return ownershipSnapshot(query.loginUids, owners);
    },
  };
  const dependencies = {
    signal,
    async assertMutationAllowed() {
      steps.push("guard");
      if (guardFailure) throw guardFailure;
    },
  };
  const response = {
    ok: true as const,
    inviteId: body.inviteId,
    matchId: body.matchId,
    actorUid: body.playerId,
  };
  const surrenderRequest = {
    inviteId: body.inviteId,
    matchId: body.matchId,
    playerId: body.playerId,
  };
  return {
    repository,
    steps,
    run: () =>
      command === "move"
        ? submitMove({ uid }, body, repository, {
            ...dependencies,
            async submitCanonical(input) {
              assert.equal(input, body);
              steps.push("canonical");
              return { ...response, outcome: "applied" };
            },
          })
        : surrenderMatch({ uid }, surrenderRequest, repository, {
            ...dependencies,
            async surrenderCanonical(input) {
              assert.equal(input, surrenderRequest);
              steps.push("canonical");
              return response;
            },
          }),
  };
}

for (const command of ["move", "surrender"] as const) {
  test(`${command} admits direct and linked owners before mutation`, async () => {
    for (const uid of ["actor", "linked"]) {
      for (const matchId of ["invite", "invite1", "invite2"]) {
        const h = harness(command, { uid, body: { ...request, matchId } });
        await h.run();
        assert.deepEqual(h.steps, [
          "invite",
          ...(uid === "linked" ? ["ownership"] : []),
          "guard",
          "canonical",
        ]);
      }
    }
  });

  test(`${command} rejects invalid requests before reading or mutating`, async () => {
    for (const body of [
      { ...request, playerId: "" },
      { ...request, matchId: "other1" },
    ]) {
      const h = harness(command, { body });
      await assert.rejects(h.run(), {
        status: 400,
        message: "invalid-request",
      });
      assert.deepEqual(h.steps, []);
    }
  });

  test(`${command} rejects missing or malformed invites and unknown matches`, async () => {
    for (const scenario of [
      { inviteValue: null, status: 404, message: "invite-not-found" },
      { inviteValue: {}, status: 409, message: "invite-invalid" },
      {
        inviteValue: { ...invite, hostId: "" },
        status: 409,
        message: "invite-invalid",
      },
      {
        inviteValue: { ...invite, guestId: "actor" },
        status: 409,
        message: "invite-invalid",
      },
      {
        body: { ...request, playerId: "stranger" },
        status: 403,
        message: "permission-denied",
      },
      {
        body: { ...request, matchId: "invite3" },
        status: 404,
        message: "match-not-found",
      },
    ]) {
      const h = harness(command, scenario);
      await assert.rejects(h.run(), {
        status: scenario.status,
        message: scenario.message,
      });
      assert.deepEqual(h.steps, ["invite"]);
    }
  });

  test(`${command} rejects unrelated and missing profile owners`, async () => {
    for (const linked of ["other-profile", null]) {
      const h = harness(command, {
        uid: "linked",
        owners: { actor: "profile", linked },
      });
      await assert.rejects(h.run(), {
        status: 403,
        message: "permission-denied",
      });
      assert.deepEqual(h.steps, ["invite", "ownership"]);
    }
  });

  test(`${command} preserves invite and ownership error precedence`, async () => {
    const malformedInvite = harness(command, {
      uid: "linked",
      inviteValue: {},
      owners: { actor: "profile", linked: "other-profile" },
    });
    await assert.rejects(malformedInvite.run(), {
      status: 409,
      code: "failed-precondition",
      message: "invite-invalid",
    });
    assert.deepEqual(malformedInvite.steps, ["invite"]);

    const unrelatedOwner = harness(command, {
      uid: "linked",
      body: { ...request, matchId: "invite3" },
      owners: { actor: "profile", linked: "other-profile" },
    });
    await assert.rejects(unrelatedOwner.run(), {
      status: 403,
      code: "permission-denied",
      message: "permission-denied",
    });
    assert.deepEqual(unrelatedOwner.steps, ["invite", "ownership"]);
  });

  test(`${command} preserves ownership failures after cancellation during invite reads`, async () => {
    for (const malformed of [false, true]) {
      const controller = new AbortController();
      const h = harness(command, {
        uid: "linked",
        signal: controller.signal,
        onRead: () => controller.abort(new Error("request-cancelled")),
      });
      const readOwnership = h.repository.readProfileOwnershipSnapshot;
      h.repository.readProfileOwnershipSnapshot = async (query) => {
        const snapshot = await readOwnership(query);
        if (!malformed) throw new Error("ownership-unavailable");
        return { ...snapshot, loginOwnerByUid: new Map() };
      };
      await assert.rejects(h.run(), {
        status: 503,
        code: "unavailable",
        message: "profile-ownership-unavailable",
      });
      assert.deepEqual(h.steps, ["invite", "ownership"]);
    }
  });

  test(`${command} honors cancellation before and after invite reads`, async () => {
    for (const abortBeforeRead of [true, false]) {
      const controller = new AbortController();
      const failure = new Error("request-cancelled");
      if (abortBeforeRead) controller.abort(failure);
      const h = harness(command, {
        signal: controller.signal,
        onRead: () => controller.abort(failure),
      });
      await assert.rejects(h.run(), (error) => error === failure);
      assert.deepEqual(h.steps, abortBeforeRead ? [] : ["invite"]);
    }
  });

  test(`${command} preserves mutation guard failures without canonical writes`, async () => {
    const failure = new AuthApiFailure(503, "unavailable", "writes-disabled");
    const h = harness(command, { guardFailure: failure });
    await assert.rejects(h.run(), (error) => error === failure);
    assert.deepEqual(h.steps, ["invite", "guard"]);
  });
}
