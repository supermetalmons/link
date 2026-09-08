import {
  createAutomatchD1Store,
  isAutomatchRevisionConflict,
  parseAutomatchPath,
  type AutomatchRecordMutation,
} from "./automatchD1.ts";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { buildLoginMatchDiscoveryStatements } from "./loginMatchDiscoveryD1.ts";
import {
  acquireInviteSourceAdmission,
  createInviteSourceD1Store,
  inviteSourceAdmissionGuardStatements,
  inviteSourceControlGuardStatements,
  isEventOwnedInviteSource,
  isInviteSourceRevisionConflict,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
  type InviteSourceMutation,
} from "./inviteSourceD1.ts";

export const GAME_SESSION_CREATION_FIELD = "sessionCreation";
export const GAME_SESSION_TRANSITION_FIELD = "sessionTransition";
export const GAME_SESSION_TRANSITION_SWEEP_LIMIT = 10;
export const GAME_SESSION_TRANSITION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PREPARATION_ATTEMPTS = 3;

export type GameSessionLeaseProof = {
  lockId: string;
  operationId: string;
  ownerId: string;
};

type JsonRecord = Record<string, unknown>;
type TransitionMarker = {
  sequence: number;
  transitionId: string;
  digest: string;
};
type MatchCreation = {
  path: string;
  value: JsonRecord;
  marker: string;
};
type InviteEffect = {
  existed: boolean;
  expectedMarker: TransitionMarker | null;
  expectedFields: JsonRecord;
  updates: JsonRecord;
  marker: TransitionMarker;
};
type TransitionPayloadBase = {
  inviteId: string;
  transitionId: string;
  digest: string;
  resources: string[];
  mutations: AutomatchRecordMutation[];
  creations: MatchCreation[];
  createdAtMs: number;
};
type TransitionPayload = TransitionPayloadBase &
  (
    | { version: 1; invite: InviteEffect }
    | {
        version: 2;
        inviteSourceEpoch: number;
        inviteMutations: InviteSourceMutation[];
      }
  );
type TransitionRow = {
  transition_id: string;
  invite_id: string;
  payload_json: string;
  status: "pending" | "completed";
};
type TransitionStore = Pick<
  ReturnType<typeof createAutomatchD1Store>,
  "preparePatch" | "buildCommitStatements" | "buildRevisionGuardStatements"
>;
type InviteTransitionStore = Pick<
  ReturnType<typeof createInviteSourceD1Store>,
  "preparePatch" | "buildCommitStatements" | "buildRevisionGuardStatements"
>;
type InviteAdmission = Awaited<ReturnType<typeof acquireInviteSourceAdmission>>;
type InviteControl = Awaited<ReturnType<typeof readInviteSourceControl>>;
type InviteOperation = { admission: InviteAdmission; control: InviteControl };

export type GameSessionTransitionsOptions = {
  db: D1Database;
  rtdb: Pick<FirebaseRtdbClient, "getPath" | "transactPath">;
  store?: TransitionStore;
  inviteStore?: InviteTransitionStore;
  inviteAdmission?: InviteAdmission;
  now?: () => number;
  createId?: () => string;
  onCommitted?: (inviteId: string) => Promise<void>;
  writeGuards?: () => D1PreparedStatement[] | Promise<D1PreparedStatement[]>;
};

export class GameSessionTransitionFailure extends Error {
  constructor(code: string) {
    super(`game-session-transition-${code}`);
  }
}

function fail(code: string): never {
  throw new GameSessionTransitionFailure(code);
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!record(value)) return fail("invalid-json");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function pathParts(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !isSafeFirebaseKey(part))) fail("invalid-path");
  return parts;
}

