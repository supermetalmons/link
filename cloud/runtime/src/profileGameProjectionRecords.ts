import type {
  NavigationEventStatus,
  NavigationGameStatus,
} from "@mons/shared/navigation";

declare const projectionDocument: unique symbol;
declare const projectionProfile: unique symbol;
export type ProfileGameProjectionDocument = {
  readonly [projectionDocument]: true;
};
export type ProjectionProfileDocument = { readonly [projectionProfile]: true };

export type GameProjectionWrite = {
  schemaVersion: 2;
  projectorVersion: 2;
  source: "rtdb-projector";
  entityType: "game";
  inviteId: string;
  kind: "auto" | "direct";
  hostLoginId: string | null;
  guestLoginId: string | null;
  hostProfileId: string | null;
  guestProfileId: string | null;
  status: NavigationGameStatus;
  sortBucket: number;
  isPendingAutomatch: boolean;
  automatchStateHint: string | null;
  automatchCanceledAt: number | null;
  latestMatchId: string;
  ownerProfileId: string;
  ownerRole: "host" | "guest";
  ownerLoginId: string | null;
  opponentProfileId: string | null;
  opponentLoginId: string | null;
  opponentName: string | null;
  opponentDisplayName: string | null;
  opponentEmoji: number | null;
  opponentEmojiId: number | null;
  listSortAt: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastEventFingerprint: string;
  lastEventType: string | null;
  lastEventReason: string | null;
  lastEventAt: number;
};

export type EventProjectionPayloadWrite = {
  schemaVersion: 1;
  source: "event-projector";
  entityType: "event";
  id: string;
  eventId: string;
  status: NavigationEventStatus;
  sortBucket: number;
  listSortAt: number;
  ownerProfileId: string;
  startAt: number | null;
  updatedAt: number;
  endedAt: number | null;
  participantCount: number;
  participantPreview: Array<{
    profileId: string | null;
    displayName: string | null;
    emojiId: number | null;
    aura: string | null;
  }>;
  winnerDisplayName: string | null;
};
export type ProfileGameProjectionWrite =
  GameProjectionWrite | EventProjectionPayloadWrite;
export type ProjectionProfileWrite = {
  eth: string;
  sol: string;
  username: string;
  custom?: { emoji: string | number };
  emoji?: string | number;
};

type Fields = Record<string, unknown>;
const fields = (value: ProfileGameProjectionDocument): Fields => {
  const retained: unknown = value;
  return retained as Fields;
};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const timestamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
const emoji = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
};

export function retainProfileGameProjection(
  value: unknown,
): ProfileGameProjectionDocument {
  return value as ProfileGameProjectionDocument;
}

export function createGameProjection(
  value: GameProjectionWrite,
): ProfileGameProjectionDocument {
  const retained: unknown = value;
  return retained as ProfileGameProjectionDocument;
}

export function createEventProjection(
  value: EventProjectionPayloadWrite,
): ProfileGameProjectionDocument {
  const retained: unknown = value;
  return retained as ProfileGameProjectionDocument;
}

export function retainProjectionProfile(
  value: unknown,
): ProjectionProfileDocument {
  return value as ProjectionProfileDocument;
}

export function createProjectionProfile(
  value: ProjectionProfileWrite,
): ProjectionProfileDocument {
  const retained: unknown = value;
  return retained as ProjectionProfileDocument;
}

export function projectionOwnerLoginId(
  value: ProfileGameProjectionDocument,
): string | null {
  return text(fields(value).ownerLoginId);
}

export function projectionOwnerRole(
  profileId: string,
  value: ProfileGameProjectionDocument | null,
): "host" | "guest" | null {
  const data = value && fields(value);
  const ownerRole = text(data && data.ownerRole);
  if (ownerRole === "host" || ownerRole === "guest") return ownerRole;
  const ownerProfileId = text(data && data.ownerProfileId) || profileId;
  if (ownerProfileId === text(data && data.hostProfileId)) return "host";
  if (ownerProfileId === text(data && data.guestProfileId)) return "guest";
  return null;
}

export function projectionOpponentName(
  value: ProfileGameProjectionDocument | null,
): string | null {
  const data = value && fields(value);
  return text(data ? (data.opponentName ?? data.opponentDisplayName) : null);
}

export function projectionOpponentEmoji(
  value: ProfileGameProjectionDocument | null,
): number | null {
  const data = value && fields(value);
  return emoji(data ? (data.opponentEmoji ?? data.opponentEmojiId) : null);
}

export function projectionFreshness(
  value: ProfileGameProjectionDocument,
): number {
  const data = fields(value);
  return [
    data.updatedAt,
    data.lastEventAt,
    data.listSortAt,
    data.createdAt,
  ].reduce<number>((current, value) => {
    const millis = timestamp(value);
    return Number.isFinite(millis)
      ? Math.max(current, millis as number)
      : current;
  }, Number.NEGATIVE_INFINITY);
}

export function projectionLastFingerprint(
  value: ProfileGameProjectionDocument | null,
): string | null {
  const data = value && fields(value);
  return data && typeof data.lastEventFingerprint === "string"
    ? data.lastEventFingerprint
    : null;
}

export function projectionTime(
  value: ProfileGameProjectionDocument | null,
  field: "listSortAt" | "createdAt" | "endedAt",
): number | null {
  const data = value && fields(value);
  return timestamp(data && data[field]);
}

export function projectionMergeFreshness(
  value: ProfileGameProjectionDocument,
): number {
  const data = fields(value);
  return Math.max(
    timestamp(data.updatedAt) ?? 0,
    timestamp(data.listSortAt) ?? 0,
  );
}

export function copyProjectionOwner(
  value: ProfileGameProjectionDocument,
  ownerProfileId: string,
): ProfileGameProjectionDocument {
  return retainProfileGameProjection({ ...value, ownerProfileId });
}
