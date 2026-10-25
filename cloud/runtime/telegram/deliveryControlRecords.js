// Generated from src/telegram/deliveryControlRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearRateLimitProofRecord = clearRateLimitProofRecord;
exports.prepareDesiredGateRecord = prepareDesiredGateRecord;
exports.settleApiGateRecord = settleApiGateRecord;
const deliveryState_js_1 = require("./deliveryState.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const values_js_1 = require("./values.js");
function clearRateLimitProofRecord(current, input) {
  const { owner } = input;
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    const clearsDesired =
      (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(delivery.apiGateProofRequired, "owner"),
      ) === owner;
    const clearsPending =
      (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(
          pendingDelete.apiGateProofRequired,
          "owner",
        ),
      ) === owner;
    if (!clearsDesired && !clearsPending) {
      return { commit: false, decision: "rate-limit-proof-marker-stale" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...(clearsDesired
            ? (0, deliveryState_js_1.omitKeys)(delivery, [
                "apiGateProofRequired",
              ])
            : (0, deliveryState_js_1.deliveryDocument)(delivery)),
          ...(clearsPending
            ? {
                pendingDelete: (0, deliveryState_js_1.omitKeys)(pendingDelete, [
                  "apiGateProofRequired",
                ]),
              }
            : {}),
        },
      },
      decision: "rate-limit-proof-marker-cleared",
    };
  };
  const output = apply(asObject(current));
  return output;
}
function prepareDesiredGateRecord(current, delivery, input) {
  const { generation, messageKey, preparedAtMs, revision } = input;
  const apply = (record) => {
    const existingOwner = (0, deliveryState_js_1.normalizeString)(
      delivery.apiGateOwner,
    );
    return {
      ...record,
      delivery: {
        ...(0, deliveryState_js_1.deliveryDocument)(delivery),
        apiGateOwner:
          existingOwner ||
          (0, deliveryState_js_1.buildApiGateOwner)(
            messageKey,
            "desired",
            revision,
            generation,
          ),
        apiGateGeneration:
          (0, deliveryState_js_1.normalizeString)(delivery.apiGateGeneration) ||
          generation,
        apiGateStartedAtMs:
          (0, deliveryPolicy_js_1.normalizeTimestamp)(
            delivery.apiGateStartedAtMs,
          ) || preparedAtMs,
      },
    };
  };
  const output = apply(asObject(current));
  return output;
}
function settleApiGateRecord(current, input) {
  const { field, settleOwner } = input;
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    if (delivery.settlementOwner(field) !== settleOwner) {
      return { commit: false, decision: "api-gate-settle-stale" };
    }
    return {
      value: {
        ...record,
        delivery: (0, deliveryState_js_1.omitKeys)(delivery, [field]),
      },
      decision: "api-gate-settled",
    };
  };
  const output = apply(asObject(current));
  return output;
}
const asObject = (value) => {
  const retained =
    value instanceof deliveryState_js_1.DeliverySnapshot
      ? (0, deliveryState_js_1.deliveryDocument)(value)
      : value instanceof deliveryState_js_1.PendingDeleteSnapshot
        ? (0, deliveryState_js_1.pendingDeleteDocument)(value)
        : value;
  return retained && typeof retained === "object" && !Array.isArray(retained)
    ? retained
    : {};
};
