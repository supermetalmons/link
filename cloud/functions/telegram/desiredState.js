"use strict";

const admin = require("../firebaseAdmin");
const core = require("./desiredStateCore");

const persistDesiredUpdates = async (messageKey, updates, database) => {
  await database.ref().update(updates);
  const desired = Object.values(updates)[0];
  return {
    messageKey: core.validateTelegramMessageKey(messageKey),
    revision: desired.revision,
    desired,
  };
};

const queueTelegramSend = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    core.buildTelegramSendUpdates(input),
    dependencies.database || admin.database(),
  );

const queueTelegramEdit = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    core.buildTelegramEditUpdates(input),
    dependencies.database || admin.database(),
  );

const queueTelegramDelete = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    core.buildTelegramDeleteUpdates(input),
    dependencies.database || admin.database(),
  );

module.exports = {
  ...core,
  queueTelegramDelete,
  queueTelegramEdit,
  queueTelegramSend,
};
