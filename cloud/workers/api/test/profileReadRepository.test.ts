import assert from "node:assert/strict";
import test from "node:test";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import { createConfiguredProfileRepository } from "../src/profileReadRepository.ts";
import {
  ProfileRepositoryFailure,
  type ProfileRepository,
} from "../src/profileRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const profile = {
  id: "profile-1",
  nonce: 1,
  rating: 1500,
  totalManaPoints: 0,
  win: true,
  emoji: 1,
  username: null,
  eth: null,
  sol: null,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};

function repository(
  calls: string[],
  value: CompletePlayerProfile = profile,
): ProfileRepository {
  return {
    async getProfileById() {
      calls.push("profile");
      return value;
    },
    async getProfileByLoginId() {
      calls.push("login");
      return value;
    },
    async readLeaderboard() {
      calls.push("leaderboard");
      return [value];
    },
  };
}

test("Firestore mode never calls D1", async () => {
  const firestoreCalls: string[] = [];
  const d1Calls: string[] = [];
  const selected = createConfiguredProfileRepository(TELEGRAM_TEST_ENV as Env, {
    mode: "firestore",
    d1: repository(d1Calls),
    firestore: repository(firestoreCalls),
  });
  assert.equal(
    (await selected.getProfileByLoginId("login-1", "token"))?.id,
    "profile-1",
  );
  assert.deepEqual(firestoreCalls, ["login"]);
  assert.deepEqual(d1Calls, []);
});

test("D1 mode never calls or falls back to Firestore", async () => {
  const firestoreCalls: string[] = [];
  const d1Calls: string[] = [];
  const d1 = repository(d1Calls);
  d1.getProfileById = async () => {
    d1Calls.push("profile");
    throw new ProfileRepositoryFailure();
  };
  const selected = createConfiguredProfileRepository(TELEGRAM_TEST_ENV as Env, {
    mode: "d1",
    d1,
    firestore: repository(firestoreCalls),
  });
  await assert.rejects(
    selected.getProfileById("profile-1", "token"),
    ProfileRepositoryFailure,
  );
  assert.deepEqual(d1Calls, ["profile"]);
  assert.deepEqual(firestoreCalls, []);
});

test("invalid configured modes fail closed", () => {
  const invalidEnv = { ...TELEGRAM_TEST_ENV } as Env;
  Reflect.set(invalidEnv, "PROFILE_READ_MODE", "invalid");
  assert.throws(
    () =>
      createConfiguredProfileRepository(invalidEnv, {
        d1: repository([]),
        firestore: repository([]),
      }),
    ProfileRepositoryFailure,
  );
});
