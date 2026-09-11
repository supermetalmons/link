import { isSafeRecordKey } from "./recordKeys.ts";

export const WAGER_STATE_WRITER_EPOCH = 1;

export type WagerStateKey = {
  inviteId: string;
  matchId: string;
};

export type WagerStateValue = {
  wager: unknown;
  resolutionMarker: boolean | null;
};

export type WagerStateSnapshot = WagerStateKey &
  WagerStateValue & { revision: number };

export type WagerStateMutation = {
  current: WagerStateSnapshot;
  value: WagerStateValue;
};

export type WagerStateD1Options = {
  writeGuards?: () => readonly D1PreparedStatement[];
  now?: () => number;
};

type ActivationRow = {
  activation_epoch: number;
  verified_at_ms: number | null;
  activated_at_ms: number | null;
};

type StateRow = ActivationRow & {
  invite_id: string | null;
  match_id: string | null;
  wager_json: string | null;
  resolution_marker: number | null;
  revision: number | null;
};

export class WagerStateD1Failure extends Error {
  constructor(message = "wager-state-unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}

function requireActivation(row: ActivationRow | null): void {
  if (
    row?.activation_epoch !== WAGER_STATE_WRITER_EPOCH ||
    !Number.isSafeInteger(row.verified_at_ms) ||
    Number(row.verified_at_ms) <= 0 ||
    !Number.isSafeInteger(row.activated_at_ms) ||
    Number(row.activated_at_ms) < Number(row.verified_at_ms)
  ) {
    throw new WagerStateD1Failure("wager-state-not-activated");
  }
}

export async function assertWagerStateActivated(db: D1Database): Promise<void> {
  requireActivation(
    await db
      .withSession("first-primary")
      .prepare(
        `SELECT activation_epoch, verified_at_ms, activated_at_ms
         FROM wager_state_activation WHERE singleton = 1`,
      )
      .first<ActivationRow>(),
  );
}

function requireKey(key: WagerStateKey): void {
  if (!isSafeRecordKey(key.inviteId) || !isSafeRecordKey(key.matchId)) {
    throw new TypeError("invalid-wager-state-key");
  }
}

function decodeState(row: StateRow): WagerStateSnapshot {
  if (
    !row.invite_id ||
    !row.match_id ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) <= 0 ||
    (row.resolution_marker !== null &&
      row.resolution_marker !== 0 &&
      row.resolution_marker !== 1)
  ) {
    throw new WagerStateD1Failure("wager-state-corrupt");
  }
  const key = { inviteId: row.invite_id, matchId: row.match_id };
  requireKey(key);
  try {
    return {
      ...key,
      wager: row.wager_json === null ? null : JSON.parse(row.wager_json),
      resolutionMarker:
        row.resolution_marker === null ? null : row.resolution_marker === 1,
      revision: Number(row.revision),
    };
  } catch (error) {
    throw new WagerStateD1Failure("wager-state-corrupt", { cause: error });
  }
}

function encodeWager(value: unknown): string | null {
  if (value === null) return null;
  const visited = new Set<object>();
  const validate = (entry: unknown, depth: number): void => {
    if (depth > 64) throw new TypeError("invalid-wager-state-json");
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      return;
    }
    if (!entry || typeof entry !== "object" || visited.has(entry)) {
      throw new TypeError("invalid-wager-state-json");
    }
    const prototype = Object.getPrototypeOf(entry);
    if (
      !Array.isArray(entry) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError("invalid-wager-state-json");
    }
    visited.add(entry);
    for (const nested of Object.values(entry)) validate(nested, depth + 1);
    visited.delete(entry);
  };
  validate(value, 0);
  return JSON.stringify(value);
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("wager_state_revision_guard") ||
      isRevisionConflict(error.cause))
  );
}

