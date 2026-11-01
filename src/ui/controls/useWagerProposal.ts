import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AuthState } from "../../connection/authModels";
import { connection } from "../../connection/connection";
import type { MatchWagerState } from "../../connection/connectionModels";
import {
  hasConfirmedWagerSnapshot,
  subscribeToWagerState,
} from "../../game/wagerState";
import { useAvailableMaterials } from "../../hooks/useAvailableMaterials";
import { useMaterialImages } from "../../hooks/useMaterialImages";
import type { MaterialName } from "../../services/rocksMiningService";
import { getStashedPlayerProfile } from "../../utils/playerMetadata";
import {
  getOpponentReactionUid,
  getPlayerReactionUid,
} from "./boardReactionPort";
import type {
  BottomControlsUiAction,
  BottomControlsUiState,
} from "./bottomControlsUiState";
import type { WagerPickerProps } from "./WagerPicker";

type UseWagerProposalOptions = {
  authState: Pick<AuthState, "authStatus" | "profileId">;
  canWagerInCurrentGame: boolean;
  reactionPicker: BottomControlsUiState["popups"]["reaction"];
  dispatchControlsUi: (action: BottomControlsUiAction) => void;
};

export const useWagerProposal = ({
  authState,
  canWagerInCurrentGame,
  reactionPicker,
  dispatchControlsUi,
}: UseWagerProposalOptions) => {
  const { authStatus, profileId } = authState;
  const isAuthenticated = authStatus === "authenticated";
  const materialUrls = useMaterialImages(reactionPicker.mode === "wager");
  const hasConfirmedInviteWagers = useSyncExternalStore(
    subscribeToWagerState,
    hasConfirmedWagerSnapshot,
    hasConfirmedWagerSnapshot,
  );
  const {
    availableMaterials: materialAmounts,
    frozenMaterialsStatus,
    hasConfirmedSnapshot: hasFrozenSnapshot,
  } = useAvailableMaterials();
  const [wagerState, setWagerState] = useState<MatchWagerState | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToWagerState((state) => {
      setWagerState(state);
    });
    return unsubscribe;
  }, []);

  const playerUid = getPlayerReactionUid();
  const opponentUid = getOpponentReactionUid();
  const opponentProfile = opponentUid
    ? getStashedPlayerProfile(opponentUid)
    : undefined;
  const playerHasProfile = isAuthenticated && profileId !== "";
  const opponentHasProfile = !!(opponentProfile && opponentProfile.id);
  const wagerRequiresManualReview =
    wagerState?.blocked?.requiresManualReview === true;
  const hasAgreedWager = !!wagerState?.agreed;
  const hasResolvedWager = !!wagerState?.resolved;
  const playerHasProposed =
    !!(
      playerUid &&
      wagerState?.proposedBy &&
      wagerState.proposedBy[playerUid]
    ) ||
    !!(playerUid && wagerState?.proposals && wagerState.proposals[playerUid]);
  const hasPlayers = !!playerUid && !!opponentUid;
  const isEligibleForWager =
    canWagerInCurrentGame &&
    playerHasProfile &&
    opponentHasProfile &&
    hasPlayers;
  const canSubmitWager =
    hasConfirmedInviteWagers &&
    isEligibleForWager &&
    !wagerRequiresManualReview &&
    !hasAgreedWager &&
    !hasResolvedWager &&
    !playerHasProposed;
  const wagerMaterial = reactionPicker.selection.name;
  const wagerCount = reactionPicker.selection.count;
  const wagerReady =
    canSubmitWager &&
    frozenMaterialsStatus === "ready" &&
    !!wagerMaterial &&
    wagerCount > 0;

  const handleWagerModeToggle = useCallback(() => {
    dispatchControlsUi({ type: "enterWager" });
  }, [dispatchControlsUi]);

  const handleMaterialSelect = useCallback(
    (name: MaterialName) => {
      if (frozenMaterialsStatus !== "ready") return;
      const total = materialAmounts[name] ?? 0;
      if (total <= 0) return;
      dispatchControlsUi({ type: "selectWagerMaterial", name, total });
    },
    [dispatchControlsUi, materialAmounts, frozenMaterialsStatus],
  );

  const handleWagerSubmit = useCallback(() => {
    if (!wagerMaterial || !wagerReady) {
      return;
    }
    dispatchControlsUi({ type: "dismissPopups", reaction: true });
    const material = wagerMaterial;
    const count = wagerCount;
    connection.sendWagerProposal(material, count).catch(() => {});
  }, [dispatchControlsUi, wagerReady, wagerCount, wagerMaterial]);

  const pickerProps: WagerPickerProps = {
    selection: reactionPicker.selection,
    materialAmounts,
    materialUrls,
    frozenMaterialsStatus,
    hasFrozenSnapshot,
    wagerReady,
    onMaterialSelect: handleMaterialSelect,
    onSubmit: handleWagerSubmit,
  };

  return {
    canSubmitWager,
    wagerRequiresManualReview,
    handleWagerModeToggle,
    pickerProps,
  };
};
