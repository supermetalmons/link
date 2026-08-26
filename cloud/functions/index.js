const admin = require("./firebaseAdmin");

admin.initializeApp();

const { withdrawEventPrize } = require("./eventPrizeWithdrawal");
const {
  onInviteCreated,
  onInviteGuestIdChanged,
  onInviteHostRematchesChanged,
  onInviteGuestRematchesChanged,
  onMatchCreated,
  onProfileLinkCreated,
  onProfileLinkWritten,
  onProfileDeleted,
} = require("./profileGamesProjector");
const {
  onProfileEventPrizeWritten,
  onProfileMergeTargetWritten,
} = require("./eventPrizeProjector");

exports.withdrawEventPrize = withdrawEventPrize;
exports.projectProfileGamesOnInviteCreated = onInviteCreated;
exports.projectProfileGamesOnInviteGuestIdChanged = onInviteGuestIdChanged;
exports.projectProfileGamesOnInviteHostRematchesChanged =
  onInviteHostRematchesChanged;
exports.projectProfileGamesOnInviteGuestRematchesChanged =
  onInviteGuestRematchesChanged;
exports.projectProfileGamesOnMatchCreated = onMatchCreated;
exports.projectProfileGamesOnProfileLinkCreated = onProfileLinkCreated;
exports.projectProfileGamesOnProfileLinkWritten = onProfileLinkWritten;
exports.projectProfileGamesOnProfileDeleted = onProfileDeleted;
exports.projectProfileEventPrizesOnPrizeWritten = onProfileEventPrizeWritten;
exports.projectProfileEventPrizesOnMergeTargetWritten =
  onProfileMergeTargetWritten;
