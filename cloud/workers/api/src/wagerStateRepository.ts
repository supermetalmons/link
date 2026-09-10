import type {
  FirebaseRtdbClient,
  FirebaseRtdbQuery,
  FirebaseRtdbTransactionResult,
} from "./firebaseRtdb.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { composeInviteWagerSource } from "./inviteWagerSource.ts";
import { validateTelegramTransactionDecision } from "./telegramTransaction.ts";
import {
  createWagerStateD1Store,
  WagerStateD1Failure,
  type WagerStateD1Options,
  type WagerStateSnapshot,
  type WagerStateValue,
} from "./wagerStateD1.ts";

const MAX_TRANSACTION_ATTEMPTS = 25;
const OWNED_FIELDS = new Set(["wagers", "matchesWagerResolutions"]);

export type WagerStateRepositoryOptions = WagerStateD1Options & {
  notify?: (
    updates: Record<string, unknown>,
    committed: boolean,
  ) => Promise<void>;
};

type OwnedPath = {
  inviteId: string;
  field: "wagers" | "matchesWagerResolutions";
  matchId?: string;
  nested: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathParts(path: string): string[] {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.some((part) => !isSafeFirebaseKey(part))) {
    throw new TypeError("invalid-wager-state-path");
  }
  return parts;
}

function ownedPath(parts: readonly string[]): OwnedPath | null {
  if (parts[0] !== "invites" || !OWNED_FIELDS.has(parts[2])) return null;
  return {
    inviteId: parts[1],
    field: parts[2] as OwnedPath["field"],
    matchId: parts[3],
    nested: parts.slice(4),
  };
}

function shallowQuery(query?: FirebaseRtdbQuery): boolean {
  if (!query) return false;
  if (Object.keys(query).some((key) => key !== "shallow")) {
    throw new TypeError("wager-state-query-unsupported");
  }
  return query.shallow === true;
}

function shallowValue(value: unknown): unknown {
  return value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).map((key) => [key, true]))
    : value;
}

function getNested(root: unknown, parts: readonly string[]): unknown {
  let current = root;
  for (const part of parts) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    ) {
      return null;
    }
    current = Reflect.get(current, part);
  }
  return structuredClone(current);
}

function normalizeJson(value: unknown): unknown {
  const active = new Set<object>();
  const normalize = (entry: unknown, depth: number): unknown => {
    if (depth > 64) throw new TypeError("invalid-wager-state-json");
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    )
      return entry;
    if (!entry || typeof entry !== "object" || active.has(entry)) {
      throw new TypeError("invalid-wager-state-json");
    }
    const prototype = Object.getPrototypeOf(entry);
    if (
      !Array.isArray(entry) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError("invalid-wager-state-json");
    }
    active.add(entry);
    let result: unknown;
    if (Array.isArray(entry)) {
      const values = entry.map((nested) => normalize(nested, depth + 1));
      result = values.some((nested) => nested !== null) ? values : null;
    } else {
      const values = Object.entries(entry)
        .map(([key, nested]) => {
          if (!isSafeFirebaseKey(key))
            throw new TypeError("invalid-wager-state-json");
          return [key, normalize(nested, depth + 1)] as const;
        })
        .filter(([, nested]) => nested !== null);
      result = values.length ? Object.fromEntries(values) : null;
    }
    active.delete(entry);
    return result;
  };
  return normalize(value, 0);
}

