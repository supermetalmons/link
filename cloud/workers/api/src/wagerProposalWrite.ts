import type { DecodedWager } from "./wagerModel.ts";

export type ProposalWriteObservation =
  | { source: "command"; wager: DecodedWager | null }
  | { source: "readback"; wager: DecodedWager | null };

export async function observeProposalWrite({
  refreshLease,
  command,
  readback,
}: {
  refreshLease: () => Promise<void>;
  command: () => Promise<DecodedWager | null>;
  readback: () => Promise<DecodedWager | null>;
}): Promise<ProposalWriteObservation> {
  await refreshLease();
  try {
    return { source: "command", wager: await command() };
  } catch {
    return { source: "readback", wager: await readback() };
  }
}
