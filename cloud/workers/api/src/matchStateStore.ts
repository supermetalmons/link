import {
  isRetiredOrphanTimer,
  type OrphanTimerIdentity,
} from "./retiredOrphanTimers.ts";
import { parseMatchStateEventEffects } from "./matchStateRequestCodec.ts";
import { sha256Hex } from "./canonicalJson.ts";
import {
  readStoredMatchJson,
  storedMatchValue,
  readMatchDocument,
  matchesCreationMarker,
  withMatchCreationMarker,
  matchSurrenderState,
  matchSurrenderHasFen,
  writeSurrenderedMatch,
  supersededMatchPosition,
  writeMatchTimer,
  writeRetainedMatchTerminalTimer,
  matchTimerEquals,
  type MatchDocument,
  type RetainedMatchValue,
} from "./matchRecordCodec.ts";
import {
  pendingTimerClaim,
  readCommittedTimerClaim,
  readRetainedTimerClaim,
  readStoredTimerClaim,
  timerClaimIdentityMatches,
  timerClaimStatus,
  type RetainedTimerClaim,
  type TimerClaimDocument,
} from "./matchClaimCodec.ts";
import type {
  MatchStateCreateWireRequest,
  MatchStateEventEffectsWireRequest,
} from "./matchStateWire.ts";
import {
  isSubmitMoveRequest,
  isSurrenderMatchRequest,
  type SubmitMoveResponse,
  type SurrenderMatchResponse,
} from "@mons/shared/game-sessions";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_TERMINAL,
  matchTimersEqual,
  isStartMatchTimerRequest,
  parseStrictMatchTimer,
  type ClaimMatchVictoryByTimerResponse,
  type StartMatchTimerResponse,
} from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import { MatchEffectsOutbox } from "./matchEffectsOutbox.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import type { MatchTimerStartCandidate } from "./matchTimerRecords.ts";
import { LocalMatchTimerStore } from "./localMatchTimerStore.ts";
import {
  parseMatchTimerRecord,
  rawMatchTimerIsTerminal,
  resolveMatchTimerGame,
  type MatchTimerGameState,
  type MatchTimerRecord,
} from "./matchTimer.ts";
import {
  canonicalMatchStateJson,
  decideMatchStateMove,
  isCommittedMatchStateClaim,
  normalizeCreatedMatchState,
} from "./matchStateLogic.ts";
import {
  buildMatchStateTimerStartCandidate,
  decideMatchStateTimerClaim,
  decideMatchStateTimerStartCommit,
  prepareMatchStateTimerStart,
  type TimerPair,
} from "./matchStateTimerPolicy.ts";
import { MAX_MATCH_STATE_RECORD_READS } from "./matchStateTypes.ts";
import type {
  MatchStateAuthority,
  MatchStateClaimTimerRequest,
  MatchStateCreateResult,
  MatchStateMoveRequest,
  MatchStatePair,
  MatchStatePairRequest,
  MatchStateRecordRequest,
  MatchStateRecordsRequest,
  MatchStateSource,
  MatchStateStartTimerRequest,
  MatchStateSurrenderRequest,
  MatchStateSyncReadRequest,
  MatchStateSyncReadResult,
} from "./matchStateTypes.ts";

type SourceRow = {
  invite_id: string;
  active_epoch: number | null;
  staged_epoch: number | null;
  import_id: string | null;
  digest: string | null;
};

export type MatchStateStoreOptions = {
  retiredTimer?: (identity: OrphanTimerIdentity) => boolean;
  assertTimerWriter?: () => void;
  recordTimerWriterOutcome?: (result: unknown) => void;
  now?: () => number;
  scheduleAlarm?: (
    atMs: number,
    transaction: DurableObjectTransaction,
  ) => Promise<void>;
  resolveGame?: (
    player: MatchTimerRecord,
    opponent: MatchTimerRecord,
  ) => MatchTimerGameState;
};

function fail(message: string): never {
  throw new AuthApiFailure(409, "failed-precondition", message);
}

function unavailable(message: string): never {
  throw new AuthApiFailure(503, "unavailable", message);
}

function validKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !isSafeRecordKey(value)
  ) {
    throw new TypeError("match-state-invalid-key");
  }
}

function validEpoch(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("match-state-invalid-epoch");
  }
}

function validTimestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("match-state-invalid-timestamp");
  }
}

