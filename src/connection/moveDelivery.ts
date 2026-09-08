import {
  countMoveHistory,
  isMoveHistoryPrefix,
  isSubmitMoveRequest,
  MAX_MATCH_MOVE_PREVIOUS_STATES,
  MAX_MATCH_MOVE_REQUEST_BYTES,
  type SubmitMoveRequest,
  type SubmitMoveResponse,
} from "@mons/shared/game-sessions";
import {
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
} from "@mons/shared/match-protocol";

export type MoveDeliveryScope = {
  loginUid: string;
  inviteId: string;
  matchId: string;
  playerId: string;
};

export type MoveDeliveryState = {
  fen: string;
  flatMovesString: string;
};

type PendingMove = { moveFen: string; fen: string };
type StoredMoves = {
  version: 1;
  scope: MoveDeliveryScope;
  confirmed: MoveDeliveryState;
  pending: PendingMove[];
  gameVariant?: string;
  finished?: true;
};

export type MoveDeliveryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

type Timer = ReturnType<typeof setTimeout> | number;
type MoveDeliveryDependencies = {
  storage: MoveDeliveryStorage | null;
  isAuthorized: () => boolean;
  isOnline: () => boolean;
  submit: (
    request: SubmitMoveRequest,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<SubmitMoveResponse>;
  read: (options: {
    signal: AbortSignal;
    timeoutMs: number;
  }) => Promise<MoveDeliveryState | null>;
  onError: (error: Error, kind: "storage" | "paused" | "conflict") => void;
  onRemoteAdvance: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  retryWindowMs?: number;
  attemptTimeoutMs?: number;
  verificationWindowMs?: number;
  recoveryDelayMs?: number;
};

type Attempt = {
  request: SubmitMoveRequest;
  target: MoveDeliveryState;
  controller: AbortController;
  generation: number;
};

type Barrier = {
  target: MoveDeliveryState;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class MoveDeliveryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MoveDeliveryError";
    this.code = code;
  }
}

export function moveDeliveryStorageKey(scope: MoveDeliveryScope): string {
  return `mons:pending-moves:v1:${JSON.stringify([
    scope.loginUid,
    scope.inviteId,
    scope.matchId,
    scope.playerId,
  ])}`;
}

function validState(value: unknown): value is MoveDeliveryState {
  if (!value || typeof value !== "object") return false;
  const state = value as MoveDeliveryState;
  return (
    typeof state.fen === "string" &&
    state.fen !== "" &&
    isMatchFenWithinLimit(state.fen) &&
    isMatchHistoryWithinLimits(state.flatMovesString)
  );
}

function appendHistory(history: string, move: string): string {
  return history ? `${history}-${move}` : move;
}

function sameState(
  first: MoveDeliveryState,
  second: MoveDeliveryState,
): boolean {
  return (
    first.flatMovesString === second.flatMovesString && first.fen === second.fen
  );
}

function covers(first: MoveDeliveryState, second: MoveDeliveryState): boolean {
  return (
    isMoveHistoryPrefix(second.flatMovesString, first.flatMovesString) &&
    (first.flatMovesString !== second.flatMovesString ||
      first.fen === second.fen)
  );
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "unavailable";
}

function terminalError(error: unknown): boolean {
  if (error instanceof Error && error.message === "match-move-blocked")
    return false;
  return [
    "invalid-argument",
    "permission-denied",
    "not-found",
    "unauthenticated",
    "failed-precondition",
  ].includes(errorCode(error));
}

export class MoveDelivery {
  readonly scope: MoveDeliveryScope;
  private confirmed: MoveDeliveryState;
  private pending: PendingMove[] = [];
  private gameVariant?: string;
  private readonly dependencies: MoveDeliveryDependencies;
  private readonly key: string;
  private readonly attempts = new Set<Attempt>();
  private readonly barriers = new Set<Barrier>();
  private timer: Timer | null = null;
  private windowStartedAt: number | null = null;
  private retryAt = 0;
  private failures = 0;
  private lastAttemptCount = -1;
  private paused: Error | null = null;
  private conflicted = false;
  private verifying = false;
  private verificationController: AbortController | null = null;
  private reconciliation: Promise<void> | null = null;
  private storageFailureReported = false;
  private confirmationRevision = 0;
  private generation = 0;
  private suspended = false;
  private finished = false;

