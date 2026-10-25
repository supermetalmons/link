import { isSessionId } from "@mons/shared/session-auth";
import type { SessionIdentity } from "./sessionAuth.ts";
import {
  nextSocketAttachmentExpiry,
  readSocketAttachment,
  socketAttachmentRequiresSession,
  socketAttachmentSessionCurrent,
  unsupportedReactionAttachment,
} from "./socketAttachmentRecords.ts";

export type SocketSession =
  | { authenticated: false }
  | { authenticated: true; sid: string; authExpiresAtMs: number };

const SESSION_ID_HEADER = "X-Mons-Session-Id";
const SESSION_EXPIRY_HEADER = "X-Mons-Session-Expires-At";

export function socketSessionHeaders(
  identity: SessionIdentity | null,
): Record<string, string> {
  return identity
    ? {
        [SESSION_ID_HEADER]: identity.sid,
        [SESSION_EXPIRY_HEADER]: String(identity.authExpiresAtMs),
      }
    : {};
}

export function readSocketSession(
  request: Request,
  authenticated: boolean,
): SocketSession | null {
  if (!authenticated) return { authenticated: false };
  const sid = request.headers.get(SESSION_ID_HEADER);
  const expiry = request.headers.get(SESSION_EXPIRY_HEADER);
  const authExpiresAtMs = Number(expiry);
  if (
    !isSessionId(sid) ||
    !expiry ||
    !/^[1-9]\d*$/.test(expiry) ||
    !Number.isSafeInteger(authExpiresAtMs) ||
    authExpiresAtMs <= Date.now()
  )
    return null;
  return { authenticated: true, sid, authExpiresAtMs };
}

export function socketSessionCurrent(session: SocketSession): boolean {
  return !session.authenticated || session.authExpiresAtMs > Date.now();
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}

export class SocketSessions {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  active(socket: WebSocket): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const attachment = readSocketAttachment(socket);
    if (unsupportedReactionAttachment(attachment)) {
      closeSocket(socket, 1008, "Unsupported reaction protocol");
      return false;
    }
    const authenticated = socketAttachmentRequiresSession(attachment, () =>
      this.ctx.getTags(socket),
    );
    if (!authenticated) return true;
    if (socketAttachmentSessionCurrent(attachment)) return true;
    closeSocket(socket, 4001, "Session expired");
    return false;
  }

  send(socket: WebSocket, message: string): void {
    if (!this.active(socket)) return;
    try {
      socket.send(message);
    } catch {
      closeSocket(socket, 1011, "Socket delivery failed");
    }
  }

  nextExpiry(): number | null {
    let next: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      if (!this.active(socket)) continue;
      const attachment = readSocketAttachment(socket);
      next = nextSocketAttachmentExpiry(next, attachment);
    }
    return next;
  }
}
