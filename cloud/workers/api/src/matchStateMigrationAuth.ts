const PURPOSE = "mons-match-state-migration-v1";
export const MATCH_STATE_SIGNATURE_SKEW_SECONDS = 300;

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signedBytes(body: string, timestamp: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${PURPOSE}\n${timestamp}\n${body}`);
}

export async function createMatchStateMigrationSignature(
  body: string,
  secret: string,
  timestamp: string,
): Promise<string> {
  const result = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await key(secret),
      signedBytes(body, timestamp),
    ),
  );
  return btoa(String.fromCharCode(...result))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function verifyMatchStateMigrationSignature(
  body: string,
  secret: string,
  timestamp: string,
  signature: string,
  nowMs: number,
): Promise<boolean> {
  if (
    !secret ||
    !/^\d{10}$/.test(timestamp) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !Number.isFinite(nowMs) ||
    Math.abs(nowMs / 1000 - Number(timestamp)) >
      MATCH_STATE_SIGNATURE_SKEW_SECONDS
  )
    return false;
  const bytes = Uint8Array.from(
    atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "="),
    (character) => character.charCodeAt(0),
  );
  return crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    signedBytes(body, timestamp),
  );
}