function setNested(
  root: unknown,
  parts: readonly string[],
  value: unknown,
): unknown {
  if (!parts.length) return value;
  const source =
    root !== null && typeof root === "object"
      ? Object.fromEntries(Object.entries(root))
      : {};
  const [key, ...nested] = parts;
  const next = setNested(
    Object.hasOwn(source, key) ? source[key] : null,
    nested,
    value,
  );
  if (next === null) delete source[key];
  else
    Object.defineProperty(source, key, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  if (!Object.keys(source).length) return null;
  if (
    Array.isArray(root) &&
    Object.keys(source).every((part) => /^(0|[1-9]\d*)$/.test(part))
  ) {
    const highest = Math.max(...Object.keys(source).map(Number));
    if (
      Number.isSafeInteger(highest) &&
      highest < Object.keys(source).length * 2
    ) {
      return Array.from(
        { length: highest + 1 },
        (_, index) => source[String(index)] ?? null,
      );
    }
  }
  return source;
}

function readOwned(state: WagerStateValue, path: OwnedPath): unknown {
  return getNested(
    path.field === "wagers" ? state.wager : state.resolutionMarker,
    path.nested,
  );
}

function writeOwned(
  state: WagerStateValue,
  path: OwnedPath,
  value: unknown,
): WagerStateValue {
  if (path.field === "matchesWagerResolutions") {
    if (path.nested.length || (value !== null && typeof value !== "boolean")) {
      throw new TypeError("invalid-wager-resolution-marker");
    }
    return { ...state, resolutionMarker: value };
  }
  return {
    ...state,
    wager: setNested(state.wager, path.nested, normalizeJson(value)),
  };
}

function requireWritablePath(
  path: OwnedPath,
): asserts path is OwnedPath & { matchId: string } {
  if (
    !path.matchId ||
    (path.field === "matchesWagerResolutions" && path.nested.length)
  ) {
    throw new TypeError("wager-state-path-unsupported");
  }
}

function validateMetadataWrite(
  parts: readonly string[],
  value?: unknown,
): void {
  if (parts[0] !== "invites") return;
  if (parts.length === 1 || (parts.length === 2 && !record(value))) {
    throw new TypeError("wager-state-ancestor-write-unsupported");
  }
  if (
    parts.length === 2 &&
    record(value) &&
    [...OWNED_FIELDS].some((field) => Object.hasOwn(value, field))
  ) {
    throw new TypeError("wager-state-embedded-write-unsupported");
  }
}

function rejectOverlaps(paths: readonly string[]): void {
  const supplied = new Set(paths);
  if (supplied.size !== paths.length)
    throw new TypeError("overlapping-wager-state-updates");
  for (const path of paths) {
    for (
      let separator = path.indexOf("/");
      separator !== -1;
      separator = path.indexOf("/", separator + 1)
    ) {
      if (supplied.has(path.slice(0, separator)))
        throw new TypeError("overlapping-wager-state-updates");
    }
  }
}

export function createWagerStateRtdbClient(
  db: D1Database,
  base: FirebaseRtdbClient,
  options: WagerStateRepositoryOptions = {},
): FirebaseRtdbClient {
  const store = createWagerStateD1Store(db, options);
  const requireWritable = () => {
    if (!options.writeGuards)
      throw new WagerStateD1Failure("wager-state-read-only");
  };
  const notify = async (
    updates: Record<string, unknown>,
    committed: boolean,
  ) => {
    try {
      await options.notify?.(updates, committed);
    } catch {}
  };

  return {
    async getPath(path, query, signal) {
      const parts = pathParts(path);
      const owned = ownedPath(parts);
      if (parts[0] === "invites" && parts.length === 1) {
        throw new TypeError("wager-state-path-unsupported");
      }
      if (!owned && !(parts[0] === "invites" && parts.length === 2)) {
        return base.getPath(path, query, signal);
      }
      const shallow = shallowQuery(query);
      if (owned?.matchId) {
        const value = readOwned(
          await store.read(
            { inviteId: owned.inviteId, matchId: owned.matchId },
            signal,
          ),
          owned,
        );
        return shallow ? shallowValue(value) : value;
      }
      const inviteId = owned?.inviteId || parts[1];
      const states = await store.readInvite(inviteId, signal, shallow);
      if (!owned) {
        const source = await base.getPath(path, query, signal);
        return composeInviteWagerSource(source, states, shallow);
      }
      const field = owned.field === "wagers" ? "wager" : "resolutionMarker";
      const values = Object.fromEntries(
        states
          .filter((state) => state[field] !== null)
          .map((state) => [state.matchId, state[field]]),
      );
      const value = Object.keys(values).length ? values : null;
      return shallow ? shallowValue(value) : value;
    },

    async patchRoot(updates, signal) {
      const entries = Object.entries(updates).map(([path, value]) => {
        const parts = pathParts(path);
        return { path: parts.join("/"), parts, owned: ownedPath(parts), value };
      });
      rejectOverlaps(entries.map((entry) => entry.path));
      for (const entry of entries) {
        if (entry.owned) requireWritablePath(entry.owned);
        else validateMetadataWrite(entry.parts, entry.value);
      }
      if (!entries.some((entry) => entry.owned))
        return base.patchRoot(updates, signal);
      if (entries.some((entry) => !entry.owned))
        throw new TypeError("mixed-wager-state-updates");
      requireWritable();
      const groups = new Map<string, typeof entries>();
      for (const entry of entries) {
        const key = `${entry.owned!.inviteId}/${entry.owned!.matchId}`;
        const group = groups.get(key) || [];
        group.push(entry);
        groups.set(key, group);
      }
      for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
        signal?.throwIfAborted();
        const mutations = await Promise.all(
          [...groups.values()].map(async (group) => {
            const path = group[0].owned!;
            const current = await store.read(
              { inviteId: path.inviteId, matchId: path.matchId! },
              signal,
            );
            let value: WagerStateValue = {
              wager: current.wager,
              resolutionMarker: current.resolutionMarker,
            };
            for (const entry of group)
              value = writeOwned(value, entry.owned!, entry.value);
            return { current, value };
          }),
        );
        let committed: boolean;
        try {
          committed = await store.commit(mutations, signal);
        } catch (error) {
          await notify(updates, false);
          throw error;
        }
        if (committed) {
          await notify(updates, true);
          return;
        }
      }
      throw new WagerStateD1Failure("wager-state-conflict");
    },

    async transactPath(
      path,
      updater,
      signal,
    ): Promise<FirebaseRtdbTransactionResult> {
      const parts = pathParts(path);
      const owned = ownedPath(parts);
      if (!owned) {
        if (parts[0] === "invites" && parts.length <= 2) {
          throw new TypeError("wager-state-ancestor-write-unsupported");
        }
        return base.transactPath(path, updater, signal);
      }
      requireWritablePath(owned);
      requireWritable();
      for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
        const current: WagerStateSnapshot = await store.read(
          { inviteId: owned.inviteId, matchId: owned.matchId },
          signal,
        );
        const value = readOwned(current, owned);
        const decision = validateTelegramTransactionDecision(updater(value));
        if (!decision.commit)
          return { committed: false, decision: decision.decision, value };
        const next = writeOwned(current, owned, decision.value);
        let committed: boolean;
        try {
          committed = await store.commit([{ current, value: next }], signal);
        } catch (error) {
          await notify({ [path]: decision.value }, false);
          throw error;
        }
        if (committed) {
          await notify({ [path]: decision.value }, true);
          return {
            committed: true,
            decision: decision.decision,
            value: readOwned(next, owned),
          };
        }
      }
      throw new WagerStateD1Failure("wager-state-conflict");
    },
  };
}
