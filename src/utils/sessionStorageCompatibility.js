export function isRetiredSessionStorageKey(key) {
  return key.startsWith("firebase:");
}
