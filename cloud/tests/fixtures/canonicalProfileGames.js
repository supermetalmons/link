"use strict";

const assert = require("node:assert/strict");
const { isInviteDocument } = require("../../runtime/shared/invite-records");
const {
  retainProjectionProfile,
  retainProfileGameProjection,
} = require("../../runtime/profileGameProjectionRecords");

/** @param {{[Field in keyof import("../../runtime/shared/invite-records").InviteDocument]?: import("../../runtime/shared/invite-records").InviteDocument[Field]}} [patch] */
function invite(patch = {}) {
  const value = {
    schemaVersion: 1,
    version: 2,
    kind: "manual",
    hostId: "host-login",
    guestId: null,
    hostColor: "white",
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [] },
    sessionTransition: null,
    automatchMessage: null,
    automatchOperationIds: {},
    password: null,
    automatchStateHint: null,
    automatchCanceledAt: null,
    telegramDeliveryVersion: null,
    eventOwned: false,
    eventId: null,
    eventRoundIndex: null,
    eventMatchKey: null,
    ...patch,
  };
  assert.ok(isInviteDocument(value), "invalid invite fixture");
  return value;
}

/** @param {Partial<import("../../runtime/profileGameProjectionRecords").ProjectionProfileDocument>} [patch] */
function profile(patch = {}) {
  return retainProjectionProfile({
    eth: "",
    sol: "",
    username: "",
    emoji: null,
    ...patch,
  });
}

/** @param {Partial<import("../../runtime/shared/profile-game-projections").GameProjectionRecord>} [patch] */
function projection(patch = {}) {
  const status = patch.status ?? "waiting";
  const timestamp = patch.listSortAt ?? 1;
  const value = retainProfileGameProjection({
    schemaVersion: 3,
    projectorVersion: 3,
    source: "game-projector",
    entityType: "game",
    inviteId: "invite",
    kind: "direct",
    hostLoginId: null,
    guestLoginId: null,
    hostProfileId: null,
    guestProfileId: null,
    status,
    sortBucket: { pending: 20, waiting: 30, active: 40, ended: 50 }[status],
    isPendingAutomatch: status === "pending",
    automatchStateHint: null,
    automatchCanceledAt: null,
    latestMatchId: patch.inviteId ?? "invite",
    ownerProfileId: "profile-1",
    ownerRole: "host",
    ownerLoginId: null,
    opponentProfileId: null,
    opponentLoginId: null,
    opponentName: null,
    opponentEmoji: status === "active" || status === "ended" ? 1 : null,
    listSortAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    endedAt: null,
    lastEventFingerprint: "fixture",
    lastEventType: null,
    lastEventReason: null,
    lastEventAt: timestamp,
    ...patch,
  });
  assert.ok(value.entityType === "game");
  return value;
}

module.exports = { invite, profile, projection };
