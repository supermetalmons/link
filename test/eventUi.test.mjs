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
  canLeaveEvent,
  getCurrentUiState,
  getEventParticipant,
  getEventProfileIdsToResolve,
  canSelectEventPrize,
  getDisplayedMatchSides,
  getEventAutoRecoveryReason,
  getEventNowRefreshDelayMs,
} = await import("../src/ui/event/eventState.ts");
const { storage } = await import("../src/utils/storage.ts");
const { getProfileByIdViaApi, resolveProfileIdViaApi } =
  await import("../src/services/profileApi.ts");
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
  for (const status of ["scheduled", "active", "ended"]) {
    assert.equal(
      getEventAutoRecoveryReason(
        eventRecord({ status, startAtMs: 100, participants }),
        100,
        false,
      ),
      null,
    );
  }
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
  assert.equal(EVENT_AUTO_RECOVERY_DELAY_MS, 1_000);
  assert.equal(EVENT_AUTO_RECOVERY_MIN_GAP_MS, 6_000);
  assert.equal(EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON, 2);
  assert.equal(getEventNowRefreshDelayMs("active", 100, 100), 30_000);
  assert.equal(getEventNowRefreshDelayMs("scheduled", 100, 100), 5_000);
  assert.equal(getEventNowRefreshDelayMs("scheduled", 61_000, 0), 1_050);
});

test("refreshes just after the strict prize reveal boundary", () => {
  const nowMs = 1_000_000;
  const hourMs = 3_600_000;

  assert.equal(
    getEventNowRefreshDelayMs("scheduled", nowMs + hourMs + 1, nowMs),
    51,
  );
  assert.equal(
    getEventNowRefreshDelayMs("scheduled", nowMs + hourMs, nowMs),
    50,
  );
  assert.equal(
    getEventNowRefreshDelayMs("scheduled", nowMs + hourMs - 1, nowMs),
    60_000,
  );
  assert.equal(
    getEventNowRefreshDelayMs("scheduled", nowMs + hourMs + 61_000, nowMs),
    1_050,
  );
  assert.equal(getEventNowRefreshDelayMs("scheduled", null, nowMs), 30_000);
  assert.equal(getEventNowRefreshDelayMs("scheduled", NaN, nowMs), 30_000);
  assert.equal(getEventNowRefreshDelayMs("ended", nowMs, nowMs), 30_000);
  assert.equal(getEventNowRefreshDelayMs(null, null, nowMs), 30_000);
});

test("allows enrolled noncreators to leave only before the scheduled start", (t) => {
  let profileId = "p2";
  let loginUid = "p2-login";
  t.mock.method(storage, "getProfileId", () => profileId);
  t.mock.method(storage, "getLoginId", () => loginUid);
  const event = eventRecord({
    startAtMs: 1000,
    participants: { p1: participant("p1", 1), p2: participant("p2", 2) },
  });
  assert.equal(canLeaveEvent(event, profileId, 999), true);
  assert.equal(canLeaveEvent(event, profileId, 1000), false);
  assert.equal(canLeaveEvent(event, profileId, 1001), false);
  assert.equal(canLeaveEvent(null, profileId, 999), false);
  assert.equal(canLeaveEvent(event, "", 999), false);
  assert.equal(canLeaveEvent(event, "p3", 999, "p3-login"), false);
  for (const startAtMs of [NaN, Infinity, -Infinity]) {
    assert.equal(canLeaveEvent({ ...event, startAtMs }, profileId, 999), false);
  }
  for (const status of ["active", "ended", "dismissed"]) {
    assert.equal(canLeaveEvent({ ...event, status }, profileId, 999), false);
  }
  profileId = "p1";
  assert.equal(canLeaveEvent(event, profileId, 999), false);
  profileId = "p2";
  loginUid = "p1-login";
  assert.equal(canLeaveEvent(event, profileId, 999), false);
});

test("merged-profile membership shows Leave without Join using the stored login", (t) => {
  t.mock.method(storage, "getProfileId", () => "new-profile");
  t.mock.method(storage, "getLoginId", () => "linked-login");
  const storedParticipant = {
    ...participant("old-profile", 2),
    loginUid: "linked-login",
  };
  const event = eventRecord({
    startAtMs: 1000,
    participants: { "old-profile": storedParticipant },
  });
  assert.equal(
    getEventParticipant(event, "new-profile", "linked-login"),
    storedParticipant,
  );
  const uiState = getCurrentUiState(event, "new-profile", "linked-login");
  const showJoin =
    !uiState.isJoined && event.status === "scheduled" && 999 < event.startAtMs;
  const showLeave = canLeaveEvent(event, "new-profile", 999, "linked-login");
  assert.equal(showLeave, true);
  assert.equal(showJoin, false);
  assert.equal(showJoin && showLeave, false);
  assert.equal(
    getEventParticipant(event, "new-profile", "different-login"),
    null,
  );
  assert.equal(getEventParticipant(event, "", ""), null);
  const leftEvent = { ...event, participants: {} };
  assert.equal(
    getCurrentUiState(leftEvent, "new-profile", "linked-login").isJoined,
    false,
  );
  assert.equal(
    canLeaveEvent(leftEvent, "new-profile", 999, "linked-login"),
    false,
  );
});

