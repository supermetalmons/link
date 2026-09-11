import type {
  MatchStateCreation,
  MatchStateEventEffectsRequest,
  MatchStatePair,
  MatchStatePairRequest,
} from "./matchStateTypes.ts";

export const FIREBASE_RTDB_SERVER_TIMESTAMP = Object.freeze({
  ".sv": "timestamp",
});

export function firebaseRtdbIncrement(delta: number): Record<string, unknown> {
  if (!Number.isFinite(delta)) {
    throw new TypeError("RTDB increment must be finite");
  }
  return { ".sv": { increment: delta } };
}

export class FirebaseRtdbFailure extends Error {
  constructor() {
    super("firebase-rtdb-unavailable");
  }
}

export class FirebaseRtdbPermissionDenied extends FirebaseRtdbFailure {
  constructor() {
    super();
    this.message = "firebase-rtdb-permission-denied";
  }
}

export type FirebaseRtdbCredentials = {
  email: string;
  privateKeyPem: string;
};

export type FirebaseRtdbQuery = {
  endAt?: string | number | boolean | null;
  equalTo?: string | number | boolean | null;
  limitToFirst?: number;
  orderBy?: string;
  shallow?: boolean;
  startAt?: string | number | boolean | null;
};

export type FirebaseRtdbTransactionResult = {
  committed: boolean;
  decision?: string;
  value: unknown;
};

export type FirebaseRtdbClient = {
  readMatchPair?: (
    input: Omit<MatchStatePairRequest, "epoch">,
    signal?: AbortSignal,
  ) => Promise<MatchStatePair>;
  createMatchRecords?: (
    input: {
      inviteId: string;
      transitionId: string;
      records: MatchStateCreation[];
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  applyMatchEventEffects?: (
    input: Omit<MatchStateEventEffectsRequest, "epoch">,
    signal?: AbortSignal,
  ) => Promise<void>;
  getPath: (
    path: string,
    query?: FirebaseRtdbQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchRoot: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
  transactPath: (
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
    beforeWrite?: (attempt: {
      current: unknown;
      proposed: unknown;
      etag: string;
    }) => Promise<void>,
  ) => Promise<FirebaseRtdbTransactionResult>;
};
