import { isAutoInviteId } from "@mons/shared/ids";

type RouteMode = "home" | "invite" | "snapshot" | "watch" | "event";

export type RouteState = {
  mode: RouteMode;
  path: string;
  inviteId: string | null;
  snapshotId: string | null;
  eventId: string | null;
  autojoin: boolean;
};

const normalizePath = (rawPath: string): string => {
  return rawPath.replace(/^\/|\/$/g, "");
};

const decodePathId = (encoded: string): string | null => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
};

const normalizeEventId = (eventId: string | null): string | null => {
  return eventId?.trim() || null;
};

const parseRouteState = (pathname: string, search: string): RouteState => {
  const path = normalizePath(pathname);
  const eventId = normalizeEventId(new URLSearchParams(search).get("event"));
  if (path === "") {
    return {
      mode: "home",
      path,
      inviteId: null,
      snapshotId: null,
      eventId,
      autojoin: false,
    };
  }
  if (path === "watch") {
    return {
      mode: "watch",
      path,
      inviteId: null,
      snapshotId: null,
      eventId,
      autojoin: false,
    };
  }
  if (path.startsWith("event/")) {
    const pathEventId = decodePathId(path.substring("event/".length));
    return {
      mode: "event",
      path,
      inviteId: null,
      snapshotId: null,
      eventId: normalizeEventId(pathEventId),
      autojoin: false,
    };
  }
  if (path.startsWith("snapshot/")) {
    return {
      mode: "snapshot",
      path,
      inviteId: null,
      snapshotId: decodePathId(path.substring("snapshot/".length)),
      eventId,
      autojoin: false,
    };
  }
  return {
    mode: "invite",
    path,
    inviteId: path,
    snapshotId: null,
    eventId,
    autojoin: isAutoInviteId(path),
  };
};

export const getCurrentRouteState = (): RouteState => {
  return parseRouteState(window.location.pathname, window.location.search);
};

const getBackgroundPath = (target: RouteState): string => {
  if (target.mode === "home") {
    return "/";
  }
  if (target.mode === "watch") {
    return "/watch";
  }
  if (target.mode === "event") {
    return `/event/${encodeURIComponent(target.eventId ?? "")}`;
  }
  if (target.mode === "snapshot") {
    const encoded = encodeURIComponent(target.snapshotId ?? "");
    return `/snapshot/${encoded}`;
  }
  return `/${target.inviteId ?? ""}`;
};

export const getRoutePathForTarget = (
  target: RouteState,
  suffix?: { search?: string; hash?: string },
): string => {
  const search = new URLSearchParams(suffix?.search);
  search.delete("event");
  const eventId = normalizeEventId(target.eventId);
  if (target.mode !== "event" && eventId) {
    search.set("event", eventId);
  }
  const query = search.toString();
  const hash = suffix?.hash ?? "";
  return `${getBackgroundPath(target)}${query ? `?${query}` : ""}${hash && !hash.startsWith("#") ? `#${hash}` : hash}`;
};

export const getRouteWithEventOverlay = (
  route: RouteState,
  eventId: string | null,
): RouteState => {
  const normalizedEventId = normalizeEventId(eventId);
  if (route.mode === "home" || route.mode === "event") {
    return {
      mode: normalizedEventId ? "event" : "home",
      path: normalizedEventId
        ? `event/${encodeURIComponent(normalizedEventId)}`
        : "",
      inviteId: null,
      snapshotId: null,
      eventId: normalizedEventId,
      autojoin: false,
    };
  }
  return { ...route, eventId: normalizedEventId };
};

export const isSameBackgroundRoute = (
  first: RouteState,
  second: RouteState,
): boolean => {
  const firstIsLobby = first.mode === "home" || first.mode === "event";
  const secondIsLobby = second.mode === "home" || second.mode === "event";
  if (firstIsLobby || secondIsLobby) {
    return firstIsLobby && secondIsLobby;
  }
  if (first.mode !== second.mode || first.autojoin !== second.autojoin) {
    return false;
  }
  if (first.mode === "invite") {
    return first.inviteId === second.inviteId;
  }
  if (first.mode === "snapshot") {
    return first.snapshotId === second.snapshotId;
  }
  return true;
};

export const getCurrentViewUrl = (): string => {
  return new URL(
    getRoutePathForTarget(getCurrentRouteState()),
    window.location.origin,
  ).href;
};
