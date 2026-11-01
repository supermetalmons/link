import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  REACTION_MAX_MESSAGE_BYTES,
  isReactionSocketToken,
} from "@mons/shared/reactions";
import { AuthApiFailure } from "./authErrors.ts";
import { APPLICATION_DATA_SOCKET_PROTOCOL } from "@mons/shared/data-contract";

export function readInviteSocketToken(
  request: Request,
  protocol: string,
  errorCode: string,
): string | null {
  const invalid = () => new AuthApiFailure(400, "invalid-argument", errorCode);
  const header = request.headers.get("Sec-WebSocket-Protocol") || "";
  if (
    header.length >
    REACTION_MAX_MESSAGE_BYTES +
      REACTION_AUTH_PROTOCOL_PREFIX.length +
      protocol.length +
      APPLICATION_DATA_SOCKET_PROTOCOL.length +
      2 +
      4
  ) {
    throw invalid();
  }
  const offered = header.split(",").map((value) => value.trim());
  if (
    offered.filter((value) => value === APPLICATION_DATA_SOCKET_PROTOCOL)
      .length !== 1
  )
    throw invalid();
  const protocols = offered.filter(
    (value) => value !== APPLICATION_DATA_SOCKET_PROTOCOL,
  );
  if (
    protocols[0] !== protocol ||
    protocols.length > 2 ||
    (protocols.length === 2 &&
      !protocols[1]!.startsWith(REACTION_AUTH_PROTOCOL_PREFIX))
  ) {
    throw invalid();
  }
  const token =
    protocols.length === 2
      ? protocols[1]!.slice(REACTION_AUTH_PROTOCOL_PREFIX.length)
      : null;
  if (token !== null && !isReactionSocketToken(token)) throw invalid();
  const authorization = request.headers.get("Authorization");
  let headerToken: string | null = null;
  if (authorization !== null) {
    if (authorization.length > REACTION_MAX_MESSAGE_BYTES + 7) throw invalid();
    headerToken = authorization.match(/^Bearer (\S+)$/)?.[1] || null;
    if (!isReactionSocketToken(headerToken)) throw invalid();
  }
  if (token && headerToken && token !== headerToken) throw invalid();
  return token || headerToken;
}
