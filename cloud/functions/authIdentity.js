const crypto = require("crypto");
const admin = require("./firebaseAdmin");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  normalizeMiningSnapshot,
  sumMaterials,
} = require("@mons/shared/mining");
const {
  AUTH_COOLDOWN_REASONS,
  AUTH_METHOD_FIELD_BY_TYPE,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  getAuthCooldownScope,
  normalizeAuthMethod,
} = require("@mons/shared/auth");
const {
  USERNAME_LOOKUP_KEY_FIELD,
  buildUsernameLookupKey: toUsernameLookupKey,
  getUsernameIndexDocIds,
  isSafeFirestoreDocIdSegment,
} = require("@mons/shared/usernames");
const {
  assignRandomUsernameIfNeededForWalletlessProfile,
} = require("./usernameRegistry");
const { readProfileByLoginUid } = require("./profileLookup");
const {
  copyProfileEventPrizesToCanonicalTarget,
  resolveCanonicalProfileId,
} = require("./profileEventPrizeProjection");
const {
  PROFILE_MERGE_TARGETS_COLLECTION,
  getProfileMergeTargetId,
} = require("./profileMergeTargets");

const INTENT_TTL_MS = 5 * 60 * 1000;
const MERGE_LOCK_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_COUNT = 20;
const AUTH_OP_REPLAY_TTL_MS = 10 * 60 * 1000;
const LINK_METHOD_MAX_ATTEMPTS = 3;
const MERGE_LOCK_RELEASE_MAX_ATTEMPTS = 3;
const MERGE_LOCK_RELEASE_RETRY_BASE_DELAY_MS = 80;

const toCleanString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const assertSupportedMethod = (value) => {
  const method = normalizeAuthMethod(value);
  if (!method) {
    throw new HttpsError("invalid-argument", "Unsupported auth method.");
  }
  return method;
};
const isFeatureDisabled = (name) => {
  const value = toCleanString(process.env[name]).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};

const hasValue = (value) => {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
};

const parseNumber = (value, fallback) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const waitMs = (value) => new Promise((resolve) => setTimeout(resolve, value));

const getProfileMethodCooldownDocId = (profileId, method) => {
  const normalizedProfileId = toCleanString(profileId);
  const normalizedMethod = assertSupportedMethod(method);
  if (!normalizedProfileId) {
    throw new HttpsError("invalid-argument", "profileId is required.");
  }
  return `${normalizedProfileId}:${normalizedMethod}`;
};

const parseCooldownRetryAtMs = (
  docData,
  fallbackCooldownMs = AUTH_METHOD_REUSE_COOLDOWN_MS,
) => {
  const retryAtMs = parseNumber(docData && docData.retryAtMs, 0);
  if (retryAtMs > 0) {
    return retryAtMs;
  }
  const expiresAtMs = parseNumber(docData && docData.expiresAtMs, 0);
  if (expiresAtMs > 0) {
    return expiresAtMs;
  }
  const startedAtMs = Math.max(
    parseNumber(docData && docData.startedAtMs, 0),
    parseNumber(docData && docData.revokedAtMs, 0),
    parseNumber(docData && docData.createdAtMs, 0),
    parseNumber(docData && docData.updatedAtMs, 0),
  );
  const cooldownMs = parseNumber(
    docData && docData.cooldownMs,
    fallbackCooldownMs,
  );
  if (startedAtMs > 0 && cooldownMs > 0) {
    return startedAtMs + cooldownMs;
  }
  return 0;
};

const buildMethodReuseCooldownDetails = ({ method, retryAtMs }) => {
  const normalizedMethod = assertSupportedMethod(method);
  const reason = AUTH_COOLDOWN_REASONS.method;
  return {
    reason,
    scope: getAuthCooldownScope(reason),
    method: normalizedMethod,
    retryAtMs: Math.max(parseNumber(retryAtMs, 0), 0),
    cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
  };
};

const buildProfileMethodCooldownDetails = ({
  method,
  profileId,
  retryAtMs,
}) => {
  const normalizedMethod = assertSupportedMethod(method);
  const normalizedProfileId = toCleanString(profileId);
  const reason = AUTH_COOLDOWN_REASONS.profileMethod;
  return {
    reason,
    scope: getAuthCooldownScope(reason),
    method: normalizedMethod,
    retryAtMs: Math.max(parseNumber(retryAtMs, 0), 0),
    cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
    profileId: normalizedProfileId || null,
  };
};

const throwMethodReuseCooldownError = ({ method, retryAtMs }) => {
  throw new HttpsError(
    "failed-precondition",
    AUTH_COOLDOWN_REASONS.method,
    buildMethodReuseCooldownDetails({ method, retryAtMs }),
  );
};

const throwProfileMethodCooldownError = ({ method, profileId, retryAtMs }) => {
  throw new HttpsError(
    "failed-precondition",
    AUTH_COOLDOWN_REASONS.profileMethod,
    buildProfileMethodCooldownDetails({
      method,
      profileId,
      retryAtMs,
    }),
  );
};

const queueCleanupRef = (cleanupRefsByPath, ref) => {
  if (!cleanupRefsByPath || !ref || typeof ref.path !== "string") {
    return;
  }
  cleanupRefsByPath.set(ref.path, ref);
};

const applyQueuedCleanupDeletes = ({ transaction, cleanupRefsByPath }) => {
  if (!cleanupRefsByPath || cleanupRefsByPath.size === 0) {
    return;
  }
  cleanupRefsByPath.forEach((ref) => {
    transaction.delete(ref);
  });
};

const ensureCooldownInactiveInTransaction = async ({
  transaction,
  ref,
  nowMs,
  onActive,
  cleanupRefsByPath,
}) => {
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) {
    return;
  }
  const retryAtMs = parseCooldownRetryAtMs(snapshot.data() || {});
  if (retryAtMs > nowMs) {
    onActive(retryAtMs);
    return;
  }
  queueCleanupRef(cleanupRefsByPath, ref);
};

const enforceMethodReuseCooldownInTransaction = async ({
  transaction,
  method,
  normalizedMethodValue,
  nowMs,
  cleanupRefsByPath,
}) => {
  const normalizedMethod = assertSupportedMethod(method);
  const normalizedValue = toCleanString(normalizedMethodValue);
  if (!normalizedValue) {
    return;
  }
  const firestore = admin.firestore();
  const revocationRef = firestore
    .collection("authMethodRevocations")
    .doc(getMethodKey(normalizedMethod, normalizedValue));
  await ensureCooldownInactiveInTransaction({
    transaction,
    ref: revocationRef,
    nowMs,
    cleanupRefsByPath,
    onActive: (retryAtMs) => {
      throwMethodReuseCooldownError({
        method: normalizedMethod,
        retryAtMs,
      });
    },
  });
};

const enforceProfileMethodCooldownInTransaction = async ({
  transaction,
  profileId,
  method,
  nowMs,
  cleanupRefsByPath,
}) => {
  const normalizedProfileId = toCleanString(profileId);
  if (!normalizedProfileId) {
    throw new HttpsError("invalid-argument", "profileId is required.");
  }
  const normalizedMethod = assertSupportedMethod(method);
  const firestore = admin.firestore();
  const profileCooldownRef = firestore
    .collection("authProfileMethodCooldowns")
    .doc(getProfileMethodCooldownDocId(normalizedProfileId, normalizedMethod));
  await ensureCooldownInactiveInTransaction({
    transaction,
    ref: profileCooldownRef,
    nowMs,
    cleanupRefsByPath,
    onActive: (retryAtMs) => {
      throwProfileMethodCooldownError({
        method: normalizedMethod,
        profileId: normalizedProfileId,
        retryAtMs,
      });
    },
  });
};

const createOpId = () => crypto.randomBytes(16).toString("hex");
const createToken = (bytes = 18) =>
  crypto.randomBytes(bytes).toString("base64url");
const createSiweNonce = (length = 24) => {
  const targetLength =
    Number.isFinite(length) && length >= 8 ? Math.floor(length) : 24;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < targetLength; index += 1) {
    value += alphabet[crypto.randomInt(alphabet.length)];
  }
  return value;
};

const normalizeEth = (value) => {
  const input = toCleanString(value).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(input)) {
    throw new HttpsError("invalid-argument", "Invalid Ethereum address.");
  }
  return input;
};

const normalizeSol = (value) => {
  const input = toCleanString(value);
  if (input.length < 20 || input.length > 64) {
    throw new HttpsError("invalid-argument", "Invalid Solana address.");
  }
  return input;
};

const normalizeAppleSub = (value) => {
  const input = toCleanString(value);
  if (input.length < 6) {
    throw new HttpsError("invalid-argument", "Invalid Apple subject.");
  }
  return input;
};

const normalizeXUserId = (value) => {
  const input = toCleanString(value);
  if (!/^\d+$/.test(input)) {
    throw new HttpsError("invalid-argument", "Invalid X user id.");
  }
  return input;
};

const normalizeMethodValue = (method, value) => {
  if (method === "eth") {
    return normalizeEth(value);
  }
  if (method === "sol") {
    return normalizeSol(value);
  }
  if (method === "apple") {
    return normalizeAppleSub(value);
  }
  if (method === "x") {
    return normalizeXUserId(value);
  }
  throw new HttpsError("invalid-argument", "Unsupported auth method.");
};

const getMethodField = (method) => {
  const field = AUTH_METHOD_FIELD_BY_TYPE[method];
  if (!field) {
    throw new HttpsError("invalid-argument", "Unsupported auth method.");
  }
  return field;
};

const getMethodKey = (method, normalizedValue) => {
  return `${method}:${Buffer.from(normalizedValue, "utf8").toString("base64url")}`;
};

const hashMethodValue = (method, normalizedValue) => {
  const cleanValue = toCleanString(normalizedValue);
  if (!cleanValue) {
    return "";
  }
  return crypto
    .createHash("sha256")
    .update(`${method}:${cleanValue}`)
    .digest("hex");
};

const getMethodValueFromProfile = (profileData, method) => {
  const field = getMethodField(method);
  return toCleanString(profileData && profileData[field]);
};

const normalizeFromProfileByMethod = (method, profileData) => {
  const value = getMethodValueFromProfile(profileData, method);
  if (!value) {
    return "";
  }
  try {
    return normalizeMethodValue(method, value);
  } catch {
    return "";
  }
};

const linkedMethodsFromProfileData = (profileData) => ({
  apple: normalizeFromProfileByMethod("apple", profileData) !== "",
  eth: normalizeFromProfileByMethod("eth", profileData) !== "",
  sol: normalizeFromProfileByMethod("sol", profileData) !== "",
  x: normalizeFromProfileByMethod("x", profileData) !== "",
});