function readField(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split("/")) {
    if (!record(current) || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current ?? null;
}

function setField(target: JsonRecord, path: string, value: unknown): void {
  const parts = path.split("/");
  let current = target;
  for (const key of parts.slice(0, -1)) {
    const existing = Object.hasOwn(current, key) ? current[key] : null;
    const nested: JsonRecord = record(existing) ? { ...existing } : {};
    Object.defineProperty(current, key, {
      value: nested,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    current = nested;
  }
  const key = parts.at(-1)!;
  if (value === null) delete current[key];
  else
    Object.defineProperty(current, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

function resolveValue(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  if (Array.isArray(value))
    return value.map((entry, index) =>
      resolveValue(
        entry,
        Array.isArray(current) ? current[index] : null,
        nowMs,
      ),
    );
  if (!record(value)) {
    canonical(value);
    return value;
  }
  if (Object.hasOwn(value, ".sv")) {
    if (Object.keys(value).length !== 1) return fail("invalid-server-value");
    if (value[".sv"] === "timestamp") return nowMs;
    const server = value[".sv"];
    if (
      record(server) &&
      Object.keys(server).length === 1 &&
      typeof server.increment === "number" &&
      Number.isFinite(server.increment)
    ) {
      const next =
        (typeof current === "number" && Number.isFinite(current)
          ? current
          : 0) + server.increment;
      if (Number.isFinite(next)) return next;
    }
    return fail("invalid-server-value");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveValue(child, record(current) ? current[key] : null, nowMs),
    ]),
  );
}

function marker(value: unknown): TransitionMarker | null {
  if (value === null || value === undefined) return null;
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.transitionId !== "string" ||
    !isSafeFirebaseKey(value.transitionId) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    return fail("invalid-marker");
  return {
    sequence: Number(value.sequence),
    transitionId: value.transitionId,
    digest: value.digest,
  };
}

function validateLease(proof: GameSessionLeaseProof): void {
  if (
    !isSafeFirebaseKey(proof.lockId) ||
    typeof proof.operationId !== "string" ||
    !proof.operationId ||
    typeof proof.ownerId !== "string" ||
    !proof.ownerId
  )
    fail("invalid-lease");
}

export function gameSessionOperationResource(operationId: string): string {
  if (!isSafeFirebaseKey(operationId)) fail("invalid-operation");
  return `gameplay-operation:${operationId}`;
}

export function gameSessionResourceGuardStatements(
  db: D1Database,
  resourceKeys: readonly string[],
): D1PreparedStatement[] {
  return [...new Set(resourceKeys)].map((key) =>
    db
      .prepare(
        `INSERT INTO game_session_transition_guards (singleton)
      SELECT 0 WHERE EXISTS (
        SELECT 1 FROM game_session_transition_resources WHERE resource_key = ?
      )`,
      )
      .bind(key),
  );
}

function loginResources(mutations: AutomatchRecordMutation[]): string[] {
  const uids = new Set<string>();
  for (const mutation of mutations) {
    for (const value of [mutation.current.value, mutation.value]) {
      if (!record(value)) continue;
      for (const key of ["uid", "requesterUid"]) {
        const uid = value[key];
        if (typeof uid === "string" && isSafeFirebaseKey(uid)) uids.add(uid);
      }
    }
  }
  return [...uids].map((uid) => `automatch-login:${uid}`);
}

function splitUpdates(updates: JsonRecord): {
  inviteId: string;
  canonicalUpdates: JsonRecord;
  inviteUpdates: JsonRecord;
  matchUpdates: { path: string; value: JsonRecord }[];
  operationResources: string[];
} {
  const inviteIds = new Set<string>();
  const canonicalUpdates: JsonRecord = {};
  const inviteUpdates: JsonRecord = {};
  const matchUpdates: { path: string; value: JsonRecord }[] = [];
  const operationResources: string[] = [];
  const paths = Object.keys(updates);
  for (const path of paths) {
    if (paths.some((other) => other !== path && path.startsWith(`${other}/`)))
      fail("overlapping-updates");
    const parts = pathParts(path);
    const value = updates[path];
    const owned = parseAutomatchPath(path);
    if (owned) {
      canonicalUpdates[path] = value;
      if (
        parts[0] === "gameplayMutationReceipts" ||
        parts[0] === "gameplayMutationReceiptExpirations"
      ) {
        operationResources.push(gameSessionOperationResource(parts[1]));
        if (parts[0] === "gameplayMutationReceipts" && record(value)) {
          if (typeof value.inviteId === "string") inviteIds.add(value.inviteId);
          else if (
            record(value.response) &&
            typeof value.response.inviteId === "string"
          )
            inviteIds.add(value.response.inviteId);
        }
      } else if (owned.key) inviteIds.add(owned.key);
      continue;
    }
    if (parts[0] === "invites" && parts.length >= 2) {
      inviteIds.add(parts[1]);
      const fields = parts.slice(2);
      if (!fields.length) {
        if (!record(value)) fail("invalid-invite-write");
        for (const [field, child] of Object.entries(value)) {
          pathParts(field);
          if (field.includes("/")) fail("invalid-invite-field");
          inviteUpdates[field] = child;
        }
      } else inviteUpdates[fields.join("/")] = value;
      continue;
    }
    if (
      parts[0] === "players" &&
      parts[2] === "matches" &&
      parts.length === 4 &&
      record(value) &&
      typeof value.fen === "string" &&
      value.fen &&
      !Object.hasOwn(value, GAME_SESSION_CREATION_FIELD)
    ) {
      matchUpdates.push({ path, value });
      continue;
    }
    fail("unsupported-effect");
  }
  if (inviteIds.size !== 1 || !Object.keys(canonicalUpdates).length)
    fail("invalid-scope");
  const inviteId = [...inviteIds][0];
  if (!isSafeFirebaseKey(inviteId)) fail("invalid-invite");
  for (const field of Object.keys(inviteUpdates)) {
    if (
      [
        GAME_SESSION_TRANSITION_FIELD,
        "wagers",
        "matchesWagerResolutions",
        "reactions",
      ].includes(field.split("/")[0])
    )
      fail("reserved-invite-field");
  }
  for (const { path } of matchUpdates) {
    const matchId = path.split("/")[3];
    if (
      matchId !== inviteId &&
      !(
        matchId.startsWith(inviteId) &&
        /^[1-9]\d*$/.test(matchId.slice(inviteId.length))
      )
    )
      fail("match-outside-invite");
  }
  return {
    inviteId,
    canonicalUpdates,
    inviteUpdates,
    matchUpdates,
    operationResources,
  };
}

function readPayload(row: TransitionRow): TransitionPayload {
  const payload: TransitionPayload = JSON.parse(row.payload_json);
  if (
    (payload.version !== 1 && payload.version !== 2) ||
    payload.transitionId !== row.transition_id ||
    payload.inviteId !== row.invite_id ||
    !Array.isArray(payload.resources) ||
    !Array.isArray(payload.mutations) ||
    !Array.isArray(payload.creations)
  )
    fail("invalid-intent");
  if (
    payload.version === 2 &&
    (!Number.isSafeInteger(payload.inviteSourceEpoch) ||
      payload.inviteSourceEpoch < 1 ||
      !Array.isArray(payload.inviteMutations) ||
      payload.inviteMutations.length !== 1 ||
      payload.inviteMutations.some(
        ({ current, value }) =>
          !current ||
          current.inviteId !== payload.inviteId ||
          !Number.isSafeInteger(current.revision) ||
          current.revision < 0 ||
          (current.value !== null && !record(current.value)) ||
          !record(value) ||
          isEventOwnedInviteSource(current.value) ||
          isEventOwnedInviteSource(value),
      ))
  )
    fail("invalid-invite-source-intent");
  return payload;
}

export function createGameSessionTransitions({
  db,
  rtdb,
  store = createAutomatchD1Store(db),
  inviteStore = createInviteSourceD1Store(db),
  inviteAdmission,
  now = Date.now,
  createId = () => crypto.randomUUID(),
  onCommitted,
  writeGuards = () => [],
}: GameSessionTransitionsOptions) {
  const inviteGuards = ({ admission, control }: InviteOperation) => [
    ...inviteSourceControlGuardStatements(db, control),
    ...inviteSourceAdmissionGuardStatements(db, admission),
  ];

  async function assertInviteOperation(
    operation: InviteOperation,
  ): Promise<void> {
    const current = await readInviteSourceControl(db);
    if (
      current.backend !== operation.control.backend ||
      current.epoch !== operation.control.epoch ||
      current.freezeGeneration !== operation.control.freezeGeneration ||
      current.state !== "active"
    )
      fail("invite-source-control-changed");
    await db.batch(inviteGuards(operation));
  }

  async function withInviteOperation<T>(
    kind: string,
    work: (operation: InviteOperation) => Promise<T>,
  ): Promise<T> {
    const admission =
      inviteAdmission ||
      (await acquireInviteSourceAdmission(db, kind, { now }));
    try {
      const operation = {
        admission,
        control: await readInviteSourceControl(db),
      };
      await assertInviteOperation(operation);
      return await work(operation);
    } finally {
      if (!inviteAdmission) await releaseInviteSourceAdmission(db, admission);
    }
  }

  const read = (transitionId: string): Promise<TransitionRow | null> =>
    db
      .withSession("first-primary")
      .prepare(
        "SELECT transition_id, invite_id, payload_json, status FROM game_session_transitions WHERE transition_id = ?",
      )
      .bind(transitionId)
      .first<TransitionRow>();

  async function pendingResource(
    resourceKey: string,
  ): Promise<TransitionRow | null> {
    return db
      .withSession("first-primary")
      .prepare(
        `SELECT t.transition_id, t.invite_id, t.payload_json, t.status
        FROM game_session_transition_resources r
        JOIN game_session_transitions t ON t.transition_id = r.transition_id
        WHERE r.resource_key = ?`,
      )
      .bind(resourceKey)
      .first<TransitionRow>();
  }

  async function assertResourceAvailable(resourceKey: string): Promise<void> {
    if (await pendingResource(resourceKey)) fail("resource-pending");
  }

  async function materialize(
    payload: TransitionPayload,
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    await assertInviteOperation(operation);
    if (
      (payload.version === 1 && operation.control.backend !== "rtdb") ||
      (payload.version === 2 &&
        (operation.control.backend !== "d1" ||
          payload.inviteSourceEpoch !== operation.control.epoch))
    )
      fail("invite-source-backend-conflict");
    for (const creation of payload.creations) {
      signal?.throwIfAborted();
      await assertInviteOperation(operation);
      await rtdb.transactPath(
        creation.path,
        (current) => {
          if (current !== null && current !== undefined) {
            if (
              record(current) &&
              current[GAME_SESSION_CREATION_FIELD] === creation.marker
            )
              return { commit: false, decision: "applied" };
            return fail("match-creation-conflict");
          }
          return {
            value: {
              ...creation.value,
              [GAME_SESSION_CREATION_FIELD]: creation.marker,
            },
            decision: "created",
          };
        },
        signal,
      );
    }
    if (payload.version === 2) return;
    signal?.throwIfAborted();
    await assertInviteOperation(operation);
    await rtdb.transactPath(
      `invites/${payload.inviteId}`,
      (current) => {
        if (current !== null && current !== undefined && !record(current))
          fail("invalid-invite-source");
        const currentInvite = record(current) ? current : null;
        const currentMarker = marker(
          currentInvite?.[GAME_SESSION_TRANSITION_FIELD],
        );
        if (currentMarker?.transitionId === payload.transitionId) {
          if (canonical(currentMarker) !== canonical(payload.invite.marker))
            fail("marker-conflict");
          return { commit: false, decision: "applied" };
        }
        if (
          (currentInvite !== null) !== payload.invite.existed ||
          canonical(currentMarker) !== canonical(payload.invite.expectedMarker)
        )
          fail("invite-precondition-conflict");
        for (const [field, expected] of Object.entries(
          payload.invite.expectedFields,
        )) {
          if (
            canonical(readField(currentInvite, field)) !== canonical(expected)
          )
            fail("invite-precondition-conflict");
        }
        const next = { ...(currentInvite || {}) };
        for (const [field, value] of Object.entries(payload.invite.updates))
          setField(next, field, value);
        next[GAME_SESSION_TRANSITION_FIELD] = payload.invite.marker;
        return { value: next, decision: "applied" };
      },
      signal,
    );
  }

  async function applyState(
    row: TransitionRow,
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (row.status === "completed") return;
    const payload = readPayload(row);
    try {
      await materialize(payload, operation, signal);
      signal?.throwIfAborted();
      const active = await read(payload.transitionId);
      if (!active || active.status === "completed") return;
      const statements = [
        ...(await writeGuards()),
        ...inviteGuards(operation),
        db
          .prepare(
            `INSERT INTO game_session_transition_guards (singleton)
          SELECT 0 WHERE NOT EXISTS (
            SELECT 1 FROM game_session_transitions WHERE transition_id = ? AND status = 'pending'
          )`,
          )
          .bind(payload.transitionId),
        ...payload.resources.map((key) =>
          db
            .prepare(
              `INSERT INTO game_session_transition_guards (singleton)
          SELECT 0 WHERE NOT EXISTS (
            SELECT 1 FROM game_session_transition_resources WHERE resource_key = ? AND transition_id = ?
          )`,
            )
            .bind(key, payload.transitionId),
        ),
        ...buildLoginMatchDiscoveryStatements(
          db,
          payload.creations.map((creation) => {
            const [root, loginUid, matches, matchId, extra] = pathParts(
              creation.path,
            );
            if (
              root !== "players" ||
              matches !== "matches" ||
              !matchId ||
              extra
            )
              fail("invalid-match-discovery-path");
            return {
              loginUid,
              matchId,
              inviteId: payload.inviteId,
              resolution: "resolved",
              provenance: "capture",
            };
          }),
          now(),
        ),
        ...store.buildCommitStatements(payload.mutations, now()),
        ...(payload.version === 2
          ? inviteStore.buildCommitStatements(payload.inviteMutations, now())
          : []),
        db
          .prepare(
            "UPDATE game_session_transitions SET status = 'completed', updated_at_ms = ?, last_error = NULL WHERE transition_id = ? AND status = 'pending'",
          )
          .bind(now(), payload.transitionId),
        db
          .prepare(
            "DELETE FROM game_session_transition_resources WHERE transition_id = ?",
          )
          .bind(payload.transitionId),
      ];
      try {
        await db.batch(statements);
      } catch (error) {
        const latest = await read(payload.transitionId);
        if (latest?.status === "completed") return;
        throw error;
      }
    } catch (error) {
      const latest = await read(payload.transitionId);
      if (latest?.status === "completed") return;
      try {
        await db
          .prepare(
            "UPDATE game_session_transitions SET updated_at_ms = ?, attempt_count = attempt_count + 1, last_error = ? WHERE transition_id = ? AND status = 'pending'",
          )
          .bind(
            now(),
            error instanceof GameSessionTransitionFailure
              ? error.message
              : "game-session-transition-unavailable",
            payload.transitionId,
          )
          .run();
      } catch {}
      throw error;
    }
  }

  async function apply(
    row: TransitionRow,
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    await applyState(row, operation, signal);
    try {
      await onCommitted?.(row.invite_id);
    } catch {}
  }

  async function recoverResource(
    resourceKey: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return withInviteOperation(
      "session-transition-recovery",
      async (operation) => {
        const row = await pendingResource(resourceKey);
        if (!row) return false;
        await apply(row, operation, signal);
        return true;
      },
    );
  }

  async function prepareAndCommit(
    updates: JsonRecord,
    leases: readonly GameSessionLeaseProof[],
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    leases.forEach(validateLease);
    const split = splitUpdates(updates);
    if (!leases.some((proof) => proof.lockId === split.inviteId))
      fail("invite-lease-required");
    if (new Set(leases.map((proof) => proof.lockId)).size !== leases.length)
      fail("duplicate-lease");
    const rawInvite =
      operation.control.backend === "rtdb"
        ? await rtdb.getPath(`invites/${split.inviteId}`, undefined, signal)
        : null;
    if (rawInvite !== null && rawInvite !== undefined && !record(rawInvite))
      fail("invalid-invite-source");
    const legacyInvite = record(rawInvite) ? rawInvite : null;
    const invitePatch = Object.keys(split.inviteUpdates).length
      ? Object.fromEntries(
          Object.entries(split.inviteUpdates).map(([field, value]) => [
            `invites/${split.inviteId}/${field}`,
            value,
          ]),
        )
      : { [`invites/${split.inviteId}`]: {} };
    const createdAtMs = now();
    const transitionId = createId();
    if (
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < 0 ||
      !isSafeFirebaseKey(transitionId)
    )
      fail("invalid-intent-id");
    for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      const inviteMutations =
        operation.control.backend === "d1"
          ? await inviteStore.preparePatch(invitePatch, createdAtMs, signal)
          : [];
      if (
        operation.control.backend === "d1" &&
        (inviteMutations.length !== 1 ||
          inviteMutations[0].current.inviteId !== split.inviteId)
      )
        fail("invalid-invite-source-mutation");
      const currentInvite =
        operation.control.backend === "d1"
          ? inviteMutations[0].current.value
          : legacyInvite;
      if (
        isEventOwnedInviteSource(currentInvite) ||
        isEventOwnedInviteSource(split.inviteUpdates) ||
        inviteMutations.some(({ value }) => isEventOwnedInviteSource(value))
      )
        fail("event-owned-invite");
      if (!currentInvite && !split.inviteUpdates.hostId) fail("invite-missing");
      const expectedMarker =
        operation.control.backend === "rtdb"
          ? marker(currentInvite?.[GAME_SESSION_TRANSITION_FIELD])
          : null;
      const sequence = (expectedMarker?.sequence || 0) + 1;
      if (!Number.isSafeInteger(sequence)) fail("sequence-exhausted");
      const mutations = await store.preparePatch(
        split.canonicalUpdates,
        createdAtMs,
        signal,
      );
      const resources = [
        ...new Set([
          ...leases.map((proof) => proof.lockId),
          ...split.operationResources,
          ...loginResources(mutations),
        ]),
      ].sort();
      const inviteUpdates = Object.fromEntries(
        Object.entries(split.inviteUpdates).map(([field, value]) => [
          field,
          resolveValue(value, readField(currentInvite, field), createdAtMs),
        ]),
      );
      const expectedFields = Object.fromEntries(
        [
          ...new Set([
            "hostId",
            "guestId",
            "eventOwned",
            "eventId",
            ...Object.keys(inviteUpdates),
          ]),
        ].map((field) => [field, readField(currentInvite, field)]),
      );
      const contentDigest = await digest({
        transitionId,
        inviteId: split.inviteId,
        mutations,
        inviteUpdates,
        expectedFields,
        expectedMarker,
        matchUpdates: split.matchUpdates,
        resources,
        createdAtMs,
        ...(operation.control.backend === "d1"
          ? {
              inviteSourceEpoch: operation.control.epoch,
              inviteMutations,
            }
          : {}),
      });
      const creations = await Promise.all(
        split.matchUpdates.map(async ({ path, value }) => ({
          path,
          value: resolveValue(value, null, createdAtMs) as JsonRecord,
          marker: await digest({ transitionId, path, digest: contentDigest }),
        })),
      );
      const payload: TransitionPayload = {
        inviteId: split.inviteId,
        transitionId,
        digest: contentDigest,
        resources,
        mutations,
        creations,
        ...(operation.control.backend === "d1"
          ? {
              version: 2 as const,
              inviteSourceEpoch: operation.control.epoch,
              inviteMutations,
            }
          : {
              version: 1 as const,
              invite: {
                existed: currentInvite !== null,
                expectedMarker,
                expectedFields,
                updates: inviteUpdates,
                marker: { sequence, transitionId, digest: contentDigest },
              },
            }),
        createdAtMs,
      };
      signal?.throwIfAborted();
      const leaseCheckMs = now();
      const statements = [
        ...(await writeGuards()),
        ...inviteGuards(operation),
        db.prepare(`INSERT INTO game_session_transition_guards (singleton)
          SELECT 0 WHERE NOT EXISTS (
            SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'd1'
          )`),
        ...leases.map((proof) =>
          db
            .prepare(
              `INSERT INTO game_session_transition_guards (singleton)
          SELECT 0 WHERE NOT EXISTS (
            SELECT 1 FROM game_session_mutation_locks
            WHERE lock_id = ? AND operation_id = ? AND owner_id = ? AND expires_at_ms > ? AND writer_generation = 2
          )`,
            )
            .bind(proof.lockId, proof.operationId, proof.ownerId, leaseCheckMs),
        ),
        ...store.buildRevisionGuardStatements(mutations),
        ...inviteStore.buildRevisionGuardStatements(inviteMutations),
        db
          .prepare(
            "INSERT INTO game_session_transitions (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 'pending', ?, ?)",
          )
          .bind(
            transitionId,
            split.inviteId,
            canonical(payload),
            createdAtMs,
            createdAtMs,
          ),
        ...resources.map((key) =>
          db
            .prepare(
              "INSERT INTO game_session_transition_resources (resource_key, transition_id) VALUES (?, ?)",
            )
            .bind(key, transitionId),
        ),
      ];
      try {
        await db.batch(statements);
      } catch (error) {
        const existing = await read(transitionId);
        if (!existing) {
          if (
            (isAutomatchRevisionConflict(error) ||
              isInviteSourceRevisionConflict(error)) &&
            attempt + 1 < MAX_PREPARATION_ATTEMPTS
          ) {
            continue;
          }
          throw error;
        }
        if (existing.payload_json !== canonical(payload)) throw error;
      }
      const row = await read(transitionId);
      if (!row) fail("intent-missing");
      await apply(row, operation, signal);
      return;
    }
  }

  async function sweepPrepared(
    limit: number,
    operation: InviteOperation,
  ): Promise<{ recovered: number; failed: number }> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > GAME_SESSION_TRANSITION_SWEEP_LIMIT
    )
      fail("invalid-sweep-limit");
    const rows = await db
      .withSession("first-primary")
      .prepare(
        "SELECT transition_id, invite_id, payload_json, status FROM game_session_transitions WHERE status = 'pending' ORDER BY updated_at_ms, transition_id LIMIT ?",
      )
      .bind(limit)
      .all<TransitionRow>();
    let recovered = 0;
    let failed = 0;
    for (const row of rows.results) {
      try {
        await apply(row, operation);
        recovered++;
      } catch {
        failed++;
      }
    }
    await db.batch([
      ...(await writeGuards()),
      ...inviteGuards(operation),
      db
        .prepare(
          `DELETE FROM game_session_transitions WHERE transition_id IN (
        SELECT t.transition_id FROM game_session_transitions t
        WHERE t.status = 'completed' AND t.updated_at_ms < ?
          AND NOT EXISTS (
            SELECT 1 FROM game_session_transition_resources r
            WHERE r.transition_id = t.transition_id
          )
        ORDER BY t.updated_at_ms, t.transition_id LIMIT ?
      )`,
        )
        .bind(now() - GAME_SESSION_TRANSITION_RETENTION_MS, limit),
    ]);
    return { recovered, failed };
  }

  const commit = (
    updates: JsonRecord,
    leases: readonly GameSessionLeaseProof[],
    signal?: AbortSignal,
  ) =>
    withInviteOperation("session-transition-commit", (operation) =>
      prepareAndCommit(updates, leases, operation, signal),
    );

  const sweep = (limit = GAME_SESSION_TRANSITION_SWEEP_LIMIT) =>
    withInviteOperation("session-transition-sweep", (operation) =>
      sweepPrepared(limit, operation),
    );

  return { commit, recoverResource, assertResourceAvailable, sweep };
}
