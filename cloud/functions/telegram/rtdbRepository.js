"use strict";

const admin = require("../firebaseAdmin");
const { runRtdbDecisionTransaction } = require("../rtdbDecisionTransaction");
const {
  TELEGRAM_DELIVERY_CONTROL_ROOT,
  createTelegramRepository,
} = require("./repositoryCore");

const createFirebaseTelegramRepository = (database = admin.database()) =>
  createTelegramRepository({
    async getPath(path) {
      const snapshot = await database.ref(path).once("value");
      return snapshot.exists() ? snapshot.val() : null;
    },
    transactPath(path, updater) {
      return runRtdbDecisionTransaction(database.ref(path), updater);
    },
  });

module.exports = {
  TELEGRAM_DELIVERY_CONTROL_ROOT,
  createFirebaseTelegramRepository,
};
