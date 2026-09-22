import type { SocketSessions } from "./socketSession.ts";

type SocketPair = InstanceType<typeof WebSocketPair>;

export function acceptRoomSocket(
  ctx: DurableObjectState,
  attachment: unknown,
  tags: string[],
): SocketPair {
  const pair = new WebSocketPair();
  pair[1].serializeAttachment(attachment);
  ctx.acceptWebSocket(pair[1], tags);
  return pair;
}

export function sendSocketSnapshot(
  sessions: Pick<SocketSessions, "send">,
  pair: SocketPair,
  message: unknown,
  protocol?: string,
): Response {
  sessions.send(pair[1], JSON.stringify(message));
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {},
  });
}
