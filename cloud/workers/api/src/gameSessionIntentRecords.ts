import {
  isGameSessionMatch,
  type GameSessionMatch,
} from "@mons/shared/game-sessions";
import {
  readInviteDocument,
  type InviteDocument,
} from "@mons/shared/invite-records";
import {
  parseAutomatchRecord,
  type AutomatchRecordMap,
  type AutomatchRecordRoot,
} from "../../../runtime/automatchRecords.js";
import { isSafeRecordKey } from "./recordKeys.ts";
import { canonicalJson } from "./canonicalJson.ts";

type JsonRecord = Record<string, unknown>;
type IntentAutomatchMutation = {
  [Root in AutomatchRecordRoot]: {
    current: {
      root: Root;
      key: string;
      revision: number;
      value: AutomatchRecordMap[Root] | null;
    };
    value: AutomatchRecordMap[Root] | null;
  };
}[AutomatchRecordRoot];
type IntentInviteMutation = {
  current: { inviteId: string; revision: number; value: InviteDocument | null };
  value: InviteDocument;
};
export type StoredSessionMatchCreation = {
  path: string;
  value: GameSessionMatch;
  marker: string;
};
export type GameSessionIntentWrite = {
  version: 3;
  inviteId: string;
  inviteSourceEpoch: number;
  inviteMutations: readonly IntentInviteMutation[];
  transitionId: string;
  operationDigest: string;
  resources: string[];
  mutations: readonly IntentAutomatchMutation[];
  creations: StoredSessionMatchCreation[];
  createdAtMs: number;
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
function pathParts(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !isSafeRecordKey(part) || part.trim() !== part))
    fail("invalid-path");
  return parts;
}
function canonical(value: unknown): string {
  return canonicalJson(value, () => fail("invalid-json"));
}
const intentRoots: readonly AutomatchRecordRoot[] = [
  "automatch",
  "telegramAutomatches",
  "telegramProjectionOutbox/automatch",
  "profileGameProjectionOutbox/automatch",
  "gameplayMutationReceipts",
  "gameplayMutationReceiptExpirations",
];
function exact(value: unknown, keys: readonly string[]): value is JsonRecord {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function safeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    isSafeRecordKey(value)
  );
}
function integer(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}
function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function parseGameSessionIntent(value: unknown): GameSessionIntentWrite {
  if (
    !exact(value, [
      "version",
      "inviteId",
      "inviteSourceEpoch",
      "inviteMutations",
      "transitionId",
      "operationDigest",
      "resources",
      "mutations",
      "creations",
      "createdAtMs",
    ]) ||
    value.version !== 3 ||
    !safeKey(value.inviteId) ||
    !safeKey(value.transitionId) ||
    !integer(value.inviteSourceEpoch, 1) ||
    !sha(value.operationDigest) ||
    !integer(value.createdAtMs) ||
    !Array.isArray(value.resources) ||
    value.resources.length === 0 ||
    !value.resources.every(safeKey) ||
    new Set(value.resources).size !== value.resources.length ||
    !value.resources.includes(value.inviteId) ||
    !Array.isArray(value.mutations) ||
    !Array.isArray(value.creations) ||
    !Array.isArray(value.inviteMutations) ||
    value.inviteMutations.length !== 1
  )
    fail("invalid-intent");
  const mutations: IntentAutomatchMutation[] = value.mutations.map(
    (entry: unknown) => {
      if (
        !exact(entry, ["current", "value"]) ||
        !exact(entry.current, ["root", "key", "value", "revision"]) ||
        !intentRoots.includes(entry.current.root as AutomatchRecordRoot) ||
        !safeKey(entry.current.key) ||
        !integer(entry.current.revision)
      )
        fail("invalid-intent-mutation");
      const root = entry.current.root as AutomatchRecordRoot;
      return {
        current: {
          root,
          key: entry.current.key,
          revision: entry.current.revision,
          value: parseAutomatchRecord(root, entry.current.value),
        },
        value: parseAutomatchRecord(root, entry.value),
      } as IntentAutomatchMutation;
    },
  );
  if (
    new Set(mutations.map(({ current }) => `${current.root}/${current.key}`))
      .size !== mutations.length
  )
    fail("duplicate-intent-mutation");
  const inviteMutations: IntentInviteMutation[] = value.inviteMutations.map(
    (entry: unknown) => {
      if (
        !exact(entry, ["current", "value"]) ||
        !exact(entry.current, ["inviteId", "value", "revision"]) ||
        entry.current.inviteId !== value.inviteId ||
        !integer(entry.current.revision)
      )
        fail("invalid-invite-source-intent");
      const current =
        entry.current.value === null
          ? null
          : readInviteDocument(entry.current.value);
      const next = readInviteDocument(entry.value);
      if (
        (entry.current.value !== null && current === null) ||
        next === null ||
        current?.eventOwned === true ||
        next.eventOwned === true
      )
        fail("invalid-invite-source-intent");
      return {
        current: {
          inviteId: value.inviteId as string,
          value: current,
          revision: entry.current.revision,
        },
        value: next,
      };
    },
  );
  const paths = new Set<string>();
  const creations: StoredSessionMatchCreation[] = value.creations.map(
    (entry: unknown) => {
      if (
        !exact(entry, ["path", "value", "marker"]) ||
        typeof entry.path !== "string" ||
        !sha(entry.marker) ||
        !isGameSessionMatch(entry.value)
      )
        fail("invalid-match-creation");
      const [root, playerId, matches, matchId, extra] = pathParts(entry.path);
      if (
        root !== "players" ||
        !playerId ||
        matches !== "matches" ||
        !matchId ||
        extra ||
        paths.has(entry.path) ||
        (matchId !== value.inviteId &&
          !(
            matchId.startsWith(value.inviteId as string) &&
            /^[1-9]\d*$/.test(matchId.slice((value.inviteId as string).length))
          ))
      )
        fail("invalid-match-creation");
      paths.add(entry.path);
      return { path: entry.path, value: entry.value, marker: entry.marker };
    },
  );
  return {
    version: 3,
    inviteId: value.inviteId,
    inviteSourceEpoch: value.inviteSourceEpoch,
    inviteMutations,
    transitionId: value.transitionId,
    operationDigest: value.operationDigest,
    resources: value.resources,
    mutations,
    creations,
    createdAtMs: value.createdAtMs,
  };
}
export function readGameSessionIntent(row: {
  payload_json: string;
  transition_id: string;
  invite_id: string;
}): GameSessionIntentWrite {
  const intent = parseGameSessionIntent(JSON.parse(row.payload_json));
  if (
    intent.transitionId !== row.transition_id ||
    intent.inviteId !== row.invite_id
  )
    fail("invalid-intent-identity");
  return intent;
}
export function serializeGameSessionIntent(
  payload: GameSessionIntentWrite,
): string {
  return canonical(parseGameSessionIntent(payload));
}
export function gameSessionIntentResources(
  intent: GameSessionIntentWrite,
): readonly string[] {
  return intent.resources;
}
