import type { MiningMaterialName } from "./mining.js";
import { normalizeRecordKey } from "./ids.js";
import { isMaterialName } from "./mining.js";

export type PublicWagerProposal = {
  material: MiningMaterialName;
  count: number;
  createdAt?: number;
};

export type PublicWagerAgreement = {
  material: MiningMaterialName;
  count: number;
  total?: number;
  proposerId: string;
  accepterId: string;
  acceptedAt?: number;
};

export type PublicWagerResolution = {
  winnerId: string;
  loserId: string;
  material: MiningMaterialName;
  count: number;
  total?: number;
  resolvedAt?: number;
};

export type PublicMatchWagerState = {
  proposals?: Record<string, PublicWagerProposal>;
  proposedBy?: Record<string, boolean>;
  agreed?: PublicWagerAgreement;
  resolved?: PublicWagerResolution;
};

export type InviteWagersSnapshot = {
  inviteId: string;
  revision: number;
  wagers: Record<string, PublicMatchWagerState>;
};

export type ReadInviteWagersResponse = {
  ok: true;
  snapshot: InviteWagersSnapshot;
};

export type InviteWagersMessage = {
  schemaVersion: 1;
  type: "snapshot";
  snapshot: InviteWagersSnapshot;
};

const INVITE_WAGERS_SOCKET_PROTOCOL = "mons-invite-wagers-v1";
const INVITE_WAGERS_MAX_MESSAGE_BYTES: number = 1024 * 1024 + 16 * 1024;
const INVITE_WAGERS_REFRESH_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const isKey = (value: unknown): value is string =>
  typeof value === "string" && normalizeRecordKey(value) === value;
const isUid = (value: unknown): value is string =>
  isKey(value) && value.length <= 128;
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && (value as number) >= 0;
const optional = (
  value: Record<string, unknown>,
  key: string,
  validate: (value: unknown) => boolean,
) => !Object.hasOwn(value, key) || validate(value[key]);
const isParticipantMap = (
  value: unknown,
  validate: (value: unknown) => boolean,
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length <= 2 &&
  Object.entries(value).every(([uid, entry]) => isUid(uid) && validate(entry));

function isPublicWagerProposal(value: unknown): value is PublicWagerProposal {
  return (
    isRecord(value) &&
    hasKeys(value, ["material", "count"], ["createdAt"]) &&
    isMaterialName(value.material) &&
    isCount(value.count) &&
    optional(value, "createdAt", isTimestamp)
  );
}

function isPublicWagerAgreement(value: unknown): value is PublicWagerAgreement {
  return (
    isRecord(value) &&
    hasKeys(
      value,
      ["material", "count", "proposerId", "accepterId"],
      ["total", "acceptedAt"],
    ) &&
    isMaterialName(value.material) &&
    isCount(value.count) &&
    isUid(value.proposerId) &&
    isUid(value.accepterId) &&
    value.proposerId !== value.accepterId &&
    optional(value, "total", isCount) &&
    optional(value, "acceptedAt", isTimestamp)
  );
}

function isPublicWagerResolution(
  value: unknown,
): value is PublicWagerResolution {
  return (
    isRecord(value) &&
    hasKeys(
      value,
      ["material", "count", "winnerId", "loserId"],
      ["total", "resolvedAt"],
    ) &&
    isMaterialName(value.material) &&
    isCount(value.count) &&
    isUid(value.winnerId) &&
    isUid(value.loserId) &&
    value.winnerId !== value.loserId &&
    optional(value, "total", isCount) &&
    optional(value, "resolvedAt", isTimestamp)
  );
}

function isPublicMatchWagerState(
  value: unknown,
): value is PublicMatchWagerState {
  return (
    isRecord(value) &&
    hasKeys(value, [], ["proposals", "proposedBy", "agreed", "resolved"]) &&
    optional(value, "proposals", (proposals) =>
      isParticipantMap(proposals, isPublicWagerProposal),
    ) &&
    optional(value, "proposedBy", (proposedBy) =>
      isParticipantMap(proposedBy, (proposed) => typeof proposed === "boolean"),
    ) &&
    optional(value, "agreed", isPublicWagerAgreement) &&
    optional(value, "resolved", isPublicWagerResolution)
  );
}

function isInviteWagersSnapshot(value: unknown): value is InviteWagersSnapshot {
  return (
    isRecord(value) &&
    hasKeys(value, ["inviteId", "revision", "wagers"]) &&
    isKey(value.inviteId) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    isRecord(value.wagers) &&
    Object.entries(value.wagers).every(
      ([matchId, wager]) => isKey(matchId) && isPublicMatchWagerState(wager),
    )
  );
}

function isReadInviteWagersResponse(
  value: unknown,
): value is ReadInviteWagersResponse {
  return (
    isRecord(value) &&
    hasKeys(value, ["ok", "snapshot"]) &&
    value.ok === true &&
    isInviteWagersSnapshot(value.snapshot)
  );
}

function isInviteWagersMessage(value: unknown): value is InviteWagersMessage {
  return (
    isRecord(value) &&
    hasKeys(value, ["schemaVersion", "type", "snapshot"]) &&
    value.schemaVersion === 1 &&
    value.type === "snapshot" &&
    isInviteWagersSnapshot(value.snapshot)
  );
}

export {
  INVITE_WAGERS_SOCKET_PROTOCOL,
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  INVITE_WAGERS_REFRESH_MS,
  isPublicWagerProposal,
  isPublicWagerAgreement,
  isPublicWagerResolution,
  isPublicMatchWagerState,
  isInviteWagersSnapshot,
  isReadInviteWagersResponse,
  isInviteWagersMessage,
};
