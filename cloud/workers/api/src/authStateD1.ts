import type { AuthMethodKey } from "@mons/shared/auth";
import {
  AuthStateFailure,
  decodeAuthIntentRow as decodeIntent,
  decodeXFlowRow as decodeFlow,
  parseAuthIntent,
  parseXRedirectFlow,
  type AuthIntentDocument,
  type AuthIntentRecord,
  type XRedirectFlowDocument,
  type XRedirectFlow,
  type XFlowUpdate,
} from "./authStateRecords.ts";
export { AuthStateFailure } from "./authStateRecords.ts";
export type {
  AuthIntentDocument,
  AuthIntentRecord,
  XRedirectFlowDocument,
  XRedirectFlow,
  XFlowUpdate,
  XFlowResult,
} from "./authStateRecords.ts";

export type AuthStateRepository = {
  consumeAuthIntent: (input: {
    consumedAtMs: number;
    consumedByOpId: string | null;
    intentId: string;
    method: AuthMethodKey;
    uid: string;
  }) => Promise<boolean>;
  createAuthIntent: (
    document: AuthIntentDocument,
  ) => Promise<"created" | "exists">;
  createXFlow: (
    document: XRedirectFlowDocument,
  ) => Promise<"created" | "exists">;
  getAuthIntent: (intentId: string) => Promise<AuthIntentRecord | null>;
  getXFlow: (flowId: string) => Promise<XRedirectFlow | null>;
  updateXFlow: (
    flowId: string,
    updates: XFlowUpdate,
    expectedRevision: number,
  ) => Promise<number>;
};

export type XFlowRepository = Pick<
  AuthStateRepository,
  "getXFlow" | "updateXFlow"
>;

const AUTH_STATE_NONTERMINAL_RETENTION_MS = 60 * 60 * 1_000;
const AUTH_STATE_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const AUTH_STATE_SWEEP_BATCH_SIZE = 1_000;

const FLOW_COLUMNS: Record<Exclude<keyof XFlowUpdate, "result">, string> = {
  completedAtMs: "completed_at_ms",
  errorCode: "error_code",
  processingStartedAtMs: "processing_started_at_ms",
  status: "status",
  updatedAtMs: "updated_at_ms",
  xUserId: "x_user_id",
  xUsername: "x_username",
};

export class AuthStateConflict extends AuthStateFailure {}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new AuthStateFailure();
  }
  return value;
}

function safeInteger(value: unknown, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new AuthStateFailure();
  }
  return value;
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stateFailure(error: unknown): never {
  if (error instanceof AuthStateFailure) throw error;
  throw new AuthStateFailure({ cause: error });
}

