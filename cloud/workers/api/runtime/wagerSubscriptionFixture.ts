import type { PublicMatchWagerState } from "@mons/shared/invite-wagers";
import { wagerRecordFixture } from "../test/wagerRecordFixture.ts";

export function subscriptionWagerFixture(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const proposals = row.proposals;
  return wagerRecordFixture({
    ...row,
    ...(proposals && typeof proposals === "object" && !Array.isArray(proposals)
      ? {
          proposals: Object.fromEntries(
            Object.entries(proposals).map(([uid, proposal]) => [
              uid,
              proposal &&
              typeof proposal === "object" &&
              !Array.isArray(proposal)
                ? {
                    operationId: "a".repeat(64),
                    reservationOperationId: "b".repeat(64),
                    ...proposal,
                  }
                : proposal,
            ]),
          ),
        }
      : {}),
  });
}

export function publicWagerFixture(
  overrides: Partial<PublicMatchWagerState> = {},
): PublicMatchWagerState {
  return {
    schemaVersion: 1,
    state: overrides.resolved
      ? "settled"
      : overrides.agreed
        ? "agreed"
        : "proposed",
    proposals: {},
    proposedBy: {},
    agreed: null,
    resolved: null,
    blocked: null,
    ...overrides,
  };
}