  constructor(
    scope: MoveDeliveryScope,
    initial: MoveDeliveryState & { gameVariant?: string },
    dependencies: MoveDeliveryDependencies,
  ) {
    this.scope = { ...scope };
    this.confirmed = {
      fen: initial.fen,
      flatMovesString: initial.flatMovesString ?? "",
    };
    this.gameVariant = initial.gameVariant || undefined;
    this.dependencies = dependencies;
    this.key = moveDeliveryStorageKey(scope);
    this.restore();
  }

  get hasPendingMoves(): boolean {
    return this.pending.length > 0;
  }

  get isConflicted(): boolean {
    return this.conflicted;
  }

  get confirmationVersion(): number {
    return this.confirmationRevision;
  }

  get latest(): MoveDeliveryState {
    return this.pending.reduce(
      (state, move) => ({
        flatMovesString: appendHistory(state.flatMovesString, move.moveFen),
        fen: move.fen,
      }),
      { ...this.confirmed },
    );
  }

  enqueue(moveFen: string, fen: string): MoveDeliveryState {
    if (this.finished) throw new MoveDeliveryError("match-move-finished");
    if (this.conflicted) throw this.paused;
    if (
      this.paused?.message === "move-delivery-snapshot-behind" ||
      this.paused?.message === "move-delivery-baseline-conflict"
    )
      throw this.paused;
    const target = {
      fen,
      flatMovesString: appendHistory(this.latest.flatMovesString, moveFen),
    };
    if (!moveFen || moveFen.includes("-") || !validState(target)) {
      throw new MoveDeliveryError("invalid-move-output");
    }
    this.pending.push({ moveFen, fen });
    this.persist();
    if (this.paused && !this.suspended) this.resume();
    else this.pump();
    return target;
  }

  reconcile(
    remote: MoveDeliveryState,
    readRevision?: number,
  ): MoveDeliveryState {
    if (!validState(remote)) return this.conflict();
    if (
      readRevision !== undefined &&
      this.confirmationRevision !== readRevision &&
      isMoveHistoryPrefix(
        remote.flatMovesString,
        this.confirmed.flatMovesString,
      ) &&
      remote.flatMovesString !== this.confirmed.flatMovesString
    ) {
      return this.latest;
    }
    if (
      remote.flatMovesString !== this.confirmed.flatMovesString &&
      isMoveHistoryPrefix(
        remote.flatMovesString,
        this.confirmed.flatMovesString,
      )
    ) {
      const error = new MoveDeliveryError("move-delivery-snapshot-behind");
      this.conflicted = false;
      this.pauseForRetry(error);
      throw error;
    }
    if (
      !isMoveHistoryPrefix(
        this.confirmed.flatMovesString,
        remote.flatMovesString,
      ) ||
      (remote.flatMovesString === this.confirmed.flatMovesString &&
        remote.fen !== this.confirmed.fen)
    ) {
      return this.baselineConflict();
    }
    const latest = this.latest;
    if (covers(remote, latest)) {
      const advanced = remote.flatMovesString !== latest.flatMovesString;
      if (!sameState(this.confirmed, remote)) this.confirmationRevision++;
      this.confirmed = { ...remote };
      this.pending = [];
      this.conflicted = false;
      this.paused = null;
      this.persist();
      this.resolveBarriers();
      if (advanced) this.dependencies.onRemoteAdvance();
      return { ...remote };
    }
    const state = this.checkpoint(remote.flatMovesString);
    if (!state || !sameState(state, remote)) return this.conflict();
    this.confirm(remote);
    this.conflicted = false;
    this.paused = null;
    return this.latest;
  }