const linkedMethodCount = (profileData) => {
  const linked = linkedMethodsFromProfileData(profileData);
  return [linked.apple, linked.eth, linked.sol, linked.x].filter(Boolean)
    .length;
};

const pickTargetOrSource = (targetValue, sourceValue) =>
  hasValue(targetValue) ? targetValue : sourceValue;

const maskEmail = (value) => {
  const email = toCleanString(value);
  if (!email.includes("@")) {
    return null;
  }
  const [localPart, domain] = email.split("@");
  if (!domain) {
    return null;
  }
  if (!localPart) {
    return `***@${domain}`;
  }
  if (localPart.length === 1) {
    return `${localPart}***@${domain}`;
  }
  return `${localPart.slice(0, 1)}***${localPart.slice(-1)}@${domain}`;
};

const toMillis = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (value && typeof value.toMillis === "function") {
    try {
      const millis = value.toMillis();
      if (Number.isFinite(millis)) {
        return Math.floor(millis);
      }
    } catch {}
  }
  if (value && typeof value === "object" && Number.isFinite(value._seconds)) {
    const nanos = Number.isFinite(value._nanoseconds) ? value._nanoseconds : 0;
    return Math.floor(value._seconds * 1000 + nanos / 1e6);
  }
  return 0;
};

const readMergeFreshness = (docData) => {
  return Math.max(
    toMillis(docData && docData.updatedAt),
    toMillis(docData && docData.listSortAt),
  );
};

const mergeUniqueStringArray = (left, right) => {
  const result = [];
  const add = (value) => {
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      !result.includes(value)
    ) {
      result.push(value);
    }
  };
  if (Array.isArray(left)) {
    left.forEach(add);
  }
  if (Array.isArray(right)) {
    right.forEach(add);
  }
  return result;
};

const mergeMining = (targetData, sourceData) => {
  const targetMining = normalizeMiningSnapshot(targetData && targetData.mining);
  const sourceMining = normalizeMiningSnapshot(sourceData && sourceData.mining);
  const lastRockDate =
    [targetMining.lastRockDate, sourceMining.lastRockDate]
      .filter((value) => typeof value === "string" && value !== "")
      .sort()
      .pop() || null;
  return {
    lastRockDate,
    materials: sumMaterials(targetMining.materials, sourceMining.materials),
  };
};

const mergeCustom = (targetData, sourceData) => {
  const targetCustom =
    targetData && typeof targetData.custom === "object" && targetData.custom
      ? targetData.custom
      : {};
  const sourceCustom =
    sourceData && typeof sourceData.custom === "object" && sourceData.custom
      ? sourceData.custom
      : {};
  const merged = {
    ...sourceCustom,
    ...targetCustom,
  };
  merged.emoji = pickTargetOrSource(targetCustom.emoji, sourceCustom.emoji);
  merged.aura = pickTargetOrSource(targetCustom.aura, sourceCustom.aura);
  merged.cardBackgroundId = pickTargetOrSource(
    targetCustom.cardBackgroundId,
    sourceCustom.cardBackgroundId,
  );
  merged.cardStickers = pickTargetOrSource(
    targetCustom.cardStickers,
    sourceCustom.cardStickers,
  );
  merged.cardSubtitleId = pickTargetOrSource(
    targetCustom.cardSubtitleId,
    sourceCustom.cardSubtitleId,
  );
  merged.profileCounter = pickTargetOrSource(
    targetCustom.profileCounter,
    sourceCustom.profileCounter,
  );
  merged.profileMons = pickTargetOrSource(
    targetCustom.profileMons,
    sourceCustom.profileMons,
  );
  merged.completedProblems = mergeUniqueStringArray(
    targetCustom.completedProblems,
    sourceCustom.completedProblems,
  );
  merged.tutorialCompleted =
    !!targetCustom.tutorialCompleted || !!sourceCustom.tutorialCompleted;
  return merged;
};

const ensureMethodCompatibility = (profileData, method, normalizedValue) => {
  const existing = normalizeFromProfileByMethod(method, profileData);
  if (existing && existing !== normalizedValue) {
    throw new HttpsError(
      "failed-precondition",
      "method-already-linked-different",
    );
  }
};

const validateMergeMethodConflict = (targetData, sourceData) => {
  const checks = [
    [
      "eth",
      normalizeFromProfileByMethod("eth", targetData),
      normalizeFromProfileByMethod("eth", sourceData),
    ],
    [
      "sol",
      normalizeFromProfileByMethod("sol", targetData),
      normalizeFromProfileByMethod("sol", sourceData),
    ],
    [
      "apple",
      normalizeFromProfileByMethod("apple", targetData),
      normalizeFromProfileByMethod("apple", sourceData),
    ],
    [
      "x",
      normalizeFromProfileByMethod("x", targetData),
      normalizeFromProfileByMethod("x", sourceData),
    ],
  ];
  for (const [, targetValue, sourceValue] of checks) {
    if (targetValue && sourceValue && targetValue !== sourceValue) {
      throw new HttpsError("failed-precondition", "merge-method-conflict");
    }
  }
};

const ensureProfileClaimAndRtdb = async (uid, profileId) => {
  const normalizedUid = toCleanString(uid);
  const normalizedProfileId = toCleanString(profileId);
  if (!normalizedUid || !normalizedProfileId) {
    throw new HttpsError("invalid-argument", "uid and profileId are required.");
  }
  const auth = admin.auth();
  const profileRef = admin.database().ref(`players/${normalizedUid}/profile`);
  const [profileSnapshot, userRecord] = await Promise.all([
    profileRef.once("value"),
    auth.getUser(normalizedUid),
  ]);
  const currentProfileId = toCleanString(profileSnapshot.val());
  const currentClaims = userRecord.customClaims || {};
  const currentClaimProfileId = toCleanString(currentClaims.profileId);
  const writes = [];
  if (currentProfileId !== normalizedProfileId) {
    writes.push(profileRef.set(normalizedProfileId));
  }
  if (currentClaimProfileId !== normalizedProfileId) {
    writes.push(
      auth.setCustomUserClaims(normalizedUid, {
        ...currentClaims,
        profileId: normalizedProfileId,
      }),
    );
  }
  if (writes.length > 0) {
    await Promise.all(writes);
  }
};

const readProfileByMethod = async (method, normalizedValue, rawValue) => {
  const firestore = admin.firestore();
  const indexRef = firestore
    .collection("authMethodIndex")
    .doc(getMethodKey(method, normalizedValue));
  const indexSnapshot = await indexRef.get();
  if (indexSnapshot.exists) {
    const indexData = indexSnapshot.data() || {};
    const profileId = toCleanString(indexData.profileId);
    if (profileId) {
      const profileDoc = await firestore
        .collection("users")
        .doc(profileId)
        .get();
      if (profileDoc.exists) {
        const indexedNormalizedValue = normalizeFromProfileByMethod(
          method,
          profileDoc.data() || {},
        );
        if (indexedNormalizedValue === normalizedValue) {
          return profileDoc;
        }
      }
    }
    await firestore
      .runTransaction(async (transaction) => {
        const liveIndexSnapshot = await transaction.get(indexRef);
        if (!liveIndexSnapshot.exists) {
          return;
        }
        const liveIndexData = liveIndexSnapshot.data() || {};
        const liveProfileId = toCleanString(liveIndexData.profileId);
        if (!liveProfileId) {
          transaction.delete(indexRef);
          return;
        }
        const liveProfileRef = firestore.collection("users").doc(liveProfileId);
        const liveProfileSnapshot = await transaction.get(liveProfileRef);
        if (!liveProfileSnapshot.exists) {
          transaction.delete(indexRef);
          return;
        }
        const liveNormalizedValue = normalizeFromProfileByMethod(
          method,
          liveProfileSnapshot.data() || {},
        );
        if (liveNormalizedValue !== normalizedValue) {
          transaction.delete(indexRef);
        }
      })
      .catch(() => {});
  }

  const field = getMethodField(method);
  const candidateValues = [];
  const cleanRawValue = toCleanString(rawValue);
  if (cleanRawValue) {
    candidateValues.push(cleanRawValue);
  }
  if (!candidateValues.includes(normalizedValue)) {
    candidateValues.push(normalizedValue);
  }

  for (const candidate of candidateValues) {
    const snapshot = await firestore
      .collection("users")
      .where(field, "==", candidate)
      .limit(2)
      .get();
    if (!snapshot.empty) {
      if (snapshot.size > 1) {
        throw new HttpsError(
          "failed-precondition",
          "legacy-method-duplicate-ownership",
        );
      }
      const doc = snapshot.docs[0];
      const nowMs = Date.now();
      await firestore.runTransaction(async (transaction) => {
        const liveIndexSnapshot = await transaction.get(indexRef);
        if (liveIndexSnapshot.exists) {
          const liveIndexData = liveIndexSnapshot.data() || {};
          const indexedProfileId = toCleanString(liveIndexData.profileId);
          if (indexedProfileId && indexedProfileId !== doc.id) {
            const indexedProfileRef = firestore
              .collection("users")
              .doc(indexedProfileId);
            const indexedProfileSnapshot =
              await transaction.get(indexedProfileRef);
            if (indexedProfileSnapshot.exists) {
              const indexedNormalizedValue = normalizeFromProfileByMethod(
                method,
                indexedProfileSnapshot.data() || {},
              );
              if (indexedNormalizedValue === normalizedValue) {
                throw new HttpsError(
                  "failed-precondition",
                  "method-index-conflict",
                );
              }
            }
          }
        }
        transaction.set(
          indexRef,
          {
            profileId: doc.id,
            method,
            normalizedValue,
            updatedAtMs: nowMs,
          },
          { merge: true },
        );
      });
      return doc;
    }
  }

  return null;
};

