import type {
  CardBackgroundId,
  CardSubtitleId,
  ProfileCounter,
  SelectedMons,
  StickerMap,
} from "@mons/shared/appearance";
import type { Aura } from "@mons/shared/appearance";
import type { ProfileCustomizationUpdateRequest } from "@mons/shared/profiles";
import type { UsernameEditResponse } from "@mons/shared/usernames";
import type { AuthTokenProvider } from "../services/apiTransport";
import {
  MINING_MATERIAL_NAMES,
  type MiningMaterialName,
  type PlayerProfile,
} from "./connectionModels";
import { resolvePlayerProfileWithRetry } from "./playerProfileLookup";

type BoundAuthTokenProvider = AuthTokenProvider & {
  readonly assertCurrentUser: () => void;
};

export type ProfileClientApi = Pick<
  typeof import("../services/profileApi"),
  | "editUsernameViaApi"
  | "getProfileByIdViaApi"
  | "getProfileByLoginIdViaApi"
  | "readLeaderboardViaApi"
  | "resolveProfileIdViaApi"
  | "updateProfileCustomizationViaApi"
>;

export type ProfileClientDependencies = {
  ensureAuthenticated: () => Promise<void>;
  getAuthApiToken: AuthTokenProvider;
  getUserBoundAuthTokenProvider: () => BoundAuthTokenProvider;
  getLocalProfileId: () => string | null;
  getStoredEmojiAura: () => Aura;
  invalidateInitialIdentity: () => void;
  api: ProfileClientApi;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
};

const LEADERBOARD_ENTRY_LIMIT = 99;
const LEADERBOARD_CACHE_TTL_MS = 60_000;
const PROFILE_LOOKUP_RETRY_DELAY_MS = 1_000;

export class ProfileClient {
  private readonly dependencies: ProfileClientDependencies;
  private materialLeaderboardCache: Map<MiningMaterialName, PlayerProfile[]> =
    new Map();
  private materialLeaderboardCacheTime = 0;
  private leaderboardCacheGeneration = 0;

  constructor(dependencies: ProfileClientDependencies) {
    this.dependencies = dependencies;
  }

  public async getProfileByLoginId(loginId: string): Promise<PlayerProfile> {
    await this.dependencies.ensureAuthenticated();
    return this.dependencies.api.getProfileByLoginIdViaApi(
      loginId,
      this.dependencies.getAuthApiToken,
    );
  }

