// Generated from src/eventCommandCodec.ts. Run npm run generate:runtime.
import { type EventInviteDocument } from "./shared/invite-records.js";
import type { EventMutation, EventEffect } from "./eventCommands.js";
import type { EventProgressOutboxRecord } from "./events.js";
export declare function eventCommandRecord(
  value: unknown,
): value is Record<string, unknown>;
export declare function parseEventProgressCommandRecord(
  value: unknown,
): EventProgressOutboxRecord;
export declare function parseEventMutation(value: unknown): EventMutation;
export declare function parseEventInvite(value: unknown): EventInviteDocument;
export declare function parseEventEffect(value: unknown): EventEffect;
export declare function parseEventMutations(value: unknown): EventMutation[];
export declare function parseEventEffects(value: unknown): EventEffect[];
