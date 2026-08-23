import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { canRenderSymmetricalBracket, computeSymmetricalBracket } =
  await import("../src/ui/event/bracketGeometry.ts");
const {
  EVENT_AUTO_RECOVERY_DELAY_MS,
  EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON,
  EVENT_AUTO_RECOVERY_MIN_GAP_MS,
  EVENT_SUBSCRIBE_RETRY_DELAYS_MS,
  getDisplayedMatchSides,
  getEventAutoRecoveryReason,
  getEventNowRefreshDelayMs,
} = await import("../src/ui/event/eventState.ts");
const { getEndedEventWinnerPodiumEntries } =
  await import("../src/ui/event/eventPresentation.ts");
const modalController = await import("../src/ui/eventModalController.ts");

const participant = (profileId, joinedAtMs) => ({
  profileId,
  loginUid: `${profileId}-login`,
  username: profileId,
  displayName: profileId.toUpperCase(),
  emojiId: joinedAtMs,
  aura: "",
  joinedAtMs,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});

const match = (roundIndex, matchIndex, values = {}) => ({
  matchKey: `${roundIndex}_${matchIndex}`,
  inviteId: null,
  status: "upcoming",
  resolvedAtMs: null,
  winnerDisqualified: false,
  winnerProfileId: null,
  loserProfileId: null,
  hostSlotBlocked: false,
  hostProfileId: null,
  hostLoginUid: null,
  hostDisplayName: null,
  hostEmojiId: null,
  hostAura: null,
  guestSlotBlocked: false,
  guestProfileId: null,
  guestLoginUid: null,
  guestDisplayName: null,
  guestEmojiId: null,
  guestAura: null,
  ...values,
});

const round = (roundIndex, matchCount, matchValues = {}) => ({
  roundIndex,
  status: "upcoming",
  createdAtMs: 1,
  completedAtMs: null,
  matches: Object.fromEntries(
    Array.from({ length: matchCount }, (_, matchIndex) => [
      `${roundIndex}_${matchIndex}`,
      match(roundIndex, matchIndex, matchValues[`${roundIndex}_${matchIndex}`]),
    ]),
  ),
});

const eventRecord = (values = {}) => ({
  schemaVersion: 2,
  eventId: "event-test",
  status: "scheduled",
  createdAtMs: 1,
  updatedAtMs: 1,
  startAtMs: 10_000,
  startedAtMs: null,
  endedAtMs: null,
  createdByProfileId: "p1",
  createdByLoginUid: "p1-login",
  createdByUsername: "p1",
  winnerProfileId: null,
  winnerDisplayName: null,
  currentRoundIndex: null,
  bracketSize: 0,
  roundCount: 0,
  participants: {},
  rounds: {},
  ...values,
});

test("preserves symmetrical bracket geometry and disqualification connectors", () => {
  const rounds = [
    round(0, 4, { "0_0": { winnerDisqualified: true } }),
    round(1, 2),
    round(2, 1),
  ];

  assert.equal(canRenderSymmetricalBracket(rounds), true);
  const layout = computeSymmetricalBracket(rounds);
  assert.ok(layout);
  assert.deepEqual(
    { width: layout.width, height: layout.height },
    { width: 476, height: 152 },
  );
  assert.deepEqual(
    layout.positions.map(({ key, x, y, width, height }) => ({
      key,
      x,
      y,
      width,
      height,
    })),
    [
      { key: "L0_0", x: 0, y: 24, width: 72, height: 40 },
      { key: "L0_1", x: 0, y: 112, width: 72, height: 40 },
      { key: "L1_0", x: 90, y: 68, width: 72, height: 40 },
      { key: "FINAL", x: 202, y: 68, width: 72, height: 40 },
      { key: "R0_0", x: 404, y: 24, width: 72, height: 40 },
      { key: "R0_1", x: 404, y: 112, width: 72, height: 40 },
      { key: "R1_0", x: 314, y: 68, width: 72, height: 40 },
    ],
  );
  assert.deepEqual(layout.connectors[0], {
    d: "M72,44H116Q126,44 126,54V68",
    isBlocked: true,
    crossX: 94,
    crossY: 44,
  });
});

test("requires canonical bracket rounds and preserves bye and DQ side display", () => {
  const invalidRounds = [round(0, 2), round(1, 1)];
  invalidRounds[0].matches["0_0"].matchKey = "0_1";
  assert.equal(canRenderSymmetricalBracket(invalidRounds), false);

  assert.deepEqual(
    getDisplayedMatchSides(
      match(0, 0, {
        status: "bye",
        hostProfileId: "p1",
        hostDisplayName: "P1",
      }),
    ),
    ["host"],
  );
  assert.deepEqual(
    getDisplayedMatchSides(
      match(0, 0, {
        winnerDisqualified: true,
        hostProfileId: "p1",
        guestProfileId: "p2",
      }),
    ),
    ["host", "guest"],
  );
});

