const admin = require("./firebaseAdmin");

admin.initializeApp();

const { withdrawEventPrize } = require("./eventPrizeWithdrawal");
const {
  onInviteCreated,
  onInviteGuestIdChanged,
  onInviteHostRematchesChanged,
  onInviteGuestRematchesChanged,
  onMatchCreated,
} = require("./profileGamesProjector");

exports.withdrawEventPrize = withdrawEventPrize;
exports.projectProfileGamesOnInviteCreated = onInviteCreated;
exports.projectProfileGamesOnInviteGuestIdChanged = onInviteGuestIdChanged;
exports.projectProfileGamesOnInviteHostRematchesChanged =
  onInviteHostRematchesChanged;
exports.projectProfileGamesOnInviteGuestRematchesChanged =
  onInviteGuestRematchesChanged;
exports.projectProfileGamesOnMatchCreated = onMatchCreated;
