"use strict";

const core = require("../runtime/telegram/eventProjectionCore");
const {
  buildTelegramSendDesired,
  buildTelegramEditDesired,
} = require("../runtime/telegram/desiredStateCore");
const {
  canonicalEventTelegramProjection,
} = require("../../test/fixtures/canonicalData.mjs");

/**
 * @typedef {import("../runtime/telegram/eventProjectionCore").EventTelegramProjectionChanges} ProjectionChanges
 * @typedef {import("../runtime/telegram/eventProjectionCore").EventTelegramDesiredChange} DesiredChange
 * @typedef {import("../runtime/telegram/eventProjectionCore").EventTelegramProjectionGuard} ProjectionGuard
 * @typedef {Parameters<typeof canonicalEventTelegramProjection>[0]} ProjectionStatePatch
 * @typedef {Record<string, unknown>} LegacyUpdates
 */

/** @param {unknown} value */
function messageFixture(value) {
  if (value === undefined || value === null) return value;
  /** @type {Record<string, unknown>} */
  const result = {
    schemaVersion: 1,
    ...structuredClone(/** @type {Record<string, unknown>} */ (value)),
  };
  const desired = /** @type {Record<string, unknown> | null | undefined} */ (
    result.desired
  );
  if (desired && desired.schemaVersion === undefined)
    result.desired =
      desired.operation === "edit"
        ? buildTelegramEditDesired(
            /** @type {import("../runtime/telegram/desiredStateCore").TelegramEditDesiredInput} */ ({
              sourceRevision: "fixture-source",
              ...desired,
            }),
          )
        : buildTelegramSendDesired(
            /** @type {import("../runtime/telegram/desiredStateCore").TelegramSendDesiredInput} */ ({
              sourceRevision: "fixture-source",
              ...desired,
            }),
          );
  if (result.applied)
    result.applied = {
      appliedAtMs: 1,
      chatId: "fixture-chat",
      revision: "applied-revision",
      .../** @type {Record<string, unknown>} */ (result.applied),
    };
  if (result.delivery) {
    const currentDesired =
      /** @type {{revision?: unknown} | null | undefined} */ (result.desired);
    const applied = /** @type {{revision?: unknown} | null | undefined} */ (
      result.applied
    );
    result.delivery = {
      revision:
        currentDesired?.revision || applied?.revision || "fixture-revision",
      .../** @type {Record<string, unknown>} */ (result.delivery),
    };
  }
  return result;
}

const statePrefix = "eventTelegramProjections/";
const messagePrefix = "telegramMessages/";
const desiredSuffix = "/desired";

/** @param {LegacyUpdates} updates */
const desiredChanges = (updates) =>
  Object.entries(updates).map(([path, value]) => ({
    messageKey:
      path.startsWith(messagePrefix) && path.endsWith(desiredSuffix)
        ? path.slice(messagePrefix.length, -desiredSuffix.length)
        : "",
    value,
  }));

/**
 * @param {ProjectionChanges | null} changes
 * @returns {LegacyUpdates}
 */
const toUpdates = (changes) =>
  changes
    ? {
        [`${statePrefix}${changes.eventId}`]: changes.state,
        ...Object.fromEntries(
          changes.desired.map(({ messageKey, value }) => [
            `${messagePrefix}${messageKey}${desiredSuffix}`,
            value,
          ]),
        ),
      }
    : {};

/** @param {{eventId: string, updates: LegacyUpdates}} input */
const splitEventTelegramProjectionUpdates = ({ eventId, updates }) => {
  const statePath = `${statePrefix}${eventId}`;
  if (!Object.hasOwn(updates, statePath)) {
    throw new TypeError("event Telegram projection state update is required");
  }
  return {
    stateUpdates: { [statePath]: updates[statePath] },
    desiredUpdates: Object.fromEntries(
      Object.entries(updates).filter(([path]) => path !== statePath),
    ),
  };
};

module.exports = {
  ...core,
  /** @param {Parameters<typeof core.buildEventTelegramProjection>[0]} input */
  buildEventTelegramProjection(input) {
    return core.buildEventTelegramProjection({
      ...input,
      state:
        input.state == null
          ? input.state
          : canonicalEventTelegramProjection(
              /** @type {ProjectionStatePatch} */ (input.state),
            ),
      upcomingMessage: messageFixture(input.upcomingMessage),
      reminderMessage: messageFixture(input.reminderMessage),
    });
  },
  /** @param {Parameters<typeof core.buildEventTelegramProjectionChanges>[0]} input */
  buildEventTelegramProjectionUpdates(input) {
    return toUpdates(core.buildEventTelegramProjectionChanges(input));
  },
  /** @param {{updates: LegacyUpdates, guard?: ProjectionGuard | null}} input */
  addEventTelegramProjectionGuard({ updates, guard }) {
    if (!guard) return updates;
    const statePath = `${statePrefix}${guard.eventId}`;
    const changes = {
      eventId: guard.eventId,
      state: canonicalEventTelegramProjection(
        /** @type {ProjectionStatePatch} */ (updates[statePath] || {}),
      ),
      desired: desiredChanges(
        Object.fromEntries(
          Object.entries(updates).filter(([path]) => path !== statePath),
        ),
      ),
    };
    const guarded = toUpdates(
      core.addEventTelegramProjectionGuard({
        changes: /** @type {ProjectionChanges} */ (changes),
        guard,
      }),
    );
    return Object.fromEntries(
      Object.entries(guarded).filter(([path]) => Object.hasOwn(updates, path)),
    );
  },
  splitEventTelegramProjectionUpdates,
  /** @param {{eventId: string, desiredUpdates: LegacyUpdates}} input */
  buildEventTelegramDispatches({ eventId, desiredUpdates }) {
    return core.buildEventTelegramDispatches({
      eventId,
      desiredChanges: /** @type {DesiredChange[]} */ (
        desiredChanges(desiredUpdates)
      ),
    });
  },
};
