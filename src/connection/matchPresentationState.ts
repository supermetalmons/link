import {
  isMatchPresentation,
  isMatchPresentationSnapshot,
  isUpdateMatchPresentationRequest,
  type MatchPresentation,
  type MatchPresentationSnapshot,
  type UpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";

type PresentationIntent = {
  operationId: string;
  emojiId: number;
  aura: string;
};

type MatchPresentationStateDependencies = {
  matchId: string;
  actorUid: string | null;
  isActive: () => boolean;
  load: (signal: AbortSignal) => Promise<MatchPresentationSnapshot>;
  save: (
    request: UpdateMatchPresentationRequest,
    signal: AbortSignal,
  ) => Promise<MatchPresentation>;
  onChange: (actorUid: string) => void;
  onError: (error: unknown) => void;
  createOperationId?: () => string;
};

function conflictingPresentation(error: unknown): MatchPresentation | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "presentation-conflict" &&
    "presentation" in error &&
    isMatchPresentation(error.presentation)
  ) {
    return error.presentation;
  }
  return null;
}

export class MatchPresentationState {
  private readonly dependencies: MatchPresentationStateDependencies;
  private readonly controller = new AbortController();
  private readonly confirmed = new Map<string, MatchPresentation>();
  private queued: PresentationIntent | null = null;
  private sending: PresentationIntent | null = null;
  private uncertain: UpdateMatchPresentationRequest | null = null;
  private draining = false;
  private refreshRequired = true;
  private loading: Promise<boolean> | null = null;
  private recoveryVersion = 0;
  private selectionVersion = 0;

