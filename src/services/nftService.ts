import { connection } from "../connection/connection";
import { VALID_REACTION_IDS } from "@mons/shared/nfts";
import { shuffle } from "@mons/shared/ids";
import type { AuthState } from "../connection/authentication";
import type { AuthIdentity } from "../utils/storage";
import {
  fetchCachedNfts,
  getEmptyNftCollection,
  NFT_CACHE_TTL_MS,
  type NftFetchSnapshot,
} from "./nftCache";

export { NFT_CACHE_TTL_MS, type NftFetchSnapshot } from "./nftCache";

const USE_STUB_RESPONSE = false;

export function getNftIdentityKey({
  profileId,
  solAddress,
  ethAddress,
}: AuthIdentity): string | null {
  if (!profileId) {
    return null;
  }
  return JSON.stringify([profileId, solAddress || "", ethAddress || ""]);
}

function generateStubResponse() {
  const validReactionIds = Array.from(VALID_REACTION_IDS);
  const validAvatarIds = Array.from({ length: 467 }, (_, i) => i);
  const randomInt = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;
  const reactionCount = randomInt(1, Math.min(50, validReactionIds.length));
  const selectedReactionIds = shuffle(validReactionIds).slice(0, reactionCount);
  const swagpack_reactions = selectedReactionIds.map((id) => ({
    id,
    count: randomInt(1, 10),
  }));

  const usedIds = new Set(selectedReactionIds);
  const maxExtraAvatars = 50 - swagpack_reactions.length;
  const extraAvatarCount =
    maxExtraAvatars > 0 ? randomInt(0, maxExtraAvatars) : 0;
  const availableAvatarOnlyIds = shuffle(
    validAvatarIds.filter((id) => !usedIds.has(id)),
  ).slice(0, extraAvatarCount);
  const swagpack_avatars = [
    ...swagpack_reactions.map((x) => ({ id: x.id, count: x.count })),
    ...availableAvatarOnlyIds.map((id) => ({ id, count: randomInt(1, 10) })),
  ];
  const specials = [
    { id: 0, count: 1 },
    { id: 1, count: 2 },
    { id: 2, count: 3 },
  ];

  return { ok: true, specials, swagpack_avatars, swagpack_reactions };
}

async function fetchNftsByIdentity(
  key: string,
  sol: string,
  eth: string,
): Promise<NftFetchSnapshot> {
  if (USE_STUB_RESPONSE) {
    return {
      data: generateStubResponse(),
      expiresAtMs: Date.now() + NFT_CACHE_TTL_MS,
    };
  }

  return fetchCachedNfts(key, sol, eth, () => connection.getNfts(sol, eth));
}

export async function fetchNftsForIdentity(
  identity: AuthState,
): Promise<NftFetchSnapshot> {
  if (identity.authStatus !== "authenticated") {
    return {
      data: getEmptyNftCollection(),
      expiresAtMs: Date.now() + NFT_CACHE_TTL_MS,
    };
  }
  const key = getNftIdentityKey(identity);
  if (!key) {
    return { data: { ok: false }, expiresAtMs: 0 };
  }
  return fetchNftsByIdentity(key, identity.solAddress, identity.ethAddress);
}
