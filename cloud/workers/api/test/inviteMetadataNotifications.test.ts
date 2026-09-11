import assert from "node:assert/strict";
import test from "node:test";
import { notifyInviteSourceChanged } from "../src/inviteWagersNotifications.ts";
import {
  changedInviteMetadataIds,
  notifyInviteMetadataChanged,
} from "../src/inviteMetadataNotifications.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("metadata notifications cover structural producer writes and ignore unrelated state", () => {
  assert.deepEqual(
    changedInviteMetadataIds({
      "invites/manual": { hostId: "host" },
      "invites/auto_pending": { guestId: null },
      "invites/auto_matched/guestId": "guest",
      "invites/auto_canceled/automatchStateHint": "canceled",
      "invites/auto_recovered/automatchOperationIds/host": "operation",
      "invites/event_invite": {
        eventOwned: true,
        hostId: "host",
        guestId: "guest",
      },
      "invites/rematch/hostRematches": "1",
      "invites/rematch/guestRematches": "1x",
      "invites/private/password": "changed",
      "invites/removed": null,
      "invites/wager/wagers/match/proposals": {},
      "invites/wager/matchesWagerResolutions/match": true,
      "players/host/matches/manual/fen": "next",
      "matchTimerClaims/manual": {},
      "telegramProjectionOutbox/automatch/manual": {},
    }),
    [
      "manual",
      "auto_pending",
      "auto_matched",
      "auto_canceled",
      "auto_recovered",
      "event_invite",
      "rematch",
      "private",
      "removed",
    ],
  );
  assert.deepEqual(
    changedInviteMetadataIds({ invites: { "bulk-one": {}, "bulk-two": {} } }),
    ["bulk-one", "bulk-two"],
  );
});

test("committed source updates notify metadata once per invite", async () => {
  const notices: string[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (id: string) => ({
        notifyMetadataChanged: async (incoming: string) => {
          assert.equal(incoming, id);
          notices.push(id);
        },
        notifyWagersChanged: async () =>
          assert.fail("metadata already invalidates wagers"),
      }),
    },
  } as unknown as Env;
  await notifyInviteSourceChanged(
    env,
    {
      "invites/manual/hostRematches": "1",
      "invites/manual/guestRematches": "1",
      "invites/joined/guestId": "guest",
    },
    true,
  );
  assert.deepEqual(notices, ["manual", "joined"]);
});

test("unconfirmed changes skip metadata and notification failure cannot reject committed work", async () => {
  let notices = 0;
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: async () => {
          notices++;
        },
        notifyWagersChanged: async () => undefined,
      }),
    },
  } as unknown as Env;
  await notifyInviteSourceChanged(
    env,
    { "invites/manual/guestId": "guest" },
    false,
  );
  assert.equal(notices, 0);
  let failures = 0;
  const unavailable = {
    ...env,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: async () => {
          throw new Error("unavailable");
        },
      }),
    },
  } as unknown as Env;
  await notifyInviteMetadataChanged(
    unavailable,
    { "invites/manual/guestId": "guest" },
    {
      logFailure: () => {
        failures++;
      },
    },
  );
  assert.equal(failures, 1);
});

test("notification deadline prevents a stuck room from holding a committed mutation", async () => {
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: () => new Promise<void>(() => undefined),
      }),
    },
  } as unknown as Env;
  let failures = 0;
  await notifyInviteMetadataChanged(
    env,
    { "invites/manual/hostRematches": "1" },
    {
      timeoutMs: 1,
      logFailure: () => {
        failures++;
      },
    },
  );
  assert.equal(failures, 1);
});
