export const eventId = "NN3eRzoZo80";

const requiredFields = {
  eventId,
  status: "scheduled",
  updatedAtMs: 100,
  startAtMs: 1000,
};

export const retiredEventCases = [
  {
    name: "sparse records omit canonical fields",
    stored: {
      ...requiredFields,
      participants: { "profile-one": {} },
      rounds: { 0: {} },
    },
  },
  {
    name: "nested fields require coercion and contain unsupported extensions",
    stored: {
      ...requiredFields,
      schemaVersion: "2.9",
      isSundayMons: true,
      createdAtMs: "12.9",
      startedAtMs: "0",
      endedAtMs: null,
      currentRoundIndex: "2.8",
      bracketSize: "8",
      roundCount: "3",
      prizeSelectionsLockedAtMs: "17.9",
      winnerDisplayName: "  Winner  ",
      unknownFutureField: { retained: [true, null, 3] },
      participants: {
        "profile-one": {
          profileId: "",
          loginUid: "login-one",
          emojiId: "7.9",
          aura: null,
          joinedAtMs: "10.8",
          state: "legacy-state",
          eliminatedRoundIndex: "2.8",
          eliminatedByProfileId: "",
          futureParticipantField: { retained: true },
        },
      },
      rounds: {
        2: {
          status: "legacy-round-state",
          createdAtMs: "12.9",
          completedAtMs: null,
          futureRoundField: [1, 2],
          matches: {
            "2_0": {
              matchKey: "",
              status: "legacy-match-state",
              hostEmojiId: "9.9",
              guestEmojiId: null,
              winnerDisqualified: "true",
              hostSlotBlocked: true,
              futureMatchField: "retained",
            },
          },
        },
      },
      thirdPlaceMatch: { status: "upcoming", resolvedAtMs: "19.9" },
      prizeAssignments: {
        1: {
          eventId,
          profileId: "profile-one",
          place: "1",
          prizeId: " 1092 ",
          assignedAtMs: "25.9",
          futureAssignmentField: "retained",
        },
      },
    },
  },
  {
    name: "incomplete records contain nullable legacy fields",
    stored: {
      ...requiredFields,
      startedAtMs: null,
      endedAtMs: null,
      winnerProfileId: null,
      winnerDisplayName: null,
      currentRoundIndex: null,
      thirdPlaceMatch: null,
      prizeAssignments: null,
      prizeSelectionsLockedAtMs: null,
      participants: {},
      rounds: {},
    },
  },
];