export class MatchStateStore {
  readonly effects: MatchEffectsOutbox;
  private readonly now: () => number;
  private readonly localTimers: LocalMatchTimerStore;
  private readonly resolveGame: NonNullable<
    MatchStateStoreOptions["resolveGame"]
  >;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly options: MatchStateStoreOptions,
  ) {
    this.now = options.now || Date.now;
    this.resolveGame = options.resolveGame || resolveMatchTimerGame;
    this.localTimers = new LocalMatchTimerStore(storage.sql);
    this.effects = new MatchEffectsOutbox(storage, {
      now: this.now,
      scheduleAlarm: (atMs, transaction) => this.ensureAlarm(atMs, transaction),
    });
  }

  readSource(): MatchStateSource {
    const [row] = this.storage.sql
      .exec<SourceRow>(
        "SELECT * FROM match_state_source_canonical WHERE singleton = 1",
      )
      .toArray();
    if (row) {
      validKey(row.invite_id);
      if (row.active_epoch !== null) validEpoch(row.active_epoch);
      if (row.staged_epoch !== null) validEpoch(row.staged_epoch);
      if (row.import_id !== null) validKey(row.import_id);
      if (
        (row.active_epoch === null && row.staged_epoch === null) ||
        (row.import_id === null) !== (row.digest === null) ||
        (row.digest !== null && !/^[a-f0-9]{64}$/.test(row.digest)) ||
        (row.staged_epoch !== null &&
          (row.import_id === null ||
            (row.active_epoch !== null && row.staged_epoch < row.active_epoch)))
      )
        throw new TypeError("match-state-invalid-source");
    }
    return {
      inviteId: row?.invite_id ?? null,
      epoch: row?.active_epoch ?? 0,
      status: row?.active_epoch
        ? "active"
        : row?.import_id
          ? "staged"
          : "empty",
      importId: row?.import_id ?? null,
      stagedEpoch: row?.staged_epoch ?? null,
      digest: row?.digest ?? null,
    };
  }

  private identity(input: MatchStateAuthority): MatchStateSource {
    validKey(input.inviteId);
    validEpoch(input.epoch);
    const source = this.readSource();
    if (source.inviteId !== null && source.inviteId !== input.inviteId) {
      fail("match-state-invite-conflict");
    }
    return source;
  }

  private authority(input: MatchStateAuthority): void {
    const source = this.identity(input);
    if (source.status !== "active" || source.epoch !== input.epoch) {
      unavailable("match-state-authority-unavailable");
    }
  }

  private target(input: MatchStateRecordRequest): void {
    validKey(input.matchId);
    if (
      !isCanonicalLoginUid(input.playerId) ||
      parseInviteMatchIndex(input.inviteId, input.matchId) === null
    ) {
      throw new TypeError("match-state-invalid-target");
    }
  }

  private record(matchId: string, playerId: string): RetainedMatchValue {
    const [row] = this.storage.sql
      .exec<{ value_json: string }>(
        "SELECT value_json FROM match_state_records_canonical WHERE match_id = ? AND player_id = ?",
        matchId,
        playerId,
      )
      .toArray();
    return storedMatchValue(readStoredMatchJson(row, "durable"));
  }

  private claim(matchId: string): RetainedTimerClaim {
    const [row] = this.storage.sql
      .exec<{ value_json: string }>(
        "SELECT value_json FROM match_state_claims_canonical WHERE match_id = ?",
        matchId,
      )
      .toArray();
    return row ? readStoredTimerClaim(row.value_json) : null;
  }

  private revision(matchId: string): number {
    const [row] = this.storage.sql
      .exec<{ revision: number }>(
        "SELECT revision FROM match_state_revisions_canonical WHERE match_id = ?",
        matchId,
      )
      .toArray();
    return row?.revision ?? 0;
  }

  private bump(matchId: string): void {
    if (this.revision(matchId) >= Number.MAX_SAFE_INTEGER) {
      fail("match-state-revision-exhausted");
    }
    this.storage.sql.exec(
      "INSERT INTO match_state_revisions_canonical(match_id, revision) VALUES (?, 1) ON CONFLICT(match_id) DO UPDATE SET revision = revision + 1",
      matchId,
    );
  }

  private putRecord(
    matchId: string,
    playerId: string,
    value: MatchDocument,
  ): void {
    this.storage.sql.exec(
      "INSERT INTO match_state_records_canonical(match_id, player_id, value_json) VALUES (?, ?, ?) ON CONFLICT(match_id, player_id) DO UPDATE SET value_json = excluded.value_json",
      matchId,
      playerId,
      canonicalMatchStateJson(value),
    );
  }

  private putClaim(matchId: string, value: TimerClaimDocument): void {
    this.storage.sql.exec(
      "INSERT INTO match_state_claims_canonical(match_id, value_json) VALUES (?, ?) ON CONFLICT(match_id) DO UPDATE SET value_json = excluded.value_json",
      matchId,
      canonicalMatchStateJson(value),
    );
  }

  readRecord(input: MatchStateRecordRequest): RetainedMatchValue {
    this.authority(input);
    this.target(input);
    return this.record(input.matchId, input.playerId);
  }

  readRecords(input: MatchStateRecordsRequest): RetainedMatchValue[] {
    if (
      !Array.isArray(input.requests) ||
      input.requests.length === 0 ||
      input.requests.length > MAX_MATCH_STATE_RECORD_READS
    ) {
      throw new TypeError("match-state-invalid-read-batch");
    }
    this.authority(input);
    for (const request of input.requests)
      this.target({ ...request, inviteId: input.inviteId, epoch: input.epoch });
    const rows = this.storage.sql
      .exec<{ match_id: string; player_id: string; value_json: string }>(
        `SELECT match_id, player_id, value_json FROM match_state_records_canonical WHERE ${input.requests.map(() => "(match_id = ? AND player_id = ?)").join(" OR ")}`,
        ...input.requests.flatMap(({ matchId, playerId }) => [
          matchId,
          playerId,
        ]),
      )
      .toArray();
    const records = new Map(
      rows.map((row) => [
        JSON.stringify([row.match_id, row.player_id]),
        row.value_json,
      ]),
    );
    return input.requests.map(({ matchId, playerId }) => {
      const value = records.get(JSON.stringify([matchId, playerId]));
      return storedMatchValue(
        readStoredMatchJson(
          value === undefined ? null : { value_json: value },
          "durable",
        ),
      );
    });
  }

  private pairTarget(input: MatchStatePairRequest): void {
    this.target(input);
    if (
      input.opponentId !== null &&
      (!isCanonicalLoginUid(input.opponentId) ||
        input.opponentId === input.playerId)
    ) {
      throw new TypeError("match-state-invalid-opponent");
    }
  }

  readPair(input: MatchStatePairRequest): MatchStatePair {
    this.authority(input);
    this.pairTarget(input);
    return {
      ...input,
      revision: this.revision(input.matchId),
      playerMatch: this.record(input.matchId, input.playerId),
      opponentMatch:
        input.opponentId === null
          ? null
          : this.record(input.matchId, input.opponentId),
      claim: this.claim(input.matchId),
    };
  }

  readSyncState(input: MatchStateSyncReadRequest): MatchStateSyncReadResult {
    if (
      input.knownRevision !== undefined &&
      (!Number.isSafeInteger(input.knownRevision) || input.knownRevision < 0)
    ) {
      throw new TypeError("match-state-invalid-revision");
    }
    this.authority(input);
    this.pairTarget(input);
    const revision = this.revision(input.matchId);
    const version = { epoch: input.epoch, revision };
    if (input.knownRevision === revision)
      return { ...version, status: "unchanged" };
    return {
      ...version,
      status: "changed",
      playerMatch: this.record(input.matchId, input.playerId),
      opponentMatch:
        input.opponentId === null
          ? null
          : this.record(input.matchId, input.opponentId),
    };
  }

  private initializeCreation(input: MatchStateAuthority): void {
    const source = this.identity(input);
    if (source.status === "empty") {
      this.storage.sql.exec(
        "INSERT INTO match_state_source_canonical(singleton, invite_id, active_epoch) VALUES (1, ?, ?)",
        input.inviteId,
        input.epoch,
      );
    }
    this.authority(input);
  }

  private create(input: MatchStateCreateWireRequest): MatchStateCreateResult {
    this.initializeCreation(input);
    const records: MatchStateCreateResult["records"] = [];
    const changed = new Set<string>();
    const timerCohorts = new Set<string>();
    for (const creation of input.records) {
      this.target({ ...input, ...creation });
      validKey(creation.marker);
      const creationDocument = readMatchDocument(creation.value);
      if (!creationDocument)
        throw new TypeError("match-state-invalid-creation");
      if (!timerCohorts.has(creation.matchId)) {
        this.localTimers.initializeFresh(creation.matchId);
        timerCohorts.add(creation.matchId);
      }
      const current = this.record(creation.matchId, creation.playerId);
      if (current) {
        if (!matchesCreationMarker(current, creation.marker))
          fail("match-creation-conflict");
        records.push({
          matchId: creation.matchId,
          playerId: creation.playerId,
          outcome: "already-created",
          value: current,
        });
        continue;
      }
      const value = normalizeCreatedMatchState(
        withMatchCreationMarker(creationDocument, creation.marker),
      );
      this.putRecord(creation.matchId, creation.playerId, value);
      records.push({
        matchId: creation.matchId,
        playerId: creation.playerId,
        outcome: "created",
        value,
      });
      changed.add(creation.matchId);
    }
    for (const matchId of changed) this.bump(matchId);
    return { records, changedMatchIds: [...changed] };
  }

  createRecords(input: MatchStateCreateWireRequest): MatchStateCreateResult {
    this.options.assertTimerWriter?.();
    if (!Array.isArray(input.records) || input.records.length === 0) {
      throw new TypeError("match-state-empty-creation");
    }
    return this.storage.transactionSync(() =>
      this.committed(this.create(input)),
    );
  }

  private committed<T>(result: T): T {
    this.options.recordTimerWriterOutcome?.(result);
    return result;
  }

  private assertUnfenced(
    input: MatchStateRecordRequest,
    kind: "move" | "surrender",
  ): void {
    const claim = this.claim(input.matchId);
    const pending = pendingTimerClaim(claim);
    if (!claim || (pending && pending.expiresAtMs <= this.now())) return;
    fail(
      kind === "move" && isCommittedMatchStateClaim(claim, input.inviteId)
        ? "match-move-finished"
        : `match-${kind}-blocked`,
    );
  }

  move(input: MatchStateMoveRequest): SubmitMoveResponse {
    this.options.assertTimerWriter?.();
    const { epoch, ...request } = input;
    validEpoch(epoch);
    if (!isSubmitMoveRequest(request)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return this.storage.transactionSync(() => {
      this.authority(input);
      this.target(input);
      const decision = decideMatchStateMove(
        this.record(input.matchId, input.playerId),
        request,
      );
      if (decision.outcome === "applied") {
        this.assertUnfenced(input, "move");
        this.putRecord(input.matchId, input.playerId, decision.value);
        this.bump(input.matchId);
      }
      const base = {
        ok: true as const,
        inviteId: input.inviteId,
        matchId: input.matchId,
        actorUid: input.playerId,
      };
      return this.committed<SubmitMoveResponse>(
        decision.outcome === "superseded"
          ? {
              ...base,
              outcome: "superseded",
              ...supersededMatchPosition(decision.value),
            }
          : { ...base, outcome: decision.outcome },
      );
    });
  }

  surrender(input: MatchStateSurrenderRequest): SurrenderMatchResponse {
    this.options.assertTimerWriter?.();
    const { epoch, ...request } = input;
    validEpoch(epoch);
    if (!isSurrenderMatchRequest(request)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return this.storage.transactionSync(() => {
      this.authority(input);
      this.target(input);
      const current = this.record(input.matchId, input.playerId);
      const state = matchSurrenderState(current);
      if (!state.exists)
        throw new AuthApiFailure(404, "not-found", "match-not-found");
      if (!state.surrendered) {
        this.assertUnfenced(input, "surrender");
        if (!matchSurrenderHasFen(current)) fail("match-surrender-blocked");
        this.putRecord(
          input.matchId,
          input.playerId,
          writeSurrenderedMatch(current),
        );
        this.bump(input.matchId);
      }
      return this.committed<SurrenderMatchResponse>({
        ok: true,
        inviteId: input.inviteId,
        matchId: input.matchId,
        actorUid: input.playerId,
      });
    });
  }

  private timerSnapshot(input: MatchStateStartTimerRequest): MatchStatePair {
    const { epoch, ...request } = input;
    validEpoch(epoch);
    if (!isStartMatchTimerRequest(request)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
    }
    return this.readPair(input);
  }

  private resolveTimerPair(pair: MatchStatePair): TimerPair {
    const player = parseMatchTimerRecord(pair.playerMatch);
    const opponent = parseMatchTimerRecord(pair.opponentMatch);
    if (!player || !opponent || player.color === opponent.color) {
      fail("something is wrong with the game state.");
    }
    return {
      pair: {
        ...pair,
        playerMatch: readMatchDocument(pair.playerMatch)!,
        opponentMatch: readMatchDocument(pair.opponentMatch)!,
      },
      player,
      opponent,
      game: this.resolveGame(player, opponent),
    };
  }

  private timerPair(input: MatchStateStartTimerRequest): TimerPair {
    return this.resolveTimerPair(this.timerSnapshot(input));
  }

  private retiredTimer(
    input: MatchStateStartTimerRequest,
    timer: MatchTimerRecord["timer"],
  ): boolean {
    const parsed = parseStrictMatchTimer(timer);
    return (
      parsed !== null &&
      (this.options.retiredTimer ?? isRetiredOrphanTimer)({
        inviteId: input.inviteId,
        matchId: input.matchId,
        playerId: input.playerId,
        opponentId: input.opponentId,
        turnNumber: parsed.turnNumber,
        deadlineAtMs: parsed.deadlineAtMs,
      })
    );
  }

  private assertTimerNotRetired(
    input: MatchStateStartTimerRequest,
    timer: MatchTimerRecord["timer"],
  ): void {
    if (this.retiredTimer(input, timer)) fail("match-timer-retired");
  }

  async startTimer(
    input: MatchStateStartTimerRequest,
  ): Promise<StartMatchTimerResponse> {
    this.options.assertTimerWriter?.();
    return this.storage.transactionSync(() => this.startLocalTimer(input));
  }

  private startLocalTimer(
    input: MatchStateStartTimerRequest,
  ): StartMatchTimerResponse {
    const snapshot = this.timerSnapshot(input);
    if (this.localTimers.mode(input.matchId) !== "local")
      unavailable("match-timer-cohort-missing");
    const currentTimer = parseMatchTimerRecord(snapshot.playerMatch);
    if (currentTimer) this.assertTimerNotRetired(input, currentTimer.timer);
    if (
      rawMatchTimerIsTerminal(snapshot.playerMatch) ||
      rawMatchTimerIsTerminal(snapshot.opponentMatch)
    )
      fail("game is already over.");
    const current = this.resolveTimerPair(snapshot);
    const prepared = prepareMatchStateTimerStart(current);
    const nowMs = this.now();
    validTimestamp(nowMs);
    const candidate = buildMatchStateTimerStartCandidate(prepared, nowMs);
    this.assertTimerNotRetired(input, candidate.timer);
    const marker = this.localTimers.getOrAdvance(
      input.matchId,
      input.playerId,
      input.opponentId,
      candidate,
      nowMs,
    );
    this.assertTimerNotRetired(input, marker.timer);
    if (
      prepared.existingTimer !== null &&
      marker.turnNumber === prepared.turnNumber &&
      !matchTimersEqual(marker.timer, prepared.existingTimer)
    )
      unavailable("match-timer-storage-conflict");
    return this.commitTimerStart(input, current, marker);
  }

  private commitTimerStart(
    input: MatchStateStartTimerRequest,
    current: TimerPair,
    marker: MatchTimerStartCandidate,
  ): StartMatchTimerResponse {
    this.assertTimerNotRetired(input, marker.timer);
    const decision = decideMatchStateTimerStartCommit(current, marker);
    if (decision.changed) {
      this.putRecord(input.matchId, input.playerId, decision.playerMatch);
      this.bump(input.matchId);
    }
    return this.committed<StartMatchTimerResponse>({
      ok: true,
      timer: decision.timer,
      duration: MATCH_TIMER_DURATION_MS,
    });
  }

  private async ensureAlarm(
    atMs: number,
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    this.options.assertTimerWriter?.();
    if (this.options.scheduleAlarm) {
      await this.options.scheduleAlarm(atMs, transaction);
      this.options.assertTimerWriter?.();
      return;
    }
    const alarm = await transaction.getAlarm();
    this.options.assertTimerWriter?.();
    if (alarm === null || alarm > atMs) {
      await transaction.setAlarm(atMs);
      this.options.assertTimerWriter?.();
    }
  }

  async claimTimer(
    input: MatchStateClaimTimerRequest,
  ): Promise<ClaimMatchVictoryByTimerResponse> {
    this.options.assertTimerWriter?.();
    if (input.eventId !== undefined && input.eventId !== null)
      validKey(input.eventId);
    const { eventId, ...timerRequest } = input;
    if (eventId !== undefined && eventId !== null) validKey(eventId);
    const snapshot = this.timerSnapshot(timerRequest);
    const currentTimer = parseMatchTimerRecord(snapshot.playerMatch);
    if (currentTimer)
      this.assertTimerNotRetired(timerRequest, currentTimer.timer);
    return this.storage.transaction(async (transaction) => {
      this.options.assertTimerWriter?.();
      const current = this.timerPair(timerRequest);
      this.assertTimerNotRetired(timerRequest, current.player.timer);
      const nowMs = this.now();
      validTimestamp(nowMs);
      const decision = decideMatchStateTimerClaim(current, input, nowMs);
      if (decision.changed) {
        this.putRecord(input.matchId, input.playerId, decision.playerMatch);
        this.putClaim(input.matchId, decision.claim);
        this.bump(input.matchId);
      }
      const due = this.effects.insertTimerClaim(input, decision.claimedAtMs);
      if (due !== null) await this.ensureAlarm(due, transaction);
      return this.committed<ClaimMatchVictoryByTimerResponse>({ ok: true });
    });
  }

  async applyEventEffects(
    value: MatchStateEventEffectsWireRequest,
  ): Promise<MatchStateCreateResult> {
    this.options.assertTimerWriter?.();
    const input = parseMatchStateEventEffects(value);
    const payloadJson = canonicalMatchStateJson(input);
    const operationDigest = await sha256Hex(payloadJson);
    this.options.assertTimerWriter?.();
    return this.storage.transactionSync(() => {
      const [receipt] = this.storage.sql
        .exec<{ payload_json: string }>(
          "SELECT payload_json FROM match_state_event_receipts_canonical WHERE operation_id = ?",
          input.operationId,
        )
        .toArray();
      if (receipt) {
        this.authority(input);
        if (receipt.payload_json !== payloadJson)
          fail("match-state-event-effect-conflict");
        return this.committed<MatchStateCreateResult>({
          records: [],
          changedMatchIds: [],
        });
      }
      const created = input.creations?.length
        ? this.create({ ...input, records: input.creations })
        : (this.authority(input),
          { records: [], changedMatchIds: [] } as MatchStateCreateResult);
      const changed = new Set(created.changedMatchIds);
      for (const effect of input.terminalTimers || []) {
        this.target({ ...input, ...effect });
        const record = this.record(effect.matchId, effect.playerId);
        if (!record || !parseMatchTimerRecord(record)) {
          fail("match-state-event-match-missing");
        }
        if (!matchTimerEquals(record, MATCH_TIMER_TERMINAL)) {
          this.putRecord(
            effect.matchId,
            effect.playerId,
            writeMatchTimer(readMatchDocument(record)!, MATCH_TIMER_TERMINAL),
          );
          if (!changed.has(effect.matchId)) this.bump(effect.matchId);
          changed.add(effect.matchId);
        }
      }
      for (const effect of input.claims || []) {
        this.target({ ...input, ...effect });
        const claim = readRetainedTimerClaim(effect.claim);
        const committed = readCommittedTimerClaim(claim, input.inviteId);
        if (
          !committed ||
          committed.playerId !== effect.playerId ||
          committed.opponentId !== effect.opponentId
        )
          fail("match-state-invalid-event-claim");
        const record = this.record(effect.matchId, effect.playerId);
        if (!record || !this.record(effect.matchId, effect.opponentId))
          fail("match-state-event-match-missing");
        const existing = this.claim(effect.matchId);
        if (
          timerClaimStatus(existing) === "claimed" &&
          !timerClaimIdentityMatches(
            existing,
            effect.playerId,
            effect.opponentId,
            input.inviteId,
          )
        )
          fail("match-state-event-claim-conflict");
        this.putRecord(
          effect.matchId,
          effect.playerId,
          writeRetainedMatchTerminalTimer(record),
        );
        this.putClaim(effect.matchId, committed.document);
        if (!changed.has(effect.matchId)) this.bump(effect.matchId);
        changed.add(effect.matchId);
      }
      this.storage.sql.exec(
        "INSERT INTO match_state_event_receipts_canonical(operation_id, payload_json, operation_digest) VALUES (?, ?, ?)",
        input.operationId,
        payloadJson,
        operationDigest,
      );
      return this.committed<MatchStateCreateResult>({
        records: created.records,
        changedMatchIds: [...changed],
      });
    });
  }
}
