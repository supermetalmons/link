// Generated from src/eventCommandCodec.ts. Run npm run generate:runtime.
import { type EventInviteDocument } from "./shared/invite-records.js";
import { type MatchCreationRecord } from "./shared/match-protocol.js";
import { type ClaimedTimerWrite } from "./shared/timers.js";
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
export declare function parseEventMatchCreation(
  value: unknown,
): MatchCreationRecord;
export declare function parseEventTimerClaim(value: unknown): ClaimedTimerWrite;
export declare function parseEventEffect(value: unknown): EventEffect;
export declare function parseEventMutations(value: unknown): EventMutation[];
export declare function parseEventEffects(value: unknown): EventEffect[];
