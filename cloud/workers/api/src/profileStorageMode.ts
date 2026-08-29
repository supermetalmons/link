export const PROFILE_STORAGE_MODES = ["firestore", "d1"] as const;

export type ProfileStorageMode = (typeof PROFILE_STORAGE_MODES)[number];

export class ProfileStorageModeFailure extends Error {
  constructor() {
    super("profile-storage-mode-invalid");
  }
}

export function parseProfileStorageMode(value: unknown): ProfileStorageMode {
  if (value === "firestore" || value === "d1") {
    return value;
  }
  throw new ProfileStorageModeFailure();
}

export function readProfileStorageMode(environment: {
  PROFILE_STORAGE_MODE: unknown;
}): ProfileStorageMode {
  return parseProfileStorageMode(environment.PROFILE_STORAGE_MODE);
}

export function profileStorageUsesD1(mode: ProfileStorageMode): boolean {
  return mode === "d1";
}

export function profileStorageUsesFirestore(mode: ProfileStorageMode): boolean {
  return mode === "firestore";
}
