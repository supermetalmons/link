// Generated from src/eventPrizes/assets.ts. Run npm run generate:runtime.
import type { Umi, TransactionBuilder } from "@metaplex-foundation/umi";
import type { AssetWithProof } from "@metaplex-foundation/mpl-bubblegum";
import type { EventPrizeDefinition } from "@mons/shared/event-prizes";
import type { PrizeAssetState } from "./solanaTypes.js";
import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";
type PrizeIdentity = Pick<
  EventPrizeDefinition,
  "assetAddress" | "collectionAddress"
>;
type PrizeAssetInput = {
  umi: Umi;
  prize: EventPrizeDefinition;
  recipientAddress: string;
};
declare const createPrizeAssetVerificationError: (
  message: string,
) => HttpsError;
declare const validateCompressedPrizeAsset: ({
  umi,
  prize,
  assetWithProof: rawProofAsset,
}: {
  umi: Umi;
  prize: PrizeIdentity | null | undefined;
  assetWithProof: unknown;
}) => PrizeAssetState;
declare const buildCompressedTransferBuilder: ({
  umi,
  assetWithProof,
  recipientAddress,
}: {
  umi: Umi;
  assetWithProof: AssetWithProof;
  recipientAddress: string;
}) => TransactionBuilder;
declare const loadPrizeAssetState: ({
  umi,
  prize,
  recipientAddress,
  needsTransferBuilder,
}: PrizeAssetInput & {
  needsTransferBuilder?: boolean;
}) => Promise<PrizeAssetState>;
export {
  buildCompressedTransferBuilder,
  createPrizeAssetVerificationError,
  loadPrizeAssetState,
  validateCompressedPrizeAsset,
};
