import type { AuthMethodKey, AuthProfileResponse } from "@mons/shared/auth";

export type AuthIntentDocument = {
  consumedAtMs: null;
  createdAtMs: number;
  expiresAtMs: number;
  intentId: string;
  method: AuthMethodKey;
  nonce: string;
  state: string;
  uid: string;
};

export type AuthIntentRecord = Omit<AuthIntentDocument, "consumedAtMs"> & {
  consumedAtMs: number;
  consumedByOpId: string;
};

export type XRedirectFlowDocument = {
  callbackUri: string;
  codeChallenge: string;
  codeVerifier: string;
  consentSource: string;
  createdAtMs: number;
  errorCode: null;
  expiresAtMs: number;
  flowId: string;
  intentId: string;
  method: "x";
  returnUrl: string;
  status: "created";
  uid: string;
  updatedAtMs: number;
  xUserId: null;
  xUsername: null;
};

type XFlowStatus =
  "completed" | "created" | "failed" | "processing" | "verified";

export type XFlowResult = Pick<AuthProfileResponse, "opId" | "profileId">;

export type XRedirectFlow = {
  callbackUri: string;
  codeChallenge: string;
  codeVerifier: string;
  completedAtMs: number;
  consentSource: string;
  createdAtMs: number;
  errorCode: string;
  expiresAtMs: number;
  flowId: string;
  intentId: string;
  method: "x";
  processingStartedAtMs: number;
  result: XFlowResult | null;
  returnUrl: string;
  revision: number;
  status: XFlowStatus;
  uid: string;
  updatedAtMs: number;
  xUserId: string;
  xUsername: string;
};

export type XFlowUpdate = Partial<
  Pick<XRedirectFlow, "result" | "status" | "updatedAtMs">
> & {
  completedAtMs?: number | null;
  errorCode?: string | null;
  processingStartedAtMs?: number | null;
  xUserId?: string | null;
  xUsername?: string | null;
};

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

type AuthIntentRow = {
  consumed_at_ms: number | null;
  consumed_by_op_id: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  intent_id: string;
  method: string;
  nonce: string;
  state: string;
  uid: string;
};

type XFlowRow = {
  callback_uri: string;
  code_challenge: string;
  code_verifier: string;
  completed_at_ms: number | null;
  consent_source: string;
  created_at_ms: number;
  error_code: string | null;
  expires_at_ms: number;
  flow_id: string;
  intent_id: string;
  method: string;
  processing_started_at_ms: number | null;
  result_op_id: string | null;
  result_profile_id: string | null;
  return_url: string;
  revision: number;
  status: string;
  uid: string;
  updated_at_ms: number;
  x_user_id: string | null;
  x_username: string | null;
};

const AUTH_METHODS = new Set<AuthMethodKey>(["apple", "eth", "sol", "x"]);
const X_FLOW_STATUSES = new Set<XFlowStatus>([
  "completed",
  "created",
  "failed",
  "processing",
  "verified",
]);
const AUTH_STATE_NONTERMINAL_RETENTION_MS = 60 * 60 * 1_000;
const AUTH_STATE_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const FLOW_COLUMNS: Record<Exclude<keyof XFlowUpdate, "result">, string> = {
  completedAtMs: "completed_at_ms",
  errorCode: "error_code",
  processingStartedAtMs: "processing_started_at_ms",
  status: "status",
  updatedAtMs: "updated_at_ms",
  xUserId: "x_user_id",
  xUsername: "x_username",
};

export class AuthStateFailure extends Error {
  constructor() {
    super("auth-state-unavailable");
  }
}

export class AuthStateConflict extends AuthStateFailure {}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new AuthStateFailure();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return nonEmptyString(value);
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

function authMethod(value: unknown): AuthMethodKey {
  const method = nonEmptyString(value) as AuthMethodKey;
  if (!AUTH_METHODS.has(method)) throw new AuthStateFailure();
  return method;
}

function flowStatus(value: unknown): XFlowStatus {
  const status = nonEmptyString(value) as XFlowStatus;
  if (!X_FLOW_STATUSES.has(status)) throw new AuthStateFailure();
  return status;
}

function decodeIntent(row: AuthIntentRow): AuthIntentRecord {
  const createdAtMs = safeInteger(row.created_at_ms);
  const expiresAtMs = safeInteger(row.expires_at_ms);
  if (expiresAtMs < createdAtMs) throw new AuthStateFailure();
  return {
    consumedAtMs: nullableInteger(row.consumed_at_ms) || 0,
    consumedByOpId: nullableString(row.consumed_by_op_id) || "",
    createdAtMs,
    expiresAtMs,
    intentId: nonEmptyString(row.intent_id),
    method: authMethod(row.method),
    nonce: nonEmptyString(row.nonce),
    state: nonEmptyString(row.state),
    uid: nonEmptyString(row.uid),
  };
}

