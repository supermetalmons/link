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
  isStartMatchTimerRequest,
  type ClaimMatchVictoryByTimerResponse,
  type StartMatchTimerResponse,
} from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import { MatchEffectsOutbox } from "./matchEffectsOutbox.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import type {
  MatchTimerStartCandidate,
  MatchTimerStartStore,
  RetainedTimerCleanupInput,
} from "./gameplayCoordinationD1.ts";
import {
  LocalMatchTimerStore,
  parseNewMatchTimerStorage,
  type MatchTimerStorageMode,
} from "./localMatchTimerStore.ts";
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
  timerTerminal,
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
  timerStarts: Pick<
    MatchTimerStartStore,
    "getOrAdvance" | "deletePair" | "deleteRetainedPair"
  >;
  newMatchTimerStorage?: MatchTimerStorageMode;
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
  private readonly newMatchTimerStorage: MatchTimerStorageMode;
  private readonly resolveGame: NonNullable<
    MatchStateStoreOptions["resolveGame"]
  >;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly options: MatchStateStoreOptions,
  ) {
    this.now = options.now || Date.now;
    this.newMatchTimerStorage = parseNewMatchTimerStorage(
      options.newMatchTimerStorage,
    );
    this.resolveGame = options.resolveGame || resolveMatchTimerGame;
    this.localTimers = new LocalMatchTimerStore(storage.sql);
    this.effects = new MatchEffectsOutbox(storage, {
      now: this.now,
      scheduleAlarm: (atMs, transaction) => this.ensureAlarm(atMs, transaction),
    });
  }

  readSource(): MatchStateSource {
    const [row] = this.storage.sql
      .exec<SourceRow>("SELECT * FROM match_state_source WHERE singleton = 1")
      .toArray();
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
        "SELECT value_json FROM match_state_records WHERE match_id = ? AND player_id = ?",
        matchId,
        playerId,
      )
      .toArray();
    return storedMatchValue(readStoredMatchJson(row, "durable"));
  }

  private claim(matchId: string): RetainedTimerClaim {
    const [row] = this.storage.sql
      .exec<{ value_json: string }>(
        "SELECT value_json FROM match_state_claims WHERE match_id = ?",
        matchId,
      )
      .toArray();
    return row ? readStoredTimerClaim(row.value_json) : null;
  }

  private revision(matchId: string): number {
    const [row] = this.storage.sql
      .exec<{ revision: number }>(
        "SELECT revision FROM match_state_revisions WHERE match_id = ?",
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
      "INSERT INTO match_state_revisions(match_id, revision) VALUES (?, 1) ON CONFLICT(match_id) DO UPDATE SET revision = revision + 1",
      matchId,
    );
  }

  private putRecord(
    matchId: string,
    playerId: string,
    value: MatchDocument,
  ): void {
    this.storage.sql.exec(
      "INSERT INTO match_state_records(match_id, player_id, value_json) VALUES (?, ?, ?) ON CONFLICT(match_id, player_id) DO UPDATE SET value_json = excluded.value_json",
      matchId,
      playerId,
      canonicalMatchStateJson(value),
    );
  }

  private putClaim(matchId: string, value: TimerClaimDocument): void {
    this.storage.sql.exec(
      "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?) ON CONFLICT(match_id) DO UPDATE SET value_json = excluded.value_json",
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
        `SELECT match_id, player_id, value_json FROM match_state_records WHERE ${input.requests.map(() => "(match_id = ? AND player_id = ?)").join(" OR ")}`,
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
        "INSERT INTO match_state_source(singleton, invite_id, active_epoch) VALUES (1, ?, ?)",
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
        this.localTimers.initializeFresh(
          creation.matchId,
          this.newMatchTimerStorage,
        );
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
    if (!Array.isArray(input.records) || input.records.length === 0) {
      throw new TypeError("match-state-empty-creation");
    }
    return this.storage.transactionSync(() => this.create(input));
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
      return decision.outcome === "superseded"
        ? {
            ...base,
            outcome: "superseded",
            ...supersededMatchPosition(decision.value),
          }
        : { ...base, outcome: decision.outcome };
    });
  }

  surrender(input: MatchStateSurrenderRequest): SurrenderMatchResponse {
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
      return {
        ok: true,
        inviteId: input.inviteId,
        matchId: input.matchId,
        actorUid: input.playerId,
      };
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

  async startTimer(
    input: MatchStateStartTimerRequest,
  ): Promise<StartMatchTimerResponse> {
    const snapshot = this.timerSnapshot(input);
    if (this.localTimers.mode(input.matchId) === "local")
      return this.storage.transactionSync(() => this.startLocalTimer(input));
    if (
      rawMatchTimerIsTerminal(snapshot.playerMatch) ||
      rawMatchTimerIsTerminal(snapshot.opponentMatch)
    ) {
      await this.options.timerStarts.deletePair(
        input.playerId,
        input.opponentId,
        input.matchId,
      );
      fail("game is already over.");
    }
    const initial = this.resolveTimerPair(snapshot);
    if (timerTerminal(initial)) {
      await this.options.timerStarts.deletePair(
        input.playerId,
        input.opponentId,
        input.matchId,
      );
      fail("game is already over.");
    }
    const prepared = prepareMatchStateTimerStart(initial);
    const nowMs = this.now();
    validTimestamp(nowMs);
    const marker = await this.options.timerStarts.getOrAdvance(
      input.playerId,
      input.opponentId,
      input.matchId,
      buildMatchStateTimerStartCandidate(prepared, nowMs),
      nowMs,
    );
    let terminal = false;
    try {
      return this.storage.transactionSync(() => {
        const freshSnapshot = this.timerSnapshot(input);
        terminal =
          rawMatchTimerIsTerminal(freshSnapshot.playerMatch) ||
          rawMatchTimerIsTerminal(freshSnapshot.opponentMatch);
        if (terminal) fail("game is already over.");
        const fresh = this.resolveTimerPair(freshSnapshot);
        terminal = timerTerminal(fresh);
        return this.commitTimerStart(input, initial, fresh, marker);
      });
    } catch (error) {
      if (terminal) {
        await this.options.timerStarts.deletePair(
          input.playerId,
          input.opponentId,
          input.matchId,
        );
      }
      throw error;
    }
  }

  private startLocalTimer(
    input: MatchStateStartTimerRequest,
  ): StartMatchTimerResponse {
    const snapshot = this.timerSnapshot(input);
    if (
      rawMatchTimerIsTerminal(snapshot.playerMatch) ||
      rawMatchTimerIsTerminal(snapshot.opponentMatch)
    )
      fail("game is already over.");
    const current = this.resolveTimerPair(snapshot);
    const prepared = prepareMatchStateTimerStart(current);
    const nowMs = this.now();
    validTimestamp(nowMs);
    const marker = this.localTimers.getOrAdvance(
      input.matchId,
      input.playerId,
      input.opponentId,
      buildMatchStateTimerStartCandidate(prepared, nowMs),
      nowMs,
    );
    if (
      prepared.existingTimer !== null &&
      marker.turnNumber === prepared.turnNumber &&
      marker.timer !== prepared.existingTimer
    )
      unavailable("match-timer-storage-conflict");
    return this.commitTimerStart(input, current, current, marker);
  }

  private commitTimerStart(
    input: MatchStateStartTimerRequest,
    initial: TimerPair,
    fresh: TimerPair,
    marker: MatchTimerStartCandidate,
  ): StartMatchTimerResponse {
    const decision = decideMatchStateTimerStartCommit(initial, fresh, marker);
    if (decision.changed) {
      this.putRecord(input.matchId, input.playerId, decision.playerMatch);
      this.bump(input.matchId);
    }
    return {
      ok: true,
      timer: decision.timer,
      duration: MATCH_TIMER_DURATION_MS,
    };
  }

  private async ensureAlarm(
    atMs: number,
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    if (this.options.scheduleAlarm)
      return this.options.scheduleAlarm(atMs, transaction);
    const alarm = await transaction.getAlarm();
    if (alarm === null || alarm > atMs) await transaction.setAlarm(atMs);
  }

  async cleanupLegacyTimerStarts(
    input: Pick<
      MatchStateStartTimerRequest,
      "matchId" | "playerId" | "opponentId"
    >,
  ): Promise<void> {
    if (this.localTimers.mode(input.matchId) === "local") return;
    await this.options.timerStarts.deletePair(
      input.playerId,
      input.opponentId,
      input.matchId,
    );
  }

  async cleanupRetainedTimerStarts(
    input: RetainedTimerCleanupInput,
  ): Promise<void> {
    if (this.localTimers.modeForRetainedCleanup(input) === "local") return;
    await this.options.timerStarts.deleteRetainedPair(input);
  }

  async claimTimer(
    input: MatchStateClaimTimerRequest,
  ): Promise<ClaimMatchVictoryByTimerResponse> {
    if (input.eventId !== undefined && input.eventId !== null)
      validKey(input.eventId);
    const { eventId, ...timerRequest } = input;
    if (eventId !== undefined && eventId !== null) validKey(eventId);
    const snapshot = this.timerSnapshot(timerRequest);
    if (
      rawMatchTimerIsTerminal(snapshot.playerMatch) ||
      rawMatchTimerIsTerminal(snapshot.opponentMatch)
    ) {
      await this.cleanupLegacyTimerStarts(input);
    }
    return this.storage.transaction(async (transaction) => {
      const current = this.timerPair(timerRequest);
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
      return { ok: true };
    });
  }

  applyEventEffects(
    input: MatchStateEventEffectsWireRequest,
  ): MatchStateCreateResult {
    validKey(input.operationId);
    const payloadJson = canonicalMatchStateJson(input);
    return this.storage.transactionSync(() => {
      const [receipt] = this.storage.sql
        .exec<{ payload_json: string }>(
          "SELECT payload_json FROM match_state_event_receipts WHERE operation_id = ?",
          input.operationId,
        )
        .toArray();
      if (receipt) {
        this.authority(input);
        if (receipt.payload_json !== payloadJson)
          fail("match-state-event-effect-conflict");
        return { records: [], changedMatchIds: [] };
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
        "INSERT INTO match_state_event_receipts(operation_id, payload_json) VALUES (?, ?)",
        input.operationId,
        payloadJson,
      );
      return { records: created.records, changedMatchIds: [...changed] };
    });
  }
}
