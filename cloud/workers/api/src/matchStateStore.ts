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
  formatMatchTimer,
  isStartMatchTimerRequest,
  parseStrictMatchTimer,
  type ClaimMatchVictoryByTimerResponse,
  type StartMatchTimerResponse,
} from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { MatchTimerStartStore } from "./gameplayCoordinationD1.ts";
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
  digestMatchStateImport,
  isCommittedMatchStateClaim,
  matchStateRecord,
  normalizeCreatedMatchState,
  sortMatchStateImport,
} from "./matchStateLogic.ts";
import type {
  MatchStateActivateRequest,
  MatchStateAuthority,
  MatchStateClaimTimerRequest,
  MatchStateCreateRequest,
  MatchStateCreateResult,
  MatchStateEffect,
  MatchStateEventEffectsRequest,
  MatchStateImportRequest,
  MatchStateImportSnapshot,
  MatchStateImportTarget,
  MatchStateMoveRequest,
  MatchStatePair,
  MatchStatePairRequest,
  MatchStateRecord,
  MatchStateRecordRequest,
  MatchStateSource,
  MatchStateStartTimerRequest,
  MatchStateSurrenderRequest,
} from "./matchStateTypes.ts";

type SourceRow = {
  invite_id: string;
  active_epoch: number | null;
  staged_epoch: number | null;
  import_id: string | null;
  digest: string | null;
};

type TimerPair = {
  pair: MatchStatePair;
  player: MatchTimerRecord;
  opponent: MatchTimerRecord;
  game: MatchTimerGameState;
};

