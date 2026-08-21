const { createHash } = require("node:crypto");
const { onValueWritten } = require("firebase-functions/v2/database");
const admin = require("../firebaseAdmin");
const { runRtdbDecisionTransaction } = require("../rtdbDecisionTransaction");
const {
  TELEGRAM_AUTOMATCH_ROOT,
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramLifecycleUpdates,
  buildMatchedAutomatchTelegramUpdates,
  buildPendingAutomatchTelegramSource,
  getAutomatchTelegramSourcePath,
} = require("./automatchSource");
const {
  asObject,
  buildAutomatchProjectionGuard,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  getAutomatchResultFragments,
  normalizeString,
  renderMatchedAutomatchTelegramText,
  resolveAutomatchTelegramLifecycle,
} = require("./projectionCore");

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
