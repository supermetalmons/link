import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolvePlayerProfile,
  resolvePlayerProfileWithRetry,
} from "../src/connection/playerProfileLookup.ts";

const profile = (id, username) => ({ id, username });

test("resolves a player's profile directly through the login lookup", async () => {
  const calls = [];
  const expected = profile("profile-1", "named-player");

  const result = await resolvePlayerProfile("login-1", {
    getProfileByLoginId: async (loginId) => {
      calls.push(loginId);
      return expected;
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(calls, ["login-1"]);
});

test("propagates a login profile lookup failure", async () => {
  await assert.rejects(
    resolvePlayerProfile("login-2", {
      getProfileByLoginId: async () => {
        throw new Error("profile-service-unavailable");
      },
    }),
    /profile-service-unavailable/,
  );
});

test("retries one current lookup and returns exactly once", async () => {
  const expected = profile("profile-3", "retried-player");
  let waits = 0;
  let attempts = 0;

  const result = await resolvePlayerProfileWithRetry(
    "login-3",
    {
      getProfileByLoginId: async (loginId) => {
        assert.equal(loginId, "login-3");
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary-failure");
        }
        return expected;
      },
    },
    () => true,
    async () => {
      waits += 1;
    },
  );

  assert.equal(result, expected);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test("does not retry after lookup cleanup", async () => {
  let isCurrent = true;
  let attempts = 0;

  const result = await resolvePlayerProfileWithRetry(
    "login-4",
    {
      getProfileByLoginId: async () => {
        attempts += 1;
        throw new Error("temporary-failure");
      },
    },
    () => isCurrent,
    async () => {
      isCurrent = false;
    },
  );

  assert.equal(result, null);
  assert.equal(attempts, 1);
});

test("browser connection code has no RTDB profile-link dependency", () => {
  const source = readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /players\/\$\{[^}]+\}\/profile/);
  assert.doesNotMatch(
    source,
    /profileObserverCleanups|observeProfile|stopObservingProfile/,
  );
  assert.doesNotMatch(
    source,
    /checkBothPlayerProfiles|resolveLocalProfileId|Number\.POSITIVE_INFINITY/,
  );
  assert.doesNotMatch(source, /loginUid === (?:hostId|guestId)/);
  const roleRead = source.indexOf(
    "let actorResolution = await this.resolveActorUidForInvite",
  );
  const autojoinDecision = source.indexOf(
    "const shouldAutojoinAsGuest",
    roleRead,
  );
  const postJoinRoleRead = source.indexOf(
    "actorResolution = await this.resolveActorUidForInvite",
    autojoinDecision,
  );
  const matchRead = source.indexOf(
    "const myMatchSnapshot = await get",
    postJoinRoleRead,
  );
  const authRecheck = source.indexOf(
    "tokenProvider.assertCurrentUser()",
    matchRead,
  );
  const hydrationFailure = source.indexOf(
    "No match data found for writable role",
    matchRead,
  );
  const teardown = source.indexOf("this.detachFromMatchSession()", roleRead);
  assert.ok(
    roleRead >= 0 &&
      autojoinDecision > roleRead &&
      postJoinRoleRead > autojoinDecision &&
      matchRead > postJoinRoleRead &&
      authRecheck > matchRead &&
      hydrationFailure > authRecheck &&
      teardown > hydrationFailure,
  );
  assert.match(source, /readInviteRoleViaApi/);

  const controllerSource = readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  );
  const freshSignInHandler = controllerSource.slice(
    controllerSource.indexOf(
      "export function handleFreshlySignedInProfileInGameIfNeeded",
    ),
    controllerSource.indexOf("export function didFindInviteThatCanBeJoined"),
  );
  assert.doesNotMatch(freshSignInHandler, /isWatchOnly/);
});
