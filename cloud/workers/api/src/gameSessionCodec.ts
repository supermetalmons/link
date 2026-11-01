import {
  GameSessionTransitionFailure,
  type StoredSessionMatchCreation,
} from "./gameSessionIntentRecords.ts";
import type { MatchCreationRecord } from "@mons/shared/match-protocol";
import { isGameSessionMatch } from "@mons/shared/game-sessions";
import { readMatchCreationInput } from "./matchRecordCodec.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { canonicalJson, sha256Hex } from "./canonicalJson.ts";
import type { MatchStateCreation } from "./matchStateTypes.ts";
import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
export {
  GameSessionTransitionFailure,
  readGameSessionIntent,
  serializeGameSessionIntent,
  gameSessionIntentResources,
} from "./gameSessionIntentRecords.ts";
export type {
  GameSessionIntentWrite,
  StoredSessionMatchCreation,
} from "./gameSessionIntentRecords.ts";

type SessionValue<Change> = Change extends { value: infer Value }
  ? Value
  : never;
type FieldValue<Value> = Value extends object ? Value[keyof Value] : never;
type FieldChange = Extract<
  GameSessionChange,
  { kind: "invite-fields" | "telegram-source-merge" | "profile-outbox-merge" }
>;
type ReceiptChange = Extract<GameSessionChange, { kind: "mutation-receipt" }>;
type HistoryChanges = Extract<
  GameSessionChange,
  { kind: "profile-outbox-merge" }
>;
export type EncodedSessionChangeValue =
  | SessionValue<Exclude<GameSessionChange, FieldChange>>
  | FieldValue<SessionValue<FieldChange>>
  | ReceiptChange["expiration"]
  | NonNullable<HistoryChanges["historicalMatches"]>[string]
  | string;

export function encodeSessionChanges(
  changes: readonly GameSessionChange[],
): Record<string, EncodedSessionChangeValue> {
  const updates: Record<string, EncodedSessionChangeValue> = {};
  for (const change of changes) {
    switch (change.kind) {
      case "invite-merge":
        updates[`invites/${change.inviteId}`] = change.value;
        break;
      case "invite-fields":
        for (const [field, value] of Object.entries(change.value))
          updates[`invites/${change.inviteId}/${field}`] = value;
        break;
      case "invite-operation":
        updates[
          `invites/${change.inviteId}/automatchOperationIds/${change.loginUid}`
        ] = change.operationId;
        break;
      case "invite-rematches":
        updates[`invites/${change.inviteId}/${change.role}Rematches`] =
          change.value;
        break;
      case "match-create":
        updates[`players/${change.playerId}/matches/${change.matchId}`] =
          change.value;
        break;
      case "automatch-entry":
        updates[`automatch/${change.inviteId}`] = change.value;
        break;
      case "telegram-source":
        updates[`telegramAutomatches/${change.inviteId}`] = change.value;
        break;
      case "telegram-source-merge":
        for (const [field, value] of Object.entries(change.value))
          updates[`telegramAutomatches/${change.inviteId}/${field}`] = value;
        break;
      case "telegram-outbox":
        updates[`telegramProjectionOutbox/automatch/${change.inviteId}`] =
          change.value;
        break;
      case "profile-outbox":
        updates[`profileGameProjectionOutbox/automatch/${change.inviteId}`] =
          change.value;
        break;
      case "profile-outbox-merge":
        for (const [field, value] of Object.entries(change.value)) {
          if (field === "historicalMatches") continue;
          updates[
            `profileGameProjectionOutbox/automatch/${change.inviteId}/${field}`
          ] = value;
        }
        for (const [matchId, value] of Object.entries(
          change.historicalMatches || {},
        ))
          updates[
            `profileGameProjectionOutbox/automatch/${change.inviteId}/historicalMatches/${matchId}`
          ] = value;
        break;
      case "mutation-receipt":
        updates[`gameplayMutationReceipts/${change.operationId}`] =
          change.value;
        updates[`gameplayMutationReceiptExpirations/${change.operationId}`] =
          change.expiration;
        break;
    }
  }
  return updates;
}

export const GAME_SESSION_CREATION_FIELD = "sessionCreation";
export const GAME_SESSION_TRANSITION_FIELD = "sessionTransition";
type JsonRecord = Record<string, unknown>;
function fail(code: string): never {
  throw new GameSessionTransitionFailure(code);
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonical(value: unknown): string {
  return canonicalJson(value, () => fail("invalid-json"));
}

export async function digest(value: unknown): Promise<string> {
  return sha256Hex(canonical(value));
}

function pathParts(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !isSafeRecordKey(part))) fail("invalid-path");
  return parts;
}

