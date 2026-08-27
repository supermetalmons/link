import {
  mapProfileGameProjection,
  type EventNavigationPreviewParticipant,
  type NavigationItem,
  type NavigationStatus,
} from "@mons/shared/navigation";

export const normalizeNavigationStatus = (
  status: unknown,
): NavigationStatus => {
  if (
    status === "pending" ||
    status === "waiting" ||
    status === "active" ||
    status === "ended" ||
    status === "dismissed"
  ) {
    return status;
  }
  return "waiting";
};

export const mapFirestoreParticipantPreview = (
  value: unknown,
): EventNavigationPreviewParticipant[] => {
  const mapped = mapProfileGameProjection(
    {
      entityType: "event",
      eventId: "preview",
      status: "waiting",
      participantPreview: value,
    },
    "event_preview",
  );
  return mapped?.entityType === "event" ? mapped.participantPreview : [];
};

export const mapFirestoreGameDocToNavigationItem = (
  rawData: Record<string, unknown>,
  fallbackInviteId: string,
): NavigationItem | null => mapProfileGameProjection(rawData, fallbackInviteId);
