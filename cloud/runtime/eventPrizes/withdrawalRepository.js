// Generated from src/eventPrizes/withdrawalRepository.ts. Run npm run generate:runtime.
"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseProcessingClaim =
  exports.persistSubmittedTransaction =
  exports.markWithdrawalBlocked =
  exports.discardDefinitiveSubmittedTransaction =
  exports.acquireWithdrawalClaim =
    void 0;
exports.createWithdrawalRecordCommands = createWithdrawalRecordCommands;
const records_js_1 = require("./records.js");
const crypto = __importStar(require("node:crypto"));
const errors_js_1 = require("./errors.js");
const eventPrizeWithdrawalState_js_1 = require("../eventPrizeWithdrawalState.js");
function createWithdrawalRecordCommands(storage) {
  return {
    read: () => storage.read(),
    claim(input) {
      return storage.transaction((current) => {
        const decision = (0,
        eventPrizeWithdrawalState_js_1.decideWithdrawalClaim)({
          ...input,
          current,
          nowMs: Date.now(),
        });
        return {
          value:
            decision.kind === "acquired" ? decision.value : (current ?? null),
        };
      });
    },
    releaseProcessing(leaseId) {
      return storage.transaction((current) =>
        (0, records_js_1.withdrawalStatus)(current) === "processing" &&
        (0, records_js_1.withdrawalLeaseId)(current) === leaseId
          ? { value: null }
          : { value: current ?? null },
      );
    },
    block({ leaseId, observedOwner }) {
      return storage.transaction((current) => {
        if (
          !current ||
          (0, records_js_1.withdrawalStatus)(current) === "completed" ||
          (0, records_js_1.withdrawalLeaseId)(current) !== leaseId
        ) {
          return { value: current ?? null };
        }
        return {
          value: (0, records_js_1.writeBlockedWithdrawal)(
            current,
            observedOwner,
            Date.now(),
          ),
        };
      });
    },
    persistSubmission({ leaseId, ...evidence }) {
      return storage.transaction((current) => {
        if (
          !current ||
          (0, records_js_1.withdrawalStatus)(current) === "completed" ||
          (0, records_js_1.withdrawalLeaseId)(current) !== leaseId
        ) {
          return { value: current ?? null };
        }
        return {
          value: (0, records_js_1.writeSubmittedWithdrawal)(
            current,
            evidence,
            (0, records_js_1.withdrawalSubmittedAtForPersistence)(
              current,
              Date.now,
            ),
            Date.now(),
          ),
        };
      });
    },
    discardSubmission({ leaseId, transactionSignature }) {
      return storage.transaction((current) =>
        (0, records_js_1.withdrawalStatus)(current) === "submitted" &&
        (0, records_js_1.withdrawalLeaseId)(current) === leaseId &&
        (0, records_js_1.withdrawalSubmissionStrings)(current)
          .transactionSignature === transactionSignature
          ? { value: null, decision: "discarded" }
          : { commit: false, decision: "stale" },
      );
    },
  };
}
const acquireWithdrawalClaim = async ({
  withdrawalRecord,
  eventId,
  prizeId,
  assetAddress,
  profileId,
  place,
  recipientAddress,
  requesterUid,
  canonicalRecordProfileId,
  canonicalRecordSourceProfileId,
}) => {
  const leaseId = crypto.randomBytes(16).toString("hex");
  const decide = (current) =>
    (0, eventPrizeWithdrawalState_js_1.decideWithdrawalClaim)({
      current,
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place,
      recipientAddress,
      requesterUid,
      canonicalRecordProfileId,
      canonicalRecordSourceProfileId,
      leaseId,
      nowMs: Date.now(),
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withdrawalRecord.claim({
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place,
      recipientAddress,
      requesterUid,
      canonicalRecordProfileId,
      canonicalRecordSourceProfileId,
      leaseId,
    });
    const withdrawal = result.value;
    if (
      result.committed &&
      (0, records_js_1.withdrawalLeaseId)(withdrawal) === leaseId &&
      ((0, records_js_1.withdrawalStatus)(withdrawal) === "processing" ||
        (0, records_js_1.withdrawalStatus)(withdrawal) === "submitted") &&
      (0, eventPrizeWithdrawalState_js_1.isWithdrawalRecordForPrize)(
        withdrawal,
        eventId,
        prizeId,
        assetAddress,
      )
    ) {
      return { leaseId, withdrawal: withdrawal };
    }
    const decision = decide(withdrawal);
    if (decision?.kind === "acquired") {
      continue;
    }
    if (decision?.kind === "completed") {
      return { completed: decision.value };
    }
    if (decision?.kind === "busy") {
      throw new errors_js_1.EventPrizeWithdrawalError(
        "aborted",
        "This prize withdrawal is already being processed.",
      );
    }
    if (decision?.kind === "destination-mismatch") {
      throw new errors_js_1.EventPrizeWithdrawalError(
        "failed-precondition",
        "The pending withdrawal is locked to its original destination.",
      );
    }
    if (decision?.kind === "blocked") {
      throw new errors_js_1.EventPrizeWithdrawalError(
        "failed-precondition",
        "This prize is unavailable for withdrawal.",
      );
    }
    throw new errors_js_1.EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  throw new errors_js_1.EventPrizeWithdrawalError(
    "aborted",
    "Prize withdrawal changed. Please try again.",
  );
};
exports.acquireWithdrawalClaim = acquireWithdrawalClaim;
const releaseProcessingClaim = async ({ withdrawalRecord, leaseId }) => {
  await withdrawalRecord.releaseProcessing(leaseId);
};
exports.releaseProcessingClaim = releaseProcessingClaim;
const markWithdrawalBlocked = async ({
  withdrawalRecord,
  leaseId,
  observedOwner,
}) => {
  await withdrawalRecord.block({ leaseId, observedOwner });
};
exports.markWithdrawalBlocked = markWithdrawalBlocked;
const persistSubmittedTransaction = async ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
  signedTransactionBase64,
  blockhash,
  lastValidBlockHeight,
}) => {
  const result = await withdrawalRecord.persistSubmission({
    leaseId,
    transactionSignature,
    signedTransactionBase64,
    blockhash,
    lastValidBlockHeight,
  });
  const persisted = result.value;
  if (
    !result.committed ||
    (0, records_js_1.withdrawalStatus)(persisted) !== "submitted" ||
    (0, records_js_1.withdrawalLeaseId)(persisted) !== leaseId ||
    (0, records_js_1.withdrawalSubmissionStrings)(persisted)
      .transactionSignature !== transactionSignature ||
    (0, records_js_1.withdrawalSubmissionStrings)(persisted)
      .signedTransactionBase64 !== signedTransactionBase64 ||
    (0, records_js_1.withdrawalSubmissionStrings)(persisted).blockhash !==
      blockhash ||
    (0, records_js_1.withdrawalLastValidBlockHeight)(persisted) !==
      lastValidBlockHeight
  ) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "aborted",
      "Prize withdrawal ownership changed. Please try again.",
    );
  }
  return persisted;
};
exports.persistSubmittedTransaction = persistSubmittedTransaction;
const discardDefinitiveSubmittedTransaction = async ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
}) => {
  const result = await withdrawalRecord.discardSubmission({
    leaseId,
    transactionSignature,
  });
  if (
    !result.committed ||
    result.decision !== "discarded" ||
    result.value !== null
  ) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "aborted",
      "Prize withdrawal changed. Please try again.",
    );
  }
};
exports.discardDefinitiveSubmittedTransaction =
  discardDefinitiveSubmittedTransaction;
