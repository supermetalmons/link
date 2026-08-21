export { MAX_FIREBASE_KEY_BYTES, isSafeFirebaseKey } from "@mons/shared/ids";

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
