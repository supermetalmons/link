import assert from "node:assert/strict";
import test from "node:test";
import {
  changedInviteWagersIds,
  notifyInviteWagersChanged,
  notifyInviteSourceChanged,
} from "../src/inviteWagersNotifications.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function environment(notify: (inviteId: string) => Promise<void>): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        notifyWagersChanged: async (incoming: string) => {
          assert.equal(incoming, inviteId);
          await notify(inviteId);
        },
        notifyMetadataChanged: async () => undefined,
      }),
    },
  } as unknown as Env;
}

test("wager invalidation covers source and access changes without unrelated state", () => {
  assert.deepEqual(
    changedInviteWagersIds({
      "invites/proposal/wagers/match/proposals/host": { count: 2 },
      "invites/proposal/wagers/match/proposals/guest": null,
      "invites/agreement/wagers/match/agreed": {},
      "invites/settlement/wagers/match/settlement": {},
      "invites/resolved/wagers/match/resolved": {},
      "invites/replaced": {},
      "invites/deleted": null,
      "invites/private/password": true,
      "invites/paired/guestId": "guest",
      "invites/owner/hostId": "host",
      "invites/unrelated/hostRematches": "1",
      "invites/unrelated/matchesWagerResolutions/match": true,
      "players/host/matches/match": {},
      "matchTimerClaims/match": {},
    }),
    [
      "proposal",
      "agreement",
      "settlement",
      "resolved",
      "replaced",
      "deleted",
      "private",
      "paired",
      "owner",
    ],
  );
  assert.deepEqual(
    changedInviteWagersIds({
      invites: { first: {}, second: null, "invalid/key": {} },
    }),
    ["first", "second"],
  );
});

test("confirmed source changes deduplicate metadata and wager invalidations", async () => {
  const calls: string[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        notifyMetadataChanged: async () => {
          calls.push(`metadata:${inviteId}`);
        },
        notifyWagersChanged: async () => {
          calls.push(`wagers:${inviteId}`);
        },
      }),
    },
  } as unknown as Env;
  await notifyInviteSourceChanged(
    env,
    {
      "invites/combined/guestId": "guest",
      "invites/combined/wagers/match": {},
      "invites/wager-only/wagers/match": {},
    },
    true,
  );
  assert.deepEqual(calls, ["metadata:combined", "wagers:wager-only"]);
  calls.length = 0;
  await notifyInviteSourceChanged(env, { "invites/combined": {} }, true);
  assert.deepEqual(calls, ["metadata:combined"]);
});

test("ambiguous source changes invalidate wagers without claiming metadata committed", async () => {
  const notices: string[] = [];
  await notifyInviteSourceChanged(
    environment(async (id) => {
      notices.push(id);
    }),
    {
      "invites/combined": {},
      "invites/wager-only/wagers/match/proposals/host": {},
      "invites/wager-only/wagers/match/proposedBy/host": true,
      "invites/unrelated/hostRematches": "1",
    },
    false,
  );
  assert.deepEqual(notices, ["combined", "wager-only"]);
});

test("failed or stuck room notifications are bounded and cannot reject committed work", async () => {
  for (const notify of [
    async () => {
      throw new Error("unavailable");
    },
    () => new Promise<void>(() => undefined),
  ]) {
    let failures = 0;
    await notifyInviteWagersChanged(
      environment(notify),
      { "invites/invite/wagers/match": {} },
      {
        timeoutMs: 1,
        logFailure: () => {
          failures++;
        },
      },
    );
    assert.equal(failures, 1);
  }
  await notifyInviteSourceChanged(
    environment(async () => {
      throw new Error("unavailable");
    }),
    { "invites/invite/wagers/match": {} },
    true,
  );
});
