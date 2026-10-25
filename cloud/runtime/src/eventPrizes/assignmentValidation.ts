import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const validatePrizeAssignment = ({
  assignment,
  eventId,
  prizeId,
  profileId,
}: {
  assignment: unknown;
  eventId: string;
  prizeId: string;
  profileId: string;
}): 1 | 2 | 3 => {
  const fields = assignment as
    | {
        eventId?: unknown;
        prizeId?: unknown;
        profileId?: unknown;
        place?: unknown;
      }
    | null
    | undefined;
  const place = Number(fields?.place);
  if (
    !assignment ||
    normalizeString(fields?.eventId) !== eventId ||
    normalizeString(fields?.prizeId) !== prizeId ||
    normalizeString(fields?.profileId) !== profileId ||
    (place !== 1 && place !== 2 && place !== 3)
  ) {
    throw new HttpsError("not-found", "Event prize not found.");
  }
  return place;
};

export { validatePrizeAssignment };