const buildProfileResponse = (profileDoc, uid, preferredAddress) => {
  const data = (profileDoc && profileDoc.data()) || {};
  const custom =
    data.custom && typeof data.custom === "object" ? data.custom : {};
  const linkedMethods = linkedMethodsFromProfileData(data);
  const eth = normalizeFromProfileByMethod("eth", data) || null;
  const sol = normalizeFromProfileByMethod("sol", data) || null;
  const emojiRaw = custom.emoji;
  const emojiNumber = Number.isFinite(
    typeof emojiRaw === "number" ? emojiRaw : Number(emojiRaw),
  )
    ? Math.floor(Number(emojiRaw))
    : 1;
  return {
    ok: true,
    uid,
    profileId: profileDoc.id,
    username: toCleanString(data.username) || null,
    address: preferredAddress || eth || sol || null,
    eth,
    sol,
    linkedMethods,
    appleLinked: linkedMethods.apple,
    emoji: emojiNumber > 0 ? emojiNumber : 1,
    aura: custom.aura || null,
    rating: data.rating ?? null,
    nonce: data.nonce ?? null,
    totalManaPoints: data.totalManaPoints ?? null,
    cardBackgroundId: custom.cardBackgroundId || null,
    cardStickers: custom.cardStickers || null,
    cardSubtitleId: custom.cardSubtitleId || null,
    profileCounter: custom.profileCounter || null,
    profileMons: custom.profileMons || null,
    completedProblems: custom.completedProblems || null,
    tutorialCompleted: custom.tutorialCompleted || null,
    mining: normalizeMiningSnapshot(data.mining),
  };
};

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

const isVerifyReplayStillValid = async ({
  opData,
  opId,
  method,
  uid,
  replay,
}) => {
  if (!replay || typeof replay !== "object" || replay.ok !== true) {
    return false;
  }
  const replayUid = toCleanString(replay.uid);
  if (replayUid && replayUid !== uid) {
    console.error("auth:verify-replay-uid-mismatch", {
      opId,
      method,
      replayUid,
      requestedUid: uid,
    });
    return false;
  }

  const currentProfile = await readProfileByLoginUid(uid);
  if (!currentProfile) {
    return false;
  }
  const currentProfileId = toCleanString(currentProfile.id);
  const replayProfileId = toCleanString(replay.profileId);
  if (replayProfileId && replayProfileId !== currentProfileId) {
    console.error("auth:verify-replay-profile-mismatch", {
      opId,
      method,
      replayProfileId,
      currentProfileId,
      uid,
    });
    return false;
  }

  const currentProfileData = currentProfile.data() || {};
  const currentNormalizedValue = normalizeFromProfileByMethod(
    method,
    currentProfileData,
  );
  if (!currentNormalizedValue) {
    return false;
  }

  const expectedHash = getExpectedMethodValueHashFromAuthOp(method, opData);
  if (expectedHash) {
    const currentHash = hashMethodValue(method, currentNormalizedValue);
    if (currentHash !== expectedHash) {
      console.error("auth:verify-replay-method-mismatch", {
        opId,
        method,
        uid,
        replayProfileId: replayProfileId || null,
        currentProfileId,
      });
      return false;
    }
  }

  return true;
};

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

const beginAuthIntent = async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }
  const method = assertSupportedMethod(request.data && request.data.method);
  await enforceRateLimit({
    uid: request.auth.uid,
    method: `intent-${method}`,
    request,
  });

  const firestore = admin.firestore();
  const nowMs = Date.now();
  const intentId = createToken(18);
  const nonce = method === "eth" ? createSiweNonce(24) : createToken(18);
  const state = createToken(18);
  const expiresAtMs = nowMs + INTENT_TTL_MS;
  await firestore.collection("authIntents").doc(intentId).set({
    intentId,
    uid: request.auth.uid,
    method,
    nonce,
    state,
    createdAtMs: nowMs,
    expiresAtMs,
    consumedAtMs: null,
  });
  return {
    ok: true,
    intentId,
    nonce,
    state,
    expiresAtMs,
  };
};

const consumeAuthIntent = async ({ uid, method, intentId }) => {
  const normalizedIntentId = toCleanString(intentId);
  if (!normalizedIntentId) {
    return null;
  }
  const firestore = admin.firestore();
  const intentRef = firestore.collection("authIntents").doc(normalizedIntentId);
  const nowMs = Date.now();
  let intentData = null;
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(intentRef);
    if (!snapshot.exists) {
      throw new HttpsError("failed-precondition", "intent-not-found");
    }
    const data = snapshot.data() || {};
    if (toCleanString(data.uid) !== uid) {
      throw new HttpsError("permission-denied", "intent-user-mismatch");
    }
    if (toCleanString(data.method) !== method) {
      throw new HttpsError("failed-precondition", "intent-method-mismatch");
    }
    if (parseNumber(data.expiresAtMs, 0) < nowMs) {
      throw new HttpsError("deadline-exceeded", "intent-expired");
    }
    if (parseNumber(data.consumedAtMs, 0) > 0) {
      throw new HttpsError("failed-precondition", "intent-consumed");
    }
    transaction.update(intentRef, {
      consumedAtMs: nowMs,
    });
    intentData = data;
  });
  return intentData;
};

const acquireMergeLocks = async ({
  targetProfileId,
  sourceProfileId,
  opId,
}) => {
  const participants = Array.from(
    new Set(
      [toCleanString(targetProfileId), toCleanString(sourceProfileId)].filter(
        (value) => value !== "",
      ),
    ),
  ).sort();
  if (participants.length === 0) {
    return [];
  }
  const firestore = admin.firestore();
  const lockRefs = participants.map((profileId) =>
    firestore.collection("mergeLocks").doc(`profile:${profileId}`),
  );
  const nowMs = Date.now();
  await firestore.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(
      lockRefs.map((lockRef) => transaction.get(lockRef)),
    );
    snapshots.forEach((snapshot) => {
      if (!snapshot.exists) {
        return;
      }
      const data = snapshot.data() || {};
      const expiresAtMs = parseNumber(data.expiresAtMs, 0);
      if (expiresAtMs > nowMs && toCleanString(data.opId) !== opId) {
        throw new HttpsError("aborted", "merge-lock-active");
      }
    });
    lockRefs.forEach((lockRef, index) => {
      const profileId = participants[index];
      transaction.set(
        lockRef,
        {
          key: lockRef.id,
          opId,
          profileId,
          targetProfileId,
          sourceProfileId,
          expiresAtMs: nowMs + MERGE_LOCK_TTL_MS,
          updatedAtMs: nowMs,
        },
        { merge: true },
      );
    });
  });
  return lockRefs;
};

const releaseMergeLocks = async (lockRefs, opId) => {
  if (!Array.isArray(lockRefs) || lockRefs.length === 0) {
    return;
  }
  const firestore = admin.firestore();
  const hardFailures = [];
  await Promise.all(
    lockRefs.map(async (lockRef) => {
      let releaseError = null;
      for (
        let attempt = 1;
        attempt <= MERGE_LOCK_RELEASE_MAX_ATTEMPTS;
        attempt += 1
      ) {
        try {
          await firestore.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(lockRef);
            if (!snapshot.exists) {
              return;
            }
            const data = snapshot.data() || {};
            if (toCleanString(data.opId) !== opId) {
              return;
            }
            transaction.delete(lockRef);
          });
          releaseError = null;
          break;
        } catch (error) {
          releaseError = error;
          if (attempt < MERGE_LOCK_RELEASE_MAX_ATTEMPTS) {
            await waitMs(MERGE_LOCK_RELEASE_RETRY_BASE_DELAY_MS * attempt);
          }
        }
      }

      if (!releaseError) {
        return;
      }

      const nowMs = Date.now();
      try {
        await firestore.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(lockRef);
          if (!snapshot.exists) {
            return;
          }
          const data = snapshot.data() || {};
          if (toCleanString(data.opId) !== opId) {
            return;
          }
          transaction.set(
            lockRef,
            {
              expiresAtMs: nowMs - 1,
              updatedAtMs: nowMs,
            },
            { merge: true },
          );
        });
      } catch (fallbackError) {
        hardFailures.push({
          lockId: lockRef.id,
          releaseError:
            toCleanString(releaseError && releaseError.message) || "unknown",
          fallbackError:
            toCleanString(fallbackError && fallbackError.message) || "unknown",
        });
      }
    }),
  );

  if (hardFailures.length > 0) {
    console.error("auth:merge:lock-release-failed", {
      opId,
      failures: hardFailures,
    });
  }
};

const commitOperations = async (operations) => {
  if (!Array.isArray(operations) || operations.length === 0) {
    return;
  }
  const firestore = admin.firestore();
  const chunkSize = 400;
  for (let index = 0; index < operations.length; index += chunkSize) {
    const batch = firestore.batch();
    const chunk = operations.slice(index, index + chunkSize);
    chunk.forEach((operation) => {
      if (operation.type === "set") {
        if (operation.merge === true) {
          batch.set(operation.ref, operation.data, { merge: true });
        } else {
          batch.set(operation.ref, operation.data);
        }
      } else if (operation.type === "update") {
        batch.update(operation.ref, operation.data);
      } else if (operation.type === "delete") {
        batch.delete(operation.ref);
      }
    });
    await batch.commit();
  }
};

const runWithRetries = async ({ attempts = 3, baseDelayMs = 100, work }) => {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await work(attempt);
      return null;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await waitMs(baseDelayMs * attempt);
      }
    }
  }
  return lastError;
};

const persistPendingClaimSync = async ({
  targetRef,
  targetProfileId,
  sourceProfileId,
  failedLoginUids,
  opId,
}) => {
  const firestore = admin.firestore();
  const nowMs = Date.now();
  const pendingPayload = {
    pendingClaimSyncLogins: failedLoginUids,
    pendingClaimSyncUpdatedAtMs: nowMs,
  };
  const pendingWriteError = await runWithRetries({
    attempts: 3,
    baseDelayMs: 120,
    work: async () => {
      await targetRef.set(pendingPayload, { merge: true });
    },
  });
  if (!pendingWriteError) {
    return { location: "profile" };
  }

  const fallbackRef = firestore
    .collection("authClaimSyncBacklog")
    .doc(toCleanString(opId) || createOpId());
  const fallbackWriteError = await runWithRetries({
    attempts: 3,
    baseDelayMs: 160,
    work: async () => {
      await fallbackRef.set(
        {
          opId: toCleanString(opId) || null,
          targetProfileId,
          sourceProfileId,
          failedLoginUids,
          status: "pending",
          createdAtMs: nowMs,
          updatedAtMs: Date.now(),
        },
        { merge: true },
      );
    },
  });
  if (!fallbackWriteError) {
    console.warn("auth:merge:claim-sync-pending-fallback", {
      opId,
      targetProfileId,
      sourceProfileId,
      failedLoginUids,
    });
    return { location: "backlog" };
  }

  console.error("auth:merge:claim-sync-pending-write-failed", {
    opId,
    targetProfileId,
    sourceProfileId,
    failedLoginUids,
    profileWriteError:
      toCleanString(pendingWriteError && pendingWriteError.message) ||
      String(pendingWriteError),
    fallbackWriteError:
      toCleanString(fallbackWriteError && fallbackWriteError.message) ||
      String(fallbackWriteError),
  });
  return { location: "unpersisted" };
};

