import type { WagerFrozenReadResponse } from "@mons/shared/wagers";

export const FROZEN_MATERIALS_POLL_INTERVAL_MS = 2_000;
export const FROZEN_MATERIALS_BACKOFF_MS = [
  2_000, 4_000, 8_000, 16_000, 30_000,
] as const;

type Timer = ReturnType<typeof setTimeout>;

type FrozenMaterialsPollerDependencies = {
  playerUid: string;
  addVisibilityListener: (listener: () => void) => () => void;
  addOnlineListener: (listener: () => void) => () => void;
  clearTimer: (timer: Timer) => void;
  isActive: () => boolean;
  isVisible: () => boolean;
  load: (signal: AbortSignal) => Promise<WagerFrozenReadResponse>;
  onPending: () => void;
  onSnapshot: (snapshot: WagerFrozenReadResponse) => void;
  onError: (
    error: unknown,
    lastConfirmed: WagerFrozenReadResponse | null,
    refreshRequired: boolean,
  ) => void;
  setTimer: (callback: () => void, delayMs: number) => Timer;
};

export class FrozenMaterialsPoller {
  private readonly dependencies: FrozenMaterialsPollerDependencies;
  private readonly removeVisibilityListener: () => void;
  private readonly removeOnlineListener: () => void;
  private timer: Timer | null = null;
  private inFlight: {
    controller: AbortController;
    generation: number;
    promise: Promise<boolean>;
  } | null = null;
  private generation = 0;
  private consecutiveFailures = 0;
  private stopped = false;
  private mutationActive = false;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private lastConfirmed: WagerFrozenReadResponse | null = null;
  private refreshRequired = true;

  constructor(dependencies: FrozenMaterialsPollerDependencies) {
    this.dependencies = dependencies;
    this.removeVisibilityListener = dependencies.addVisibilityListener(() => {
      if (dependencies.isVisible()) this.refresh();
      else this.invalidate();
    });
    this.removeOnlineListener = dependencies.addOnlineListener(() =>
      this.refresh(),
    );
    dependencies.onPending();
    this.schedule(0);
  }

  refresh(): void {
    if (!this.isActive()) return;
    this.invalidate();
    if (!this.mutationActive) this.schedule(0);
  }

  runMutation<T>(
    action: () => Promise<T>,
    options: { requiresSnapshot?: boolean; isCurrent: () => boolean },
  ): Promise<T> {
    const run = async () => {
      this.assertActive(options.isCurrent);
      if (
        options.requiresSnapshot &&
        (!this.lastConfirmed || this.refreshRequired)
      ) {
        const loaded = await this.poll();
        this.assertActive(options.isCurrent);
        if (!loaded || !this.lastConfirmed || this.refreshRequired) {
          throw new Error("wager-balance-unavailable");
        }
      }
      this.invalidate();
      this.mutationActive = true;
      this.refreshRequired = true;
      this.dependencies.onPending();
      try {
        return await action();
      } finally {
        this.mutationActive = false;
        if (this.isActive()) this.refresh();
      }
    };
    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.catch(() => undefined);
    return result;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.invalidate();
    this.removeVisibilityListener();
    this.removeOnlineListener();
  }

  private isActive(): boolean {
    return !this.stopped && this.dependencies.isActive();
  }

  private assertActive(isCurrent: () => boolean): void {
    if (!this.isActive() || !isCurrent()) {
      throw new Error("wager-session-changed");
    }
  }

  private invalidate(): void {
    this.generation += 1;
    this.clearTimer();
    this.inFlight?.controller.abort();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.dependencies.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (
      !this.isActive() ||
      this.mutationActive ||
      !this.dependencies.isVisible()
    ) {
      return;
    }
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<boolean> {
    this.clearTimer();
    if (
      !this.isActive() ||
      this.mutationActive ||
      !this.dependencies.isVisible()
    ) {
      return false;
    }
    if (this.inFlight) {
      const previous = this.inFlight;
      if (previous.generation === this.generation) return previous.promise;
      await previous.promise;
      return this.poll();
    }
    const controller = new AbortController();
    const generation = this.generation;
    const current = () =>
      this.isActive() &&
      !controller.signal.aborted &&
      generation === this.generation &&
      !this.mutationActive;
    const run = async () => {
      let delay = FROZEN_MATERIALS_POLL_INTERVAL_MS;
      try {
        const snapshot = await this.dependencies.load(controller.signal);
        if (!current()) return false;
        if (
          snapshot.playerUid !== this.dependencies.playerUid ||
          snapshot.revision < (this.lastConfirmed?.revision ?? 0)
        ) {
          throw new Error("invalid-wager-balance-snapshot");
        }
        this.lastConfirmed = {
          ...snapshot,
          frozen: { ...snapshot.frozen },
        };
        this.refreshRequired = false;
        this.consecutiveFailures = 0;
        this.dependencies.onSnapshot(snapshot);
        return true;
      } catch (error) {
        if (!current()) return false;
        this.consecutiveFailures += 1;
        delay =
          FROZEN_MATERIALS_BACKOFF_MS[
            Math.min(
              this.consecutiveFailures - 1,
              FROZEN_MATERIALS_BACKOFF_MS.length - 1,
            )
          ];
        this.dependencies.onError(
          error,
          this.lastConfirmed,
          this.refreshRequired,
        );
        return false;
      } finally {
        if (this.inFlight?.controller === controller) this.inFlight = null;
        if (this.isActive() && !this.mutationActive) {
          this.schedule(generation === this.generation ? delay : 0);
        }
      }
    };
    const promise = Promise.resolve().then(run);
    this.inFlight = { controller, generation, promise };
    return promise;
  }
}
