import React, { useRef } from "react";
import { problems, getCompletedProblemIds } from "../content/problems";
import { useGameAssets } from "../hooks/useGameAssets";
import type {
  NavigationGameStatus,
  NavigationItem,
} from "../connection/connectionModels";
import {
  HomeBoardButton,
  NavigationPickerContainer,
  ScrollableList,
} from "./navigation/NavigationPicker.styles";
import {
  NavigationEventRow,
  NavigationGameRow,
  NavigationProblemRow,
} from "./navigation/NavigationRows";
import { partitionNavigationItems } from "./navigation/navigationPickerModel";
import { useNavigationPickerScroll } from "./navigation/useNavigationPickerScroll";

interface NavigationPickerProps {
  showsHomeNavigation: boolean;
  navigateHome?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  topGames?: NavigationItem[];
  pagedGames?: NavigationItem[];
  selectedProblemId?: string | null;
  selectedNavigationItemId?: string | null;
  isGamesLoading?: boolean;
  isLoadingMoreGames?: boolean;
  hasMoreGames?: boolean;
  onSelectGame?: (
    item: NavigationItem,
    options?: { status?: NavigationGameStatus },
  ) => void;
  onRemoveGame?: (inviteId: string) => void;
  removingGameInviteIds?: Set<string>;
  onSelectProblem: (problemId: string) => void;
  onLoadMoreGames?: () => void;
}

const SectionSeparator = () => null;

const NavigationPicker: React.FC<NavigationPickerProps> = ({
  showsHomeNavigation,
  navigateHome,
  topGames = [],
  pagedGames = [],
  selectedProblemId = null,
  selectedNavigationItemId = null,
  isGamesLoading = false,
  isLoadingMoreGames = false,
  hasMoreGames = false,
  onSelectGame,
  onRemoveGame,
  removingGameInviteIds,
  onSelectProblem,
  onLoadMoreGames,
}) => {
  const navigationPickerRef = useRef<HTMLDivElement>(null);
  const { assets } = useGameAssets();
  const { scrollableListRef, onScroll } = useNavigationPickerScroll({
    topGamesCount: topGames.length,
    pagedGamesCount: pagedGames.length,
    isGamesLoading,
    isLoadingMoreGames,
    hasMoreGames,
    ...(onLoadMoreGames ? { onLoadMoreGames } : {}),
  });
  const preventScroll = (e: React.TouchEvent) => {
    e.preventDefault();
  };

  const handleHomeClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    navigateHome?.(e);
  };

  const getIconImage = (iconName: string) => {
    if (!assets || !assets[iconName]) {
      return "data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23cccccc' fill-opacity='0.5'/%3E%3C/svg%3E";
    }
    return `data:image/png;base64,${assets[iconName]}`;
  };

  const queueManaImage = getIconImage("mana");
  const completedProblemsSet = getCompletedProblemIds();
  const {
    waitingGames: waitingForOpponentGames,
    topItems: nonWaitingTopGames,
    pagedItems: nonWaitingPagedGames,
  } = partitionNavigationItems(topGames, pagedGames);

  const shouldRenderWaitingGamesSection = waitingForOpponentGames.length > 0;
  const shouldRenderTopGamesSection = nonWaitingTopGames.length > 0;
  const shouldRenderPagedGamesSection = nonWaitingPagedGames.length > 0;
  const shouldRenderLearnSection = true;
  const hasScrollableContent =
    shouldRenderLearnSection ||
    shouldRenderWaitingGamesSection ||
    shouldRenderTopGamesSection ||
    shouldRenderPagedGamesSection;

  const renderGameRows = (items: NavigationItem[]) => (
    <>
      {items.map((item) =>
        item.entityType === "event" ? (
          <NavigationEventRow
            key={item.id}
            event={item}
            isActive={selectedNavigationItemId === item.id}
            {...(onSelectGame ? { onSelectGame } : {})}
          />
        ) : (
          <NavigationGameRow
            key={item.id}
            game={item}
            isSelected={selectedNavigationItemId === item.id}
            isRemoving={!!removingGameInviteIds?.has(item.inviteId)}
            queueManaImage={queueManaImage}
            {...(onSelectGame ? { onSelectGame } : {})}
            {...(onRemoveGame ? { onRemoveGame } : {})}
          />
        ),
      )}
    </>
  );

  const renderLearnSection = () => (
    <>
      {problems.map((problem) => (
        <NavigationProblemRow
          key={problem.id}
          problem={problem}
          isSelected={selectedProblemId === problem.id}
          isPrimarySelection={
            !selectedNavigationItemId && selectedProblemId === problem.id
          }
          isCompleted={completedProblemsSet.has(problem.id)}
          iconImage={getIconImage(problem.icon)}
          onSelectProblem={onSelectProblem}
        />
      ))}
    </>
  );

  return (
    <NavigationPickerContainer
      ref={navigationPickerRef}
      onTouchMove={preventScroll}
    >
      {hasScrollableContent && (
        <ScrollableList ref={scrollableListRef} onScroll={onScroll}>
          {shouldRenderWaitingGamesSection &&
            renderGameRows(waitingForOpponentGames)}
          {shouldRenderTopGamesSection && renderGameRows(nonWaitingTopGames)}
          {shouldRenderLearnSection && shouldRenderTopGamesSection && (
            <SectionSeparator />
          )}
          {shouldRenderLearnSection && renderLearnSection()}
          {shouldRenderLearnSection && shouldRenderPagedGamesSection && (
            <SectionSeparator />
          )}
          {shouldRenderPagedGamesSection &&
            renderGameRows(nonWaitingPagedGames)}
        </ScrollableList>
      )}
      {showsHomeNavigation && (
        <HomeBoardButton
          onClick={handleHomeClick}
          $withTopBorder={hasScrollableContent}
        >
          Home Board →
        </HomeBoardButton>
      )}
    </NavigationPickerContainer>
  );
};

export default NavigationPicker;
