const admin = require("./firebaseAdmin");

admin.initializeApp();

const { withdrawEventPrize } = require("./eventPrizeWithdrawal");

exports.withdrawEventPrize = withdrawEventPrize;