test("preserves event recovery reasons and retry timing", () => {
  const participants = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
  };
  assert.equal(
    getEventAutoRecoveryReason(
      eventRecord({ startAtMs: 100, participants }),
      100,
    ),
    "start-overdue",
  );
  assert.equal(
    getEventAutoRecoveryReason(
      eventRecord({ status: "active", participants }),
      100,
    ),
    "active-no-rounds",
  );
  assert.equal(
    getEventAutoRecoveryReason(
      eventRecord({
        status: "active",
        participants,
        rounds: {
          0: round(0, 1, { "0_0": { status: "pending" } }),
        },
      }),
      100,
    ),
    "active-pending-without-invite",
  );
  assert.equal(
    getEventAutoRecoveryReason(
      eventRecord({
        eventId: "NN3eRzoZo80",
        status: "ended",
        participants,
        prizeAssignments: {},
      }),
      100,
    ),
    "ended-missing-prize-assignments",
  );
  assert.deepEqual(EVENT_SUBSCRIBE_RETRY_DELAYS_MS, [600, 1600, 3200]);
  assert.equal(EVENT_AUTO_RECOVERY_DELAY_MS, 1_000);
  assert.equal(EVENT_AUTO_RECOVERY_MIN_GAP_MS, 6_000);
  assert.equal(EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON, 2);
  assert.equal(getEventNowRefreshDelayMs("active", 100, 100), 30_000);
  assert.equal(getEventNowRefreshDelayMs("scheduled", 100, 100), 5_000);
  assert.equal(getEventNowRefreshDelayMs("scheduled", 61_000, 0), 1_050);
});

test("preserves podium ordering and excludes a disqualified final winner", () => {
  const participants = {
    p1: participant("p1", 1),
    p2: participant("p2", 2),
    p3: participant("p3", 3),
    p4: participant("p4", 4),
  };
  const final = match(1, 0, {
    status: "host",
    hostProfileId: "p1",
    hostLoginUid: "p1-login",
    guestProfileId: "p2",
    guestLoginUid: "p2-login",
    winnerProfileId: "p1",
    loserProfileId: "p2",
  });
  const rounds = [round(0, 2), { ...round(1, 1), matches: { "1_0": final } }];
  const event = eventRecord({
    status: "ended",
    winnerProfileId: "p1",
    participants,
    rounds: Object.fromEntries(
      rounds.map((entry) => [entry.roundIndex, entry]),
    ),
    thirdPlaceMatch: match(2, 0, {
      status: "guest",
      hostProfileId: "p3",
      hostLoginUid: "p3-login",
      guestProfileId: "p4",
      guestLoginUid: "p4-login",
      winnerProfileId: "p4",
      loserProfileId: "p3",
    }),
  });

  assert.deepEqual(
    getEndedEventWinnerPodiumEntries(event, rounds, participants).map(
      ({ place, participant: entry }) => [place, entry.profileId],
    ),
    [
      [2, "p2"],
      [1, "p1"],
      [3, "p4"],
    ],
  );
  final.winnerDisqualified = true;
  assert.deepEqual(
    getEndedEventWinnerPodiumEntries(event, rounds, participants),
    [],
  );
});

test("sizes event prize artwork from catalog image dimensions", () => {
  const styles = readFileSync(
    new URL("../src/ui/event/EventModal.styles.ts", import.meta.url),
    "utf8",
  );
  const view = readFileSync(
    new URL("../src/ui/event/EventModalView.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(styles, /aspect-ratio:\s*4\s*\/\s*5/);
  assert.equal(styles.match(/props\.\$imageWidth/g)?.length, 2);
  assert.equal(styles.match(/props\.\$imageHeight/g)?.length, 2);
  assert.equal(view.match(/\$imageWidth=\{prize\.imageWidth\}/g)?.length, 2);
  assert.equal(view.match(/\$imageHeight=\{prize\.imageHeight\}/g)?.length, 2);
  assert.equal(view.match(/width=\{prize\.imageWidth\}/g)?.length, 2);
  assert.equal(view.match(/height=\{prize\.imageHeight\}/g)?.length, 2);
});

test("preserves the controller façade and modal state transitions", async () => {
  assert.deepEqual(Object.keys(modalController).sort(), [
    "EVENT_MODAL_AUTH_Z_INDEX",
    "EVENT_MODAL_Z_INDEX",
    "closeEventModal",
    "getEventModalState",
    "hasEventModalVisible",
    "openEventModal",
    "openEventModalPendingCreate",
    "setEventModalPendingCreateError",
    "subscribeToEventModalState",
  ]);
  await modalController.closeEventModal({ skipHomeTransition: true });
  const states = [];
  const unsubscribe = modalController.subscribeToEventModalState((state) => {
    states.push(state);
  });

  modalController.openEventModal(" event-1 ", { restoreHomeOnClose: true });
  assert.equal(modalController.getEventModalState().eventId, "event-1");
  modalController.openEventModalPendingCreate({ restoreHomeOnClose: false });
  modalController.setEventModalPendingCreateError(" ");
  assert.equal(
    modalController.getEventModalState().pendingCreateError,
    "Failed to create event.",
  );
  await modalController.closeEventModal({
    skipHomeTransition: true,
    reason: "launch_game",
  });
  assert.equal(modalController.hasEventModalVisible(), false);
  assert.equal(
    modalController.getEventModalState().lastCloseReason,
    "launch_game",
  );
  assert.equal(states.length, 5);
  unsubscribe();
});
