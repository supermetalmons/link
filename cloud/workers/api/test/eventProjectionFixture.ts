import { canonicalEventTelegramProjection } from "../../../../test/fixtures/canonicalData.mjs";
export function eventProjectionStateFixture(value: unknown = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid projection fixture");
  return canonicalEventTelegramProjection(value);
}
