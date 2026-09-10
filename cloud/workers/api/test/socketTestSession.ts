import type { SessionIdentity } from "../src/sessionAuth.ts";

export const SOCKET_TEST_SESSION_ID = "00000000-0000-4000-8000-000000000099";

export function socketTestIdentity(uid: string): SessionIdentity {
  return {
    uid,
    sid: SOCKET_TEST_SESSION_ID,
    authExpiresAtMs: Date.now() + 300_000,
  };
}

export function socketTestSessionHeaders(): Record<string, string> {
  return {
    "X-Mons-Session-Id": SOCKET_TEST_SESSION_ID,
    "X-Mons-Session-Expires-At": String(Date.now() + 300_000),
  };
}
