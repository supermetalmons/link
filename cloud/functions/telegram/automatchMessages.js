const { createHash } = require("node:crypto");
const { onValueWritten } = require("firebase-functions/v2/database");
const admin = require("../firebaseAdmin");
const { runRtdbDecisionTransaction } = require("../rtdbDecisionTransaction");
const { parseInviteMatchIndex } = require("../shared/rematches");
const {
  TELEGRAM_AUTOMATCH_ROOT,
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramLifecycleUpdates,
  buildMatchedAutomatchTelegramUpdates,
  buildPendingAutomatchTelegramSource,
  getAutomatchTelegramSourcePath,
} = require("./automatchSource");
const AUTOMATCH_PROJECTION_GUARD_VERSION = 1;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeGeneration = (value) =>
  Number.isInteger(value) && value >= 0 ? value : 0;

const resolveAutomatchTelegramLifecycle = (source, inviteData) => {
  if (!source || source.version !== TELEGRAM_AUTOMATCH_VERSION) {
    return null;
  }
  if (normalizeString(inviteData && inviteData.guestId)) {
    return "matched";
  }
  if (
    source.lifecycle === "pending" ||
    source.lifecycle === "matched" ||
    source.lifecycle === "canceled"
  ) {
    return source.lifecycle;
  }
  return null;
};

const getAutomatchResultFragments = (inviteId, source) => {
  const results =
    source && source.results && typeof source.results === "object"
      ? source.results
      : {};
  return Object.entries(results)
    .map(([matchId, value]) => ({
      matchId,
      text: normalizeString(
        typeof value === "string" ? value : value && value.text,
      ),
      matchIndex: parseInviteMatchIndex(inviteId, matchId),
    }))
    .filter((result) => result.matchId !== "" && result.text !== "")
    .sort((left, right) => {
      const leftIndex = left.matchIndex === null ? Infinity : left.matchIndex;
      const rightIndex =
        right.matchIndex === null ? Infinity : right.matchIndex;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return left.matchId.localeCompare(right.matchId);
    });
};

const hashText = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

const buildResultDigests = (fragments) =>
  Object.fromEntries(
    fragments.map((fragment) => [fragment.matchId, hashText(fragment.text)]),
  );

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const inferAutomatchProjectionLifecycle = (record) => {
  const currentRecord = asObject(record);
  const guard = asObject(currentRecord.automatchProjection);
  const appliedInstanceKey = normalizeString(
    asObject(currentRecord.applied).instanceKey,
  );
  const desired = asObject(currentRecord.desired);
  const desiredInstanceKey = normalizeString(desired.instanceKey);
  if (
    guard.lifecycle === "matched" ||
    appliedInstanceKey.startsWith("matched:") ||
    desiredInstanceKey.startsWith("matched:")
  ) {
    return "matched";
  }
  if (
    guard.lifecycle === "canceled" ||
    (desired.operation === "edit" &&
      desired.ifMissing === "skip" &&
      desiredInstanceKey.startsWith("waiting:"))
  ) {
    return "canceled";
  }
  if (
    guard.lifecycle === "pending" ||
    desiredInstanceKey.startsWith("waiting:")
  ) {
    return "pending";
  }
  return null;
};

const containsProtectedResultDigests = (candidateDigests, protectedDigests) =>
  Object.entries(asObject(protectedDigests)).every(
    ([matchId, digest]) =>
      normalizeString(digest) !== "" && candidateDigests[matchId] === digest,
  );

const evaluateAutomatchProjectionUpdate = (record, projection) => {
  const currentRecord = asObject(record);
  const currentGuard = asObject(currentRecord.automatchProjection);
  const currentLifecycle = inferAutomatchProjectionLifecycle(currentRecord);
  const candidateLifecycle = projection.lifecycle;
  const currentGeneration = normalizeGeneration(currentGuard.sourceGeneration);
  const candidateGeneration = normalizeGeneration(projection.sourceGeneration);

  if (currentGeneration > candidateGeneration) {
    return { allowed: false, reason: "older-generation" };
  }
  if (currentLifecycle === "matched" && candidateLifecycle !== "matched") {
    return { allowed: false, reason: "matched-regression" };
  }
  if (currentLifecycle === "canceled" && candidateLifecycle === "pending") {
    return { allowed: false, reason: "canceled-regression" };
  }
  if (
    currentLifecycle === "matched" &&
    candidateLifecycle === "matched" &&
    !containsProtectedResultDigests(
      asObject(projection.resultDigests),
      asObject(currentGuard.resultDigests),
    )
  ) {
    return { allowed: false, reason: "result-regression" };
  }
  return { allowed: true, reason: "advanced" };
};

const buildAutomatchProjectionGuard = (projection) => ({
  schemaVersion: AUTOMATCH_PROJECTION_GUARD_VERSION,
  lifecycle: projection.lifecycle,
  sourceGeneration: normalizeGeneration(projection.sourceGeneration),
  sourceRevision: projection.sourceRevision,
  resultDigests: asObject(projection.resultDigests),
});

const renderMatchedAutomatchTelegramText = (inviteId, source) => {
  const matchedText = normalizeString(source && source.matchedText);
  if (!matchedText) {
    return "";
  }
  const fragments = getAutomatchResultFragments(inviteId, source);
  if (fragments.length === 0) {
    return matchedText;
  }
  return `${matchedText}\n\n${fragments.map((fragment) => fragment.text).join("\n\n")}`;
};

