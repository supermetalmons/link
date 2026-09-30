// Generated from src/telegram/eventParticipants.ts. Run npm run generate:runtime.
declare const getParticipantRecords: (eventData: unknown) => {
  profileId: string;
  participant: Record<string, unknown>;
}[];
declare const buildParticipantRenderKey: (eventData: unknown) => string;
declare const resolveParticipantToken: (
  participant: unknown,
  fallbackDisplayName?: unknown,
) => string;
declare const renderParticipantLine: (eventData: unknown) => string;
export {
  buildParticipantRenderKey,
  getParticipantRecords,
  renderParticipantLine,
  resolveParticipantToken,
};
