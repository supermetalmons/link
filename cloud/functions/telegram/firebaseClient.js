"use strict";

const { defineSecret } = require("firebase-functions/params");
const core = require("./client");

const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");

const withFirebaseToken = (operation) => (input) =>
  operation({
    ...input,
    token: input?.token || telegramBotToken.value(),
  });

module.exports = {
  ...core,
  deleteTelegramMessage: withFirebaseToken(core.deleteTelegramMessage),
  editTelegramMessage: withFirebaseToken(core.editTelegramMessage),
  sendTelegramMediaGroup: withFirebaseToken(core.sendTelegramMediaGroup),
  sendTelegramMessage: withFirebaseToken(core.sendTelegramMessage),
  telegramBotToken,
};
