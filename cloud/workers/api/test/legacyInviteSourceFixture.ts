import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import {
  createInviteSourceD1Store,
  normalizeInviteSource,
} from "../src/inviteSourceD1.ts";
import { isSafeRecordKey } from "../src/recordKeys.ts";
import type { StateQuery } from "../test/stateRepositoryTestTypes.ts";
import type { InviteSourceMutation } from "../src/inviteSourceD1.ts";
const STATE_VALUE_FIELD = ".sv";
const RETIRED_FIELDS = new Set([
  "reactions",
  "wagers",
  "matchesWagerResolutions",
]);
export function inviteSourcePath(path: string): {
  inviteId: string;
  nested: string[];
} | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "invites") return null;
  if (!parts[1]) throw new TypeError("invite-source-root-scan-unsupported");
  parts.slice(1).forEach(requireId);
  return { inviteId: parts[1], nested: parts.slice(2) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireId(value: string): void {
  if (!isSafeRecordKey(value)) throw new TypeError("invalid-invite-source-key");
}

function getNested(value: unknown, parts: readonly string[]): unknown {
  let current = value;
  for (const key of parts) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      return null;
    current = Reflect.get(current, key);
  }
  return current ?? null;
}

function setNested(
  target: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  let current = target;
  for (const key of parts.slice(0, -1)) {
    const existing = Object.hasOwn(current, key) ? current[key] : null;
    const nested = record(existing) ? { ...existing } : {};
    Object.defineProperty(current, key, {
      value: nested,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    current = nested;
  }
  const key = parts.at(-1)!;
  if (value === null) delete current[key];
  else
    Object.defineProperty(current, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
}

function resolveValue(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  if (Array.isArray(value))
    return value.map((child, index) =>
      resolveValue(
        child,
        Array.isArray(current) ? current[index] : null,
        nowMs,
      ),
    );
  if (!record(value)) return value;
  if (Object.hasOwn(value, STATE_VALUE_FIELD)) {
    if (Object.keys(value).length !== 1)
      throw new TypeError("invalid-invite-source-server-value");
    const marker = value[STATE_VALUE_FIELD];
    if (marker === "timestamp") return nowMs;
    if (
      record(marker) &&
      Object.keys(marker).length === 1 &&
      typeof marker.increment === "number" &&
      Number.isFinite(marker.increment)
    ) {
      const result =
        (typeof current === "number" && Number.isFinite(current)
          ? current
          : 0) + marker.increment;
      if (Number.isFinite(result)) return result;
    }
    throw new TypeError("invalid-invite-source-server-value");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveValue(
        child,
        record(current) && Object.hasOwn(current, key) ? current[key] : null,
        nowMs,
      ),
    ]),
  );
}

export function createLegacyInviteSourceD1Store(
  db: D1Database,
  options: NonNullable<Parameters<typeof createInviteSourceD1Store>[1]> = {},
) {
  const store = createInviteSourceD1Store(db, options);
  const read = store.read;
  const now = options.now || Date.now;
  return {
    ...store,
    async getPath(
      path: string,
      query?: StateQuery,
      signal?: AbortSignal,
    ): Promise<unknown> {
      const owned = inviteSourcePath(path);
      if (!owned) throw new TypeError("invalid-invite-source-path");
      if (query && Object.keys(query).some((key) => key !== "shallow"))
        throw new TypeError("invite-source-query-unsupported");
      if (query?.shallow !== undefined && typeof query.shallow !== "boolean")
        throw new TypeError("invite-source-query-unsupported");
      const snapshot = await read(owned.inviteId, signal);
      const value = getNested(snapshot.value, owned.nested);
      return query?.shallow && value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).map((key) => [key, true]))
        : value;
    },
    async preparePatch(
      updates: Record<string, unknown>,
      nowMs = now(),
      signal?: AbortSignal,
    ): Promise<InviteSourceMutation[]> {
      if (!integer(nowMs))
        throw new TypeError("invalid-invite-source-timestamp");
      const paths = Object.keys(updates);
      if (
        paths.some((path) =>
          paths.some((other) => path !== other && path.startsWith(`${other}/`)),
        )
      )
        throw new TypeError("overlapping-invite-source-updates");
      const grouped = new Map<string, { nested: string[]; value: unknown }[]>();
      for (const [path, value] of Object.entries(updates)) {
        const owned = inviteSourcePath(path);
        if (!owned) throw new TypeError("invalid-invite-source-path");
        const fields = owned.nested.length
          ? [owned.nested[0]!]
          : record(value)
            ? Object.keys(value)
            : [];
        if (
          fields.some(
            (field) =>
              RETIRED_FIELDS.has(field) || field === "sessionTransition",
          )
        )
          throw new TypeError("reserved-invite-source-field");
        if (!owned.nested.length && !record(value))
          throw new TypeError("invite-source-deletion-unsupported");
        const entries = grouped.get(owned.inviteId) || [];
        entries.push({ nested: owned.nested, value });
        grouped.set(owned.inviteId, entries);
      }
      const mutations: InviteSourceMutation[] = [];
      for (const [inviteId, entries] of grouped) {
        const current = await read(inviteId, signal);
        const next = structuredClone(current.value || {});
        for (const entry of entries) {
          if (!entry.nested.length && record(entry.value)) {
            for (const [key, value] of Object.entries(entry.value)) {
              requireId(key);
              setNested(
                next,
                [key],
                resolveValue(value, getNested(next, [key]), nowMs),
              );
            }
          } else {
            setNested(
              next,
              entry.nested,
              resolveValue(entry.value, getNested(next, entry.nested), nowMs),
            );
          }
        }
        mutations.push({
          current,
          value: normalizeInviteSource(inviteDocumentFixture(next)),
        });
      }
      return mutations;
    },
  };
}
