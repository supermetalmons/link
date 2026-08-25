const admin = require("./firebaseAdmin");

admin.initializeApp();

const { withdrawEventPrize } = require("./eventPrizeWithdrawal");
const {
  onInviteCreated,
  onInviteGuestIdChanged,
  onInviteHostRematchesChanged,
  onInviteGuestRematchesChanged,
  onMatchCreated,
  onAutomatchQueueWritten,
  onProfileLinkCreated,
  onProfileLinkWritten,
  onProfileDeleted,
} = require("./profileGamesProjector");
const { onEventWritten } = require("./eventProjector");
const {
  onProfileEventPrizeWritten,
  onProfileMergeTargetWritten,
} = require("./eventPrizeProjector");
const {
  onEventTelegramCreated,
  onEventTelegramUpdated,
} = require("./eventTelegramAnnouncements");

exports.withdrawEventPrize = withdrawEventPrize;
exports.projectProfileGamesOnInviteCreated = onInviteCreated;
exports.projectProfileGamesOnInviteGuestIdChanged = onInviteGuestIdChanged;
exports.projectProfileGamesOnInviteHostRematchesChanged =
  onInviteHostRematchesChanged;
exports.projectProfileGamesOnInviteGuestRematchesChanged =
  onInviteGuestRematchesChanged;
exports.projectProfileGamesOnMatchCreated = onMatchCreated;
exports.projectProfileGamesOnAutomatchQueueWritten = onAutomatchQueueWritten;
exports.projectProfileGamesOnProfileLinkCreated = onProfileLinkCreated;
exports.projectProfileGamesOnProfileLinkWritten = onProfileLinkWritten;
exports.projectProfileGamesOnProfileDeleted = onProfileDeleted;
exports.projectProfileGamesOnEventWritten = onEventWritten;
exports.projectProfileEventPrizesOnPrizeWritten = onProfileEventPrizeWritten;
exports.projectProfileEventPrizesOnMergeTargetWritten =
  onProfileMergeTargetWritten;
exports.projectEventTelegramOnCreated = onEventTelegramCreated;
exports.projectEventTelegramOnUpdated = onEventTelegramUpdated;
