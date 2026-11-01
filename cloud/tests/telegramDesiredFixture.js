"use strict";
const core = require("../runtime/telegram/desiredStateCore");
const {
  TELEGRAM_MESSAGE_ROOT,
  validateTelegramMessageKey,
  buildTelegramSendDesired,
  buildTelegramEditDesired,
  buildTelegramDeleteDesired,
} = core;
/**
 * @template {import("../runtime/telegram/desiredStateCore").TelegramDesired} Desired
 * @param {unknown} messageKey
 * @param {Desired} desired
 * @returns {Record<string, Desired>}
 */
const buildDesiredUpdates = (messageKey, desired) => ({
  [`${TELEGRAM_MESSAGE_ROOT}/${validateTelegramMessageKey(messageKey)}/desired`]:
    desired,
});

/** @param {import("../runtime/telegram/desiredStateCore").TelegramSendDesiredInput & {messageKey: string}} input */
const buildTelegramSendUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramSendDesired(desiredInput));

/** @param {import("../runtime/telegram/desiredStateCore").TelegramEditDesiredInput & {messageKey: string}} input */
const buildTelegramEditUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramEditDesired(desiredInput));

/** @param {import("../runtime/telegram/desiredStateCore").TelegramDeleteDesiredInput & {messageKey: string}} input */
const buildTelegramDeleteUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramDeleteDesired(desiredInput));

module.exports = {
  ...core,
  buildTelegramSendUpdates,
  buildTelegramEditUpdates,
  buildTelegramDeleteUpdates,
};