const buildSourceRevision = ({
  lifecycle,
  instanceKey,
  text,
  sourceGeneration,
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: TELEGRAM_AUTOMATCH_VERSION,
        lifecycle,
        instanceKey,
        text,
        sourceGeneration,
      }),
    )
    .digest("hex");

const buildAutomatchTelegramProjection = ({ inviteId, source, inviteData }) => {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    return null;
  }
  const lifecycle = resolveAutomatchTelegramLifecycle(source, inviteData);
  if (!lifecycle) {
    return null;
  }

  let operation;
  let instanceKey;
  let text;
  let ifMissing;
  let resultFragments = [];

  if (lifecycle === "pending") {
    operation = "send";
    instanceKey = normalizeString(source.waitingInstanceKey);
    text = normalizeString(source.waitingText);
  } else if (lifecycle === "canceled") {
    operation = "edit";
    instanceKey = normalizeString(source.waitingInstanceKey);
    text = normalizeString(source.canceledText);
    ifMissing = "skip";
  } else {
    resultFragments = getAutomatchResultFragments(normalizedInviteId, source);
    operation = resultFragments.length > 0 ? "edit" : "send";
    instanceKey = normalizeString(source.matchedInstanceKey);
    text = renderMatchedAutomatchTelegramText(normalizedInviteId, source);
    ifMissing = resultFragments.length > 0 ? "send" : undefined;
  }

  if (!instanceKey || !text) {
    return null;
  }

  const sourceGeneration = normalizeGeneration(source.generation);
  return {
    operation,
    lifecycle,
    messageKey: `automatch:${normalizedInviteId}`,
    destination: "community",
    instanceKey,
    text,
    parseMode: "HTML",
    silent: false,
    ...(ifMissing ? { ifMissing } : {}),
    sourceGeneration,
    resultDigests: buildResultDigests(resultFragments),
    sourceRevision: buildSourceRevision({
      lifecycle,
      instanceKey,
      text,
      sourceGeneration,
    }),
  };
};

const queueAutomatchTelegramProjection = async (
  projection,
  dependencies = {},
) => {
  const {
    buildTelegramSendDesired,
    buildTelegramEditDesired,
  } = require("./desiredState");
  const desired =
    projection.operation === "send"
      ? buildTelegramSendDesired(projection)
      : buildTelegramEditDesired(projection);
  const database = dependencies.database || admin.database();
  const transactionResult = await runRtdbDecisionTransaction(
    database.ref(`telegramMessages/${projection.messageKey}`),
    (record) => {
      const decision = evaluateAutomatchProjectionUpdate(record, projection);
      if (!decision.allowed) {
        return { commit: false, decision };
      }
      return {
        value: {
          ...asObject(record),
          desired,
          automatchProjection: buildAutomatchProjectionGuard(projection),
        },
        decision,
      };
    },
  );
  const decision = transactionResult.decision || {
    allowed: false,
    reason: "not-evaluated",
  };
  return {
    status: transactionResult.committed ? "queued" : "stale",
    reason: decision.reason,
    messageKey: projection.messageKey,
    revision: desired.revision,
    desired,
  };
};

const readAutomatchTelegramInputs = async (inviteId) => {
  const [sourceSnapshot, inviteSnapshot] = await Promise.all([
    admin
      .database()
      .ref(getAutomatchTelegramSourcePath(inviteId))
      .once("value"),
    admin.database().ref(`invites/${inviteId}`).once("value"),
  ]);
  return {
    source: sourceSnapshot.exists() ? sourceSnapshot.val() : null,
    inviteData: inviteSnapshot.exists() ? inviteSnapshot.val() : null,
  };
};

const buildInputFingerprint = (inputs) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        source: inputs.source,
        guestId: normalizeString(
          inputs.inviteData && inputs.inviteData.guestId,
        ),
      }),
    )
    .digest("hex");

const projectAutomatchTelegramSource = async (inviteId) => {
  let inputs = await readAutomatchTelegramInputs(inviteId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const projection = buildAutomatchTelegramProjection({
      inviteId,
      source: inputs.source,
      inviteData: inputs.inviteData,
    });
    if (!projection) {
      return { status: "skipped" };
    }
    const queueResult = await queueAutomatchTelegramProjection(projection);
    const latestInputs = await readAutomatchTelegramInputs(inviteId);
    if (buildInputFingerprint(inputs) === buildInputFingerprint(latestInputs)) {
      return { status: queueResult.status, projection };
    }
    inputs = latestInputs;
  }
  throw new Error(`Automatch Telegram source kept changing for ${inviteId}`);
};

const projectAutomatchTelegramMessages = onValueWritten(
  {
    ref: `/${TELEGRAM_AUTOMATCH_ROOT}/{inviteId}`,
    maxInstances: 10,
    concurrency: 20,
    memory: "256MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const inviteId = normalizeString(event.params.inviteId);
    if (!inviteId) {
      return;
    }
    await projectAutomatchTelegramSource(inviteId);
  },
);

module.exports = {
  TELEGRAM_AUTOMATCH_VERSION,
  buildPendingAutomatchTelegramSource,
  buildMatchedAutomatchTelegramUpdates,
  buildAutomatchTelegramLifecycleUpdates,
  resolveAutomatchTelegramLifecycle,
  getAutomatchResultFragments,
  renderMatchedAutomatchTelegramText,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  queueAutomatchTelegramProjection,
  projectAutomatchTelegramSource,
  projectAutomatchTelegramMessages,
};
