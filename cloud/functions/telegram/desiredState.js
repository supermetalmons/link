"use strict";

const admin = require("../firebaseAdmin");
const core = require("./desiredStateCore");

const persistDesiredUpdates = async (
  messageKey,
  updates,
  { database, dispatchDelivery, generation },
) => {
  if (typeof dispatchDelivery !== "function") {
    throw new TypeError("dispatchDelivery is required");
  }
  await database.ref().update(updates);
  const desired = Object.values(updates)[0];
  const normalizedMessageKey = core.validateTelegramMessageKey(messageKey);
  let dispatch;
  try {
    dispatch = await dispatchDelivery({
      messageKey: normalizedMessageKey,
      revision: desired.revision,
      generation: generation || `desired:${desired.revision}`,
    });
  } catch (error) {
    const failure = new Error(
      `Telegram desired state persisted for ${normalizedMessageKey} but was not confirmed enqueued. Do not rerun the producer; run requeue:telegram against Cloudflare.`,
      { cause: error },
    );
    failure.code = "telegram-delivery-pending";
    failure.messageKey = normalizedMessageKey;
    failure.revision = desired.revision;
    throw failure;
  }
  return {
    messageKey: normalizedMessageKey,
    revision: desired.revision,
    desired,
    dispatch,
  };
};

const queueTelegramSend = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    core.buildTelegramSendUpdates(input),
    {
      ...dependencies,
      database: dependencies.database || admin.database(),
    },
  );

const queueTelegramEdit = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    core.buildTelegramEditUpdates(input),
    {
      ...dependencies,
      database: dependencies.database || admin.database(),
    },
  );

const queueTelegramDelete = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    core.buildTelegramDeleteUpdates(input),
    {
      ...dependencies,
      database: dependencies.database || admin.database(),
    },
  );

module.exports = {
  ...core,
  queueTelegramDelete,
  queueTelegramEdit,
  queueTelegramSend,
};
