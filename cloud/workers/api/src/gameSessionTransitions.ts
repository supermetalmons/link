import { normalizeHistoricalMatchRecord } from "@mons/shared/game-sessions";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import { measureAutomatchPhase } from "./automatchTelemetry.ts";
import {
  createAutomatchD1Store,
  isAutomatchRevisionConflict,
  type AutomatchRecordMutation,
} from "./automatchD1.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import type { GameSessionChange } from "./gameSessionContracts.ts";
import {
  canonical,
  digest,
  readField,
  resolveValue,
  sessionLayout,
  decodeSessionMatchCreation,
  encodeSessionMatchCreations,
  GameSessionTransitionFailure,
  type StoredSessionMatchCreation,
} from "./gameSessionCodec.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { buildLoginMatchDiscoveryStatements } from "./loginMatchDiscoveryD1.ts";
import {
  buildMatchPresentationRegistrationStatements,
  type MatchPresentationRegistration,
  type PrepareMatchPresentations,
} from "./matchPresentationRegistry.ts";
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
export {
  GAME_SESSION_CREATION_FIELD,
  GAME_SESSION_TRANSITION_FIELD,
  GameSessionTransitionFailure,
  gameSessionOperationResource,
} from "./gameSessionCodec.ts";

export const GAME_SESSION_TRANSITION_SWEEP_LIMIT = 10;
export const GAME_SESSION_TRANSITION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PREPARATION_ATTEMPTS = 3;

export type GameSessionLeaseProof = {
  lockId: string;
  operationId: string;
  ownerId: string;
};

type JsonRecord = Record<string, unknown>;
type TransitionPayload = {
  version: 2;
  inviteId: string;
  inviteSourceEpoch: number;
  inviteMutations: InviteSourceMutation[];
  transitionId: string;
  digest: string;
  resources: string[];
  mutations: AutomatchRecordMutation[];
  creations: StoredSessionMatchCreation[];
  createdAtMs: number;
};
type TransitionRow = {
  transition_id: string;
  invite_id: string;
  payload_json: string;
  status: "pending" | "completed";
};
type TransitionStore = Pick<
  ReturnType<typeof createAutomatchD1Store>,
  "prepareChanges" | "buildCommitStatements" | "buildRevisionGuardStatements"
>;
type InviteTransitionStore = Pick<
  ReturnType<typeof createInviteSourceD1Store>,
  "prepareChanges" | "buildCommitStatements" | "buildRevisionGuardStatements"
>;
type InviteAdmission = Awaited<ReturnType<typeof acquireInviteSourceAdmission>>;
type InviteControl = Awaited<ReturnType<typeof readInviteSourceControl>>;
type InviteOperation = { admission: InviteAdmission; control: InviteControl };

export type GameSessionTransitionsOptions = {
  db: D1Database;
  state: Pick<MatchStatePort, "createMatchRecords">;
  store?: TransitionStore;
  inviteStore?: InviteTransitionStore;
  inviteAdmission?: InviteAdmission;
  now?: () => number;
  createId?: () => string;
  onCommitted?: (inviteId: string) => Promise<void>;
  prepareMatchPresentations?: PrepareMatchPresentations;
  writeGuards?: () => D1PreparedStatement[] | Promise<D1PreparedStatement[]>;
};

function fail(code: string): never {
  throw new GameSessionTransitionFailure(code);
}
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateLease(proof: GameSessionLeaseProof): void {
  if (
    !isSafeRecordKey(proof.lockId) ||
    typeof proof.operationId !== "string" ||
    !proof.operationId ||
    typeof proof.ownerId !== "string" ||
    !proof.ownerId
  )
    fail("invalid-lease");
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
        if (typeof uid === "string" && isSafeRecordKey(uid)) uids.add(uid);
      }
    }
  }
  return [...uids].map((uid) => `automatch-login:${uid}`);
}

function readPayload(row: TransitionRow): TransitionPayload {
  const payload: TransitionPayload = JSON.parse(row.payload_json);
  if (
    payload.version !== 2 ||
    payload.transitionId !== row.transition_id ||
    payload.inviteId !== row.invite_id ||
    !Array.isArray(payload.resources) ||
    !Array.isArray(payload.mutations) ||
    !Array.isArray(payload.creations)
  )
    fail("invalid-intent");
  if (
    !Number.isSafeInteger(payload.inviteSourceEpoch) ||
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
    )
  )
    fail("invalid-invite-source-intent");
  return payload;
}