const recordMergeGameSyncFailure = async ({
  targetProfileId,
  sourceProfileId,
  opId,
  stage,
  operationsCount,
  error,
}) => {
  const firestore = admin.firestore();
  const failureMessage = toCleanString(error && error.message) || String(error);
  const normalizedStage = toCleanString(stage) || "unknown";
  const nowMs = Date.now();
  const backlogRef = firestore
    .collection("authMergeGameBacklog")
    .doc(`${toCleanString(opId) || createOpId()}:${normalizedStage}`);
  const backlogError = await runWithRetries({
    attempts: 3,
    baseDelayMs: 160,
    work: async () => {
      await backlogRef.set(
        {
          opId: toCleanString(opId) || null,
          targetProfileId,
          sourceProfileId,
          stage: normalizedStage,
          operationsCount,
          error: failureMessage,
          status: "pending",
          createdAtMs: nowMs,
          updatedAtMs: Date.now(),
        },
        { merge: true },
      );
    },
  });
  if (backlogError) {
    console.error("auth:merge:game-copy-backlog-write-failed", {
      opId,
      targetProfileId,
      sourceProfileId,
      stage: normalizedStage,
      operationsCount,
      copyError: failureMessage,
      backlogError:
        toCleanString(backlogError && backlogError.message) ||
        String(backlogError),
    });
  }
};

