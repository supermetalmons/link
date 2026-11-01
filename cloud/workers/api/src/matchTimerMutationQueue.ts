export class MatchTimerMutationQueue {
  private readonly pending = new Map<string, Promise<void>>();

  async run<T>(matchId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(matchId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(matchId, current);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.pending.get(matchId) === current) this.pending.delete(matchId);
    }
  }
}