export function createWagerStateD1Store(
  db: D1Database,
  { writeGuards, now = Date.now }: WagerStateD1Options = {},
) {
  return {
    async read(
      key: WagerStateKey,
      signal?: AbortSignal,
    ): Promise<WagerStateSnapshot> {
      requireKey(key);
      signal?.throwIfAborted();
      const row = await db
        .withSession("first-primary")
        .prepare(
          `SELECT activation.activation_epoch, activation.verified_at_ms,
             activation.activated_at_ms, state.invite_id, state.match_id,
             state.wager_json, state.resolution_marker, state.revision
           FROM wager_state_activation AS activation
           LEFT JOIN invite_wager_states AS state
             ON state.invite_id = ? AND state.match_id = ?
           WHERE activation.singleton = 1`,
        )
        .bind(key.inviteId, key.matchId)
        .first<StateRow>();
      signal?.throwIfAborted();
      requireActivation(row);
      return row?.invite_id
        ? decodeState(row)
        : { ...key, wager: null, resolutionMarker: null, revision: 0 };
    },

    async readInvite(
      inviteId: string,
      signal?: AbortSignal,
      shallow = false,
    ): Promise<WagerStateSnapshot[]> {
      if (!isSafeRecordKey(inviteId))
        throw new TypeError("invalid-wager-state-key");
      signal?.throwIfAborted();
      const result = await db
        .withSession("first-primary")
        .prepare(
          `SELECT activation.activation_epoch, activation.verified_at_ms,
             activation.activated_at_ms, state.invite_id, state.match_id,
             ${shallow ? "CASE WHEN state.wager_json IS NOT NULL THEN 'true' END" : "state.wager_json"} AS wager_json,
             state.resolution_marker, state.revision
           FROM wager_state_activation AS activation
           LEFT JOIN invite_wager_states AS state ON state.invite_id = ?
           WHERE activation.singleton = 1 ORDER BY state.match_id`,
        )
        .bind(inviteId)
        .all<StateRow>();
      signal?.throwIfAborted();
      requireActivation(result.results[0] || null);
      return result.results
        .filter((row) => row.invite_id !== null)
        .map(decodeState);
    },

    async commit(
      mutations: readonly WagerStateMutation[],
      signal?: AbortSignal,
    ): Promise<boolean> {
      if (!writeGuards) throw new WagerStateD1Failure("wager-state-read-only");
      if (!mutations.length) return true;
      const keys = new Set<string>();
      const revisionGuards: D1PreparedStatement[] = [];
      const writes: D1PreparedStatement[] = [];
      const updatedAtMs = now();
      if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
        throw new TypeError("invalid-wager-state-timestamp");
      }
      for (const { current, value } of mutations) {
        requireKey(current);
        const key = `${current.inviteId}/${current.matchId}`;
        if (keys.has(key))
          throw new TypeError("duplicate-wager-state-mutation");
        keys.add(key);
        if (
          !Number.isSafeInteger(current.revision) ||
          current.revision < 0 ||
          !Number.isSafeInteger(current.revision + 1) ||
          (value.resolutionMarker !== null &&
            typeof value.resolutionMarker !== "boolean")
        ) {
          throw new TypeError("invalid-wager-state-mutation");
        }
        revisionGuards.push(
          db
            .prepare(
              `INSERT INTO wager_state_revision_guards (singleton)
             SELECT 0 WHERE ${
               current.revision === 0
                 ? "EXISTS (SELECT 1 FROM invite_wager_states WHERE invite_id = ? AND match_id = ?)"
                 : "NOT EXISTS (SELECT 1 FROM invite_wager_states WHERE invite_id = ? AND match_id = ? AND revision = ?)"
             }`,
            )
            .bind(
              current.inviteId,
              current.matchId,
              ...(current.revision === 0 ? [] : [current.revision]),
            ),
        );
        writes.push(
          db
            .prepare(
              `INSERT INTO invite_wager_states
               (invite_id, match_id, wager_json, resolution_marker, revision, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (invite_id, match_id) DO UPDATE SET
               wager_json = excluded.wager_json,
               resolution_marker = excluded.resolution_marker,
               revision = excluded.revision,
               updated_at_ms = MAX(invite_wager_states.updated_at_ms, excluded.updated_at_ms)`,
            )
            .bind(
              current.inviteId,
              current.matchId,
              encodeWager(value.wager),
              value.resolutionMarker === null
                ? null
                : Number(value.resolutionMarker),
              current.revision + 1,
              updatedAtMs,
            ),
        );
      }
      signal?.throwIfAborted();
      try {
        await db.batch([
          ...writeGuards(),
          db.prepare(
            `INSERT INTO wager_state_write_guards (singleton)
             SELECT 0 WHERE NOT EXISTS (
               SELECT 1 FROM wager_state_activation WHERE singleton = 1
                 AND activation_epoch = 1 AND verified_at_ms > 0
                 AND activated_at_ms >= verified_at_ms
             )`,
          ),
          ...revisionGuards,
          ...writes,
        ]);
        return true;
      } catch (error) {
        if (isRevisionConflict(error)) return false;
        throw error;
      }
    },
  };
}