function decodeFlow(row: XFlowRow): XRedirectFlow {
  const createdAtMs = safeInteger(row.created_at_ms);
  const expiresAtMs = safeInteger(row.expires_at_ms);
  const updatedAtMs = safeInteger(row.updated_at_ms);
  const resultProfileId = nullableString(row.result_profile_id);
  const resultOpId = nullableString(row.result_op_id);
  if (
    row.method !== "x" ||
    expiresAtMs < createdAtMs ||
    updatedAtMs < createdAtMs ||
    Boolean(resultProfileId) !== Boolean(resultOpId)
  ) {
    throw new AuthStateFailure();
  }
  return {
    callbackUri: nonEmptyString(row.callback_uri),
    codeChallenge: nonEmptyString(row.code_challenge),
    codeVerifier: nonEmptyString(row.code_verifier),
    completedAtMs: nullableInteger(row.completed_at_ms) || 0,
    consentSource: nonEmptyString(row.consent_source),
    createdAtMs,
    errorCode: nullableString(row.error_code) || "",
    expiresAtMs,
    flowId: nonEmptyString(row.flow_id),
    intentId: nonEmptyString(row.intent_id),
    method: "x",
    processingStartedAtMs: nullableInteger(row.processing_started_at_ms) || 0,
    result:
      resultProfileId && resultOpId
        ? { profileId: resultProfileId, opId: resultOpId }
        : null,
    returnUrl: nonEmptyString(row.return_url),
    revision: safeInteger(row.revision),
    status: flowStatus(row.status),
    uid: nonEmptyString(row.uid),
    updatedAtMs,
    xUserId: nullableString(row.x_user_id) || "",
    xUsername: nullableString(row.x_username) || "",
  };
}

function stateFailure(error: unknown): never {
  if (error instanceof AuthStateFailure) throw error;
  throw new AuthStateFailure();
}

export function createAuthStateRepository(db: D1Database): AuthStateRepository {
  return {
    async consumeAuthIntent(input) {
      try {
        const result = await db
          .prepare(
            `UPDATE auth_intents
             SET consumed_at_ms = ?, consumed_by_op_id = ?
             WHERE intent_id = ? AND uid = ? AND method = ?
               AND consumed_at_ms IS NULL`,
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
        const result = await db
          .prepare(
            `INSERT INTO auth_intents (
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
        const result = await db
          .prepare(
            `INSERT INTO x_redirect_flows (
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
            `SELECT intent_id, uid, method, nonce, state, created_at_ms,
                    expires_at_ms, consumed_at_ms, consumed_by_op_id
             FROM auth_intents
             WHERE intent_id = ?`,
          )
          .bind(intentId)
          .first<AuthIntentRow>();
        return row ? decodeIntent(row) : null;
      } catch (error) {
        stateFailure(error);
      }
    },

    async getXFlow(flowId) {
      try {
        const row = await db
          .prepare(
            `SELECT flow_id, intent_id, uid, method, callback_uri,
                    code_challenge, code_verifier, consent_source, return_url,
                    status, error_code, x_user_id, x_username,
                    result_profile_id, result_op_id, created_at_ms,
                    expires_at_ms, updated_at_ms, processing_started_at_ms,
                    completed_at_ms, revision
             FROM x_redirect_flows
             WHERE flow_id = ?`,
          )
          .bind(flowId)
          .first<XFlowRow>();
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
            values.push(flowStatus(value));
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
            `UPDATE x_redirect_flows
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
          `DELETE FROM x_redirect_flows
           WHERE expires_at_ms < ?
             AND status IN ('created', 'processing')`,
        )
        .bind(cutoffMs),
      db
        .prepare(
          `DELETE FROM x_redirect_flows
             WHERE updated_at_ms < ?
               AND status IN ('verified', 'completed', 'failed')`,
        )
        .bind(terminalCutoffMs),
      db
        .prepare(
          `DELETE FROM auth_intents
           WHERE expires_at_ms < ?
             AND NOT EXISTS (
               SELECT 1 FROM x_redirect_flows
               WHERE x_redirect_flows.intent_id = auth_intents.intent_id
             )`,
        )
        .bind(cutoffMs),
      db
        .prepare(
          `UPDATE x_redirect_flows
           SET code_challenge = 'retired', code_verifier = 'retired'
           WHERE expires_at_ms < ?
             AND status IN ('verified', 'completed', 'failed')
             AND (code_challenge <> 'retired' OR code_verifier <> 'retired')`,
        )
        .bind(cutoffMs),
      db
        .prepare(
          `UPDATE auth_intents
           SET nonce = 'retired', state = 'retired'
           WHERE expires_at_ms < ?
             AND (nonce <> 'retired' OR state <> 'retired')
             AND EXISTS (
               SELECT 1 FROM x_redirect_flows
               WHERE x_redirect_flows.intent_id = auth_intents.intent_id
                 AND x_redirect_flows.status IN ('verified', 'completed', 'failed')
             )`,
        )
        .bind(cutoffMs),
    ]);
    const result = {
      flowsCompacted: compactedFlows.meta.changes,
      flowsDeleted: deletedFlows.meta.changes,
      intentsCompacted: compactedIntents.meta.changes,
      intentsDeleted: deletedIntents.meta.changes,
      terminalFlowsDeleted: deletedTerminalFlows.meta.changes,
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
