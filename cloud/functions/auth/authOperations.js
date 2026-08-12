const crypto = require("crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("../firebaseAdmin");
const {
  createOpId,
  hashMethodValue,
  normalizeMethodValue,
  parseNumber,
  toCleanString,
} = require("./policy");

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_COUNT = 20;
const AUTH_OP_REPLAY_TTL_MS = 10 * 60 * 1000;

const getAuthOpContextState = (opData, { opId, kind, method, uid }) => {
  const existingUid = toCleanString(opData && opData.uid);
  const existingKind = toCleanString(opData && opData.kind);
  const existingMethod = toCleanString(opData && opData.method);
  if (!existingUid || !existingKind || !existingMethod) {
    return "missing";
  }
  if (
    existingUid !== uid ||
    existingKind !== kind ||
    existingMethod !== method
  ) {
    console.error("auth:op-context-mismatch", {
      opId,
      existingUid,
      existingKind,
      existingMethod,
      requestedUid: uid,
      requestedKind: kind,
      requestedMethod: method,
    });
    return "mismatch";
  }
  return "match";
};

const getReplayResultFromAuthOpData = (opData) => {
  const updatedAtMs = Math.max(
    parseNumber(opData && opData.updatedAtMs, 0),
    parseNumber(opData && opData.startedAtMs, 0),
  );
  if (updatedAtMs <= 0) {
    return null;
  }
  if (Date.now() - updatedAtMs > AUTH_OP_REPLAY_TTL_MS) {
    return null;
  }
  if (
    opData &&
    opData.status === "success" &&
    opData.result &&
    typeof opData.result === "object"
  ) {
    return opData.result;
  }
  return null;
};

const getExpectedMethodValueHashFromAuthOp = (method, opData) => {
  const meta = opData && typeof opData.meta === "object" ? opData.meta : null;
  const explicitHash = toCleanString(meta && meta.methodValueHash);
  if (explicitHash) {
    return explicitHash;
  }
  if (method === "apple" || method === "x") {
    return "";
  }
  const rawValue = toCleanString(meta && meta.methodValue);
  if (!rawValue || rawValue === "redacted") {
    return "";
  }
  try {
    const normalizedValue = normalizeMethodValue(method, rawValue);
    return hashMethodValue(method, normalizedValue);
  } catch {
    return "";
  }
};

const createAuthOperations = ({ isVerifyReplayStillValid }) => {
  if (typeof isVerifyReplayStillValid !== "function") {
    throw new TypeError("isVerifyReplayStillValid is required");
  }

  const getAuthOpReplayResult = async ({ opData, opId, kind, method, uid }) => {
    const replay = getReplayResultFromAuthOpData(opData);
    if (!replay) {
      return null;
    }
    if (kind === "verify") {
      const isValid = await isVerifyReplayStillValid({
        opData,
        opId,
        method,
        uid,
        replay,
      });
      if (!isValid) {
        return null;
      }
    }
    return replay;
  };

  const peekAuthOpReplay = async ({ opId, kind, method, uid }) => {
    const resolvedOpId = toCleanString(opId);
    if (!resolvedOpId) {
      return null;
    }
    const firestore = admin.firestore();
    const opRef = firestore.collection("authOps").doc(resolvedOpId);
    const opSnapshot = await opRef.get();
    if (!opSnapshot.exists) {
      return null;
    }
    const data = opSnapshot.data() || {};
    const contextState = getAuthOpContextState(data, {
      opId: resolvedOpId,
      kind,
      method,
      uid,
    });
    if (contextState === "mismatch") {
      throw new HttpsError("permission-denied", "op-context-mismatch");
    }
    if (contextState === "missing") {
      return null;
    }
    return getAuthOpReplayResult({
      opData: data,
      opId: resolvedOpId,
      kind,
      method,
      uid,
    });
  };

  const beginAuthOp = async ({ opId, kind, method, uid, meta }) => {
    const firestore = admin.firestore();
    const resolvedOpId = toCleanString(opId) || createOpId();
    const opRef = firestore.collection("authOps").doc(resolvedOpId);
    const nowMs = Date.now();
    const opSnapshot = await opRef.get();
    if (opSnapshot.exists) {
      const data = opSnapshot.data() || {};
      const contextState = getAuthOpContextState(data, {
        opId: resolvedOpId,
        kind,
        method,
        uid,
      });
      if (contextState === "mismatch") {
        throw new HttpsError("permission-denied", "op-context-mismatch");
      }
      if (contextState === "match") {
        const replay = await getAuthOpReplayResult({
          opData: data,
          opId: resolvedOpId,
          kind,
          method,
          uid,
        });
        if (replay) {
          return {
            opId: resolvedOpId,
            replay,
          };
        }
      }
    }
    await opRef.set(
      {
        opId: resolvedOpId,
        kind,
        method,
        uid,
        status: "started",
        meta: meta || null,
        startedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      { merge: true },
    );
    return { opId: resolvedOpId, replay: null };
  };

  const finishAuthOp = async ({ opId, result, error }) => {
    if (!opId) {
      return;
    }
    const firestore = admin.firestore();
    const opRef = firestore.collection("authOps").doc(opId);
    const nowMs = Date.now();
    if (error) {
      await opRef.set(
        {
          status: "failed",
          errorCode: error.code || null,
          errorMessage: error.message || String(error),
          updatedAtMs: nowMs,
        },
        { merge: true },
      );
      return;
    }
    await opRef.set(
      {
        status: "success",
        result,
        updatedAtMs: nowMs,
      },
      { merge: true },
    );
  };

  return {
    beginAuthOp,
    finishAuthOp,
    peekAuthOpReplay,
  };
};

const enforceRateLimit = async ({ uid, method, request }) => {
  const firestore = admin.firestore();
  const ip =
    toCleanString(request && request.rawRequest && request.rawRequest.ip) ||
    "unknown";
  const ipHash = crypto
    .createHash("sha256")
    .update(ip)
    .digest("hex")
    .slice(0, 12);
  const key = `${method}:${uid}:${ipHash}`;
  const nowMs = Date.now();
  const rateRef = firestore.collection("authRateLimits").doc(key);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateRef);
    const data = snapshot.exists ? snapshot.data() || {} : {};
    const windowStartedAtMs = parseNumber(data.windowStartedAtMs, 0);
    const inWindow = nowMs - windowStartedAtMs <= RATE_LIMIT_WINDOW_MS;
    const nextCount = inWindow ? parseNumber(data.count, 0) + 1 : 1;
    if (nextCount > RATE_LIMIT_MAX_COUNT) {
      throw new HttpsError("resource-exhausted", "Too many auth attempts.");
    }
    transaction.set(
      rateRef,
      {
        uid,
        method,
        ipHash,
        windowStartedAtMs: inWindow ? windowStartedAtMs : nowMs,
        count: nextCount,
        updatedAtMs: nowMs,
      },
      { merge: true },
    );
  });
};

module.exports = {
  createAuthOperations,
  enforceRateLimit,
  getAuthOpContextState,
  getExpectedMethodValueHashFromAuthOp,
  getReplayResultFromAuthOpData,
};