export function readField(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split("/")) {
    if (!record(current) || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current ?? null;
}

export function gameSessionOperationResource(operationId: string): string {
  if (!isSafeRecordKey(operationId)) fail("invalid-operation");
  return `gameplay-operation:${operationId}`;
}

export function sessionLayout(changes: readonly GameSessionChange[]): {
  inviteId: string;
  inviteUpdates: JsonRecord;
  matchUpdates: { path: string; value: MatchCreationRecord }[];
  operationResources: string[];
} {
  const inviteIds = new Set<string>();
  const inviteUpdates: JsonRecord = {};
  const matchUpdates: { path: string; value: MatchCreationRecord }[] = [];
  const operationResources: string[] = [];
  let canonicalChanges = 0;
  const paths = Object.keys(encodeSessionChanges(changes));
  for (const path of paths) {
    pathParts(path);
    if (paths.some((other) => other !== path && path.startsWith(`${other}/`)))
      fail("overlapping-updates");
  }
  for (const change of changes) {
    if ("inviteId" in change) inviteIds.add(change.inviteId);
    switch (change.kind) {
      case "invite-merge":
      case "invite-fields":
        if (!record(change.value)) fail("invalid-invite-write");
        for (const [field, value] of Object.entries(change.value)) {
          if (!isSafeRecordKey(field)) fail("invalid-invite-field");
          inviteUpdates[field] = value;
        }
        break;
      case "invite-operation":
        inviteUpdates[`automatchOperationIds/${change.loginUid}`] =
          change.operationId;
        break;
      case "invite-rematches":
        inviteUpdates[`${change.role}Rematches`] = change.value;
        break;
      case "match-create":
        if (
          !record(change.value) ||
          typeof change.value.fen !== "string" ||
          !change.value.fen ||
          Object.hasOwn(change.value, GAME_SESSION_CREATION_FIELD)
        )
          fail("unsupported-effect");
        matchUpdates.push({
          path: `players/${change.playerId}/matches/${change.matchId}`,
          value: change.value,
        });
        break;
      case "mutation-receipt": {
        operationResources.push(
          gameSessionOperationResource(change.operationId),
        );
        const receipt = change.value;
        if (record(receipt)) {
          if (typeof receipt.inviteId === "string")
            inviteIds.add(receipt.inviteId);
          else if (
            record(receipt.response) &&
            typeof receipt.response.inviteId === "string"
          )
            inviteIds.add(receipt.response.inviteId);
        }
        canonicalChanges++;
        break;
      }
      case "automatch-entry":
      case "telegram-source":
      case "telegram-source-merge":
      case "telegram-outbox":
      case "profile-outbox":
      case "profile-outbox-merge":
        canonicalChanges++;
        break;
      default:
        fail("unsupported-effect");
    }
  }
  if (inviteIds.size !== 1 || !canonicalChanges) fail("invalid-scope");
  const inviteId = [...inviteIds][0]!;
  if (!isSafeRecordKey(inviteId)) fail("invalid-invite");
  for (const field of Object.keys(inviteUpdates)) {
    if (
      field === GAME_SESSION_TRANSITION_FIELD &&
      inviteUpdates[field] === null
    )
      continue;
    if (
      [
        GAME_SESSION_TRANSITION_FIELD,
        "wagers",
        "matchesWagerResolutions",
        "reactions",
      ].includes(field.split("/")[0]!)
    )
      fail("reserved-invite-field");
  }
  for (const change of changes) {
    if (change.kind !== "match-create") continue;
    if (
      change.matchId !== inviteId &&
      !(
        change.matchId.startsWith(inviteId) &&
        /^[1-9]\d*$/.test(change.matchId.slice(inviteId.length))
      )
    )
      fail("match-outside-invite");
  }
  return { inviteId, inviteUpdates, matchUpdates, operationResources };
}

export function decodeSessionMatchCreation(
  creation: StoredSessionMatchCreation,
): MatchStateCreation {
  const evidence = creation;
  const [root, playerId, matches, matchId, extra] = pathParts(evidence.path);
  if (
    root !== "players" ||
    !playerId ||
    matches !== "matches" ||
    !matchId ||
    extra
  )
    fail("invalid-match-discovery-path");
  return {
    playerId,
    matchId,
    value: readMatchCreationInput(evidence.value),
    marker: evidence.marker,
  };
}

export async function encodeSessionMatchCreations(
  updates: readonly { path: string; value: MatchCreationRecord }[],
  transitionId: string,
  contentDigest: string,
  createdAtMs: number,
): Promise<StoredSessionMatchCreation[]> {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)
    fail("invalid-created-at");
  return Promise.all(
    updates.map(async ({ path, value }) => {
      if (!isGameSessionMatch(value)) fail("invalid-match-creation");
      return {
        path,
        value: structuredClone(value),
        marker: await digest({ transitionId, path, digest: contentDigest }),
      };
    }),
  );
}
