const PURPOSE = "mons-match-presentations-v1";
export const MATCH_PRESENTATION_SIGNATURE_SKEW_SECONDS = 300;

function signatureData(
  body: string,
  timestamp: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${PURPOSE}\n${timestamp}\n${body}`);
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createMatchPresentationMigrationSignature(
  body: string,
  secret: string,
  timestamp: string,
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(secret),
      signatureData(body, timestamp),
    ),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function verifyMatchPresentationMigrationSignature(
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
    !Number.isFinite(nowMs)
  )
    return false;
  if (
    Math.abs(nowMs / 1_000 - Number(timestamp)) >
    MATCH_PRESENTATION_SIGNATURE_SKEW_SECONDS
  )
    return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(
      atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "="),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    bytes,
    signatureData(body, timestamp),
  );
}
