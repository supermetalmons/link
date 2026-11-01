import { canonicalReceiptJson, sha256Hex } from "./canonicalJson.ts";
import type {
  MatchStateClaimTimerRequest,
  MatchStateMoveRequest,
  MatchStateStartTimerRequest,
  MatchStateSurrenderRequest,
} from "./matchStateTypes.ts";
import type {
  MatchStateCreateWireRequest,
  MatchStateEventEffectsWireRequest,
} from "./matchStateWire.ts";

export type MatchWriterMutation =
  | { kind: "create"; request: MatchStateCreateWireRequest }
  | { kind: "move"; request: MatchStateMoveRequest }
  | { kind: "surrender"; request: MatchStateSurrenderRequest }
  | { kind: "start-timer"; request: MatchStateStartTimerRequest }
  | { kind: "claim-timer"; request: MatchStateClaimTimerRequest }
  | { kind: "event-effects"; request: MatchStateEventEffectsWireRequest }
  | { kind: "alarm"; request: { objectId: string } };

function invalid(): never {
  throw new TypeError("invalid-timer-handoff-record");
}

export function matchWriterJson(value: unknown): string {
  return canonicalReceiptJson(value, invalid);
}

export function hashMatchWriter(value: unknown): Promise<string> {
  return sha256Hex(matchWriterJson(value));
}
