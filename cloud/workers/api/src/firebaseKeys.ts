import { MAX_FIREBASE_KEY_BYTES, isSafeFirebaseKey } from "@mons/shared/ids";

export { MAX_FIREBASE_KEY_BYTES, isSafeFirebaseKey };

export function isCanonicalFirebaseUid(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > 128 ||
    value !== value.trim() ||
    !isSafeFirebaseKey(value)
  ) {
    return false;
  }
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

export const MAX_FIRESTORE_DOCUMENT_ID_BYTES = 1_500;

export function isSafeFirestoreDocumentId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    (value.startsWith("__") && value.endsWith("__"))
  ) {
    return false;
  }
  try {
    encodeURIComponent(value);
  } catch {
    return false;
  }
  return (
    new TextEncoder().encode(value).byteLength <=
    MAX_FIRESTORE_DOCUMENT_ID_BYTES
  );
}
