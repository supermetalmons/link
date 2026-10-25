import type { ApiTransportStatus } from "@mons/shared/api-contracts";
import { isCanonicalLoginUid } from "./recordKeys.ts";
import {
  readSocketSession,
  socketSessionCurrent,
  type SocketSession,
} from "./socketSession.ts";
import type { SocketRole } from "./socketTags.ts";
type SocketAdmission = {
  role: SocketRole;
  ip: string;
  revision: number;
  passwordProtected: boolean;
  session: SocketSession;
};

export function validateCurrentSocketAdmission({
  channel,
  admission,
  current,
  canReceive,
  capacityFull,
}: {
  channel: "matches" | "metadata" | "wagers";
  admission: Pick<
    SocketAdmission,
    "revision" | "passwordProtected" | "session"
  >;
  current: { revision: number; passwordProtected: boolean };
  canReceive: () => boolean;
  capacityFull: () => boolean;
}): Response | null {
  if (
    current.revision !== admission.revision ||
    current.passwordProtected !== admission.passwordProtected
  ) {
    return new Response(
      channel === "matches"
        ? "Match admission changed"
        : `Invite ${channel} changed`,
      {
        status: 409 satisfies ApiTransportStatus<
          | "GET /invites/:inviteId/matches/:matchId/socket"
          | "GET /invites/:inviteId/metadata/socket"
          | "GET /invites/:inviteId/wagers/socket",
          "text"
        >,
      },
    );
  }
  if (channel === "matches" && !socketSessionCurrent(admission.session))
    return new Response("Session expired", {
      status: 401 satisfies ApiTransportStatus<
        | "GET /invites/:inviteId/matches/:matchId/socket"
        | "GET /invites/:inviteId/metadata/socket"
        | "GET /invites/:inviteId/wagers/socket",
        "text"
      >,
    });
  if (!canReceive())
    return new Response("Invite access denied", {
      status: 403 satisfies ApiTransportStatus<
        | "GET /invites/:inviteId/matches/:matchId/socket"
        | "GET /invites/:inviteId/metadata/socket"
        | "GET /invites/:inviteId/wagers/socket",
        "text"
      >,
    });
  if (channel !== "matches" && !socketSessionCurrent(admission.session))
    return new Response("Session expired", {
      status: 401 satisfies ApiTransportStatus<
        | "GET /invites/:inviteId/matches/:matchId/socket"
        | "GET /invites/:inviteId/metadata/socket"
        | "GET /invites/:inviteId/wagers/socket",
        "text"
      >,
    });
  if (capacityFull()) {
    const name =
      channel === "matches"
        ? "Match"
        : channel === "metadata"
          ? "Metadata"
          : "Wagers";
    return new Response(`${name} room is full`, {
      status: 429 satisfies ApiTransportStatus<
        | "GET /invites/:inviteId/matches/:matchId/socket"
        | "GET /invites/:inviteId/metadata/socket"
        | "GET /invites/:inviteId/wagers/socket",
        "text"
      >,
      headers: { "Retry-After": "60" },
    });
  }
  return null;
}

export function readSocketAdmission(
  request: Request,
  options: {
    headerPrefix: "Match" | "Metadata" | "Wagers";
    protocol: string;
    actorUid: string | null;
  },
):
  | { status: "ok"; admission: SocketAdmission }
  | { status: "invalid" }
  | { status: "expired" } {
  const header = (field: string) =>
    request.headers.get(`X-Mons-${options.headerPrefix}-${field}`);
  const role = header("Role");
  const ip = header("IP") || "unknown";
  const revision = header("Revision");
  const protectedHeader = header("Protected");
  const authenticated = header("Authenticated");
  if (
    request.headers.get("Sec-WebSocket-Protocol") !== options.protocol ||
    (role !== "host" && role !== "guest" && role !== "spectator") ||
    ip.length > 64 ||
    !revision ||
    !/^[1-9]\d*$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    (protectedHeader !== "0" && protectedHeader !== "1") ||
    (authenticated !== "0" && authenticated !== "1") ||
    (role === "spectator"
      ? options.actorUid !== null
      : !isCanonicalLoginUid(options.actorUid))
  )
    return { status: "invalid" };
  const session = readSocketSession(request, authenticated === "1");
  if (!session) return { status: "expired" };
  return {
    status: "ok",
    admission: {
      role,
      ip,
      revision: Number(revision),
      passwordProtected: protectedHeader === "1",
      session,
    },
  };
}
