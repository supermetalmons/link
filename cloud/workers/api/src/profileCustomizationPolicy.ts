import type { NftApiResponse } from "@mons/shared/nfts";
import type { ProfileCustomizationUpdateRequest } from "@mons/shared/profiles";
import { AuthApiFailure } from "./authErrors.ts";
import { fetchNftInventory } from "./inventory.ts";
import type { ProfileCustomizationProfile } from "./profileCustomizationRepository.ts";
import {
  HELIUS_TIMEOUT_MS,
  MAX_HELIUS_RESPONSE_BODY_BYTES,
  type WorkerDependencies,
} from "./provider.ts";

type InventoryRequirement = {
  collection: "specials" | "swagpack_avatars";
  id: number;
  count: number;
};

type ProfileCustomizationPolicyDependencies = {
  fetchInventory?: (
    profile: ProfileCustomizationProfile,
    signal?: AbortSignal,
  ) => Promise<NftApiResponse>;
  signal?: AbortSignal;
};

function inventoryRequirement(
  request: ProfileCustomizationUpdateRequest,
  profile: ProfileCustomizationProfile,
): InventoryRequirement | null {
  if (request.field === "emojiAndAura" && request.value.emoji >= 1000) {
    return {
      collection: "swagpack_avatars",
      id: request.value.emoji - 1000,
      count: request.value.aura === "rainbow" ? 3 : 1,
    };
  }
  if (request.field === "cardBackgroundId" && request.value === 100) {
    return { collection: "specials", id: 1, count: 1 };
  }
  if (request.field === "profileMons" && request.value.split(",")[2] === "5") {
    return { collection: "specials", id: 0, count: 1 };
  }
  if (request.field === "cardStickers" && request.value) {
    const stickers = JSON.parse(request.value) as Record<string, string>;
    if (stickers["big-mon-top-right"] === "gate") {
      return { collection: "specials", id: 2, count: 1 };
    }
  }
  return null;
}

function createInventoryFetcher(env: Env, signal?: AbortSignal) {
  const dependencies: WorkerDependencies = {
    providerFetch: (input, init) => fetch(input, init),
    providerTimeoutMs: HELIUS_TIMEOUT_MS,
    providerMaxResponseBodyBytes: MAX_HELIUS_RESPONSE_BODY_BYTES,
    logProviderFailure: () => undefined,
    logRateLimitFailure: () => undefined,
  };
  return (profile: ProfileCustomizationProfile) =>
    fetchNftInventory(
      { sol: profile.sol, eth: profile.eth },
      env,
      dependencies,
      signal,
    );
}

export async function authorizeProfileCustomization(
  request: ProfileCustomizationUpdateRequest,
  profile: ProfileCustomizationProfile,
  env: Env,
  dependencies: ProfileCustomizationPolicyDependencies = {},
): Promise<void> {
  dependencies.signal?.throwIfAborted();
  const requirement = inventoryRequirement(request, profile);
  if (!requirement) {
    return;
  }
  let inventory: NftApiResponse;
  try {
    inventory = await (
      dependencies.fetchInventory ||
      createInventoryFetcher(env, dependencies.signal)
    )(profile, dependencies.signal);
  } catch {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "profile-customization-service-unavailable",
    );
  }
  dependencies.signal?.throwIfAborted();
  if (
    !inventory[requirement.collection].some(
      (item) => item.id === requirement.id && item.count >= requirement.count,
    )
  ) {
    throw new AuthApiFailure(
      403,
      "permission-denied",
      "profile-customization-not-owned",
    );
  }
}

export { inventoryRequirement };