export function createAuthStateRepository(db: D1Database): AuthStateRepository {
  return {
    async consumeAuthIntent(input) {
      try {
        const result = await db
          .prepare(
            `UPDATE auth_intents_canonical
             SET consumed_at_ms = ?, consumed_by_op_id = ?
             WHERE intent_id = ? AND uid = ? AND method = ?
               AND consumed_at_ms IS NULL AND cancelled_at_ms IS NULL AND data_epoch = 1`,
          )
          .bind(
            input.consumedAtMs,
            input.consumedByOpId,
            input.intentId,
            input.uid,
            input.method,
          )
          .run();
        return result.meta.changes === 1;
      } catch (error) {
        stateFailure(error);
      }
    },

    async createAuthIntent(document) {
      try {
        parseAuthIntent({
          ...document,
          dataEpoch: 1,
          status: "created",
          consumedByOpId: null,
          cancelledAtMs: null,
        });
        const result = await db
          .prepare(
            `INSERT INTO auth_intents_canonical (
               intent_id, uid, method, nonce, state, created_at_ms,
               expires_at_ms, consumed_at_ms, consumed_by_op_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
             ON CONFLICT (intent_id) DO NOTHING`,
          )
          .bind(
            document.intentId,
            document.uid,
            document.method,
            document.nonce,
            document.state,
            document.createdAtMs,
            document.expiresAtMs,
          )
          .run();
        return result.meta.changes === 1 ? "created" : "exists";
      } catch (error) {
        stateFailure(error);
      }
    },

    async createXFlow(document) {
      try {
        parseXRedirectFlow({
          ...document,
          dataEpoch: 1,
          completedAtMs: null,
          processingStartedAtMs: null,
          result: null,
          revision: 1,
        });
        const result = await db
          .prepare(
            `INSERT INTO x_redirect_flows_canonical (
               flow_id, intent_id, uid, method, callback_uri, code_challenge,
               code_verifier, consent_source, return_url, status, error_code,
               x_user_id, x_username, result_profile_id, result_op_id,
               created_at_ms, expires_at_ms, updated_at_ms,
               processing_started_at_ms, completed_at_ms, revision
             ) VALUES (
               ?, ?, ?, 'x', ?, ?, ?, ?, ?, 'created', NULL,
               NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, 1
             )
             ON CONFLICT (flow_id) DO NOTHING`,
          )
          .bind(
            document.flowId,
            document.intentId,
            document.uid,
            document.callbackUri,
            document.codeChallenge,
            document.codeVerifier,
            document.consentSource,
            document.returnUrl,
            document.createdAtMs,
            document.expiresAtMs,
            document.updatedAtMs,
          )
          .run();
        return result.meta.changes === 1 ? "created" : "exists";
      } catch (error) {
        stateFailure(error);
      }
    },

    async getAuthIntent(intentId) {
      try {
        const row = await db
          .prepare(
            `SELECT data_epoch, cancelled_at_ms, intent_id, uid, method, nonce, state, created_at_ms,
                    expires_at_ms, consumed_at_ms, consumed_by_op_id
             FROM auth_intents_canonical
             WHERE intent_id = ?`,
          )
          .bind(intentId)
          .first<unknown>();
        return row ? decodeIntent(row) : null;
      } catch (error) {
        stateFailure(error);
      }
    },

    async getXFlow(flowId) {
      try {
        const row = await db
          .prepare(
            `SELECT data_epoch, flow_id, intent_id, uid, method, callback_uri,
                    code_challenge, code_verifier, consent_source, return_url,
                    status, error_code, x_user_id, x_username,
                    result_profile_id, result_op_id, created_at_ms,
                    expires_at_ms, updated_at_ms, processing_started_at_ms,
                    completed_at_ms, revision
             FROM x_redirect_flows_canonical
             WHERE flow_id = ?`,
          )
          .bind(flowId)
          .first<unknown>();
        return row ? decodeFlow(row) : null;
      } catch (error) {
        stateFailure(error);
      }
    },

    async updateXFlow(flowId, updates, expectedRevision) {
      try {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
          throw new AuthStateFailure();
        }
        const current = await createAuthStateRepository(db).getXFlow(flowId);
        if (!current || current.revision !== expectedRevision)
          throw new AuthStateConflict();
        if (current.status === "cancelled") throw new AuthStateFailure();
        parseXRedirectFlow({
          ...current,
          ...updates,
          revision: expectedRevision + 1,
        });
        const assignments: string[] = [];
        const values: unknown[] = [];
        for (const [name, value] of Object.entries(updates)) {
          if (name === "result") {
            assignments.push("result_profile_id = ?", "result_op_id = ?");
            if (value === null) {
              values.push(null, null);
              continue;
            }
            const result = record(value);
            if (
              !result ||
              Object.keys(result).length !== 2 ||
              !Object.hasOwn(result, "profileId") ||
              !Object.hasOwn(result, "opId")
            ) {
              throw new AuthStateFailure();
            }
            values.push(
              nonEmptyString(result.profileId),
              nonEmptyString(result.opId),
            );
            continue;
          }
          const column = FLOW_COLUMNS[name as keyof typeof FLOW_COLUMNS];
          if (!column) throw new AuthStateFailure();
          assignments.push(`${column} = ?`);
          if (name === "status") {
            values.push(nonEmptyString(value));
          } else if (name === "updatedAtMs") {
            values.push(safeInteger(value));
          } else if (
            name === "completedAtMs" ||
            name === "processingStartedAtMs"
          ) {
            values.push(nullableInteger(value));
          } else {
            values.push(
              value === null || value === "" ? null : nonEmptyString(value),
            );
          }
        }
        if (assignments.length === 0) throw new AuthStateFailure();
        assignments.push("revision = revision + 1");
        const result = await db
          .prepare(
            `UPDATE x_redirect_flows_canonical
             SET ${assignments.join(", ")}
             WHERE flow_id = ? AND revision = ?`,
          )
          .bind(...values, flowId, expectedRevision)
          .run();
        if (result.meta.changes !== 1) throw new AuthStateConflict();
        return expectedRevision + 1;
      } catch (error) {
        stateFailure(error);
      }
    },
  };
}