export type MatchStateStoreOptions = {
  timerStarts: Pick<MatchTimerStartStore, "getOrAdvance" | "deletePair">;
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
    !isSafeFirebaseKey(value)
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

function sameGameFields(
  left: MatchTimerRecord,
  right: MatchTimerRecord,
): boolean {
  return (
    left.color === right.color &&
    left.fen === right.fen &&
    left.flatMovesString === right.flatMovesString &&
    left.status === right.status
  );
}

function timerTerminal(pair: TimerPair): boolean {
  return (
    pair.player.status === "surrendered" ||
    pair.opponent.status === "surrendered" ||
    pair.player.timer === MATCH_TIMER_TERMINAL ||
    pair.opponent.timer === MATCH_TIMER_TERMINAL ||
    pair.game.winner !== undefined
  );
}

export class MatchStateStore {
  private readonly now: () => number;
  private readonly resolveGame: NonNullable<
    MatchStateStoreOptions["resolveGame"]
  >;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly options: MatchStateStoreOptions,
  ) {
    this.now = options.now || Date.now;
    this.resolveGame = options.resolveGame || resolveMatchTimerGame;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_source (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), invite_id TEXT NOT NULL, active_epoch INTEGER, staged_epoch INTEGER, import_id TEXT, digest TEXT)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_records (match_id TEXT NOT NULL, player_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(match_id, player_id))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_revisions (match_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_claims (match_id TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_staged_records (import_id TEXT NOT NULL, match_id TEXT NOT NULL, player_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(import_id, match_id, player_id))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_staged_claims (import_id TEXT NOT NULL, match_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(import_id, match_id))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_effects (effect_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, next_at_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, completed_at_ms INTEGER)",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS match_state_effects_due ON match_state_effects(next_at_ms)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_event_receipts (operation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)",
    );
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
      !isCanonicalFirebaseUid(input.playerId) ||
      parseInviteMatchIndex(input.inviteId, input.matchId) === null
    ) {
      throw new TypeError("match-state-invalid-target");
    }
  }

  private record(matchId: string, playerId: string): MatchStateRecord | null {
    const [row] = this.storage.sql
      .exec<{ value_json: string }>(
        "SELECT value_json FROM match_state_records WHERE match_id = ? AND player_id = ?",
        matchId,
        playerId,
      )
      .toArray();
    return row ? JSON.parse(row.value_json) : null;
  }

  private claim(matchId: string): MatchStateRecord | null {
    const [row] = this.storage.sql
      .exec<{ value_json: string }>(
        "SELECT value_json FROM match_state_claims WHERE match_id = ?",
        matchId,
      )
      .toArray();
    return row ? JSON.parse(row.value_json) : null;
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
    value: MatchStateRecord,
  ): void {
    this.storage.sql.exec(
      "INSERT INTO match_state_records(match_id, player_id, value_json) VALUES (?, ?, ?) ON CONFLICT(match_id, player_id) DO UPDATE SET value_json = excluded.value_json",
      matchId,
      playerId,
      canonicalMatchStateJson(value),
    );
  }

  private putClaim(matchId: string, value: MatchStateRecord): void {
    this.storage.sql.exec(
      "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?) ON CONFLICT(match_id) DO UPDATE SET value_json = excluded.value_json",
      matchId,
      canonicalMatchStateJson(value),
    );
  }

  readRecord(input: MatchStateRecordRequest): MatchStateRecord | null {
    this.authority(input);
    this.target(input);
    return this.record(input.matchId, input.playerId);
  }

  readPair(input: MatchStatePairRequest): MatchStatePair {
    this.authority(input);
    this.target(input);
    if (
      input.opponentId !== null &&
      (!isCanonicalFirebaseUid(input.opponentId) ||
        input.opponentId === input.playerId)
    ) {
      throw new TypeError("match-state-invalid-opponent");
    }
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

  private create(input: MatchStateCreateRequest): MatchStateCreateResult {
    this.initializeCreation(input);
    const records: MatchStateCreateResult["records"] = [];
    const changed = new Set<string>();
    for (const creation of input.records) {
      this.target({ ...input, ...creation });
      validKey(creation.marker);
      if (!matchStateRecord(creation.value))
        throw new TypeError("match-state-invalid-creation");
      const current = this.record(creation.matchId, creation.playerId);
      if (current) {
        if (current.sessionCreation !== creation.marker)
          fail("match-creation-conflict");
        records.push({
          matchId: creation.matchId,
          playerId: creation.playerId,
          outcome: "already-created",
          value: current,
        });
        continue;
      }
      const value = normalizeCreatedMatchState({
        ...creation.value,
        sessionCreation: creation.marker,
      });
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

  createRecords(input: MatchStateCreateRequest): MatchStateCreateResult {
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
    if (
      !claim ||
      (claim.status === "pending" &&
        typeof claim.expiresAtMs === "number" &&
        claim.expiresAtMs <= this.now())
    )
      return;
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
            fen: String(decision.value.fen),
            flatMovesString: String(decision.value.flatMovesString),
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
      if (!current)
        throw new AuthApiFailure(404, "not-found", "match-not-found");
      if (current.status !== "surrendered") {
        this.assertUnfenced(input, "surrender");
        if (typeof current.fen !== "string" || current.fen === "")
          fail("match-surrender-blocked");
        this.putRecord(input.matchId, input.playerId, {
          ...current,
          status: "surrendered",
        });
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
    return { pair, player, opponent, game: this.resolveGame(player, opponent) };
  }

  private timerPair(input: MatchStateStartTimerRequest): TimerPair {
    return this.resolveTimerPair(this.timerSnapshot(input));
  }

  private assertTimerTurn(pair: TimerPair, claim = false): void {
    if (timerTerminal(pair)) fail("game is already over.");
    if (!pair.game.historyValid) fail("something is wrong with the moves.");
    if (pair.game.activeColor !== pair.opponent.color) {
      fail(
        claim
          ? "can't claim timer victory on your own turn."
          : "can't start a timer on your own turn.",
      );
    }
  }

  async startTimer(
    input: MatchStateStartTimerRequest,
  ): Promise<StartMatchTimerResponse> {
    const snapshot = this.timerSnapshot(input);
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
    this.assertTimerTurn(initial);
    const stored = parseStrictMatchTimer(initial.player.timer);
    if (stored && stored.turnNumber > initial.game.turnNumber)
      fail("game state changed.");
    const nowMs = this.now();
    validTimestamp(nowMs);
    const marker = await this.options.timerStarts.getOrAdvance(
      input.playerId,
      input.opponentId,
      input.matchId,
      {
        timer:
          stored?.turnNumber === initial.game.turnNumber
            ? initial.player.timer
            : formatMatchTimer(
                initial.game.turnNumber,
                nowMs + MATCH_TIMER_DURATION_MS + 500,
              ),
        turnNumber: initial.game.turnNumber,
      },
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
        this.assertTimerTurn(fresh);
        if (
          !sameGameFields(initial.player, fresh.player) ||
          !sameGameFields(initial.opponent, fresh.opponent) ||
          initial.game.turnNumber !== fresh.game.turnNumber ||
          marker.turnNumber > fresh.game.turnNumber
        )
          fail("game state changed.");
        const parsedMarker = parseStrictMatchTimer(marker.timer);
        if (
          marker.turnNumber !== fresh.game.turnNumber ||
          parsedMarker?.turnNumber !== marker.turnNumber
        ) {
          unavailable("gameplay-service-unavailable");
        }
        const freshTimer = parseStrictMatchTimer(fresh.player.timer);
        if (freshTimer && freshTimer.turnNumber > fresh.game.turnNumber)
          fail("game state changed.");
        if (fresh.player.timer !== marker.timer) {
          this.putRecord(input.matchId, input.playerId, {
            ...fresh.pair.playerMatch,
            timer: marker.timer,
          });
          this.bump(input.matchId);
        }
        return {
          ok: true,
          timer: marker.timer,
          duration: MATCH_TIMER_DURATION_MS,
        };
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

  private async ensureAlarm(
    atMs: number,
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    if (this.options.scheduleAlarm)
      return this.options.scheduleAlarm(atMs, transaction);
    const alarm = await transaction.getAlarm();
    if (alarm === null || alarm > atMs) await transaction.setAlarm(atMs);
  }

  private insertEffect(
    input: MatchStateClaimTimerRequest,
    claimedAtMs: number,
  ): number | null {
    const effectId = `timer:${input.inviteId}:${input.matchId}`;
    const sourceKey = effectId;
    const effect = {
      effectId,
      inviteId: input.inviteId,
      matchId: input.matchId,
      playerId: input.playerId,
      opponentId: input.opponentId,
      epoch: input.epoch,
      claimedAtMs,
      eventId: input.eventId ?? null,
      sourceKey,
      reason: "timer-claimed" as const,
    };
    const [existing] = this.storage.sql
      .exec<{ payload_json: string; next_at_ms: number | null }>(
        "SELECT payload_json, next_at_ms FROM match_state_effects WHERE effect_id = ?",
        effectId,
      )
      .toArray();
    if (existing) {
      const previous = JSON.parse(existing.payload_json) as MatchStateEffect;
      if (
        previous.playerId !== input.playerId ||
        previous.opponentId !== input.opponentId ||
        previous.epoch !== input.epoch ||
        previous.eventId !== (input.eventId ?? null)
      )
        fail("match-state-effect-conflict");
      return existing.next_at_ms;
    }
    const nowMs = this.now();
    validTimestamp(nowMs);
    this.storage.sql.exec(
      "INSERT INTO match_state_effects(effect_id, payload_json, next_at_ms) VALUES (?, ?, ?)",
      effectId,
      canonicalMatchStateJson(effect),
      nowMs,
    );
    return nowMs;
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
      await this.options.timerStarts.deletePair(
        input.playerId,
        input.opponentId,
        input.matchId,
      );
    }
    return this.storage.transaction(async (transaction) => {
      const current = this.timerPair(timerRequest);
      const nowMs = this.now();
      validTimestamp(nowMs);
      const existing = current.pair.claim;
      const replay = current.player.timer === MATCH_TIMER_TERMINAL;
      if (!replay) {
        this.assertTimerTurn(current, true);
        if (!current.player.timer) fail("could not find an existing timer.");
        const timer = parseStrictMatchTimer(current.player.timer);
        if (!timer) fail("wrong timer format.");
        if (timer.turnNumber !== current.game.turnNumber)
          fail("can't claim this timer anymore, it's turn is over.");
        if (timer.targetTimestamp > nowMs)
          fail(
            `can't claim yet, ${timer.targetTimestamp - nowMs} ms remaining`,
          );
        if (existing?.status === "claimed") {
          if (
            !isCommittedMatchStateClaim(existing, input.inviteId) ||
            existing.playerId !== input.playerId ||
            existing.opponentId !== input.opponentId ||
            existing.timer !== current.player.timer ||
            existing.turnNumber !== current.game.turnNumber
          )
            fail("game state changed.");
        } else if (
          existing?.status === "pending" &&
          typeof existing.expiresAtMs === "number" &&
          existing.expiresAtMs > nowMs
        )
          fail("game state changed.");
      }
      const claimedAtMs =
        existing &&
        isCommittedMatchStateClaim(existing, input.inviteId) &&
        existing.playerId === input.playerId &&
        existing.opponentId === input.opponentId
          ? Number(existing.claimedAtMs)
          : nowMs;
      const claim: MatchStateRecord = {
        status: "claimed",
        playerId: input.playerId,
        opponentId: input.opponentId,
        inviteId: input.inviteId,
        timer:
          replay &&
          existing &&
          isCommittedMatchStateClaim(existing, input.inviteId)
            ? existing.timer
            : current.player.timer,
        turnNumber: current.game.turnNumber,
        claimedAtMs,
        expiresAtMs: null,
      };
      const changed =
        !replay ||
        canonicalMatchStateJson(existing) !== canonicalMatchStateJson(claim);
      if (changed) {
        this.putRecord(input.matchId, input.playerId, {
          ...current.pair.playerMatch,
          timer: MATCH_TIMER_TERMINAL,
        });
        this.putClaim(input.matchId, claim);
        this.bump(input.matchId);
      }
      const due = this.insertEffect(input, claimedAtMs);
      if (due !== null) await this.ensureAlarm(due, transaction);
      return { ok: true };
    });
  }

  applyEventEffects(
    input: MatchStateEventEffectsRequest,
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
        if (record.timer !== MATCH_TIMER_TERMINAL) {
          this.putRecord(effect.matchId, effect.playerId, {
            ...record,
            timer: MATCH_TIMER_TERMINAL,
          });
          if (!changed.has(effect.matchId)) this.bump(effect.matchId);
          changed.add(effect.matchId);
        }
      }
      for (const effect of input.claims || []) {
        this.target({ ...input, ...effect });
        if (
          !isCommittedMatchStateClaim(effect.claim, input.inviteId) ||
          effect.claim.playerId !== effect.playerId ||
          effect.claim.opponentId !== effect.opponentId
        )
          fail("match-state-invalid-event-claim");
        const record = this.record(effect.matchId, effect.playerId);
        if (!record || !this.record(effect.matchId, effect.opponentId))
          fail("match-state-event-match-missing");
        const existing = this.claim(effect.matchId);
        if (
          existing?.status === "claimed" &&
          (existing.playerId !== effect.playerId ||
            existing.opponentId !== effect.opponentId ||
            existing.inviteId !== input.inviteId)
        )
          fail("match-state-event-claim-conflict");
        this.putRecord(effect.matchId, effect.playerId, {
          ...record,
          timer: MATCH_TIMER_TERMINAL,
        });
        this.putClaim(effect.matchId, effect.claim);
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

  listDueEffects(nowMs = this.now(), limit = 20): MatchStateEffect[] {
    validTimestamp(nowMs);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("match-state-invalid-effect-limit");
    return this.storage.sql
      .exec<{ payload_json: string; next_at_ms: number; attempts: number }>(
        "SELECT payload_json, next_at_ms, attempts FROM match_state_effects WHERE next_at_ms <= ? ORDER BY next_at_ms, effect_id LIMIT ?",
        nowMs,
        limit,
      )
      .toArray()
      .map((row) => ({
        ...JSON.parse(row.payload_json),
        nextAtMs: row.next_at_ms,
        attempts: row.attempts,
      }));
  }

  nextEffectAt(): number | null {
    return this.storage.sql
      .exec<{ next_at_ms: number | null }>(
        "SELECT MIN(next_at_ms) AS next_at_ms FROM match_state_effects",
      )
      .one().next_at_ms;
  }

  completeEffect(effectId: string): void {
    const nowMs = this.now();
    validTimestamp(nowMs);
    this.storage.sql.exec(
      "UPDATE match_state_effects SET next_at_ms = NULL, completed_at_ms = ? WHERE effect_id = ? AND completed_at_ms IS NULL",
      nowMs,
      effectId,
    );
  }

  async retryEffect(effectId: string, atMs: number): Promise<void> {
    validTimestamp(atMs);
    await this.storage.transaction(async (transaction) => {
      this.storage.sql.exec(
        "UPDATE match_state_effects SET next_at_ms = ?, attempts = attempts + 1 WHERE effect_id = ? AND completed_at_ms IS NULL",
        atMs,
        effectId,
      );
      const due = this.nextEffectAt();
      if (due !== null) await this.ensureAlarm(due, transaction);
    });
  }

  async stageImport(
    input: MatchStateImportRequest,
  ): Promise<MatchStateImportSnapshot> {
    validKey(input.importId);
    this.storage.transactionSync(() => {
      const source = this.identity(input);
      if (
        (source.importId !== null &&
          (source.importId !== input.importId ||
            source.stagedEpoch !== input.epoch)) ||
        (source.status === "active" && source.importId === null)
      )
        fail("match-state-import-conflict");
      this.storage.sql.exec(
        "INSERT INTO match_state_source(singleton, invite_id, staged_epoch, import_id) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO NOTHING",
        input.inviteId,
        input.epoch,
        input.importId,
      );
      for (const record of input.records) {
        this.target({ ...input, ...record });
        if (!matchStateRecord(record.value))
          throw new TypeError("match-state-invalid-import-record");
        const json = canonicalMatchStateJson(record.value);
        const [previous] = this.storage.sql
          .exec<{ value_json: string }>(
            "SELECT value_json FROM match_state_staged_records WHERE import_id = ? AND match_id = ? AND player_id = ?",
            input.importId,
            record.matchId,
            record.playerId,
          )
          .toArray();
        if (previous && previous.value_json !== json)
          fail("match-state-import-record-conflict");
        if (source.status === "active" && !previous)
          fail("match-state-import-already-active");
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO match_state_staged_records(import_id, match_id, player_id, value_json) VALUES (?, ?, ?, ?)",
          input.importId,
          record.matchId,
          record.playerId,
          json,
        );
      }
      for (const claim of input.claims) {
        validKey(claim.matchId);
        if (
          parseInviteMatchIndex(input.inviteId, claim.matchId) === null ||
          !matchStateRecord(claim.value)
        ) {
          throw new TypeError("match-state-invalid-import-claim");
        }
        const json = canonicalMatchStateJson(claim.value);
        const [previous] = this.storage.sql
          .exec<{ value_json: string }>(
            "SELECT value_json FROM match_state_staged_claims WHERE import_id = ? AND match_id = ?",
            input.importId,
            claim.matchId,
          )
          .toArray();
        if (previous && previous.value_json !== json)
          fail("match-state-import-claim-conflict");
        if (source.status === "active" && !previous)
          fail("match-state-import-already-active");
        this.storage.sql.exec(
          "INSERT OR IGNORE INTO match_state_staged_claims(import_id, match_id, value_json) VALUES (?, ?, ?)",
          input.importId,
          claim.matchId,
          json,
        );
      }
    });
    return this.readImport(input);
  }

  private importContents(
    input: MatchStateImportTarget,
  ): MatchStateImportRequest {
    const source = this.identity(input);
    validKey(input.importId);
    if (
      source.importId !== input.importId ||
      source.stagedEpoch !== input.epoch
    )
      fail("match-state-import-missing");
    return sortMatchStateImport({
      inviteId: input.inviteId,
      epoch: input.epoch,
      importId: input.importId,
      records: this.storage.sql
        .exec<{ match_id: string; player_id: string; value_json: string }>(
          "SELECT match_id, player_id, value_json FROM match_state_staged_records WHERE import_id = ? ORDER BY match_id, player_id",
          input.importId,
        )
        .toArray()
        .map((row) => ({
          matchId: row.match_id,
          playerId: row.player_id,
          value: JSON.parse(row.value_json),
        })),
      claims: this.storage.sql
        .exec<{ match_id: string; value_json: string }>(
          "SELECT match_id, value_json FROM match_state_staged_claims WHERE import_id = ? ORDER BY match_id",
          input.importId,
        )
        .toArray()
        .map((row) => ({
          matchId: row.match_id,
          value: JSON.parse(row.value_json),
        })),
    });
  }

  async readImport(
    input: MatchStateImportTarget,
  ): Promise<MatchStateImportSnapshot> {
    const contents = this.importContents(input);
    return {
      ...contents,
      digest: await digestMatchStateImport(contents),
      recordCount: contents.records.length,
      claimCount: contents.claims.length,
    };
  }

  async activate(input: MatchStateActivateRequest): Promise<MatchStateSource> {
    const snapshot = await this.readImport(input);
    if (
      input.digest !== snapshot.digest ||
      input.recordCount !== snapshot.recordCount ||
      input.claimCount !== snapshot.claimCount
    )
      fail("match-state-import-verification-failed");
    return this.storage.transactionSync(() => {
      const source = this.identity(input);
      const contents = this.importContents(input);
      if (
        canonicalMatchStateJson(contents) !==
        canonicalMatchStateJson({
          inviteId: snapshot.inviteId,
          epoch: snapshot.epoch,
          importId: snapshot.importId,
          records: snapshot.records,
          claims: snapshot.claims,
        })
      )
        fail("match-state-import-changed");
      if (source.status === "active") {
        if (source.epoch !== input.epoch || source.digest !== input.digest)
          fail("match-state-activation-conflict");
        return source;
      }
      if (
        this.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM match_state_records",
          )
          .one().count !== 0
      ) {
        fail("match-state-activation-record-conflict");
      }
      const changed = new Set<string>();
      for (const record of contents.records) {
        this.putRecord(record.matchId, record.playerId, record.value);
        changed.add(record.matchId);
      }
      for (const claim of contents.claims) {
        this.putClaim(claim.matchId, claim.value);
        changed.add(claim.matchId);
      }
      for (const matchId of changed) this.bump(matchId);
      this.storage.sql.exec(
        "UPDATE match_state_source SET active_epoch = ?, digest = ? WHERE singleton = 1",
        input.epoch,
        input.digest,
      );
      return this.readSource();
    });
  }
}