const mergeProfiles = async ({ targetProfileId, sourceProfileId, opId }) => {
  if (isFeatureDisabled("AUTH_DISABLE_MERGE")) {
    throw new HttpsError("failed-precondition", "merge-disabled");
  }
  if (targetProfileId === sourceProfileId) {
    const targetDoc = await admin
      .firestore()
      .collection("users")
      .doc(targetProfileId)
      .get();
    return targetDoc;
  }

  const firestore = admin.firestore();
  const targetRef = firestore.collection("users").doc(targetProfileId);
  const sourceRef = firestore.collection("users").doc(sourceProfileId);
  const profileMergeTargetRef = firestore
    .collection(PROFILE_MERGE_TARGETS_COLLECTION)
    .doc(sourceProfileId);
  const targetProfileMergeTargetRef = firestore
    .collection(PROFILE_MERGE_TARGETS_COLLECTION)
    .doc(targetProfileId);
  let lockRefs = [];
  lockRefs = await acquireMergeLocks({
    targetProfileId,
    sourceProfileId,
    opId,
  });

  try {
    const [targetSnapshot, sourceSnapshot] = await Promise.all([
      targetRef.get(),
      sourceRef.get(),
    ]);
    if (!targetSnapshot.exists) {
      throw new HttpsError("not-found", "target-profile-not-found");
    }
    if (!sourceSnapshot.exists) {
      const [profileMergeTargetSnapshot, targetProfileMergeTargetSnapshot] =
        await Promise.all([
          profileMergeTargetRef.get(),
          targetProfileMergeTargetRef.get(),
        ]);
      if (
        targetProfileMergeTargetSnapshot.exists &&
        getProfileMergeTargetId(targetProfileMergeTargetSnapshot.data())
      ) {
        throw new HttpsError(
          "failed-precondition",
          "target-profile-already-merged",
        );
      }
      const existingMergeTargetProfileId = profileMergeTargetSnapshot.exists
        ? getProfileMergeTargetId(profileMergeTargetSnapshot.data())
        : "";
      if (existingMergeTargetProfileId) {
        const canonicalMergeTargetProfileId =
          await resolveCanonicalProfileId(sourceProfileId);
        if (canonicalMergeTargetProfileId !== targetProfileId) {
          throw new HttpsError(
            "failed-precondition",
            "profile-merge-target-conflict",
          );
        }
      }
      if (existingMergeTargetProfileId) {
        const repairError = await runWithRetries({
          attempts: 3,
          baseDelayMs: 120,
          work: async () => {
            await copyProfileEventPrizesToCanonicalTarget(sourceProfileId);
          },
        });
        if (repairError) {
          console.error("auth:merge:event-prize-repair-pending", {
            opId,
            targetProfileId,
            sourceProfileId,
            error:
              toCleanString(repairError && repairError.message) ||
              String(repairError),
          });
        }
      }
      return targetSnapshot;
    }

    const targetData = targetSnapshot.data() || {};
    const sourceData = sourceSnapshot.data() || {};
    validateMergeMethodConflict(targetData, sourceData);
    const targetEth = normalizeFromProfileByMethod("eth", targetData);
    const sourceEth = normalizeFromProfileByMethod("eth", sourceData);
    const targetSol = normalizeFromProfileByMethod("sol", targetData);
    const sourceSol = normalizeFromProfileByMethod("sol", sourceData);
    const targetAppleSub = normalizeFromProfileByMethod("apple", targetData);
    const sourceAppleSub = normalizeFromProfileByMethod("apple", sourceData);
    const targetXUserId = normalizeFromProfileByMethod("x", targetData);
    const sourceXUserId = normalizeFromProfileByMethod("x", sourceData);
    const mergedEth = targetEth || sourceEth;
    const mergedSol = targetSol || sourceSol;
    const mergedAppleSub = targetAppleSub || sourceAppleSub;
    const mergedXUserId = targetXUserId || sourceXUserId;

    const mergedCustom = mergeCustom(targetData, sourceData);
    const mergedMining = mergeMining(targetData, sourceData);
    const mergedLogins = mergeUniqueStringArray(
      targetData.logins,
      sourceData.logins,
    );
    const mergedUsername =
      pickTargetOrSource(targetData.username, sourceData.username) || "";
    const mergedUsernameLookupKey = toUsernameLookupKey(mergedUsername);
    const resolveAppleMetadata = (targetValue, sourceValue) => {
      if (!mergedAppleSub) {
        return admin.firestore.FieldValue.delete();
      }
      if (targetAppleSub) {
        return (
          pickTargetOrSource(targetValue, sourceValue) ||
          admin.firestore.FieldValue.delete()
        );
      }
      return hasValue(sourceValue)
        ? sourceValue
        : admin.firestore.FieldValue.delete();
    };
    const resolveXMetadata = (targetValue, sourceValue) => {
      if (!mergedXUserId) {
        return admin.firestore.FieldValue.delete();
      }
      if (targetXUserId) {
        return (
          pickTargetOrSource(targetValue, sourceValue) ||
          admin.firestore.FieldValue.delete()
        );
      }
      return hasValue(sourceValue)
        ? sourceValue
        : admin.firestore.FieldValue.delete();
    };
    const mergedData = {
      logins: mergedLogins,
      username: mergedUsername,
      [USERNAME_LOOKUP_KEY_FIELD]:
        mergedUsernameLookupKey || admin.firestore.FieldValue.delete(),
      rating: Math.min(
        parseNumber(targetData.rating, 1500),
        parseNumber(sourceData.rating, 1500),
      ),
      nonce: Math.max(
        parseNumber(targetData.nonce, -1),
        parseNumber(sourceData.nonce, -1),
      ),
      totalManaPoints:
        parseNumber(targetData.totalManaPoints, 0) +
        parseNumber(sourceData.totalManaPoints, 0),
      win: hasValue(targetData.win) ? targetData.win : sourceData.win,
      feb2026UniqueOpponentsCount: Math.max(
        parseNumber(targetData.feb2026UniqueOpponentsCount, 0),
        parseNumber(sourceData.feb2026UniqueOpponentsCount, 0),
      ),
      eth: mergedEth || admin.firestore.FieldValue.delete(),
      sol: mergedSol || admin.firestore.FieldValue.delete(),
      appleSub: mergedAppleSub || admin.firestore.FieldValue.delete(),
      appleEmailMasked: resolveAppleMetadata(
        targetData.appleEmailMasked,
        sourceData.appleEmailMasked,
      ),
      appleLinkedAt: resolveAppleMetadata(
        targetData.appleLinkedAt,
        sourceData.appleLinkedAt,
      ),
      appleConsentAt: resolveAppleMetadata(
        targetData.appleConsentAt,
        sourceData.appleConsentAt,
      ),
      appleConsentSource: resolveAppleMetadata(
        targetData.appleConsentSource,
        sourceData.appleConsentSource,
      ),
      xUserId: mergedXUserId || admin.firestore.FieldValue.delete(),
      xUsername: resolveXMetadata(targetData.xUsername, sourceData.xUsername),
      xLinkedAt: resolveXMetadata(targetData.xLinkedAt, sourceData.xLinkedAt),
      xConsentAt: resolveXMetadata(
        targetData.xConsentAt,
        sourceData.xConsentAt,
      ),
      xConsentSource: resolveXMetadata(
        targetData.xConsentSource,
        sourceData.xConsentSource,
      ),
      custom: mergedCustom,
      mining: mergedMining,
      mergedAtMs: Date.now(),
      mergedSourceProfileId: sourceProfileId,
    };

    const [sourceGamesSnapshot, targetGamesSnapshot] = await Promise.all([
      sourceRef.collection("games").get(),
      targetRef.collection("games").get(),
    ]);
    const targetGameByInvite = new Map();
    targetGamesSnapshot.forEach((doc) => {
      targetGameByInvite.set(doc.id, doc);
    });
    const gameCopyOps = [];
    const sourceGameDeleteOps = [];
    sourceGamesSnapshot.forEach((sourceGameDoc) => {
      const sourceDataForInvite = sourceGameDoc.data() || {};
      const targetDocForInvite = targetGameByInvite.get(sourceGameDoc.id);
      const shouldWriteToTarget =
        !targetDocForInvite ||
        readMergeFreshness(sourceDataForInvite) >=
          readMergeFreshness(targetDocForInvite.data() || {});
      if (shouldWriteToTarget) {
        gameCopyOps.push({
          type: "set",
          ref: targetRef.collection("games").doc(sourceGameDoc.id),
          data: sourceDataForInvite,
          merge: true,
        });
      }
      sourceGameDeleteOps.push({
        type: "delete",
        ref: sourceGameDoc.ref,
      });
    });

    const methodIndexEntries = [];
    if (mergedEth) {
      methodIndexEntries.push({ method: "eth", normalizedValue: mergedEth });
    }
    if (mergedSol) {
      methodIndexEntries.push({ method: "sol", normalizedValue: mergedSol });
    }
    if (mergedAppleSub) {
      methodIndexEntries.push({
        method: "apple",
        normalizedValue: mergedAppleSub,
      });
    }
    if (mergedXUserId) {
      methodIndexEntries.push({ method: "x", normalizedValue: mergedXUserId });
    }
    const allowedIndexOwners = new Set(
      [targetProfileId, sourceProfileId]
        .map((value) => toCleanString(value))
        .filter((value) => value !== ""),
    );
    const nowMs = Date.now();
    const sourceMergeRetainedPatch = {
      logins: [],
      eth: admin.firestore.FieldValue.delete(),
      sol: admin.firestore.FieldValue.delete(),
      appleSub: admin.firestore.FieldValue.delete(),
      appleEmailMasked: admin.firestore.FieldValue.delete(),
      appleLinkedAt: admin.firestore.FieldValue.delete(),
      appleConsentAt: admin.firestore.FieldValue.delete(),
      appleConsentSource: admin.firestore.FieldValue.delete(),
      xUserId: admin.firestore.FieldValue.delete(),
      xUsername: admin.firestore.FieldValue.delete(),
      xLinkedAt: admin.firestore.FieldValue.delete(),
      xConsentAt: admin.firestore.FieldValue.delete(),
      xConsentSource: admin.firestore.FieldValue.delete(),
      username: admin.firestore.FieldValue.delete(),
      [USERNAME_LOOKUP_KEY_FIELD]: admin.firestore.FieldValue.delete(),
      rating: admin.firestore.FieldValue.delete(),
      totalManaPoints: admin.firestore.FieldValue.delete(),
      nonce: admin.firestore.FieldValue.delete(),
      win: admin.firestore.FieldValue.delete(),
      feb2026UniqueOpponentsCount: admin.firestore.FieldValue.delete(),
      custom: admin.firestore.FieldValue.delete(),
      mining: admin.firestore.FieldValue.delete(),
      mergedIntoProfileId: targetProfileId,
      mergedAtMs: nowMs,
      mergeSourceRetainedForGameCopy: true,
    };
    await firestore.runTransaction(async (transaction) => {
      const [
        liveTargetSnapshot,
        liveSourceSnapshot,
        profileMergeTargetSnapshot,
        targetProfileMergeTargetSnapshot,
      ] = await Promise.all([
        transaction.get(targetRef),
        transaction.get(sourceRef),
        transaction.get(profileMergeTargetRef),
        transaction.get(targetProfileMergeTargetRef),
      ]);
      if (!liveTargetSnapshot.exists) {
        throw new HttpsError("not-found", "target-profile-not-found");
      }
      const existingMergeTargetProfileId = profileMergeTargetSnapshot.exists
        ? getProfileMergeTargetId(profileMergeTargetSnapshot.data())
        : "";
      if (
        existingMergeTargetProfileId &&
        existingMergeTargetProfileId !== targetProfileId
      ) {
        throw new HttpsError(
          "failed-precondition",
          "profile-merge-target-conflict",
        );
      }
      if (
        targetProfileMergeTargetSnapshot.exists &&
        getProfileMergeTargetId(targetProfileMergeTargetSnapshot.data())
      ) {
        throw new HttpsError(
          "failed-precondition",
          "target-profile-already-merged",
        );
      }
      const methodIndexRefs = methodIndexEntries.map((entry) =>
        firestore
          .collection("authMethodIndex")
          .doc(getMethodKey(entry.method, entry.normalizedValue)),
      );
      const methodIndexSnapshots =
        methodIndexRefs.length > 0
          ? await Promise.all(
              methodIndexRefs.map((indexRef) => transaction.get(indexRef)),
            )
          : [];
      methodIndexSnapshots.forEach((indexSnapshot) => {
        if (indexSnapshot && indexSnapshot.exists) {
          const indexData = indexSnapshot.data() || {};
          const indexedProfileId = toCleanString(indexData.profileId);
          if (indexedProfileId && !allowedIndexOwners.has(indexedProfileId)) {
            throw new HttpsError(
              "failed-precondition",
              "method-index-conflict",
            );
          }
        }
      });

      const usernameIndexCollection = firestore.collection("usernameIndex");
      const liveTargetData = liveTargetSnapshot.data() || {};
      const liveSourceData = liveSourceSnapshot.exists
        ? liveSourceSnapshot.data() || {}
        : {};
      const liveTargetUsername = toCleanString(liveTargetData.username);
      const liveSourceUsername = toCleanString(liveSourceData.username);
      const mergedUsername = toCleanString(mergedData.username);
      const mergedUsernameKeyCandidate = toUsernameLookupKey(mergedUsername);
      const mergedUsernameKey = isSafeFirestoreDocIdSegment(
        mergedUsernameKeyCandidate,
      )
        ? mergedUsernameKeyCandidate
        : "";
      let mergedUsernameIndexRef = null;

      if (mergedUsernameKey) {
        mergedUsernameIndexRef = usernameIndexCollection.doc(mergedUsernameKey);
        const mergedUsernameIndexSnapshot = await transaction.get(
          mergedUsernameIndexRef,
        );
        if (mergedUsernameIndexSnapshot.exists) {
          const mergedUsernameIndexData =
            mergedUsernameIndexSnapshot.data() || {};
          const indexedProfileId = toCleanString(
            mergedUsernameIndexData.profileId,
          );
          if (indexedProfileId && !allowedIndexOwners.has(indexedProfileId)) {
            const indexedProfileRef = firestore
              .collection("users")
              .doc(indexedProfileId);
            const indexedProfileSnapshot =
              await transaction.get(indexedProfileRef);
            if (indexedProfileSnapshot.exists) {
              const indexedProfileData = indexedProfileSnapshot.data() || {};
              const indexedUsernameKey = toUsernameLookupKey(
                indexedProfileData.username,
              );
              if (indexedUsernameKey === mergedUsernameKey) {
                throw new HttpsError(
                  "failed-precondition",
                  "username-index-conflict",
                );
              }
            }
          }
        }

        const lookupKeyConflictSnapshot = await transaction.get(
          firestore
            .collection("users")
            .where(USERNAME_LOOKUP_KEY_FIELD, "==", mergedUsernameKey),
        );
        lookupKeyConflictSnapshot.forEach((userSnapshot) => {
          const userId = toCleanString(userSnapshot.id);
          if (allowedIndexOwners.has(userId)) {
            return;
          }
          const userData = userSnapshot.data() || {};
          if (toUsernameLookupKey(userData.username) === mergedUsernameKey) {
            throw new HttpsError(
              "failed-precondition",
              "username-index-conflict",
            );
          }
        });

        const exactUsernameSnapshot = await transaction.get(
          firestore
            .collection("users")
            .where("username", "==", mergedUsername)
            .limit(3),
        );
        exactUsernameSnapshot.forEach((userSnapshot) => {
          if (!allowedIndexOwners.has(toCleanString(userSnapshot.id))) {
            throw new HttpsError(
              "failed-precondition",
              "username-index-conflict",
            );
          }
        });

        if (mergedUsername !== mergedUsernameKey) {
          const lowercaseUsernameSnapshot = await transaction.get(
            firestore
              .collection("users")
              .where("username", "==", mergedUsernameKey)
              .limit(3),
          );
          lowercaseUsernameSnapshot.forEach((userSnapshot) => {
            if (!allowedIndexOwners.has(toCleanString(userSnapshot.id))) {
              throw new HttpsError(
                "failed-precondition",
                "username-index-conflict",
              );
            }
          });
        }
      }

      const staleUsernameIndexDocIds = new Set();
      getUsernameIndexDocIds(liveTargetUsername).forEach((docId) =>
        staleUsernameIndexDocIds.add(docId),
      );
      getUsernameIndexDocIds(liveSourceUsername).forEach((docId) =>
        staleUsernameIndexDocIds.add(docId),
      );
      getUsernameIndexDocIds(mergedUsername).forEach((docId) => {
        if (docId !== mergedUsernameKey) {
          staleUsernameIndexDocIds.add(docId);
        }
      });
      if (mergedUsernameKey) {
        staleUsernameIndexDocIds.delete(mergedUsernameKey);
      }
      const staleUsernameIndexRefs = Array.from(staleUsernameIndexDocIds).map(
        (docId) => usernameIndexCollection.doc(docId),
      );
      const staleUsernameIndexSnapshots =
        staleUsernameIndexRefs.length > 0
          ? await Promise.all(
              staleUsernameIndexRefs.map((ref) => transaction.get(ref)),
            )
          : [];

      methodIndexEntries.forEach((entry, entryIndex) => {
        const indexRef = methodIndexRefs[entryIndex];
        transaction.set(
          indexRef,
          {
            profileId: targetProfileId,
            method: entry.method,
            normalizedValue: entry.normalizedValue,
            updatedAtMs: nowMs,
          },
          { merge: true },
        );
      });
      if (mergedUsernameIndexRef) {
        transaction.set(
          mergedUsernameIndexRef,
          {
            profileId: targetProfileId,
            username: mergedUsername,
            lookupKey: mergedUsernameKey,
            updatedAtMs: nowMs,
          },
          { merge: true },
        );
      }
      staleUsernameIndexSnapshots.forEach((indexSnapshot, index) => {
        if (!indexSnapshot.exists) {
          return;
        }
        const indexData = indexSnapshot.data() || {};
        const indexedProfileId = toCleanString(indexData.profileId);
        if (
          indexedProfileId === targetProfileId ||
          indexedProfileId === sourceProfileId
        ) {
          transaction.delete(staleUsernameIndexRefs[index]);
        }
      });

      transaction.set(targetRef, mergedData, { merge: true });
      transaction.set(
        profileMergeTargetRef,
        {
          sourceProfileId,
          targetProfileId,
          mergedAtMs: nowMs,
          opId: toCleanString(opId) || null,
        },
        { merge: true },
      );
      if (liveSourceSnapshot.exists) {
        transaction.set(sourceRef, sourceMergeRetainedPatch, { merge: true });
      }
    });
    const prizeCopyError = await runWithRetries({
      attempts: 3,
      baseDelayMs: 120,
      work: async () => {
        await copyProfileEventPrizesToCanonicalTarget(sourceProfileId);
      },
    });
    if (prizeCopyError) {
      console.error("auth:merge:event-prize-copy-pending", {
        opId,
        targetProfileId,
        sourceProfileId,
        error:
          toCleanString(prizeCopyError && prizeCopyError.message) ||
          String(prizeCopyError),
      });
    }
    const mergedTargetSnapshot = await targetRef.get();
    const gameCopyError = await runWithRetries({
      attempts: 3,
      baseDelayMs: 120,
      work: async () => {
        await commitOperations(gameCopyOps);
      },
    });
    if (gameCopyError) {
      console.error("auth:merge:game-copy-partial-failure", {
        opId,
        targetProfileId,
        sourceProfileId,
        gameCopyOpsCount: gameCopyOps.length,
        error:
          toCleanString(gameCopyError && gameCopyError.message) ||
          String(gameCopyError),
      });
      const pendingMarkerError = await runWithRetries({
        attempts: 3,
        baseDelayMs: 120,
        work: async () => {
          await targetRef.set(
            {
              pendingMergeGameCopySourceProfileId: sourceProfileId,
              pendingMergeGameCopyUpdatedAtMs: Date.now(),
            },
            { merge: true },
          );
        },
      });
      if (pendingMarkerError) {
        console.error("auth:merge:game-copy-pending-marker-write-failed", {
          opId,
          targetProfileId,
          sourceProfileId,
          error:
            toCleanString(pendingMarkerError && pendingMarkerError.message) ||
            String(pendingMarkerError),
        });
      }
      await recordMergeGameSyncFailure({
        targetProfileId,
        sourceProfileId,
        opId,
        stage: "copy",
        operationsCount: gameCopyOps.length,
        error: gameCopyError,
      });
    } else {
      const clearPendingMarkerError = await runWithRetries({
        attempts: 3,
        baseDelayMs: 120,
        work: async () => {
          const targetSnapshotForMarker = await targetRef.get();
          const targetMarkerData = targetSnapshotForMarker.data() || {};
          const pendingSourceProfileId = toCleanString(
            targetMarkerData.pendingMergeGameCopySourceProfileId,
          );
          if (
            pendingSourceProfileId &&
            pendingSourceProfileId !== sourceProfileId
          ) {
            return;
          }
          await targetRef.set(
            {
              pendingMergeGameCopySourceProfileId:
                admin.firestore.FieldValue.delete(),
              pendingMergeGameCopyUpdatedAtMs:
                admin.firestore.FieldValue.delete(),
            },
            { merge: true },
          );
        },
      });
      if (clearPendingMarkerError) {
        console.error("auth:merge:game-copy-pending-marker-clear-failed", {
          opId,
          targetProfileId,
          sourceProfileId,
          error:
            toCleanString(
              clearPendingMarkerError && clearPendingMarkerError.message,
            ) || String(clearPendingMarkerError),
        });
      }
      const sourceGameCleanupError = await runWithRetries({
        attempts: 3,
        baseDelayMs: 100,
        work: async () => {
          await commitOperations(sourceGameDeleteOps);
        },
      });
      if (sourceGameCleanupError) {
        console.error("auth:merge:source-games-cleanup-partial-failure", {
          opId,
          targetProfileId,
          sourceProfileId,
          sourceGameDeleteOpsCount: sourceGameDeleteOps.length,
          error:
            toCleanString(
              sourceGameCleanupError && sourceGameCleanupError.message,
            ) || String(sourceGameCleanupError),
        });
        await recordMergeGameSyncFailure({
          targetProfileId,
          sourceProfileId,
          opId,
          stage: "cleanup",
          operationsCount: sourceGameDeleteOps.length,
          error: sourceGameCleanupError,
        });
      }
      const sourceDeleteError = await runWithRetries({
        attempts: 3,
        baseDelayMs: 120,
        work: async () => {
          const sourceSnapshotForDelete = await sourceRef.get();
          if (!sourceSnapshotForDelete.exists) {
            return;
          }
          await sourceRef.delete();
        },
      });
      if (sourceDeleteError) {
        console.error("auth:merge:source-profile-delete-partial-failure", {
          opId,
          targetProfileId,
          sourceProfileId,
          error:
            toCleanString(sourceDeleteError && sourceDeleteError.message) ||
            String(sourceDeleteError),
        });
        await recordMergeGameSyncFailure({
          targetProfileId,
          sourceProfileId,
          opId,
          stage: "delete-source-profile",
          operationsCount: 1,
          error: sourceDeleteError,
        });
      }
    }

    const claimSyncResults = await Promise.allSettled(
      mergedLogins.map(async (loginUid) => {
        await ensureProfileClaimAndRtdb(loginUid, targetProfileId);
      }),
    );
    const initialClaimFailures = claimSyncResults
      .map((result, index) =>
        result.status === "rejected" ? mergedLogins[index] : null,
      )
      .filter((value) => typeof value === "string" && value !== "");
    const retryClaimFailures = [];
    for (const failedLoginUid of initialClaimFailures) {
      try {
        await ensureProfileClaimAndRtdb(failedLoginUid, targetProfileId);
      } catch {
        retryClaimFailures.push(failedLoginUid);
      }
    }
    if (retryClaimFailures.length > 0) {
      console.error("auth:merge:claim-sync-partial-failure", {
        opId,
        targetProfileId,
        sourceProfileId,
        failedLoginUids: retryClaimFailures,
      });
      await persistPendingClaimSync({
        targetRef,
        targetProfileId,
        sourceProfileId,
        failedLoginUids: retryClaimFailures,
        opId,
      });
    } else {
      const pendingClearError = await runWithRetries({
        attempts: 3,
        baseDelayMs: 120,
        work: async () => {
          await targetRef.set(
            {
              pendingClaimSyncLogins: admin.firestore.FieldValue.delete(),
              pendingClaimSyncUpdatedAtMs: admin.firestore.FieldValue.delete(),
            },
            { merge: true },
          );
        },
      });
      if (pendingClearError) {
        console.error("auth:merge:claim-sync-pending-clear-failed", {
          opId,
          targetProfileId,
          sourceProfileId,
          error:
            toCleanString(pendingClearError && pendingClearError.message) ||
            String(pendingClearError),
        });
      }
    }

    return mergedTargetSnapshot;
  } finally {
    await releaseMergeLocks(lockRefs, opId);
  }
};