  resume(): void {
    if (this.conflicted || this.finished || !this.dependencies.isAuthorized())
      return;
    this.suspended = false;
    this.paused = null;
    this.windowStartedAt = null;
    this.retryAt = 0;
    this.failures = 0;
    this.clearRetryTimer();
    this.pump();
  }

  suspend(): void {
    this.suspended = true;
    this.clearRetryTimer();
  }

  resetAfterConflict(remote: MoveDeliveryState): void {
    if (!this.conflicted || !validState(remote)) return;
    if (
      !isMoveHistoryPrefix(
        this.confirmed.flatMovesString,
        remote.flatMovesString,
      ) ||
      (remote.flatMovesString === this.confirmed.flatMovesString &&
        remote.fen !== this.confirmed.fen)
    ) {
      this.baselineConflict();
    }
    try {
      this.dependencies.storage?.setItem(
        `${this.key}:conflict`,
        JSON.stringify(this.stored()),
      );
    } catch (error) {
      this.reportStorageError(error);
    }
    this.retireGeneration();
    this.confirmationRevision++;
    for (const attempt of this.attempts) attempt.controller.abort();
    this.confirmed = { ...remote };
    this.pending = [];
    this.conflicted = false;
    this.paused = null;
    this.windowStartedAt = null;
    this.persist();
  }

  pause(): void {
    this.retireGeneration();
    this.stop(new MoveDeliveryError("move-authentication-changed"), false);
    for (const attempt of this.attempts) attempt.controller.abort();
    this.verificationController?.abort();
  }

