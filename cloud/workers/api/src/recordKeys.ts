import { MAX_RECORD_KEY_BYTES, isSafeRecordKey } from "@mons/shared/ids";

export { MAX_RECORD_KEY_BYTES, isSafeRecordKey };

export function isCanonicalLoginUid(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > 128 ||
    value !== value.trim() ||
    !isSafeRecordKey(value)
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