const buildMethodPatch = ({
  method,
  methodValueRaw,
  appleEmailMasked,
  xUsername,
  consentSource,
}) => {
  if (method === "eth") {
    return { eth: methodValueRaw };
  }
  if (method === "sol") {
    return { sol: methodValueRaw };
  }
  if (method === "apple") {
    const patch = {
      appleSub: methodValueRaw,
      appleLinkedAt: Date.now(),
      appleConsentAt: Date.now(),
      appleConsentSource: consentSource || "signin",
    };
    if (appleEmailMasked) {
      patch.appleEmailMasked = appleEmailMasked;
    }
    return patch;
  }
  if (method === "x") {
    const patch = {
      xUserId: methodValueRaw,
      xLinkedAt: Date.now(),
      xConsentAt: Date.now(),
      xConsentSource: consentSource || "signin",
    };
    if (xUsername) {
      patch.xUsername = xUsername;
    }
    return patch;
  }
  throw new HttpsError("invalid-argument", "Unsupported auth method.");
};

const createInitialProfileWithIndex = async ({
  uid,
  method,
  normalizedMethodValue,
  methodValueRaw,
  requestEmoji,
  requestAura,
  appleEmailMasked,
  xUsername,
  consentSource,
}) => {
  const firestore = admin.firestore();
  const indexRef = firestore
    .collection("authMethodIndex")
    .doc(getMethodKey(method, normalizedMethodValue));
  let profileId = "";
  let created = false;
  await firestore.runTransaction(async (transaction) => {
    const cleanupRefsByPath = new Map();
    const indexSnapshot = await transaction.get(indexRef);
    if (indexSnapshot.exists) {
      const indexData = indexSnapshot.data() || {};
      const indexedProfileId = toCleanString(indexData.profileId);
      if (indexedProfileId) {
        const indexedProfileRef = firestore
          .collection("users")
          .doc(indexedProfileId);
        const indexedProfileSnapshot = await transaction.get(indexedProfileRef);
        if (indexedProfileSnapshot.exists) {
          const indexedNormalizedValue = normalizeFromProfileByMethod(
            method,
            indexedProfileSnapshot.data() || {},
          );
          if (indexedNormalizedValue === normalizedMethodValue) {
            profileId = indexedProfileId;
            return;
          }
        }
      }
    }
    const nowMs = Date.now();
    await enforceMethodReuseCooldownInTransaction({
      transaction,
      method,
      normalizedMethodValue,
      nowMs,
      cleanupRefsByPath,
    });
    applyQueuedCleanupDeletes({
      transaction,
      cleanupRefsByPath,
    });
    const userRef = firestore.collection("users").doc();
    profileId = userRef.id;
    created = true;
    const baseProfile = {
      logins: [uid],
      custom: {
        emoji: requestEmoji ?? 1,
        aura: requestAura ?? null,
      },
      mining: normalizeMiningSnapshot(),
    };
    const methodPatch = buildMethodPatch({
      method,
      methodValueRaw,
      appleEmailMasked,
      xUsername,
      consentSource,
    });
    transaction.set(userRef, { ...baseProfile, ...methodPatch });
    transaction.set(indexRef, {
      profileId,
      method,
      normalizedValue: normalizedMethodValue,
      updatedAtMs: Date.now(),
    });
  });
  return { profileId, created };
};

const ensureProfileMethodAndLoginAndIndex = async ({
  profileId,
  uid,
  method,
  normalizedMethodValue,
  methodValueRaw,
  appleEmailMasked,
  xUsername,
  consentSource,
}) => {
  const firestore = admin.firestore();
  const profileRef = firestore.collection("users").doc(profileId);
  const indexRef = firestore
    .collection("authMethodIndex")
    .doc(getMethodKey(method, normalizedMethodValue));
  let conflictProfileId = "";
  await firestore.runTransaction(async (transaction) => {
    const nowMs = Date.now();
    const cleanupRefsByPath = new Map();
    conflictProfileId = "";
    const profileSnapshot = await transaction.get(profileRef);
    if (!profileSnapshot.exists) {
      throw new HttpsError("not-found", "profile-not-found");
    }
    const profileData = profileSnapshot.data() || {};
    ensureMethodCompatibility(profileData, method, normalizedMethodValue);
    const existingNormalizedValue = normalizeFromProfileByMethod(
      method,
      profileData,
    );
    const isMethodAlreadyLinkedToProfile =
      existingNormalizedValue === normalizedMethodValue;

    if (!isMethodAlreadyLinkedToProfile) {
      await enforceProfileMethodCooldownInTransaction({
        transaction,
        profileId,
        method,
        nowMs,
        cleanupRefsByPath,
      });
      await enforceMethodReuseCooldownInTransaction({
        transaction,
        method,
        normalizedMethodValue,
        nowMs,
        cleanupRefsByPath,
      });
    }

    const indexSnapshot = await transaction.get(indexRef);
    if (indexSnapshot.exists) {
      const indexData = indexSnapshot.data() || {};
      const indexedProfileId = toCleanString(indexData.profileId);
      if (indexedProfileId && indexedProfileId !== profileId) {
        const indexedProfileRef = firestore
          .collection("users")
          .doc(indexedProfileId);
        const indexedProfileSnapshot = await transaction.get(indexedProfileRef);
        if (indexedProfileSnapshot.exists) {
          const indexedNormalizedValue = normalizeFromProfileByMethod(
            method,
            indexedProfileSnapshot.data() || {},
          );
          if (indexedNormalizedValue === normalizedMethodValue) {
            conflictProfileId = indexedProfileId;
            return;
          }
        }
      }
    }

    applyQueuedCleanupDeletes({
      transaction,
      cleanupRefsByPath,
    });

    const patch = buildMethodPatch({
      method,
      methodValueRaw,
      appleEmailMasked,
      xUsername,
      consentSource,
    });
    transaction.set(
      profileRef,
      {
        ...patch,
        logins: admin.firestore.FieldValue.arrayUnion(uid),
      },
      { merge: true },
    );
    transaction.set(
      indexRef,
      {
        profileId,
        method,
        normalizedValue: normalizedMethodValue,
        updatedAtMs: nowMs,
      },
      { merge: true },
    );
  });
  return conflictProfileId;
};

