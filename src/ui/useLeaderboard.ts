import { useCallback, useEffect, useRef, useState } from "react";
import { createEmptyMaterials } from "@mons/shared/mining";
import {
  type PlayerProfile,
  type MiningMaterialName,
  MINING_MATERIAL_NAMES,
} from "../connection/connectionModels";
import { flushDeferredProfilePresentation } from "../connection/deferredProfilePresentation";
import { resolveENS } from "../utils/ensResolver";
import { getStashedPlayerProfile } from "../utils/playerMetadata";
import { storage } from "../utils/storage";
import {
  leaderboardCache,
  type LeaderboardEntry,
  type LeaderboardType,
} from "./leaderboardCache";
import {
  createLeaderboardEntry,
  populateMaterialLeaderboardCaches,
  profilesToLeaderboardEntries,
} from "./leaderboardModels";
import { getLeaderboardProfiles } from "./profileSurfaceDataPort";

type UseLeaderboardOptions = {
  show: boolean;
  leaderboardType: LeaderboardType;
};

export const useLeaderboard = ({
  show,
  leaderboardType,
}: UseLeaderboardOptions) => {
  const [data, setData] = useState<LeaderboardEntry[] | null>(
    () => leaderboardCache.get(leaderboardType) ?? null,
  );
  const currentFetchRef = useRef<number>(0);
  const currentProfileId = storage.getProfileId("");
  const currentLoginId = storage.getLoginId("");

  const getCurrentPlayerEntry = useCallback((): LeaderboardEntry | null => {
    if (!currentProfileId) return null;
    flushDeferredProfilePresentation();
    const storedUsername = storage.getUsername("");
    const storedEth = storage.getEthAddress("");
    const storedSol = storage.getSolAddress("");
    const storedEmoji = parseInt(storage.getPlayerEmojiId("1"), 10) || 1;
    const storedAura = storage.getPlayerEmojiAura("") || undefined;
    const storedMaterials = storage.getMiningMaterials(
      createEmptyMaterials(),
    ) as Record<MiningMaterialName, number>;
    const storedMining = {
      lastRockDate: storage.getMiningLastRockDate(null),
      materials: { ...createEmptyMaterials(), ...storedMaterials },
    };
    const stashedProfile = currentLoginId
      ? getStashedPlayerProfile(currentLoginId)
      : undefined;
    const profile =
      stashedProfile && stashedProfile.id === currentProfileId
        ? stashedProfile
        : undefined;
    const mergedProfile: PlayerProfile = {
      id: currentProfileId,
      nonce: profile?.nonce ?? storage.getPlayerNonce(-1),
      rating: profile?.rating ?? storage.getPlayerRating(1500),
      win: profile?.win ?? true,
      emoji: profile?.emoji ?? storedEmoji,
      aura: profile?.aura ?? storedAura,
      totalManaPoints:
        profile?.totalManaPoints ?? storage.getPlayerTotalManaPoints(0),
      cardBackgroundId:
        profile?.cardBackgroundId ?? storage.getCardBackgroundId(0),
      cardSubtitleId: profile?.cardSubtitleId ?? storage.getCardSubtitleId(0),
      profileCounter:
        profile?.profileCounter ?? storage.getProfileCounter("gp"),
      profileMons: profile?.profileMons ?? storage.getProfileMons(""),
      cardStickers: profile?.cardStickers ?? storage.getCardStickers(""),
      username: profile?.username ?? (storedUsername ? storedUsername : null),
      eth: profile?.eth ?? (storedEth ? storedEth : null),
      sol: profile?.sol ?? (storedSol ? storedSol : null),
      completedProblemIds: profile?.completedProblemIds,
      isTutorialCompleted: profile?.isTutorialCompleted,
      mining: profile?.mining ?? storedMining,
    };
    return createLeaderboardEntry(mergedProfile);
  }, [currentProfileId, currentLoginId]);

  useEffect(() => {
    setData(leaderboardCache.get(leaderboardType) ?? null);
  }, [leaderboardType]);

  useEffect(() => {
    if (!show) {
      currentFetchRef.current += 1;
      return;
    }

    const fetchId = ++currentFetchRef.current;

    getLeaderboardProfiles(leaderboardType)
      .then((profiles) => {
        if (fetchId !== currentFetchRef.current) return;

        const leaderboardData = profilesToLeaderboardEntries(profiles);
        const currentEntry = getCurrentPlayerEntry();
        const mergedLeaderboardData =
          currentEntry &&
          !leaderboardData.some((entry) => entry.id === currentEntry.id)
            ? [...leaderboardData, currentEntry]
            : leaderboardData;
        const displayLeaderboardData = mergedLeaderboardData;
        leaderboardCache.set(leaderboardType, displayLeaderboardData);
        setData(displayLeaderboardData);

        if (
          leaderboardType === "total" ||
          MINING_MATERIAL_NAMES.includes(leaderboardType as MiningMaterialName)
        ) {
          populateMaterialLeaderboardCaches(
            leaderboardCache,
            profilesToLeaderboardEntries(profiles),
          );
        }

        const activeLeaderboardType = leaderboardType;
        displayLeaderboardData.forEach((entry, index) => {
          if (entry.eth && !entry.username) {
            void resolveENS(entry.eth).then((ensName) => {
              if (!ensName || fetchId !== currentFetchRef.current) {
                return;
              }
              setData((prevData) => {
                if (
                  !prevData ||
                  fetchId !== currentFetchRef.current ||
                  index >= prevData.length
                ) {
                  return prevData;
                }
                const newData = [...prevData];
                newData[index] = { ...newData[index], ensName };
                leaderboardCache.set(activeLeaderboardType, newData);
                return newData;
              });
            });
          }
        });
      })
      .catch((error) => {
        console.error("Failed to fetch leaderboard data:", error);
      });
    return () => {
      currentFetchRef.current += 1;
    };
  }, [show, leaderboardType, getCurrentPlayerEntry]);

  return { data, currentProfileId, currentLoginId };
};