test("canonical membership shows Leave without Join through another linked login", (t) => {
  t.mock.method(storage, "getProfileId", () => "canonical-profile");
  t.mock.method(storage, "getLoginId", () => "alternate-login");
  const storedParticipant = {
    ...participant("retired-profile", 2),
    loginUid: "original-login",
  };
  const event = eventRecord({
    startAtMs: 1000,
    participants: { "retired-profile": storedParticipant },
  });
  const profileIds = { "retired-profile": "canonical-profile", p1: "p1" };
  const uiState = getCurrentUiState(
    event,
    "canonical-profile",
    "alternate-login",
    profileIds,
  );
  assert.equal(
    getEventParticipant(
      event,
      "canonical-profile",
      "alternate-login",
      profileIds,
    ),
    storedParticipant,
  );
  assert.equal(uiState.isJoined, true);
  assert.equal(
    canLeaveEvent(
      event,
      "canonical-profile",
      999,
      "alternate-login",
      profileIds,
    ),
    true,
  );
  assert.equal(
    canLeaveEvent(
      event,
      "canonical-profile",
      1000,
      "alternate-login",
      profileIds,
    ),
    false,
  );

  const leftEvent = { ...event, participants: {} };
  assert.equal(
    getCurrentUiState(
      leftEvent,
      "canonical-profile",
      "alternate-login",
      profileIds,
    ).isJoined,
    false,
  );
  assert.equal(
    canLeaveEvent(
      leftEvent,
      "canonical-profile",
      999,
      "alternate-login",
      profileIds,
    ),
    false,
  );
  const rejoinedEvent = {
    ...event,
    participants: { "canonical-profile": participant("canonical-profile", 3) },
  };
  assert.equal(
    canLeaveEvent(
      rejoinedEvent,
      "canonical-profile",
      999,
      "alternate-login",
      profileIds,
    ),
    true,
  );
});

test("canonical ownership shows Leave without Join when public profile lookup is null", async (t) => {
  const profileId = "canonical-profile";
  const loginUid = "alternate-login";
  t.mock.method(storage, "getProfileId", () => profileId);
  t.mock.method(storage, "getLoginId", () => loginUid);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const response =
      path === "/profiles/lookup"
        ? { ok: true, profile: null }
        : {
            ok: true,
            profileId:
              body.profileId === "retired-profile" ? profileId : body.profileId,
          };
    assert.ok(path === "/profiles/lookup" || path === "/profiles/canonical-id");
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const event = eventRecord({
    startAtMs: 1000,
    participants: {
      "retired-profile": {
        ...participant("retired-profile", 2),
        loginUid: "original-login",
      },
    },
  });
  const tokenProvider = async () => "session-token";
  assert.equal(
    await getProfileByIdViaApi("retired-profile", tokenProvider),
    null,
  );
  const profileIds = Object.fromEntries(
    await Promise.all(
      getEventProfileIdsToResolve(event, profileId, loginUid).map(
        async (id) => [
          id,
          (await resolveProfileIdViaApi(id, tokenProvider)) ?? "",
        ],
      ),
    ),
  );
  const uiState = getCurrentUiState(event, profileId, loginUid, profileIds);
  const showJoin =
    !uiState.isJoined && event.status === "scheduled" && 999 < event.startAtMs;
  assert.equal(
    canLeaveEvent(event, profileId, 999, loginUid, profileIds),
    true,
  );
  assert.equal(showJoin, false);
  assert.deepEqual(calls, [
    {
      path: "/profiles/lookup",
      body: { kind: "profile", id: "retired-profile" },
    },
    { path: "/profiles/canonical-id", body: { profileId: "p1" } },
    { path: "/profiles/canonical-id", body: { profileId: "retired-profile" } },
  ]);
});

test("canonical creators cannot leave through another linked login", (t) => {
  t.mock.method(storage, "getProfileId", () => "canonical-profile");
  t.mock.method(storage, "getLoginId", () => "alternate-login");
  const profileIds = { "retired-profile": "canonical-profile" };
  for (const participantId of ["retired-profile", "canonical-profile"]) {
    const event = eventRecord({
      startAtMs: 1000,
      createdByProfileId: "retired-profile",
      createdByLoginUid: "original-login",
      participants: { [participantId]: participant(participantId, 1) },
    });
    assert.equal(
      getCurrentUiState(
        event,
        "canonical-profile",
        "alternate-login",
        profileIds,
      ).isJoined,
      true,
    );
    assert.equal(
      canLeaveEvent(
        event,
        "canonical-profile",
        999,
        "alternate-login",
        profileIds,
      ),
      false,
    );
  }
});

