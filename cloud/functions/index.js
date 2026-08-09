const admin = require("./firebaseAdmin");

admin.initializeApp();

const { verifySolanaAddress } = require("./verifySolanaAddress");
const { verifyEthAddress } = require("./verifyEthAddress");
const { beginAuthIntent } = require("./beginAuthIntent");
const { beginXRedirectAuth } = require("./beginXRedirectAuth");
const { verifyAppleToken } = require("./verifyAppleToken");
const { completeXRedirectAuth } = require("./completeXRedirectAuth");
const { xAuthRedirectCallback } = require("./xAuthRedirectCallback");
const { unlinkAuthMethod } = require("./unlinkAuthMethod");
const { getLinkedAuthMethods } = require("./getLinkedAuthMethods");
const { syncProfileClaim } = require("./syncProfileClaim");
const { updateRatings } = require("./updateRatings");
const { startMatchTimer, claimMatchVictoryByTimer } = require("./matchTimers");
const { automatch } = require("./automatch");
const { cancelAutomatch } = require("./cancelAutomatch");
const { removeNavigationGame } = require("./removeNavigationGame");
const { editUsername } = require("./editUsername");
const { withdrawEventPrize } = require("./eventPrizeWithdrawal");
const { announceEventPrizes } = require("./eventPrizeTelegramAnnouncement");
const { mineRock } = require("./mineRock");
const { sendWagerProposal } = require("./sendWagerProposal");
const { cancelWagerProposal } = require("./cancelWagerProposal");
const { declineWagerProposal } = require("./declineWagerProposal");
const { acceptWagerProposal } = require("./acceptWagerProposal");
const { resolveWagerOutcome } = require("./resolveWagerOutcome");
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
const {
  dispatchTelegramDelivery,
  dispatchTelegramManualRecovery,
  telegramDeliveryWorker,
} = require("./telegramDeliveryFunctions");
const {
  projectAutomatchTelegramMessages,
} = require("./automatchTelegramMessages");
const { projectRatingTelegramUpdates } = require("./ratingTelegramProjector");

exports.verifySolanaAddress = verifySolanaAddress;
exports.verifyEthAddress = verifyEthAddress;
exports.beginAuthIntent = beginAuthIntent;
exports.beginXRedirectAuth = beginXRedirectAuth;
exports.verifyAppleToken = verifyAppleToken;
exports.completeXRedirectAuth = completeXRedirectAuth;
exports.xAuthRedirectCallback = xAuthRedirectCallback;
exports.unlinkAuthMethod = unlinkAuthMethod;
exports.getLinkedAuthMethods = getLinkedAuthMethods;
exports.syncProfileClaim = syncProfileClaim;
exports.startMatchTimer = startMatchTimer;
exports.claimMatchVictoryByTimer = claimMatchVictoryByTimer;
exports.automatch = automatch;
exports.cancelAutomatch = cancelAutomatch;
exports.removeNavigationGame = removeNavigationGame;
exports.updateRatings = updateRatings;
exports.editUsername = editUsername;
exports.withdrawEventPrize = withdrawEventPrize;
exports.announceEventPrizes = announceEventPrizes;
exports.mineRock = mineRock;
exports.sendWagerProposal = sendWagerProposal;
exports.cancelWagerProposal = cancelWagerProposal;
exports.declineWagerProposal = declineWagerProposal;
exports.acceptWagerProposal = acceptWagerProposal;
exports.resolveWagerOutcome = resolveWagerOutcome;
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
exports.dispatchTelegramDelivery = dispatchTelegramDelivery;
exports.dispatchTelegramManualRecovery = dispatchTelegramManualRecovery;
exports.telegramDeliveryWorker = telegramDeliveryWorker;
exports.projectAutomatchTelegramMessages = projectAutomatchTelegramMessages;
exports.projectRatingTelegramUpdates = projectRatingTelegramUpdates;
