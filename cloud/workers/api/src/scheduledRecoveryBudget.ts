import {
  EVENT_ANNOUNCEMENT_KINDS,
  eventAnnouncementRunAtMs,
} from "./eventAnnouncementKinds.ts";
import type { ScheduledEventRecoveryCandidate } from "./eventScheduledRecoveryD1.ts";

const SCHEDULED_RECOVERY_URGENT_BUDGET = 4_500;
const SCHEDULED_RECOVERY_BACKGROUND_BUDGET = 1_000;
const SCHEDULED_RECOVERY_START_COST = 10;
const SCHEDULED_RECOVERY_ANNOUNCEMENT_COST = 40;

export function createScheduledRecoveryBudget(nowMs: number) {
  const remaining = {
    urgent: SCHEDULED_RECOVERY_URGENT_BUDGET,
    background: SCHEDULED_RECOVERY_BACKGROUND_BUDGET,
  };
  const visited = new Set<string>();
  return {
    select(
      candidates: readonly ScheduledEventRecoveryCandidate[],
      lane: "urgent" | "background",
    ): {
      selected: ScheduledEventRecoveryCandidate[];
      traversedCount: number;
    } {
      const selected: ScheduledEventRecoveryCandidate[] = [];
      let traversedCount = 0;
      for (const candidate of candidates) {
        const { eventId } = candidate.cursor;
        if (visited.has(eventId)) {
          traversedCount++;
          continue;
        }
        const event = candidate.event;
        const cost = event
          ? SCHEDULED_RECOVERY_START_COST +
            EVENT_ANNOUNCEMENT_KINDS.filter(
              (kind) =>
                eventAnnouncementRunAtMs(eventId, event, nowMs, kind) !== null,
            ).length *
              SCHEDULED_RECOVERY_ANNOUNCEMENT_COST
          : 0;
        if (cost > remaining[lane]) break;
        remaining[lane] -= cost;
        visited.add(eventId);
        selected.push(candidate);
        traversedCount++;
      }
      return { selected, traversedCount };
    },
  };
}
