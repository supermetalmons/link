export const eventId = "NN3eRzoZo80";

const participant = (profileId, fields = {}) => ({
  profileId,
  loginUid: "",
  username: "",
  displayName: "",
  emojiId: 0,
  aura: "",
  joinedAtMs: 0,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
  ...fields,
});

const match = (matchKey, fields = {}) => ({
  matchKey,
  inviteId: null,
  status: "pending",
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
  ...fields,
});

const event = (fields = {}) => ({
  schemaVersion: 1,
  eventId,
  status: "scheduled",
  isSundayMons: false,
  createdAtMs: 0,
  updatedAtMs: 100,
  startAtMs: 1000,
  startedAtMs: null,
  endedAtMs: null,
  createdByProfileId: "",
  createdByLoginUid: "",
  createdByUsername: "",
  winnerProfileId: null,
  winnerDisplayName: null,
  currentRoundIndex: null,
  bracketSize: 0,
  roundCount: 0,
  thirdPlaceMatch: null,
  prizeSelectionsLockedAtMs: null,
  prizeAssignments: {},
  participants: {},
  rounds: {},
  ...fields,
});

const requiredFields = {
  eventId,
  status: "scheduled",
  updatedAtMs: 100,
  startAtMs: 1000,
};

export const eventCompatibilityCases = [
  {
    name: "sparse records keep omitted fields in storage and wire",
    stored: {
      ...requiredFields,
      participants: { "profile-one": {} },
      rounds: { 0: {} },
    },
    view: event({
      participants: { "profile-one": participant("profile-one") },
      rounds: {
        0: {
          roundIndex: 0,
          status: "active",
          createdAtMs: 0,
          completedAtMs: null,
          matches: {},
        },
      },
    }),
  },
  {
    name: "legacy nested fields retain coercions and extension JSON",
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
    view: event({
      schemaVersion: 2,
      isSundayMons: true,
      createdAtMs: 12,
      startedAtMs: 0,
      currentRoundIndex: 2,
      bracketSize: 8,
      roundCount: 3,
      prizeSelectionsLockedAtMs: 17,
      winnerDisplayName: "  Winner  ",
      participants: {
        "profile-one": participant("profile-one", {
          loginUid: "login-one",
          emojiId: 7,
          joinedAtMs: 10,
          eliminatedRoundIndex: 2,
        }),
      },
      rounds: {
        2: {
          roundIndex: 2,
          status: "active",
          createdAtMs: 12,
          completedAtMs: null,
          matches: {
            "2_0": match("2_0", { hostEmojiId: 9, hostSlotBlocked: true }),
          },
        },
      },
      thirdPlaceMatch: match("third_place", {
        status: "upcoming",
        resolvedAtMs: 19,
      }),
      prizeAssignments: {
        1: {
          eventId,
          profileId: "profile-one",
          place: 1,
          prizeId: "1092",
          assignedAtMs: 25,
        },
      },
    }),
  },
  {
    name: "explicit nulls remain distinct from absent document fields",
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
    view: event(),
  },
];
