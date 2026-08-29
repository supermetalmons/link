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