  public async getProfileById(
    profileId: string,
  ): Promise<PlayerProfile | null> {
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId) {
      return null;
    }
    await this.dependencies.ensureAuthenticated();
    return this.dependencies.api.getProfileByIdViaApi(
      normalizedProfileId,
      this.dependencies.getAuthApiToken,
    );
  }

  public async resolveProfileId(profileId: string): Promise<string | null> {
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId) return null;
    await this.dependencies.ensureAuthenticated();
    const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
    const canonicalId = await this.dependencies.api.resolveProfileIdViaApi(
      normalizedProfileId,
      tokenProvider,
    );
    tokenProvider.assertCurrentUser();
    return canonicalId;
  }

  public async getPlayerProfileWithRetry(
    loginId: string,
    isCurrent: () => boolean,
  ): Promise<PlayerProfile | null> {
    await this.dependencies.ensureAuthenticated();
    if (!isCurrent()) {
      return null;
    }
    const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
    return resolvePlayerProfileWithRetry(
      loginId,
      {
        getProfileByLoginId: async (playerLoginId) => {
          const profile = await this.dependencies.api.getProfileByLoginIdViaApi(
            playerLoginId,
            tokenProvider,
          );
          tokenProvider.assertCurrentUser();
          return profile;
        },
      },
      isCurrent,
      () => this.dependencies.wait(PROFILE_LOOKUP_RETRY_DELAY_MS),
    );
  }

  private assertLeaderboardRequestCurrent(generation: number): void {
    if (generation !== this.leaderboardCacheGeneration) {
      throw new Error("authentication-changed");
    }
  }

  private async fetchAllMaterialLeaderboards(
    generation: number,
  ): Promise<void> {
    const leaderboards = await Promise.all(
      MINING_MATERIAL_NAMES.map((material) =>
        this.dependencies.api.readLeaderboardViaApi(
          material,
          this.dependencies.getAuthApiToken,
        ),
      ),
    );
    this.assertLeaderboardRequestCurrent(generation);
    MINING_MATERIAL_NAMES.forEach((material, index) => {
      this.materialLeaderboardCache.set(material, leaderboards[index]!);
    });
    this.materialLeaderboardCacheTime = this.dependencies.now();
  }

  private isMaterialCacheValid(): boolean {
    return (
      this.materialLeaderboardCache.size === MINING_MATERIAL_NAMES.length &&
      this.dependencies.now() - this.materialLeaderboardCacheTime <
        LEADERBOARD_CACHE_TTL_MS
    );
  }

  public async getLeaderboard(
    type: "rating" | "mp" | MiningMaterialName | "total" = "rating",
  ): Promise<PlayerProfile[]> {
    const generation = this.leaderboardCacheGeneration;
    await this.dependencies.ensureAuthenticated();
    this.assertLeaderboardRequestCurrent(generation);

    if (type === "total") {
      if (!this.isMaterialCacheValid()) {
        await this.fetchAllMaterialLeaderboards(generation);
      }
      this.assertLeaderboardRequestCurrent(generation);
      const profileMap = new Map<string, PlayerProfile>();
      MINING_MATERIAL_NAMES.forEach((material) => {
        const cached = this.materialLeaderboardCache.get(material);
        if (cached) {
          cached.forEach((profile) => {
            if (!profileMap.has(profile.id)) {
              profileMap.set(profile.id, profile);
            }
          });
        }
      });
      const profiles = Array.from(profileMap.values());
      profiles.sort((a, b) => {
        const totalA = a.mining
          ? Object.values(a.mining.materials).reduce((sum, val) => sum + val, 0)
          : 0;
        const totalB = b.mining
          ? Object.values(b.mining.materials).reduce((sum, val) => sum + val, 0)
          : 0;
        return totalB - totalA;
      });
      return profiles.slice(0, LEADERBOARD_ENTRY_LIMIT);
    }

    if (MINING_MATERIAL_NAMES.includes(type as MiningMaterialName)) {
      const materialType = type as MiningMaterialName;
      if (this.isMaterialCacheValid()) {
        const cached = this.materialLeaderboardCache.get(materialType);
        if (cached) {
          return cached;
        }
      }
      await this.fetchAllMaterialLeaderboards(generation);
      this.assertLeaderboardRequestCurrent(generation);
      return this.materialLeaderboardCache.get(materialType) ?? [];
    }

    const profiles = await this.dependencies.api.readLeaderboardViaApi(
      type,
      this.dependencies.getAuthApiToken,
    );
    this.assertLeaderboardRequestCurrent(generation);
    return profiles;
  }

  public async editUsername(username: string): Promise<UsernameEditResponse> {
    try {
      await this.dependencies.ensureAuthenticated();
      const tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
      const result = await this.dependencies.api.editUsernameViaApi(
        username,
        tokenProvider,
      );
      tokenProvider.assertCurrentUser();
      if (result.ok) this.dependencies.invalidateInitialIdentity();
      return result;
    } catch (error) {
      console.error("Error editing username:", error);
      throw error;
    }
  }

  public updateStoredEmoji(newId: number, aura: Aura | undefined): void {
    const storedAura = aura ?? this.dependencies.getStoredEmojiAura();
    this.updateCustomField({
      field: "emojiAndAura",
      value: {
        emoji: newId,
        aura: storedAura,
      },
    });
  }

  public updateCardBackgroundId(newId: CardBackgroundId): void {
    this.updateCustomField({ field: "cardBackgroundId", value: newId });
  }

  public updateCardSubtitleId(newId: CardSubtitleId): void {
    this.updateCustomField({ field: "cardSubtitleId", value: newId });
  }

  public updateProfileCounter(counter: ProfileCounter): void {
    if (counter === "gp" || counter === "mp") {
      this.updateCustomField({ field: "profileCounter", value: counter });
    }
  }

  public updateProfileMons(mons: SelectedMons | null): void {
    this.updateCustomField({ field: "profileMons", value: mons });
  }

  public updateCardStickers(stickers: StickerMap): void {
    this.updateCustomField({ field: "cardStickers", value: stickers });
  }

  public updateCompletedProblems(ids: string[]): void {
    this.updateCustomField({ field: "completedProblems", value: ids });
  }

  public updateTutorialCompleted(completed: boolean): void {
    this.updateCustomField({ field: "tutorialCompleted", value: completed });
  }

  private updateCustomField(request: ProfileCustomizationUpdateRequest): void {
    const profileId = this.dependencies.getLocalProfileId();
    if (profileId === null) {
      return;
    }
    let tokenProvider: AuthTokenProvider;
    try {
      tokenProvider = this.dependencies.getUserBoundAuthTokenProvider();
    } catch {
      return;
    }
    void this.dependencies.api
      .updateProfileCustomizationViaApi(request, tokenProvider)
      .then(() => {
        tokenProvider.assertCurrentUser?.();
        this.dependencies.invalidateInitialIdentity();
      })
      .catch(() => undefined);
  }

  public resetProfile(): void {
    this.leaderboardCacheGeneration += 1;
    this.materialLeaderboardCache.clear();
    this.materialLeaderboardCacheTime = 0;
  }
}
