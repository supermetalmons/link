import {
  evaluateStateValueMarker,
  STATE_VALUE_FIELD,
} from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
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
export type StoredSessionMatchCreation = {
  path: string;
  value: JsonRecord;
  marker: string;
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
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!record(value)) return fail("invalid-json");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
  matchUpdates: { path: string; value: JsonRecord }[];
  operationResources: string[];
} {
  const inviteIds = new Set<string>();
  const inviteUpdates: JsonRecord = {};
  const matchUpdates: { path: string; value: JsonRecord }[] = [];
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
  const [root, playerId, matches, matchId, extra] = pathParts(creation.path);
  if (root !== "players" || matches !== "matches" || !matchId || extra)
    fail("invalid-match-discovery-path");
  return {
    playerId,
    matchId,
    value: creation.value as MatchStateCreation["value"],
    marker: creation.marker,
  };
}

export async function encodeSessionMatchCreations(
  updates: readonly { path: string; value: JsonRecord }[],
  transitionId: string,
  contentDigest: string,
  createdAtMs: number,
): Promise<StoredSessionMatchCreation[]> {
  return Promise.all(
    updates.map(async ({ path, value }) => ({
      path,
      value: resolveValue(value, null, createdAtMs) as JsonRecord,
      marker: await digest({ transitionId, path, digest: contentDigest }),
    })),
  );
}
