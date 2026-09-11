"use strict";

const core = require("./desiredStateCore");

const queueTelegramSend = async () => {
  throw new Error("telegram-d1-command-required");
};

module.exports = {
  ...core,
  queueTelegramSend,
};
