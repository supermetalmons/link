type AlarmTransaction = Pick<DurableObjectTransaction, "getAlarm" | "setAlarm">;

export type InviteAlarmWork = {
  schedule: () => Promise<void>;
  metadata: () => Promise<void>;
  wagers: () => Promise<void>;
};

export type InviteAlarmCallbacks = {
  expireSessions: () => number | null;
  prepareInviteChannels: () => InviteAlarmWork | null;
  refreshMatches: () => Promise<void>;
  dispatchEffects: () => Promise<void>;
  inviteDeadline: () => number | null;
  matchDeadline: () => number | null;
  effectDeadline: () => number | null;
};

export class InviteAlarmCoordinator {
  private sequence: Promise<void> = Promise.resolve();
  private readonly storage: Pick<DurableObjectStorage, "transaction">;
  private readonly callbacks: InviteAlarmCallbacks;

  constructor(
    storage: Pick<DurableObjectStorage, "transaction">,
    callbacks: InviteAlarmCallbacks,
  ) {
    this.storage = storage;
    this.callbacks = callbacks;
  }

  schedule(atMs: number, transaction?: AlarmTransaction): Promise<void> {
    const schedule = async (storage: AlarmTransaction) => {
      const current = await storage.getAlarm();
      if (current === null || current > atMs) {
        await storage.setAlarm(atMs);
      }
    };
    if (transaction) return schedule(transaction);
    const pending = this.sequence.then(() =>
      this.storage.transaction(schedule),
    );
    this.sequence = pending.catch(() => undefined);
    return pending;
  }

  async run(): Promise<void> {
    const failures: unknown[] = [];
    const run = async (work: () => unknown) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    try {
      await run(() => this.callbacks.expireSessions());
      let inviteWork: InviteAlarmWork | null = null;
      try {
        inviteWork = this.callbacks.prepareInviteChannels();
      } catch (error) {
        failures.push(error);
      }
      if (inviteWork) {
        const work = inviteWork;
        await run(() => work.schedule());
        await run(() => work.metadata());
      }
      const refreshes = await Promise.allSettled([
        Promise.resolve().then(() => inviteWork?.wagers()),
        Promise.resolve().then(() => this.callbacks.refreshMatches()),
      ]);
      for (const result of refreshes)
        if (result.status === "rejected") failures.push(result.reason);
      await run(() => this.callbacks.expireSessions());
      await run(() => this.callbacks.dispatchEffects());
    } finally {
      const due: number[] = [];
      for (const readDeadline of [
        () => this.callbacks.inviteDeadline(),
        () => this.callbacks.matchDeadline(),
        () => this.callbacks.effectDeadline(),
        () => this.callbacks.expireSessions(),
      ]) {
        try {
          const deadline = readDeadline();
          if (deadline !== null) due.push(deadline);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        if (due.length) await this.schedule(Math.min(...due));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }
}
