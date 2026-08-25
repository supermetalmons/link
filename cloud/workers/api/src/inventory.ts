import {
  createEmptyNftApiResponse,
  VALID_REACTION_IDS,
  type NftApiRequest,
  type NftApiResponse,
} from "@mons/shared/nfts";
import {
  fetchCollectionIdCounts,
  PRIMARY_COLLECTION_ID,
  SPECIALS_COLLECTION_ID,
  type HeliusLookupContext,
} from "./helius.ts";
import { ProviderFailure, type WorkerDependencies } from "./provider.ts";

const REACTION_IDS = new Set<number>(VALID_REACTION_IDS);

export async function fetchNftInventory(
  requestBody: NftApiRequest,
  env: Env,
  dependencies: WorkerDependencies,
  operationSignal?: AbortSignal,
): Promise<NftApiResponse> {
  if (!requestBody.sol) {
    return createEmptyNftApiResponse();
  }
  const apiKey = env.HELIUS_RPC_API_KEY.trim();
  if (!apiKey) {
    throw new ProviderFailure("configuration");
  }

  const controller = new AbortController();
  const signals = [
    controller.signal,
    AbortSignal.timeout(dependencies.providerTimeoutMs),
  ];
  if (operationSignal) {
    signals.push(operationSignal);
  }
  const context: HeliusLookupContext = {
    apiKey,
    ownerAddress: requestBody.sol,
    signal: AbortSignal.any(signals),
    dependencies,
  };
  try {
    const [swagpackAvatars, specials] = await Promise.all([
      fetchCollectionIdCounts(context, PRIMARY_COLLECTION_ID),
      fetchCollectionIdCounts(context, SPECIALS_COLLECTION_ID),
    ]);
    return {
      ok: true,
      specials,
      swagpack_avatars: swagpackAvatars,
      swagpack_reactions: swagpackAvatars.filter(({ id }) =>
        REACTION_IDS.has(id),
      ),
    };
  } catch (error) {
    controller.abort();
    throw error;
  }
}