const linkVerifiedMethod = async ({
  uid,
  method,
  methodValueRaw,
  methodValueLookupRaw,
  normalizedMethodValue,
  requestEmoji,
  requestAura,
  appleEmailMasked,
  xUsername,
  consentSource,
  preferredAddress,
  opId,
  request,
}) => {
  await enforceRateLimit({ uid, method: `verify-${method}`, request });
  const op = await beginAuthOp({
    opId,
    kind: "verify",
    method,
    uid,
    meta: {
      methodValue:
        method === "apple" || method === "x" ? "redacted" : methodValueRaw,
      methodValueHash: hashMethodValue(method, normalizedMethodValue),
    },
  });
  if (op.replay) {
    return op.replay;
  }

  try {
    let currentProfile = await readProfileByLoginUid(uid);
    const methodLookupValue =
      toCleanString(methodValueLookupRaw) || methodValueRaw;
    let methodProfile = await readProfileByMethod(
      method,
      normalizedMethodValue,
      methodLookupValue,
    );
    let targetProfileId = "";

    if (!currentProfile && !methodProfile) {
      const createdResult = await createInitialProfileWithIndex({
        uid,
        method,
        normalizedMethodValue,
        methodValueRaw,
        requestEmoji,
        requestAura,
        appleEmailMasked,
        xUsername,
        consentSource,
      });
      targetProfileId = createdResult.profileId;
      if (!targetProfileId) {
        methodProfile = await readProfileByMethod(
          method,
          normalizedMethodValue,
          methodLookupValue,
        );
        if (!methodProfile) {
          throw new HttpsError("aborted", "method-index-race-retry");
        }
        targetProfileId = methodProfile.id;
      }
    } else if (!currentProfile && methodProfile) {
      targetProfileId = methodProfile.id;
    } else if (currentProfile && !methodProfile) {
      targetProfileId = currentProfile.id;
    } else if (
      currentProfile &&
      methodProfile &&
      currentProfile.id === methodProfile.id
    ) {
      targetProfileId = currentProfile.id;
    } else if (
      currentProfile &&
      methodProfile &&
      currentProfile.id !== methodProfile.id
    ) {
      targetProfileId = currentProfile.id;
    } else {
      throw new HttpsError("internal", "unexpected-auth-state");
    }

    let didLinkMethod = false;
    for (let attempt = 1; attempt <= LINK_METHOD_MAX_ATTEMPTS; attempt += 1) {
      const conflictProfileId = await ensureProfileMethodAndLoginAndIndex({
        profileId: targetProfileId,
        uid,
        method,
        normalizedMethodValue,
        methodValueRaw,
        appleEmailMasked,
        xUsername,
        consentSource,
      });
      if (!conflictProfileId || conflictProfileId === targetProfileId) {
        didLinkMethod = true;
        break;
      }
      const mergedSnapshot = await mergeProfiles({
        targetProfileId,
        sourceProfileId: conflictProfileId,
        opId: op.opId,
      });
      targetProfileId = mergedSnapshot.id;
    }
    if (!didLinkMethod) {
      throw new HttpsError("aborted", "method-index-race-retry");
    }

    let targetProfileSnapshot = await admin
      .firestore()
      .collection("users")
      .doc(targetProfileId)
      .get();
    if (!targetProfileSnapshot.exists) {
      throw new HttpsError("internal", "target-profile-missing");
    }
    if (method === "apple" || method === "x") {
      targetProfileSnapshot =
        await assignRandomUsernameIfNeededForWalletlessProfile({
          profileId: targetProfileId,
          preferredUsername: method === "x" ? xUsername : null,
        });
    }
    await ensureProfileClaimAndRtdb(uid, targetProfileId);

    const response = buildProfileResponse(
      targetProfileSnapshot,
      uid,
      preferredAddress || methodValueRaw,
    );
    response.opId = op.opId;
    await finishAuthOp({ opId: op.opId, result: response });
    return response;
  } catch (error) {
    await finishAuthOp({ opId: op.opId, error });
    throw error;
  }
};

const unlinkMethodForUid = async ({ uid, method, opId, request }) => {
  const normalizedMethod = assertSupportedMethod(method);
  if (isFeatureDisabled("AUTH_DISABLE_UNLINK")) {
    throw new HttpsError("failed-precondition", "unlink-disabled");
  }
  await enforceRateLimit({
    uid,
    method: `unlink-${normalizedMethod}`,
    request,
  });
  const op = await beginAuthOp({
    opId,
    kind: "unlink",
    method: normalizedMethod,
    uid,
    meta: null,
  });
  if (op.replay) {
    return op.replay;
  }

  try {
    const profileSnapshot = await readProfileByLoginUid(uid);
    if (!profileSnapshot) {
      throw new HttpsError("not-found", "profile-not-found");
    }
    const profileId = profileSnapshot.id;
    const firestore = admin.firestore();
    const profileRef = firestore.collection("users").doc(profileId);
    await firestore.runTransaction(async (transaction) => {
      const liveProfileSnapshot = await transaction.get(profileRef);
      if (!liveProfileSnapshot.exists) {
        throw new HttpsError("not-found", "profile-not-found");
      }
      const liveProfileData = liveProfileSnapshot.data() || {};
      const linkedCount = linkedMethodCount(liveProfileData);
      const normalizedValue = normalizeFromProfileByMethod(
        normalizedMethod,
        liveProfileData,
      );
      const rawValue = getMethodValueFromProfile(
        liveProfileData,
        normalizedMethod,
      );
      if (!normalizedValue && !rawValue) {
        throw new HttpsError("failed-precondition", "method-not-linked");
      }
      if (normalizedValue && linkedCount <= 1) {
        throw new HttpsError(
          "failed-precondition",
          "cannot-remove-last-method",
        );
      }

      const updateData = {};
      if (normalizedMethod === "eth") {
        updateData.eth = admin.firestore.FieldValue.delete();
      } else if (normalizedMethod === "sol") {
        updateData.sol = admin.firestore.FieldValue.delete();
      } else if (normalizedMethod === "apple") {
        updateData.appleSub = admin.firestore.FieldValue.delete();
        updateData.appleEmailMasked = admin.firestore.FieldValue.delete();
        updateData.appleLinkedAt = admin.firestore.FieldValue.delete();
        updateData.appleConsentAt = admin.firestore.FieldValue.delete();
        updateData.appleConsentSource = admin.firestore.FieldValue.delete();
      } else if (normalizedMethod === "x") {
        updateData.xUserId = admin.firestore.FieldValue.delete();
        updateData.xUsername = admin.firestore.FieldValue.delete();
        updateData.xLinkedAt = admin.firestore.FieldValue.delete();
        updateData.xConsentAt = admin.firestore.FieldValue.delete();
        updateData.xConsentSource = admin.firestore.FieldValue.delete();
      } else {
        throw new HttpsError("invalid-argument", "Unsupported auth method.");
      }
      let indexRef = null;
      let shouldDeleteIndex = false;
      let revocationRef = null;
      const profileMethodCooldownRef = firestore
        .collection("authProfileMethodCooldowns")
        .doc(getProfileMethodCooldownDocId(profileId, normalizedMethod));
      if (normalizedValue) {
        const methodDocId = getMethodKey(normalizedMethod, normalizedValue);
        indexRef = firestore.collection("authMethodIndex").doc(methodDocId);
        revocationRef = firestore
          .collection("authMethodRevocations")
          .doc(methodDocId);
        const indexSnapshot = await transaction.get(indexRef);
        if (indexSnapshot.exists) {
          const indexData = indexSnapshot.data() || {};
          const indexedProfileId = toCleanString(indexData.profileId);
          if (!indexedProfileId || indexedProfileId === profileId) {
            shouldDeleteIndex = true;
          } else {
            const indexedProfileRef = firestore
              .collection("users")
              .doc(indexedProfileId);
            const indexedProfileSnapshot =
              await transaction.get(indexedProfileRef);
            if (!indexedProfileSnapshot.exists) {
              shouldDeleteIndex = true;
            } else {
              const indexedNormalizedValue = normalizeFromProfileByMethod(
                normalizedMethod,
                indexedProfileSnapshot.data() || {},
              );
              if (indexedNormalizedValue !== normalizedValue) {
                shouldDeleteIndex = true;
              }
            }
          }
        }
      }

      transaction.update(profileRef, updateData);

      if (shouldDeleteIndex && indexRef) {
        transaction.delete(indexRef);
      }

      const cooldownStartedAtMs = Date.now();
      const cooldownRetryAtMs =
        cooldownStartedAtMs + AUTH_METHOD_REUSE_COOLDOWN_MS;
      transaction.set(
        profileMethodCooldownRef,
        {
          profileId,
          method: normalizedMethod,
          scope: getAuthCooldownScope(AUTH_COOLDOWN_REASONS.profileMethod),
          unlinkedByUid: uid,
          cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
          startedAtMs: cooldownStartedAtMs,
          retryAtMs: cooldownRetryAtMs,
          updatedAtMs: cooldownStartedAtMs,
        },
        { merge: true },
      );

      if (normalizedValue && revocationRef) {
        transaction.set(
          revocationRef,
          {
            method: normalizedMethod,
            normalizedValue,
            profileId,
            scope: getAuthCooldownScope(AUTH_COOLDOWN_REASONS.method),
            unlinkedByUid: uid,
            cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
            startedAtMs: cooldownStartedAtMs,
            retryAtMs: cooldownRetryAtMs,
            updatedAtMs: cooldownStartedAtMs,
          },
          { merge: true },
        );
      }
    });

    const refreshedSnapshot = await profileRef.get();
    const refreshedLinkedMethods = linkedMethodsFromProfileData(
      refreshedSnapshot.data() || {},
    );
    const response = {
      ok: true,
      profileId,
      linkedMethods: refreshedLinkedMethods,
      appleLinked: refreshedLinkedMethods.apple,
    };
    await finishAuthOp({ opId: op.opId, result: response });
    return response;
  } catch (error) {
    await finishAuthOp({ opId: op.opId, error });
    throw error;
  }
};

