import type { EventTransitionIntent } from "../src/eventD1/types.ts";
import { validateTransitionIntent } from "../src/eventD1/validation.ts";

export function eventIntentFixture<
  const Input extends { schemaVersion: 1 | 2 },
>(
  value: Input,
): Extract<EventTransitionIntent, { schemaVersion: Input["schemaVersion"] }> {
  return validateTransitionIntent(value) as Extract<
    EventTransitionIntent,
    { schemaVersion: Input["schemaVersion"] }
  >;
}

export function retainedEventIntentFixture<Version extends 1 | 2 = 1 | 2>(
  value: unknown,
): Extract<EventTransitionIntent, { schemaVersion: Version }> {
  return value as Extract<EventTransitionIntent, { schemaVersion: Version }>;
}

export function retainedEventInviteMutationsFixture(
  value: unknown,
): Array<{ current: Record<string, unknown>; value: unknown }> {
  return value as Array<{ current: Record<string, unknown>; value: unknown }>;
}
