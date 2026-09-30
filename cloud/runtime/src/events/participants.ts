const getEventParticipantIds = (
  event: { participants?: unknown } | null | undefined,
) => {
  const participants =
    event && event.participants && typeof event.participants === "object"
      ? (event.participants as Record<string, unknown>)
      : {};
  return Object.keys(participants).filter(
    (profileId) =>
      participants[profileId] && typeof participants[profileId] === "object",
  );
};

export { getEventParticipantIds };