export async function sweepExpiredAuthState(
  db: D1Database,
  nowMs: number,
): Promise<{
  flowsCompacted: number;
  flowsDeleted: number;
  intentsCompacted: number;
  intentsDeleted: number;
  terminalFlowsDeleted: number;
}> {
  const cutoffMs = nowMs - AUTH_STATE_NONTERMINAL_RETENTION_MS;
  const terminalCutoffMs = Math.max(
    1,
    nowMs - AUTH_STATE_TERMINAL_RETENTION_MS,
  );
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs <= 0) {
    throw new AuthStateFailure();
  }
  try {
    const [
      deletedFlows,
      deletedTerminalFlows,
      deletedIntents,
      compactedFlows,
      compactedIntents,
    ] = await db.batch([
      db
        .prepare(
          `DELETE FROM x_redirect_flows_canonical
           WHERE flow_id IN (
             SELECT flow_id FROM x_redirect_flows_canonical
             WHERE expires_at_ms < ?
               AND status IN ('created', 'processing')
             ORDER BY expires_at_ms, flow_id
             LIMIT ?
           )`,
        )
        .bind(cutoffMs, AUTH_STATE_SWEEP_BATCH_SIZE),
      db
        .prepare(
          `DELETE FROM x_redirect_flows_canonical
           WHERE flow_id IN (
             SELECT flow_id FROM x_redirect_flows_canonical
             WHERE updated_at_ms < ?
               AND status IN ('verified', 'completed', 'failed', 'cancelled')
             ORDER BY updated_at_ms, flow_id
             LIMIT ?
           )`,
        )
        .bind(terminalCutoffMs, AUTH_STATE_SWEEP_BATCH_SIZE),
      db
        .prepare(
          `DELETE FROM auth_intents_canonical
           WHERE intent_id IN (
             SELECT intent_id FROM auth_intents_canonical
             WHERE expires_at_ms < ?
               AND NOT EXISTS (
                 SELECT 1 FROM x_redirect_flows_canonical
                 WHERE x_redirect_flows_canonical.intent_id = auth_intents_canonical.intent_id
               )
             ORDER BY expires_at_ms, intent_id
             LIMIT ?
           )`,
        )
        .bind(cutoffMs, AUTH_STATE_SWEEP_BATCH_SIZE),
      db
        .prepare(
          `UPDATE x_redirect_flows_canonical
           SET code_challenge = 'retired', code_verifier = 'retired'
           WHERE flow_id IN (
             SELECT flow_id FROM x_redirect_flows_canonical
             WHERE expires_at_ms < ?
               AND status IN ('verified', 'completed', 'failed', 'cancelled')
               AND (code_challenge <> 'retired' OR code_verifier <> 'retired')
             ORDER BY expires_at_ms, flow_id
             LIMIT ?
           )`,
        )
        .bind(cutoffMs, AUTH_STATE_SWEEP_BATCH_SIZE),
      db
        .prepare(
          `UPDATE auth_intents_canonical
           SET nonce = 'retired', state = 'retired'
           WHERE intent_id IN (
             SELECT intent_id FROM auth_intents_canonical
             WHERE expires_at_ms < ?
               AND (nonce <> 'retired' OR state <> 'retired')
               AND EXISTS (
                 SELECT 1 FROM x_redirect_flows_canonical
                 WHERE x_redirect_flows_canonical.intent_id = auth_intents_canonical.intent_id
                   AND x_redirect_flows_canonical.status IN ('verified', 'completed', 'failed', 'cancelled')
               )
             ORDER BY expires_at_ms, intent_id
             LIMIT ?
           )`,
        )
        .bind(cutoffMs, AUTH_STATE_SWEEP_BATCH_SIZE),
    ]);
    const result = {
      flowsCompacted: compactedFlows!.meta.changes,
      flowsDeleted: deletedFlows!.meta.changes,
      intentsCompacted: compactedIntents!.meta.changes,
      intentsDeleted: deletedIntents!.meta.changes,
      terminalFlowsDeleted: deletedTerminalFlows!.meta.changes,
    };
    if (Object.values(result).some((count) => count > 0)) {
      console.info(JSON.stringify({ event: "auth_state_sweep", ...result }));
    }
    return result;
  } catch (error) {
    stateFailure(error);
  }
}

export {
  AUTH_STATE_NONTERMINAL_RETENTION_MS,
  AUTH_STATE_TERMINAL_RETENTION_MS,
  decodeFlow,
  decodeIntent,
};
