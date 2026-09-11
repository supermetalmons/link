import type { D1Migration } from "cloudflare:test";
import type { StateRepository } from "../src/stateRepositoryTypes.ts";
import { createInviteSourceD1Store } from "../src/inviteSourceD1.ts";
import {
  createEventStateRepository,
  recoverEventTransitionIntents,
} from "../src/eventRepository.ts";

export async function resetEventReceiptTestState(
  db: D1Database,
  migrations: D1Migration[],
  activate = true,
): Promise<void> {
  const migration = migrations.find((entry) =>
    entry.name.includes("0019_event_transition_receipts"),
  );
  if (!migration) throw new Error("missing-event-receipt-test-migration");
  await db.batch([
    db.prepare("DROP TRIGGER event_transition_receipt_admission_insert_gate"),
    db.prepare("DROP TRIGGER event_transition_receipt_admission_update_gate"),
    db.prepare("DROP TABLE IF EXISTS event_transition_receipts"),
    db.prepare("DROP TABLE event_transition_receipt_control"),
    db.prepare("DROP TABLE event_transition_receipt_guards"),
    ...migration.queries.map((query) => db.prepare(query)),
  ]);
  if (activate) {
    const digest = "a".repeat(64);
    await db
      .prepare(
        `UPDATE event_transition_receipt_control
         SET state = 'active', source_count = 0, source_digest = ?,
             import_count = 0, import_digest = ?,
             candidate_version_id = '11111111-1111-4111-8111-111111111111',
             verified_event_freeze_generation = 1, source_exported_at_ms = 1,
             imported_at_ms = 2, verified_at_ms = 3, activated_at_ms = 4
         WHERE singleton = 1`,
      )
      .bind(digest, digest)
      .run();
  }
}

export function eventTransitionFixture(
  env: Env,
  initial: Record<string, unknown> = {},
) {
  const values = new Map(Object.entries(initial));
  const patches: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const writes: string[] = [];
  const hooks: {
    beforeTransaction?: (path: string) => Promise<void>;
    afterTransaction?: (path: string) => Promise<void>;
    beforePatch?: (updates: Record<string, unknown>) => Promise<void>;
    afterPatch?: (updates: Record<string, unknown>) => Promise<void>;
  } = {};
  const assertPath = (path: string) => {
    if (/^(?:invites|eventTransitionReceipts)(?:\/|$)/.test(path)) {
      throw new Error("retired-source-event-path");
    }
  };
  const raw: StateRepository = {
    async getPath(path) {
      assertPath(path);
      reads.push(path);
      return structuredClone(values.get(path) ?? null);
    },
    async patchRoot(updates) {
      Object.keys(updates).forEach(assertPath);
      patches.push(structuredClone(updates));
      await hooks.beforePatch?.(updates);
      for (const [path, value] of Object.entries(updates)) {
        writes.push(path);
        if (value === null) values.delete(path);
        else values.set(path, structuredClone(value));
      }
      await hooks.afterPatch?.(updates);
    },
    async transactPath(path, updater, signal, beforeWrite) {
      assertPath(path);
      signal?.throwIfAborted();
      await hooks.beforeTransaction?.(path);
      const current = structuredClone(values.get(path) ?? null);
      const proposed = updater(current);
      if (
        !proposed ||
        typeof proposed !== "object" ||
        Array.isArray(proposed)
      ) {
        throw new Error("invalid-test-transaction-result");
      }
      const result = proposed as Record<string, unknown>;
      if (result.commit === false) {
        return {
          committed: false,
          value: current,
          decision:
            typeof result.decision === "string" ? result.decision : undefined,
        };
      }
      await beforeWrite?.({ current, proposed: result.value, etag: "fixture" });
      writes.push(path);
      values.set(path, structuredClone(result.value));
      await hooks.afterTransaction?.(path);
      return {
        committed: true,
        value: result.value,
        decision:
          typeof result.decision === "string" ? result.decision : undefined,
      };
    },
  };
  const source = createInviteSourceD1Store(env.PROFILE_GAMES_DB);
  const base: StateRepository = {
    getPath: (path, query, signal) =>
      path.startsWith("invites/")
        ? source.getPath(path, query, signal)
        : raw.getPath(path, query, signal),
    patchRoot: raw.patchRoot,
    transactPath: raw.transactPath,
  };
  return {
    values,
    patches,
    reads,
    writes,
    hooks,
    raw,
    source,
    client: createEventStateRepository(env, base, raw),
    recover: () => recoverEventTransitionIntents(env, 100, raw),
  };
}