  constructor(dependencies: MatchPresentationStateDependencies) {
    this.dependencies = dependencies;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get(actorUid: string): MatchPresentation | null {
    if (!this.isActive()) return null;
    const confirmed = this.confirmed.get(actorUid) ?? null;
    const optimistic =
      actorUid === this.dependencies.actorUid
        ? (this.queued ?? this.sending)
        : null;
    return optimistic
      ? {
          matchId: this.dependencies.matchId,
          actorUid,
          emojiId: optimistic.emojiId,
          aura: optimistic.aura,
          revision: confirmed?.revision ?? 0,
        }
      : confirmed;
  }

  accept(presentation: MatchPresentation, wake = true): void {
    if (
      !this.isActive() ||
      !isMatchPresentation(presentation) ||
      presentation.matchId !== this.dependencies.matchId
    ) {
      return;
    }
    const previous = this.confirmed.get(presentation.actorUid);
    if (previous && previous.revision >= presentation.revision) return;
    this.confirmed.set(presentation.actorUid, { ...presentation });
    this.dependencies.onChange(presentation.actorUid);
    if (wake && presentation.actorUid === this.dependencies.actorUid) {
      this.recoveryVersion++;
      this.refreshRequired = false;
      void this.drain();
    }
  }

  acceptSnapshot(snapshot: MatchPresentationSnapshot, wake = true): void {
    if (
      !this.isActive() ||
      !isMatchPresentationSnapshot(snapshot) ||
      snapshot.matchId !== this.dependencies.matchId
    ) {
      return;
    }
    for (const presentation of Object.values(snapshot.players)) {
      this.accept(presentation, false);
    }
    this.refreshRequired = false;
    if (wake) {
      this.recoveryVersion++;
      void this.drain();
    }
  }

  update(emojiId: number, aura: string): void {
    if (!this.isActive() || !this.dependencies.actorUid) return;
    const intent: PresentationIntent = {
      operationId: (
        this.dependencies.createOperationId || (() => crypto.randomUUID())
      )(),
      emojiId,
      aura,
    };
    if (!isUpdateMatchPresentationRequest({ ...intent, expectedRevision: 0 })) {
      this.dependencies.onError(new Error("invalid-match-presentation"));
      return;
    }
    this.queued = intent;
    this.selectionVersion++;
    this.dependencies.onChange(this.dependencies.actorUid);
    void this.drain();
  }

  async refresh(): Promise<void> {
    if (await this.load()) {
      this.recoveryVersion++;
      void this.drain();
    }
  }

  stop(): void {
    this.controller.abort();
    this.queued = null;
    this.sending = null;
    this.uncertain = null;
    this.confirmed.clear();
  }

  private isActive(): boolean {
    return !this.signal.aborted && this.dependencies.isActive();
  }

  private load(): Promise<boolean> {
    if (!this.isActive()) return Promise.resolve(false);
    if (this.loading) return this.loading;
    const recoveryVersion = this.recoveryVersion;
    const run = async () => {
      try {
        const snapshot = await this.dependencies.load(this.signal);
        if (!this.isActive()) return false;
        if (
          !isMatchPresentationSnapshot(snapshot) ||
          snapshot.matchId !== this.dependencies.matchId
        ) {
          throw new Error("invalid-presentation-snapshot");
        }
        this.acceptSnapshot(snapshot, false);
        return true;
      } catch (error) {
        if (this.isActive()) {
          if (this.recoveryVersion !== recoveryVersion) return true;
          this.refreshRequired = true;
          this.dependencies.onError(error);
        }
        return false;
      }
    };
    const pending = run();
    this.loading = pending;
    void pending.finally(() => {
      if (this.loading === pending) this.loading = null;
    });
    return pending;
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.isActive()) return;
    this.draining = true;
    const recoveryVersion = this.recoveryVersion;
    let handledSelectionVersion = this.selectionVersion;
    const actorUid = this.dependencies.actorUid;
    try {
      while (this.isActive() && this.queued && actorUid) {
        if (this.refreshRequired || !this.confirmed.has(actorUid)) {
          if (!(await this.load()) || !this.confirmed.has(actorUid)) {
            if (!this.uncertain) this.queued = null;
            if (this.isActive()) this.dependencies.onChange(actorUid);
            break;
          }
        }
        if (!this.isActive() || !this.queued) break;
        handledSelectionVersion = this.selectionVersion;
        const confirmed = this.confirmed.get(actorUid)!;
        if (
          this.uncertain &&
          confirmed.revision > this.uncertain.expectedRevision
        ) {
          this.uncertain = null;
        }
        const settlingUncertain = this.uncertain !== null;
        const request = this.uncertain ?? {
          ...this.queued,
          expectedRevision: confirmed.revision,
        };
        if (!settlingUncertain) this.queued = null;
        if (
          !settlingUncertain &&
          confirmed.emojiId === request.emojiId &&
          confirmed.aura === request.aura
        ) {
          this.dependencies.onChange(actorUid);
          continue;
        }
        this.sending = request;
        let reconcileAfterSave = false;
        try {
          const result = await this.dependencies.save(request, this.signal);
          if (!this.isActive()) break;
          if (
            !isMatchPresentation(result) ||
            result.matchId !== this.dependencies.matchId ||
            result.actorUid !== actorUid ||
            result.revision <= request.expectedRevision ||
            result.emojiId !== request.emojiId ||
            result.aura !== request.aura
          ) {
            throw new Error("invalid-presentation-update");
          }
          this.accept(result);
          this.uncertain = null;
        } catch (error) {
          if (!this.isActive()) break;
          const conflict = conflictingPresentation(error);
          if (
            conflict?.matchId === this.dependencies.matchId &&
            conflict.actorUid === actorUid &&
            (!settlingUncertain || conflict.revision > request.expectedRevision)
          ) {
            this.accept(conflict);
            this.uncertain = null;
          } else {
            this.uncertain = request;
            reconcileAfterSave = true;
            this.refreshRequired = true;
            this.dependencies.onError(error);
          }
        } finally {
          this.sending = null;
          if (this.isActive()) this.dependencies.onChange(actorUid);
        }
        if (this.isActive() && (reconcileAfterSave || this.refreshRequired)) {
          if (reconcileAfterSave && this.loading) await this.loading;
          if (!this.isActive()) break;
          this.refreshRequired = true;
          if (!(await this.load())) {
            if (!this.uncertain) this.queued = null;
            if (this.isActive()) this.dependencies.onChange(actorUid);
            break;
          }
        }
        if (
          settlingUncertain &&
          this.uncertain &&
          (this.confirmed.get(actorUid)?.revision ?? -1) <=
            this.uncertain.expectedRevision
        ) {
          break;
        }
      }
    } finally {
      this.draining = false;
      if (
        this.isActive() &&
        this.queued &&
        (this.recoveryVersion !== recoveryVersion ||
          this.selectionVersion !== handledSelectionVersion)
      ) {
        if (this.recoveryVersion !== recoveryVersion)
          this.refreshRequired = false;
        void this.drain();
      }
    }
  }
}