test("profile resolution skips unrelated participants when membership is direct", () => {
  const event = eventRecord({
    participants: { p1: participant("p1", 1), p2: participant("p2", 2) },
  });
  assert.deepEqual(getEventProfileIdsToResolve(event, "p2", "other-login"), [
    "p1",
  ]);
  assert.deepEqual(
    getEventProfileIdsToResolve(event, "merged-p2", "p2-login"),
    ["p1"],
  );
  assert.deepEqual(getEventProfileIdsToResolve(event, "p1", "p1-login"), []);
  assert.deepEqual(
    getEventProfileIdsToResolve(event, "merged-p2", "other-login"),
    ["p1", "p2"],
  );
});

test("allows prize selection only during the reveal window for unlocked participants", () => {
  const nowMs = 1_000_000;
  const hourMs = 3_600_000;
  const event = eventRecord({
    startAtMs: nowMs + hourMs,
    participants: { p1: participant("p1", 1) },
  });

  for (const [offsetMs, expected] of [
    [1, false],
    [0, false],
    [-1, true],
  ]) {
    assert.equal(
      canSelectEventPrize(
        { ...event, startAtMs: nowMs + hourMs + offsetMs },
        "p1",
        nowMs,
      ),
      expected,
    );
  }

  const revealedEvent = { ...event, startAtMs: nowMs + hourMs - 1 };
  assert.equal(canSelectEventPrize(null, "p1", nowMs), false);
  assert.equal(canSelectEventPrize(revealedEvent, "", nowMs), false);
  assert.equal(canSelectEventPrize(revealedEvent, "p2", nowMs), false);
  assert.equal(
    canSelectEventPrize(
      { ...revealedEvent, prizeSelectionsLockedAtMs: 0 },
      "p1",
      nowMs,
    ),
    false,
  );
  assert.equal(
    canSelectEventPrize(
      { ...revealedEvent, startAtMs: nowMs - 1 },
      "p1",
      nowMs,
    ),
    true,
  );
  assert.equal(
    canSelectEventPrize({ ...event, status: "active" }, "p1", nowMs),
    true,
  );
  assert.equal(
    canSelectEventPrize(
      { ...event, status: "active", prizeSelectionsLockedAtMs: nowMs },
      "p1",
      nowMs,
    ),
    false,
  );
  for (const status of ["ended", "dismissed"]) {
    assert.equal(
      canSelectEventPrize({ ...revealedEvent, status }, "p1", nowMs),
      false,
    );
  }
  assert.equal(
    canSelectEventPrize({ ...revealedEvent, startAtMs: NaN }, "p1", nowMs),
    false,
  );
  assert.equal(
    canSelectEventPrize(
      { ...revealedEvent, startAtMs: nowMs + hourMs + 1 },
      "p1",
      nowMs,
    ),
    false,
  );
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

test("preserves the controller façade and modal state transitions", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let location = new URL("https://mons.link/game-1");
  const paths = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      get location() {
        return location;
      },
      history: {
        pushState(_state, _title, path) {
          paths.push(path);
          location = new URL(path, location);
        },
      },
    },
  });
  t.after(() => {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  });
  assert.deepEqual(Object.keys(modalController).sort(), [
    "EVENT_MODAL_AUTH_Z_INDEX",
    "EVENT_MODAL_Z_INDEX",
    "closeEventModal",
    "getEventModalState",
    "hasEventModalVisible",
    "openEventModal",
    "openEventModalPendingCreate",
    "prepareEventModalGameLaunch",
    "setEventModalPendingCreateError",
    "subscribeToEventModalState",
    "syncEventModalToRoute",
  ]);
  await modalController.closeEventModal();
  const states = [];
  const unsubscribe = modalController.subscribeToEventModalState((state) => {
    states.push(state);
  });

  modalController.openEventModal(" event-1 ");
  assert.equal(modalController.getEventModalState().eventId, "event-1");
  modalController.openEventModalPendingCreate();
  modalController.setEventModalPendingCreateError(" ");
  assert.equal(
    modalController.getEventModalState().pendingCreateError,
    "Failed to create event.",
  );
  await modalController.closeEventModal({
    reason: "launch_game",
  });
  assert.equal(modalController.hasEventModalVisible(), false);
  assert.equal(
    modalController.getEventModalState().lastCloseReason,
    "launch_game",
  );
  assert.deepEqual(paths, ["/game-1?event=event-1", "/game-1"]);
  assert.deepEqual(
    states.map(({ isOpen, isPendingCreate }) => [isOpen, isPendingCreate]),
    [
      [false, false],
      [true, false],
      [false, false],
      [true, true],
      [true, true],
      [false, false],
    ],
  );
  unsubscribe();
});