const getLinkedMethodsForUid = async (uid) => {
  const profileSnapshot = await readProfileByLoginUid(uid);
  if (!profileSnapshot) {
    return {
      ok: true,
      profileId: null,
      linkedMethods: {
        apple: false,
        eth: false,
        sol: false,
        x: false,
      },
      appleLinked: false,
    };
  }
  const linkedMethods = linkedMethodsFromProfileData(
    profileSnapshot.data() || {},
  );
  return {
    ok: true,
    profileId: profileSnapshot.id,
    linkedMethods,
    appleLinked: linkedMethods.apple,
  };
};

const syncProfileClaimForUid = async (uid) => {
  const profileSnapshot = await readProfileByLoginUid(uid);
  if (!profileSnapshot) {
    try {
      const normalizedUid = toCleanString(uid);
      if (normalizedUid) {
        const auth = admin.auth();
        const profileRef = admin
          .database()
          .ref(`players/${normalizedUid}/profile`);
        const [userRecord, profileLinkSnapshot] = await Promise.all([
          auth.getUser(normalizedUid),
          profileRef.once("value"),
        ]);
        const claims = { ...(userRecord.customClaims || {}) };
        const hasProfileClaim = Object.prototype.hasOwnProperty.call(
          claims,
          "profileId",
        );
        if (hasProfileClaim) {
          delete claims.profileId;
        }
        const writes = [];
        if (hasProfileClaim) {
          writes.push(auth.setCustomUserClaims(normalizedUid, claims));
        }
        if (profileLinkSnapshot.exists()) {
          writes.push(profileRef.remove());
        }
        if (writes.length > 0) {
          await Promise.all(writes);
        }
      }
    } catch {}
    return {
      ok: true,
      profileId: null,
      linkedMethods: {
        apple: false,
        eth: false,
        sol: false,
        x: false,
      },
      appleLinked: false,
    };
  }
  await ensureProfileClaimAndRtdb(uid, profileSnapshot.id);
  const linkedMethods = linkedMethodsFromProfileData(
    profileSnapshot.data() || {},
  );
  return {
    ok: true,
    profileId: profileSnapshot.id,
    linkedMethods,
    appleLinked: linkedMethods.apple,
  };
};

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const APPLE_JWKS_UNKNOWN_KID_FORCE_REFRESH_COOLDOWN_MS = 60 * 1000;
const APPLE_JWKS_RECENT_FETCH_WINDOW_MS = 5 * 1000;
let appleJwksCache = {
  fetchedAtMs: 0,
  keysByKid: new Map(),
};
let appleJwksFetchPromise = null;
let appleJwksLastUnknownKidRefreshAtMs = 0;

const getAppleAudiences = () => {
  const configured = toCleanString(process.env.APPLE_AUDIENCES);
  if (configured) {
    return configured
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "");
  }
  const fallback = toCleanString(process.env.APPLE_CLIENT_ID);
  if (fallback) {
    return [fallback];
  }
  return [];
};

const buildNonceHashes = (nonce) => {
  const digestBuffer = crypto.createHash("sha256").update(nonce).digest();
  const digestHex = digestBuffer.toString("hex");
  const digestBase64Url = digestBuffer.toString("base64url");
  return new Set([nonce, digestHex, digestBase64Url]);
};

const decodeJwtPart = (value) => {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpsError("invalid-argument", "Invalid JWT structure.");
  }
};

const readJwt = (token) => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpsError("invalid-argument", "Invalid JWT format.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);
  const signature = Buffer.from(encodedSignature, "base64url");
  const signedContent = `${encodedHeader}.${encodedPayload}`;
  return {
    header,
    payload,
    signature,
    signedContent,
  };
};

const fetchAppleJwks = async (options = {}) => {
  const forceRefresh = !!(options && options.forceRefresh);
  const nowMs = Date.now();
  if (
    !forceRefresh &&
    nowMs - appleJwksCache.fetchedAtMs < APPLE_JWKS_CACHE_MAX_AGE_MS &&
    appleJwksCache.keysByKid.size > 0
  ) {
    return appleJwksCache.keysByKid;
  }
  if (appleJwksFetchPromise) {
    return appleJwksFetchPromise;
  }
  appleJwksFetchPromise = (async () => {
    const fetchedAtMs = Date.now();
    const response = await fetch("https://appleid.apple.com/auth/keys");
    if (!response.ok) {
      throw new HttpsError("internal", "Failed to fetch Apple JWKS.");
    }
    const data = await response.json();
    const keys = Array.isArray(data && data.keys) ? data.keys : [];
    const keysByKid = new Map();
    keys.forEach((key) => {
      const kid = toCleanString(key && key.kid);
      if (kid) {
        keysByKid.set(kid, key);
      }
    });
    if (keysByKid.size === 0) {
      throw new HttpsError("internal", "Apple JWKS keyset is empty.");
    }
    appleJwksCache = {
      fetchedAtMs,
      keysByKid,
    };
    return keysByKid;
  })();
  try {
    return await appleJwksFetchPromise;
  } finally {
    appleJwksFetchPromise = null;
  }
};

const verifyAppleJwtSignature = async (idToken) => {
  const { header, payload, signature, signedContent } = readJwt(idToken);
  const algorithm = toCleanString(header.alg);
  const keyId = toCleanString(header.kid);
  if (algorithm !== "RS256" || !keyId) {
    throw new HttpsError(
      "permission-denied",
      "Unsupported Apple JWT algorithm.",
    );
  }
  let keysByKid = await fetchAppleJwks();
  let jwk = keysByKid.get(keyId);
  if (!jwk) {
    if (appleJwksFetchPromise) {
      keysByKid = await appleJwksFetchPromise;
      jwk = keysByKid.get(keyId);
    }
  }
  if (!jwk) {
    const nowMs = Date.now();
    const cacheWasFetchedRecently =
      nowMs - appleJwksCache.fetchedAtMs < APPLE_JWKS_RECENT_FETCH_WINDOW_MS;
    const canForceRefreshUnknownKid =
      !cacheWasFetchedRecently &&
      nowMs - appleJwksLastUnknownKidRefreshAtMs >=
        APPLE_JWKS_UNKNOWN_KID_FORCE_REFRESH_COOLDOWN_MS;
    if (canForceRefreshUnknownKid) {
      appleJwksLastUnknownKidRefreshAtMs = nowMs;
      keysByKid = await fetchAppleJwks({ forceRefresh: true });
      jwk = keysByKid.get(keyId);
    }
  }
  if (!jwk) {
    throw new HttpsError("permission-denied", "Unknown Apple JWT key id.");
  }
  let isValidSignature = false;
  try {
    const publicKey = crypto.createPublicKey({
      key: jwk,
      format: "jwk",
    });
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(signedContent);
    verifier.end();
    isValidSignature = verifier.verify(publicKey, signature);
  } catch {
    isValidSignature = false;
  }
  if (!isValidSignature) {
    throw new HttpsError("permission-denied", "Invalid Apple token signature.");
  }
  return payload;
};

const verifyAppleIdToken = async ({ idToken, expectedNonce }) => {
  const audiences = getAppleAudiences();
  if (!Array.isArray(audiences) || audiences.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      "APPLE_CLIENT_ID or APPLE_AUDIENCES is required.",
    );
  }
  const payload = await verifyAppleJwtSignature(idToken);
  const issuer = toCleanString(payload.iss);
  if (issuer !== APPLE_ISSUER) {
    throw new HttpsError("permission-denied", "apple-issuer-mismatch");
  }
  const audience = toCleanString(payload.aud);
  if (!audiences.includes(audience)) {
    throw new HttpsError("permission-denied", "apple-audience-mismatch");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = parseNumber(payload.exp, 0);
  if (!Number.isFinite(exp) || exp <= nowSeconds) {
    throw new HttpsError("permission-denied", "apple-token-expired");
  }
  const nonceClaim = toCleanString(payload.nonce);
  if (expectedNonce) {
    const acceptedNonces = buildNonceHashes(expectedNonce);
    if (!acceptedNonces.has(nonceClaim)) {
      throw new HttpsError("permission-denied", "apple-nonce-mismatch");
    }
  }
  const subject = normalizeAppleSub(payload.sub);
  return {
    sub: subject,
    emailMasked: maskEmail(payload.email),
    emailVerified:
      payload.email_verified === true || payload.email_verified === "true",
  };
};

const getAllowedSiweDomains = () => {
  const configured = toCleanString(process.env.SIWE_ALLOWED_DOMAINS);
  if (configured) {
    return configured
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== "");
  }
  return ["mons.link", "www.mons.link", "localhost", "127.0.0.1"];
};

const validateSiweDomainAndUri = (fieldsData) => {
  const allowedDomains = new Set(getAllowedSiweDomains());
  const domain = toCleanString(fieldsData && fieldsData.domain).toLowerCase();
  const uriRaw = toCleanString(fieldsData && fieldsData.uri);
  let uriHost = "";
  if (uriRaw) {
    try {
      uriHost = toCleanString(new URL(uriRaw).host).toLowerCase();
    } catch {}
  }
  if (!domain || !allowedDomains.has(domain)) {
    const bareDomain = domain.includes(":") ? domain.split(":")[0] : domain;
    if (!bareDomain || !allowedDomains.has(bareDomain)) {
      throw new HttpsError("permission-denied", "siwe-domain-not-allowed");
    }
  }
  if (uriHost) {
    if (allowedDomains.has(uriHost)) {
      return;
    }
    const bareHost = uriHost.includes(":") ? uriHost.split(":")[0] : uriHost;
    if (!allowedDomains.has(bareHost)) {
      throw new HttpsError("permission-denied", "siwe-uri-not-allowed");
    }
  }
};

module.exports = {
  beginAuthIntent,
  consumeAuthIntent,
  normalizeMethodValue,
  linkVerifiedMethod,
  peekAuthOpReplay,
  unlinkMethodForUid,
  getLinkedMethodsForUid,
  syncProfileClaimForUid,
  verifyAppleIdToken,
  validateSiweDomainAndUri,
};
