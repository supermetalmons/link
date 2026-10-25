import type { MatchCreationRecord } from "@mons/shared/match-protocol";
import type {
  AutomatchRecordMutation,
  RetainedAutomatchMutationBatch,
} from "./automatchD1/types.ts";
import {
  isEventOwnedInviteSource,
  type InviteSourceMutation,
  type RetainedInviteMutationBatch,
} from "./inviteSourceD1.ts";
import { readMatchCreationInput } from "./matchRecordCodec.ts";
import {
  evaluateStateValueMarker,
  STATE_VALUE_FIELD,
} from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { canonicalJson, sha256Hex } from "./canonicalJson.ts";
import type { MatchStateCreation } from "./matchStateTypes.ts";
import type { GameSessionChange } from "./gameSessionContracts.ts";

export function encodeSessionChanges(
  changes: readonly GameSessionChange[],
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
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
        for (const [field, value] of Object.entries(change.value))
          updates[
            `profileGameProjectionOutbox/automatch/${change.inviteId}/${field}`
          ] = value;
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
declare const retainedSessionCreation: unique symbol;
export type StoredSessionMatchCreation = {
  readonly [retainedSessionCreation]: true;
};

type SessionCreationEvidence = {
  path: string;
  value: unknown;
  marker: string;
};

export type GameSessionIntentWrite = {
  version: 2;
  inviteId: string;
  inviteSourceEpoch: number;
  inviteMutations: InviteSourceMutation[];
  transitionId: string;
  digest: string;
  resources: string[];
  mutations: AutomatchRecordMutation[];
  creations: StoredSessionMatchCreation[];
  createdAtMs: number;
};

declare const retainedSessionResources: unique symbol;
type RetainedSessionResources = { readonly [retainedSessionResources]: true };
declare const retainedSessionIntent: unique symbol;
export type RetainedGameSessionIntent = {
  readonly [retainedSessionIntent]: true;
  version: 2;
  inviteId: string;
  inviteSourceEpoch: number;
  transitionId: string;
  resources: RetainedSessionResources;
  mutations: RetainedAutomatchMutationBatch;
  inviteMutations: RetainedInviteMutationBatch;
  creations: StoredSessionMatchCreation[];
};

type SessionIntentEvidence = {
  version?: unknown;
  transitionId?: unknown;
  inviteId?: unknown;
  resources?: unknown;
  mutations?: unknown;
  creations?: unknown;
  inviteSourceEpoch?: unknown;
  inviteMutations?: unknown;
};

type InviteMutationEvidence = {
  current?: { inviteId?: unknown; revision?: unknown; value?: unknown };
  value?: unknown;
};

export class GameSessionTransitionFailure extends Error {
  constructor(code: string) {
    super(`game-session-transition-${code}`);
  }
}

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

export function resolveValue(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  if (Array.isArray(value))
    return value.map((entry, index) =>
      resolveValue(
        entry,
        Array.isArray(current) ? current[index] : null,
        nowMs,
      ),
    );
  if (!record(value)) {
    canonical(value);
    return value;
  }
  if (Object.hasOwn(value, STATE_VALUE_FIELD)) {
    if (Object.keys(value).length !== 1) return fail("invalid-server-value");
    const result = evaluateStateValueMarker(
      value[STATE_VALUE_FIELD],
      current,
      nowMs,
    );
    if (result.ok) return result.value;
    return fail("invalid-server-value");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveValue(child, record(current) ? current[key] : null, nowMs),
    ]),
  );
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
  const inviteId = [...inviteIds][0];
  if (!isSafeRecordKey(inviteId)) fail("invalid-invite");
  for (const field of Object.keys(inviteUpdates)) {
    if (
      [
        GAME_SESSION_TRANSITION_FIELD,
        "wagers",
        "matchesWagerResolutions",
        "reactions",
      ].includes(field.split("/")[0])
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
  const retained: unknown = creation;
  const evidence = retained as SessionCreationEvidence;
  const [root, playerId, matches, matchId, extra] = pathParts(evidence.path);
  if (root !== "players" || matches !== "matches" || !matchId || extra)
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
  return Promise.all(
    updates.map(async ({ path, value }) => {
      const creation: unknown = {
        path,
        value: resolveValue(value, null, createdAtMs),
        marker: await digest({ transitionId, path, digest: contentDigest }),
      };
      return creation as StoredSessionMatchCreation;
    }),
  );
}

export function readGameSessionIntent(row: {
  payload_json: string;
  transition_id: string;
  invite_id: string;
}): RetainedGameSessionIntent {
  const parsed: unknown = JSON.parse(row.payload_json);
  const payload = parsed as SessionIntentEvidence;
  if (
    payload.version !== 2 ||
    payload.transitionId !== row.transition_id ||
    payload.inviteId !== row.invite_id ||
    !Array.isArray(payload.resources) ||
    !Array.isArray(payload.mutations) ||
    !Array.isArray(payload.creations)
  )
    fail("invalid-intent");
  if (
    !Number.isSafeInteger(payload.inviteSourceEpoch) ||
    (payload.inviteSourceEpoch as number) < 1 ||
    !Array.isArray(payload.inviteMutations) ||
    payload.inviteMutations.length !== 1 ||
    payload.inviteMutations.some(
      ({ current, value }: InviteMutationEvidence) =>
        !current ||
        current.inviteId !== payload.inviteId ||
        !Number.isSafeInteger(current.revision) ||
        (current.revision as number) < 0 ||
        (current.value !== null && !record(current.value)) ||
        !record(value) ||
        isEventOwnedInviteSource(current.value) ||
        isEventOwnedInviteSource(value),
    )
  )
    fail("invalid-invite-source-intent");
  return parsed as RetainedGameSessionIntent;
}

export function serializeGameSessionIntent(
  payload: GameSessionIntentWrite,
): string {
  return canonical(payload);
}

declare const retainedSessionResourceKey: unique symbol;
type RetainedSessionResourceKey = {
  readonly [retainedSessionResourceKey]: true;
};

export function gameSessionIntentResources(
  intent: RetainedGameSessionIntent,
): RetainedSessionResourceKey[] {
  const evidence: unknown = intent.resources;
  return evidence as RetainedSessionResourceKey[];
}