export function prepareGameSessionResourceTransitionRead(
  db: Pick<D1Database, "prepare">,
  resourceKey: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT t.transition_id, t.invite_id, t.payload_json, t.status
        FROM game_session_transition_resources r
        JOIN game_session_transitions t ON t.transition_id = r.transition_id
        WHERE r.resource_key = ?`,
    )
    .bind(resourceKey);
}

function readGameSessionResourceTransition(
  db: D1Database,
  resourceKey: string,
): Promise<TransitionRow | null> {
  return prepareGameSessionResourceTransitionRead(
    db.withSession("first-primary"),
    resourceKey,
  ).first<TransitionRow>();
}

export function assertNoGameSessionResourceTransition(row: unknown): void {
  if (row) fail("resource-pending");
}

export async function assertGameSessionResourceAvailable(
  db: D1Database,
  resourceKey: string,
): Promise<void> {
  assertNoGameSessionResourceTransition(
    await readGameSessionResourceTransition(db, resourceKey),
  );
}

export function createGameSessionTransitions({
  db,
  state,
  store = createAutomatchD1Store(db),
  inviteStore = createInviteSourceD1Store(db),
  inviteAdmission,
  now = Date.now,
  createId = () => crypto.randomUUID(),
  onCommitted,
  prepareMatchPresentations,
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
    if (current.backend !== "d1" || operation.control.backend !== "d1")
      fail("invite-source-backend-retired");
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

  const pendingResource = (
    resourceKey: string,
  ): Promise<TransitionRow | null> =>
    readGameSessionResourceTransition(db, resourceKey);

  const assertResourceAvailable = (resourceKey: string): Promise<void> =>
    assertGameSessionResourceAvailable(db, resourceKey);

  async function materialize(
    payload: TransitionPayload,
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<MatchPresentationRegistration[]> {
    await assertInviteOperation(operation);
    if (payload.inviteSourceEpoch !== operation.control.epoch)
      fail("invite-source-backend-conflict");
    if (payload.creations.length) {
      await measureAutomatchPhase("creation", () =>
        state.createMatchRecords(
          {
            inviteId: payload.inviteId,
            transitionId: payload.transitionId,
            records: payload.creations.map(decodeSessionMatchCreation),
          },
          signal,
        ),
      );
    }
    signal?.throwIfAborted();
    const presentations = prepareMatchPresentations
      ? await prepareMatchPresentations(
          payload.creations.map((stored) => {
            const creation = decodeSessionMatchCreation(stored);
            const { playerId: actorUid, matchId } = creation;
            const match = normalizeHistoricalMatchRecord(creation.value);
            if (!match) fail("invalid-match-presentation-creation");
            return {
              inviteId: payload.inviteId,
              matchId,
              actorUid,
              emojiId: match.emojiId,
              aura: match.aura,
              sourceId: creation.marker,
            };
          }),
        )
      : [];
    return presentations;
  }

  async function applyState(
    row: TransitionRow,
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (row.status === "completed") return;
    await requireActiveDurableMatchState(db);
    await applyAdmittedState(row, operation, signal);
  }

  async function applyAdmittedState(
    row: TransitionRow,
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (row.status === "completed") return;
    const payload = readPayload(row);
    try {
      const presentations = await materialize(payload, operation, signal);
      signal?.throwIfAborted();
      const active = await read(payload.transitionId);
      if (!active || active.status === "completed") return;
      const statements = [
        ...(await writeGuards()),
        ...inviteGuards(operation),
        ...buildMatchPresentationRegistrationStatements(
          db,
          presentations,
          now(),
        ),
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
          payload.creations.map((stored) => {
            const { playerId: loginUid, matchId } =
              decodeSessionMatchCreation(stored);
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
        ...inviteStore.buildCommitStatements(payload.inviteMutations, now()),
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
        await measureAutomatchPhase("finalize", () => db.batch(statements));
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
    changes: readonly GameSessionChange[],
    leases: readonly GameSessionLeaseProof[],
    operation: InviteOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    leases.forEach(validateLease);
    const split = sessionLayout(changes);
    if (!leases.some((proof) => proof.lockId === split.inviteId))
      fail("invite-lease-required");
    if (new Set(leases.map((proof) => proof.lockId)).size !== leases.length)
      fail("duplicate-lease");
    const inviteChanges = changes.flatMap((change) => {
      switch (change.kind) {
        case "invite-merge":
        case "invite-fields":
          return [{ inviteId: change.inviteId, value: change.value }];
        case "invite-operation":
          return [
            {
              inviteId: change.inviteId,
              value: {},
              operationIds: { [change.loginUid]: change.operationId },
            },
          ];
        case "invite-rematches":
          return [
            {
              inviteId: change.inviteId,
              value: { [`${change.role}Rematches`]: change.value },
            },
          ];
        default:
          return [];
      }
    });
    if (!inviteChanges.length)
      inviteChanges.push({ inviteId: split.inviteId, value: {} });
    const createdAtMs = now();
    const transitionId = createId();
    if (
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < 0 ||
      !isSafeRecordKey(transitionId)
    )
      fail("invalid-intent-id");
    for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      const inviteMutations = await inviteStore.prepareChanges(
        inviteChanges,
        createdAtMs,
        signal,
      );
      if (
        inviteMutations.length !== 1 ||
        inviteMutations[0].current.inviteId !== split.inviteId
      )
        fail("invalid-invite-source-mutation");
      const currentInvite = inviteMutations[0].current.value;
      if (
        isEventOwnedInviteSource(currentInvite) ||
        isEventOwnedInviteSource(split.inviteUpdates) ||
        inviteMutations.some(({ value }) => isEventOwnedInviteSource(value))
      )
        fail("event-owned-invite");
      if (!currentInvite && !split.inviteUpdates.hostId) fail("invite-missing");
      const mutations = await store.prepareChanges(
        changes,
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
        expectedMarker: null,
        matchUpdates: split.matchUpdates,
        resources,
        createdAtMs,
        inviteSourceEpoch: operation.control.epoch,
        inviteMutations,
      });
      const creations = await encodeSessionMatchCreations(
        split.matchUpdates,
        transitionId,
        contentDigest,
        createdAtMs,
      );
      const payload: TransitionPayload = {
        inviteId: split.inviteId,
        transitionId,
        digest: contentDigest,
        resources,
        mutations,
        creations,
        version: 2,
        inviteSourceEpoch: operation.control.epoch,
        inviteMutations,
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
        await measureAutomatchPhase("prepare", () => db.batch(statements));
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
    changes: readonly GameSessionChange[],
    leases: readonly GameSessionLeaseProof[],
    signal?: AbortSignal,
  ) =>
    withInviteOperation("session-transition-commit", (operation) =>
      prepareAndCommit(changes, leases, operation, signal),
    );

  const sweep = (limit = GAME_SESSION_TRANSITION_SWEEP_LIMIT) =>
    withInviteOperation("session-transition-sweep", (operation) =>
      sweepPrepared(limit, operation),
    );

  return { commit, recoverResource, assertResourceAvailable, sweep };
}