  async refresh(): Promise<void> {
    if (!this.dependencies.isAuthorized()) {
      this.pause();
      return;
    }
    if (this.reconciliation) return this.reconciliation;
    const readRevision = this.confirmationRevision;
    const generation = this.generation;
    const reconciliation = (async () => {
      try {
        const remote = await this.dependencies.read({
          signal: new AbortController().signal,
          timeoutMs: this.dependencies.attemptTimeoutMs ?? 20_000,
        });
        if (generation !== this.generation || !this.dependencies.isAuthorized())
          return;
        if (!remote) this.conflict();
        this.reconcile(remote, readRevision);
      } catch (error) {
        if (
          generation === this.generation &&
          !this.conflicted &&
          this.dependencies.isAuthorized()
        )
          this.pauseForRetry(
            error instanceof Error ? error : new Error(String(error)),
          );
      }
    })();
    this.reconciliation = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.reconciliation === reconciliation) this.reconciliation = null;
      if (generation === this.generation && !this.paused) this.resume();
    }
  }

  flush(): Promise<void> {
    if (this.finished)
      return Promise.reject(new MoveDeliveryError("match-move-finished"));
    const target = this.latest;
    if (covers(this.confirmed, target)) return Promise.resolve();
    if (this.conflicted) return Promise.reject(this.paused);
    if (!this.dependencies.isAuthorized())
      return Promise.reject(
        new MoveDeliveryError("move-authentication-changed"),
      );
    if (this.paused && !this.suspended) this.resume();
    else this.pump();
    return new Promise<void>((resolve, reject) => {
      this.barriers.add({ target, resolve, reject });
    });
  }

  private now(): number {
    return (this.dependencies.now || Date.now)();
  }

  private checkpoint(history: string): MoveDeliveryState | null {
    let state = this.confirmed;
    if (state.flatMovesString === history) return state;
    for (const move of this.pending) {
      state = {
        flatMovesString: appendHistory(state.flatMovesString, move.moveFen),
        fen: move.fen,
      };
      if (state.flatMovesString === history) return state;
    }
    return null;
  }

  private confirm(state: MoveDeliveryState): void {
    if (covers(this.confirmed, state)) return;
    const checkpoint = this.checkpoint(state.flatMovesString);
    if (!checkpoint || !sameState(checkpoint, state)) this.conflict();
    const count =
      countMoveHistory(state.flatMovesString) -
      countMoveHistory(this.confirmed.flatMovesString);
    this.pending.splice(0, count);
    this.confirmed = { ...state };
    this.confirmationRevision++;
    this.windowStartedAt = this.hasPendingMoves ? this.now() : null;
    this.failures = 0;
    this.retryAt = 0;
    this.persist();
    this.resolveBarriers();
  }

  private buildRequest(): SubmitMoveRequest | null {
    let state = this.confirmed;
    const previousStates: NonNullable<SubmitMoveRequest["previousStates"]> = [];
    let request: SubmitMoveRequest | null = null;
    for (const move of this.pending.slice(0, MAX_MATCH_MOVE_PREVIOUS_STATES)) {
      previousStates.push({
        moveCount: countMoveHistory(state.flatMovesString),
        fen: state.fen,
      });
      state = {
        flatMovesString: appendHistory(state.flatMovesString, move.moveFen),
        fen: move.fen,
      };
      const candidate: SubmitMoveRequest = {
        inviteId: this.scope.inviteId,
        matchId: this.scope.matchId,
        playerId: this.scope.playerId,
        previousFlatMovesString: this.confirmed.flatMovesString,
        flatMovesString: state.flatMovesString,
        fen: state.fen,
        previousStates: previousStates.map((checkpoint) => ({ ...checkpoint })),
        ...(this.gameVariant ? { gameVariant: this.gameVariant } : {}),
      };
      if (
        new TextEncoder().encode(JSON.stringify(candidate)).byteLength >
        MAX_MATCH_MOVE_REQUEST_BYTES
      ) {
        break;
      }
      if (!isSubmitMoveRequest(candidate))
        throw new MoveDeliveryError("invalid-move-batch");
      request = candidate;
    }
    return request;
  }

  private pump(): void {
    if (
      this.finished ||
      this.paused ||
      this.suspended ||
      this.verifying ||
      this.reconciliation
    )
      return;
    if (!this.dependencies.isAuthorized()) {
      this.pause();
      return;
    }
    if (!this.hasPendingMoves) {
      this.windowStartedAt = null;
      this.clearRetryTimer();
      this.resolveBarriers();
      return;
    }
    if (!this.dependencies.isOnline() || this.attempts.size >= 2) return;
    this.windowStartedAt ??= this.now();
    const remaining =
      (this.dependencies.retryWindowMs ?? 60_000) -
      (this.now() - this.windowStartedAt);
    if (remaining <= 0) {
      void this.verifyAfterWindow();
      return;
    }
    let request: SubmitMoveRequest | null;
    try {
      request = this.buildRequest();
    } catch (error) {
      this.stop(error as Error, true);
      return;
    }
    if (!request) {
      this.stop(new MoveDeliveryError("move-batch-too-large"), true);
      return;
    }
    const count = countMoveHistory(request.flatMovesString);
    if (
      [...this.attempts].some(
        (attempt) => countMoveHistory(attempt.target.flatMovesString) >= count,
      )
    ) {
      return;
    }
    if (this.retryAt > this.now() && count <= this.lastAttemptCount) {
      this.scheduleRetry(Math.min(this.retryAt - this.now(), remaining));
      return;
    }
    this.clearRetryTimer();
    this.lastAttemptCount = count;
    const attempt: Attempt = {
      request,
      target: { fen: request.fen, flatMovesString: request.flatMovesString },
      controller: new AbortController(),
      generation: this.generation,
    };
    this.attempts.add(attempt);
    void this.runAttempt(
      attempt,
      Math.min(remaining, this.dependencies.attemptTimeoutMs ?? 20_000),
    );
  }

  private async runAttempt(attempt: Attempt, timeoutMs: number): Promise<void> {
    try {
      const response = await this.dependencies.submit(attempt.request, {
        signal: attempt.controller.signal,
        timeoutMs,
      });
      if (this.conflicted || attempt.generation !== this.generation) return;
      if (response.outcome === "superseded") {
        const remote = {
          fen: response.fen,
          flatMovesString: response.flatMovesString,
        };
        if (!covers(this.confirmed, remote)) this.reconcile(remote);
      } else {
        this.confirm(attempt.target);
      }
    } catch (error) {
      if (
        covers(this.confirmed, attempt.target) ||
        this.conflicted ||
        attempt.generation !== this.generation
      )
        return;
      if (!this.dependencies.isAuthorized()) {
        this.pause();
        return;
      }
      if (attempt.controller.signal.aborted) return;
      if (error instanceof Error && error.message === "match-move-finished") {
        this.finish(error);
        return;
      }
      if (
        error instanceof Error &&
        error.message === "authentication-changed"
      ) {
        this.retryAt = 0;
        return;
      }
      if (error instanceof Error && error.message === "move-chain-conflict") {
        await this.reconcileAfterConflict();
      } else if (terminalError(error)) {
        this.stop(
          error instanceof Error ? error : new Error(String(error)),
          true,
        );
      } else {
        this.failures++;
        this.retryAt = this.now() + Math.min(700 + this.failures * 350, 3000);
      }
    } finally {
      this.attempts.delete(attempt);
      this.pump();
    }
  }

  private async reconcileAfterConflict(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const generation = this.generation;
    const reconciliation = (async () => {
      try {
        const readRevision = this.confirmationRevision;
        const remote = await this.dependencies.read({
          signal: new AbortController().signal,
          timeoutMs: 1200,
        });
        if (generation !== this.generation || !this.dependencies.isAuthorized())
          return;
        if (!remote) this.conflict();
        this.reconcile(remote, readRevision);
      } catch (error) {
        if (generation === this.generation && !this.conflicted) {
          this.failures++;
          this.retryAt = this.now() + Math.min(700 + this.failures * 350, 3000);
        }
      }
    })();
    this.reconciliation = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.reconciliation === reconciliation) this.reconciliation = null;
    }
  }

  private async verifyAfterWindow(): Promise<void> {
    if (this.verifying || this.paused) return;
    this.verifying = true;
    const controller = new AbortController();
    const generation = this.generation;
    this.verificationController = controller;
    const startedAt = this.now();
    const windowMs = this.dependencies.verificationWindowMs ?? 3500;
    try {
      while (
        this.hasPendingMoves &&
        this.dependencies.isAuthorized() &&
        this.now() - startedAt < windowMs &&
        generation === this.generation &&
        !controller.signal.aborted
      ) {
        try {
          const readRevision = this.confirmationRevision;
          const remote = await this.dependencies.read({
            signal: controller.signal,
            timeoutMs: Math.min(1200, windowMs - (this.now() - startedAt)),
          });
          if (
            generation !== this.generation ||
            controller.signal.aborted ||
            !this.dependencies.isAuthorized()
          )
            return;
          if (remote) this.reconcile(remote, readRevision);
          if (!this.hasPendingMoves || this.conflicted) return;
          if (this.confirmationRevision !== readRevision) return;
        } catch {
          if (generation !== this.generation || this.conflicted) return;
        }
        const remaining = windowMs - (this.now() - startedAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) =>
            (this.dependencies.setTimer || setTimeout)(
              resolve,
              Math.min(350, remaining),
            ),
          );
        }
      }
      if (
        generation === this.generation &&
        this.hasPendingMoves &&
        !this.paused
      ) {
        this.pauseForRetry(new MoveDeliveryError("move-delivery-unavailable"));
      }
    } finally {
      if (this.verificationController === controller) {
        this.verifying = false;
        this.verificationController = null;
      }
      if (!this.paused) this.pump();
    }
  }

  private conflict(): never {
    const error = new MoveDeliveryError("move-delivery-conflict");
    this.stop(error, true);
    throw error;
  }

  private retireGeneration(): void {
    this.generation++;
    this.clearRetryTimer();
    for (const attempt of this.attempts) attempt.controller.abort();
    this.attempts.clear();
    this.verificationController?.abort();
    this.verificationController = null;
    this.verifying = false;
    this.reconciliation = null;
  }

  private finish(error: Error): void {
    try {
      this.dependencies.storage?.setItem(
        `${this.key}:finished`,
        JSON.stringify(this.stored()),
      );
    } catch (storageError) {
      this.reportStorageError(storageError);
    }
    this.retireGeneration();
    this.finished = true;
    this.pending = [];
    this.persist();
    this.stop(error, false);
    this.dependencies.onRemoteAdvance();
  }

  private baselineConflict(): never {
    const error = new MoveDeliveryError("move-delivery-baseline-conflict");
    this.conflicted = false;
    this.pauseForRetry(error);
    throw error;
  }

  private stop(error: Error, conflict: boolean): void {
    this.paused = error;
    this.conflicted ||= conflict;
    this.clearRetryTimer();
    for (const attempt of this.attempts) attempt.controller.abort();
    for (const barrier of this.barriers) barrier.reject(error);
    this.barriers.clear();
    this.dependencies.onError(error, conflict ? "conflict" : "paused");
  }

  private pauseForRetry(error: Error): void {
    this.paused = error;
    this.clearRetryTimer();
    for (const attempt of this.attempts) attempt.controller.abort();
    this.dependencies.onError(error, "paused");
    this.timer = (this.dependencies.setTimer || setTimeout)(() => {
      this.timer = null;
      if (!this.dependencies.isAuthorized()) this.pause();
      else void this.refresh();
    }, this.dependencies.recoveryDelayMs ?? 15_000);
  }

  private resolveBarriers(): void {
    for (const barrier of this.barriers) {
      if (covers(this.confirmed, barrier.target)) {
        this.barriers.delete(barrier);
        barrier.resolve();
      }
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = (this.dependencies.setTimer || setTimeout)(() => {
      this.timer = null;
      this.pump();
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.timer !== null) {
      (this.dependencies.clearTimer || clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  private restore(): void {
    try {
      const text = this.dependencies.storage?.getItem(this.key);
      if (!text) return;
      const value = JSON.parse(text) as StoredMoves;
      if (
        value.version !== 1 ||
        !value.scope ||
        moveDeliveryStorageKey(value.scope) !== this.key ||
        !validState(value.confirmed) ||
        !Array.isArray(value.pending) ||
        value.pending.some(
          (move) =>
            !move ||
            typeof move.moveFen !== "string" ||
            !move.moveFen ||
            move.moveFen.includes("-") ||
            typeof move.fen !== "string" ||
            !move.fen ||
            !isMatchFenWithinLimit(move.fen),
        )
      ) {
        throw new MoveDeliveryError("invalid-stored-moves");
      }
      const latest = value.pending.reduce(
        (state, move) => ({
          fen: move.fen,
          flatMovesString: appendHistory(state.flatMovesString, move.moveFen),
        }),
        value.confirmed,
      );
      if (!validState(latest))
        throw new MoveDeliveryError("invalid-stored-moves");
      this.confirmed = { ...value.confirmed };
      this.pending = value.pending.map((move) => ({ ...move }));
      this.finished = value.finished === true;
      if (typeof value.gameVariant === "string")
        this.gameVariant = value.gameVariant;
    } catch (error) {
      this.reportStorageError(error);
    }
  }

  private persist(): void {
    try {
      if (!this.dependencies.storage)
        throw new Error("move-storage-unavailable");
      if (!this.hasPendingMoves && !this.finished) {
        this.dependencies.storage.removeItem(this.key);
        return;
      }
      this.dependencies.storage.setItem(
        this.key,
        JSON.stringify(this.stored()),
      );
    } catch (error) {
      this.reportStorageError(error);
    }
  }

  private stored(): StoredMoves {
    return {
      version: 1,
      scope: this.scope,
      confirmed: this.confirmed,
      pending: this.pending,
      ...(this.gameVariant ? { gameVariant: this.gameVariant } : {}),
      ...(this.finished ? { finished: true } : {}),
    };
  }

  private reportStorageError(error: unknown): void {
    if (this.storageFailureReported) return;
    this.storageFailureReported = true;
    this.dependencies.onError(
      error instanceof Error ? error : new Error(String(error)),
      "storage",
    );
  }
}
