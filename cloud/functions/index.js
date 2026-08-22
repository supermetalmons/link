const admin = require("./firebaseAdmin");

admin.initializeApp();

const { verifySolanaAddress } = require("./verifySolanaAddress");
const { verifyEthAddress } = require("./verifyEthAddress");
const { verifyAppleToken } = require("./verifyAppleToken");
const { completeXRedirectAuth } = require("./completeXRedirectAuth");
const { unlinkAuthMethod } = require("./unlinkAuthMethod");
const { syncProfileClaim } = require("./syncProfileClaim");
const { withdrawEventPrize } = require("./eventPrizeWithdrawal");
const {
  createEvent,
  joinEvent,
  postponeEventStart,
  removeEventParticipant,
  disqualifyEventMatchWinners,
  syncEventState,
  processEventProgress,
  processEventProgressFallback,
} = require("./events");
const {
  onInviteCreated,
  onInviteGuestIdChanged,
  onInviteHostRematchesChanged,
  onInviteGuestRematchesChanged,
  onMatchCreated,
  onInviteMatchRatingUpdated,
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
const { projectRatingTelegramUpdates } = require("./ratingTelegramProjector");

exports.verifySolanaAddress = verifySolanaAddress;
exports.verifyEthAddress = verifyEthAddress;
exports.verifyAppleToken = verifyAppleToken;
exports.completeXRedirectAuth = completeXRedirectAuth;
exports.unlinkAuthMethod = unlinkAuthMethod;
exports.syncProfileClaim = syncProfileClaim;
exports.withdrawEventPrize = withdrawEventPrize;
exports.createEvent = createEvent;
exports.joinEvent = joinEvent;
exports.postponeEventStart = postponeEventStart;
exports.removeEventParticipant = removeEventParticipant;
exports.disqualifyEventMatchWinners = disqualifyEventMatchWinners;
exports.syncEventState = syncEventState;
exports.processEventProgress = processEventProgress;
exports.processEventProgressFallback = processEventProgressFallback;
exports.projectProfileGamesOnInviteCreated = onInviteCreated;
exports.projectProfileGamesOnInviteGuestIdChanged = onInviteGuestIdChanged;
exports.projectProfileGamesOnInviteHostRematchesChanged =
  onInviteHostRematchesChanged;
exports.projectProfileGamesOnInviteGuestRematchesChanged =
  onInviteGuestRematchesChanged;
exports.projectProfileGamesOnMatchCreated = onMatchCreated;
exports.projectProfileGamesOnInviteMatchRatingUpdated =
  onInviteMatchRatingUpdated;
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
exports.projectRatingTelegramUpdates = projectRatingTelegramUpdates;
