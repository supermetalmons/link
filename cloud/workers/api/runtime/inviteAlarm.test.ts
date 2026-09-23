import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { InviteReactions } from "../src/inviteReactions.ts";
import type { InviteAlarmWork } from "../src/inviteAlarmCoordinator.ts";

type Room = DurableObjectStub<InviteReactions>;
type AlarmComponents = {
  socketSessions: { nextExpiry: () => number | null };
  inviteChannels: {
    prepareAlarm: () => InviteAlarmWork | null;
    nextAlarm: () => number | null;
  };
  matchSync: {
    alarm: () => Promise<void>;
    nextAlarm: () => number | null;
  };
  matchState: { nextEffectAt: () => number | null };
  matchEffects: { dispatch: () => Promise<void> };
};

const rooms: Room[] = [];

function fixture() {
  const room = env.INVITE_REACTIONS.getByName(`alarm-${crypto.randomUUID()}`);
  rooms.push(room);
  return room;
}

afterEach(async () => {
  await Promise.all(
    rooms
      .splice(0)
      .map((room) =>
        runInDurableObject(room, (_instance, state) =>
          state.storage.deleteAlarm(),
        ),
      ),
  );
});

it("refreshes sockets and expiry before awaiting effects, then schedules the earliest deadline", async () => {
  await runInDurableObject(fixture(), async (instance, state) => {
    const target = instance as unknown as AlarmComponents;
    const phases: string[] = [];
    const now = Date.now();
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    target.socketSessions.nextExpiry = () => {
      phases.push("expiry");
      return now + 2_000;
    };
    target.inviteChannels.prepareAlarm = () => ({
      schedule: async () => {
        phases.push("schedule");
      },
      metadata: async () => {
        phases.push("metadata");
      },
      wagers: async () => {
        phases.push("wagers");
      },
    });
    target.inviteChannels.nextAlarm = () => now + 5_000;
    target.matchSync.alarm = async () => {
      phases.push("match");
    };
    target.matchSync.nextAlarm = () => now + 4_000;
    target.matchState.nextEffectAt = () => now + 60_000;
    target.matchEffects.dispatch = async () => {
      phases.push("effects");
      started();
      await gate;
    };
    let finished = false;
    const pending = instance.alarm().then(() => {
      finished = true;
    });
    await began;
    try {
      expect(phases).toEqual([
        "expiry",
        "schedule",
        "metadata",
        "wagers",
        "match",
        "expiry",
        "effects",
      ]);
      expect(finished).toBe(false);
    } finally {
      release();
      await pending;
    }
    expect(await state.storage.getAlarm()).toBe(now + 2_000);
  });
});

it("finishes metadata before refreshing matches without awaiting blocked wagers", async () => {
  await runInDurableObject(fixture(), async (instance) => {
    const target = instance as unknown as AlarmComponents;
    const metadataStarted = Promise.withResolvers<void>();
    const releaseMetadata = Promise.withResolvers<void>();
    const releaseWagers = Promise.withResolvers<void>();
    const matchStarted = Promise.withResolvers<void>();
    const phases: string[] = [];
    target.socketSessions.nextExpiry = () => null;
    target.inviteChannels.prepareAlarm = () => ({
      schedule: async () => {},
      metadata: async () => {
        phases.push("metadata-start");
        metadataStarted.resolve();
        await releaseMetadata.promise;
        phases.push("metadata-end");
      },
      wagers: async () => {
        phases.push("wagers-start");
        await releaseWagers.promise;
        phases.push("wagers-end");
      },
    });
    target.inviteChannels.nextAlarm = () => null;
    target.matchSync.alarm = async () => {
      phases.push("match");
      matchStarted.resolve();
    };
    target.matchSync.nextAlarm = () => null;
    target.matchState.nextEffectAt = () => null;
    target.matchEffects.dispatch = async () => {
      phases.push("effects");
    };
    const pending = instance.alarm();
    await metadataStarted.promise;
    try {
      expect(phases).toEqual(["metadata-start"]);
      releaseMetadata.resolve();
      await matchStarted.promise;
      expect(phases).toEqual([
        "metadata-start",
        "metadata-end",
        "wagers-start",
        "match",
      ]);
    } finally {
      releaseMetadata.resolve();
      releaseWagers.resolve();
      await pending;
    }
    expect(phases.slice(-2)).toEqual(["wagers-end", "effects"]);
  });
});

for (const failed of [
  "prepare",
  "schedule",
  "metadata",
  "wagers",
  "match",
  "effects",
] as const) {
  it(`continues after a ${failed} failure, reschedules and surfaces the original error`, async () => {
    await runInDurableObject(fixture(), async (instance, state) => {
      const target = instance as unknown as AlarmComponents;
      const phases: string[] = [];
      const error = new Error(`${failed}-alarm-failed`);
      const deadline = Date.now() + 5_000;
      const run = async (phase: string) => {
        phases.push(phase);
        if (phase === failed) throw error;
        if (phase === "effects") throw new Error("later-effect-failure");
      };
      target.socketSessions.nextExpiry = () => {
        phases.push("expiry");
        return null;
      };
      target.inviteChannels.prepareAlarm = () => {
        phases.push("prepare");
        if (failed === "prepare") throw error;
        return {
          schedule: () => run("schedule"),
          metadata: () => run("metadata"),
          wagers: () => run("wagers"),
        };
      };
      target.inviteChannels.nextAlarm = () => deadline;
      target.matchSync.alarm = () => run("match");
      target.matchSync.nextAlarm = () => deadline + 1_000;
      target.matchState.nextEffectAt = () => deadline + 60_000;
      target.matchEffects.dispatch = () => run("effects");
      await expect(instance.alarm()).rejects.toBe(error);
      expect(phases).toEqual([
        "expiry",
        "prepare",
        ...(failed === "prepare" ? [] : ["schedule", "metadata", "wagers"]),
        "match",
        "expiry",
        "effects",
        "expiry",
      ]);
      expect(await state.storage.getAlarm()).toBe(deadline);
    });
  });
}

it("schedules surviving deadlines when another component cannot read its deadline", async () => {
  await runInDurableObject(fixture(), async (instance, state) => {
    const target = instance as unknown as AlarmComponents;
    const error = new Error("invite-deadline-unavailable");
    const deadline = Date.now() + 2_000;
    target.socketSessions.nextExpiry = () => deadline;
    target.inviteChannels.prepareAlarm = () => null;
    target.inviteChannels.nextAlarm = () => {
      throw error;
    };
    target.matchSync.alarm = async () => {};
    target.matchSync.nextAlarm = () => deadline + 5_000;
    target.matchState.nextEffectAt = () => deadline + 60_000;
    target.matchEffects.dispatch = async () => {};
    await expect(instance.alarm()).rejects.toBe(error);
    expect(await state.storage.getAlarm()).toBe(deadline);
  });
});
