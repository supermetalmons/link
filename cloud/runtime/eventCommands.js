// Generated from src/eventCommands.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventCommandIdentity =
  exports.mergeEventPlans =
  exports.eventField =
  exports.isEventMutation =
    void 0;
exports.getEventField = getEventField;
const EFFECT_KIND_REGISTRY = {
  invite: true,
  "match-creation": true,
  "match-terminal-timer": true,
  "match-timer-start-cleanup": true,
  "match-timer-claim": true,
};
const EFFECT_KINDS = new Set(Object.keys(EFFECT_KIND_REGISTRY));
const isEventMutation = (command) => !EFFECT_KINDS.has(command.kind);
exports.isEventMutation = isEventMutation;
const eventField = (eventId, field, value) => ({
  kind: "event-field",
  eventId,
  field,
  value,
});
exports.eventField = eventField;
const eventCommandIdentity = (command) => {
  const fields = command;
  return JSON.stringify([
    fields.kind,
    fields.eventId,
    fields.profileId,
    fields.outboxId,
    fields.inviteId,
    fields.playerId,
    fields.matchId,
    fields.field,
    fields.roundKey,
    fields.matchKey,
  ]);
};
exports.eventCommandIdentity = eventCommandIdentity;
const mergeEventPlans = (...plans) => {
  const commands = new Map();
  for (const command of plans.flat())
    commands.set(eventCommandIdentity(command), command);
  return [...commands.values()];
};
exports.mergeEventPlans = mergeEventPlans;
function getEventField(plan, eventId, field) {
  const command = plan.findLast(
    (command) =>
      command.kind === "event-field" &&
      command.eventId === eventId &&
      command.field === field,
  );
  return command?.value;
}
