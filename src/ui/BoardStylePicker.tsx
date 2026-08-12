import React, { useState, useEffect } from "react";
import styled from "styled-components";
import {
  AssetsSet,
  BoardStyleSet,
  ColorSetKey,
  setBoardColorSet,
  getCurrentColorSetKey,
  colorSets,
  getCurrentAssetsSet,
  getCurrentBoardStyleSet,
  subscribeToAssetsSetChanges,
  subscribeToBoardColorSetChanges,
  subscribeToBoardStyleSetChanges,
} from "../content/boardStyles";
import { generateBoardPattern } from "../utils/boardPatternGenerator";
import { isMobile } from "../utils/misc";
import { setBoardStyleSet, setItemsStyleSet } from "../game/board";
import { loadGameAssets } from "../assets/gameAssetsLoader";

const PICTURE_BOARD_STYLE_SETS = [BoardStyleSet.Pangchiu] as const;
type PictureBoardStyleSet = (typeof PICTURE_BOARD_STYLE_SETS)[number];

const BOARD_PREVIEW_URLS: Record<PictureBoardStyleSet, string> = {
  [BoardStyleSet.Pangchiu]:
    "https://cdn.lil.org/mons/boards/backgrounds/thumbs/pangchiu.jpg",
};

type BoardPreviewCache = {
  promise: Promise<string | null> | null;
  url: string | null;
  failed: boolean;
  decoded: boolean;
};

const createBoardPreviewCache = (): BoardPreviewCache => ({
  promise: null,
  url: null,
  failed: false,
  decoded: false,
});

const boardPreviewCaches: Record<PictureBoardStyleSet, BoardPreviewCache> = {
  [BoardStyleSet.Pangchiu]: createBoardPreviewCache(),
};

type BoardPreviewDisplayState = Record<
  PictureBoardStyleSet,
  {
    src: string | null;
    loaded: boolean;
    failed: boolean;
  }
>;

const createBoardPreviewDisplayState = (): BoardPreviewDisplayState =>
  PICTURE_BOARD_STYLE_SETS.reduce((state, styleSet) => {
    const cache = boardPreviewCaches[styleSet];
    state[styleSet] = {
      src: cache.url,
      loaded: cache.decoded,
      failed: cache.failed,
    };
    return state;
  }, {} as BoardPreviewDisplayState);

type ItemStylePreviewUrls = Record<AssetsSet, string | null>;

const EMPTY_ITEM_STYLE_PREVIEWS: ItemStylePreviewUrls = {
  [AssetsSet.Pixel]: null,
  [AssetsSet.Original]: null,
  [AssetsSet.Pangchiu]: null,
};

const getItemStylePreviewUrl = async (
  assetsSet: AssetsSet,
): Promise<string | null> => {
  try {
    const module = await loadGameAssets(assetsSet);
    return `url(data:image/webp;base64,${module.gameAssets.supermana})`;
  } catch {
    return null;
  }
};

const getBoardPreviewUrl = (styleSet: PictureBoardStyleSet) => {
  const cache = boardPreviewCaches[styleSet];
  if (cache.url) {
    return Promise.resolve(cache.url);
  }
  if (cache.failed) {
    return Promise.resolve(null);
  }
  if (!cache.promise) {
    cache.promise = fetch(BOARD_PREVIEW_URLS[styleSet])
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch image");
        return res.blob();
      })
      .then((blob) => {
        cache.url = URL.createObjectURL(blob);
        return cache.url;
      })
      .catch(() => {
        cache.failed = true;
        return null;
      });
  }
  return cache.promise.then((url) => {
    if (!url) {
      cache.failed = true;
    }
    return url;
  });
};

const decodeBoardPreview = (styleSet: PictureBoardStyleSet, url: string) => {
  const cache = boardPreviewCaches[styleSet];
  if (cache.decoded || typeof Image === "undefined") {
    cache.decoded = true;
    return Promise.resolve();
  }
  const img = new Image();
  img.src = url;
  const decodePromise =
    typeof img.decode === "function"
      ? img.decode()
      : new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject();
        });
  return decodePromise.then(() => {
    cache.decoded = true;
  });
};

const preloadBoardPreview = (styleSet: PictureBoardStyleSet) => {
  const cache = boardPreviewCaches[styleSet];
  if (cache.url || cache.failed || typeof window === "undefined") {
    return;
  }
  getBoardPreviewUrl(styleSet)
    .then((url) => {
      if (!url) return;
      return decodeBoardPreview(styleSet, url);
    })
    .catch(() => {});
};

export const preloadPangchiuBoardPreview = () => {
  PICTURE_BOARD_STYLE_SETS.forEach(preloadBoardPreview);
};

const BoardStylePicker = styled.div`
  position: fixed;
  bottom: max(50px, calc(env(safe-area-inset-bottom) + 44px));
  left: 8px;
  background-color: var(--panel-light-90);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  overflow: hidden;
  z-index: 7;

  @media screen and (max-height: 453px) {
    bottom: max(44px, calc(env(safe-area-inset-bottom) + 38px));
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--panel-dark-90);
  }
`;

const SectionRow = styled.div`
  display: flex;
  gap: 12px;
  position: relative;
  z-index: 1;
`;

const OptionButton = styled.button<{ $isSelected?: boolean }>`
  width: 44px;
  height: 44px;
  min-width: 44px;
  min-height: 44px;
  border-radius: 10px;
  border: 4px solid transparent;
  outline: none;
  cursor: pointer;
  position: relative;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
  overflow: hidden;
  background: transparent;
  transition: all 0.15s ease;
  touch-action: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;

  ${(props) =>
    props.$isSelected &&
    `
    border-color: var(--color-blue-primary);
    box-shadow: 0 0 0 3px var(--selectedBorderShadowColor);
  `}

  @media (prefers-color-scheme: dark) {
    ${(props) =>
      props.$isSelected &&
      `
      border-color: var(--color-blue-primary-dark);
      box-shadow: 0 0 0 3px var(--selectedBorderShadowColorDark);
    `}
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      ${(props) =>
        !props.$isSelected &&
        `
        border-color: var(--focusBorderColor);
        box-shadow: 0 0 0 2px var(--focusShadowColor);

        @media (prefers-color-scheme: dark) {
          border-color: var(--focusBorderColorDark);
          box-shadow: 0 0 0 2px var(--focusShadowColorDark);
        }
      `}
    }
  }

  &:active {
    transform: scale(0.94);
    transition: transform 0.08s ease;
  }

  @media (hover: none) and (pointer: coarse) {
    &:active {
      ${(props) =>
        !props.$isSelected &&
        `
        border-color: var(--focusBorderColor);
        box-shadow: 0 0 0 2px var(--focusShadowColor);
        @media (prefers-color-scheme: dark) {
          border-color: var(--focusBorderColorDark);
          box-shadow: 0 0 0 2px var(--focusShadowColorDark);
        }
      `}
    }
  }
`;

const ColorSquare = styled(OptionButton)`
  svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 102%;
    height: 102%;
    transform: translate(-1%, -1%);
    border-radius: 6px;
    pointer-events: none;
  }
`;

const ItemStyleButton = styled.button<{ $isSelected?: boolean }>`
  width: 44px;
  height: 44px;
  min-width: 44px;
  min-height: 44px;
  border: none;
  outline: none;
  cursor: pointer;
  position: relative;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
  background: transparent;
  touch-action: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  opacity: ${(props) => (props.$isSelected ? 1 : 0.45)};
  filter: ${(props) =>
    props.$isSelected
      ? "drop-shadow(0 0 4px rgba(59, 130, 246, 0.95))"
      : "none"};
  transition:
    transform 0.1s ease,
    filter 0.2s ease,
    opacity 0.2s ease;

  @media (prefers-color-scheme: dark) {
    filter: ${(props) =>
      props.$isSelected
        ? "drop-shadow(0 0 4px rgba(100, 165, 255, 0.95))"
        : "none"};
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      opacity: 1;
    }
  }

  &:active {
    transform: scale(0.94);
  }
`;

const ItemStylePreview = styled.div<{
  itemSet: AssetsSet;
  previewUrl: string | null;
}>`
  width: 100%;
  height: 100%;
  background-image: ${(props) => props.previewUrl ?? "none"};
  background-size: 94%;
  background-position: center;
  background-repeat: no-repeat;
  ${(props) =>
    props.itemSet === AssetsSet.Pixel &&
    `
    image-rendering: pixelated;
  `}
`;

const PlaceholderImage = styled.img`
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(1.01);
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  touch-action: none;
  pointer-events: none;
`;

const ImagePlaceholderBg = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: var(--color-gray-d0);
  border-radius: 6px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  pointer-events: none;
  touch-action: none;

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-a0);
  }
`;

const BoardStylePickerComponent: React.FC = () => {
  const [currentColorSetKey, setCurrentColorSetKey] = useState<ColorSetKey>(
    getCurrentColorSetKey(),
  );
  const [selectedBoardStyleSet, setSelectedBoardStyleSet] =
    useState<BoardStyleSet>(getCurrentBoardStyleSet());
  const [selectedItemsStyleSet, setSelectedItemsStyleSet] = useState<AssetsSet>(
    getCurrentAssetsSet(),
  );
  const [itemStylePreviewUrls, setItemStylePreviewUrls] =
    useState<ItemStylePreviewUrls>(EMPTY_ITEM_STYLE_PREVIEWS);

  const [boardPreviewDisplayState, setBoardPreviewDisplayState] = useState(
    createBoardPreviewDisplayState,
  );

  useEffect(() => {
    let cancelled = false;
    PICTURE_BOARD_STYLE_SETS.forEach((styleSet) => {
      getBoardPreviewUrl(styleSet).then((url) => {
        if (cancelled) return;
        if (!url) {
          setBoardPreviewDisplayState((prevState) => ({
            ...prevState,
            [styleSet]: {
              ...prevState[styleSet],
              failed: true,
            },
          }));
          return;
        }
        const cache = boardPreviewCaches[styleSet];
        setBoardPreviewDisplayState((prevState) => ({
          ...prevState,
          [styleSet]: {
            ...prevState[styleSet],
            src: url,
            loaded: cache.decoded,
            failed: false,
          },
        }));
        decodeBoardPreview(styleSet, url)
          .then(() => {
            if (cancelled) return;
            setBoardPreviewDisplayState((prevState) => ({
              ...prevState,
              [styleSet]: {
                ...prevState[styleSet],
                loaded: true,
              },
            }));
          })
          .catch(() => {
            if (cancelled) return;
            setBoardPreviewDisplayState((prevState) => ({
              ...prevState,
              [styleSet]: {
                ...prevState[styleSet],
                failed: true,
              },
            }));
          });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      Object.values(AssetsSet).map(
        async (assetsSet) =>
          [assetsSet, await getItemStylePreviewUrl(assetsSet)] as const,
      ),
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      const nextPreviewUrls: ItemStylePreviewUrls = {
        ...EMPTY_ITEM_STYLE_PREVIEWS,
      };
      entries.forEach(([assetsSet, previewUrl]) => {
        nextPreviewUrls[assetsSet] = previewUrl;
      });
      setItemStylePreviewUrls(nextPreviewUrls);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribeBoardColorSet = subscribeToBoardColorSetChanges(() => {
      setCurrentColorSetKey(getCurrentColorSetKey());
    });
    const unsubscribeBoardStyleSet = subscribeToBoardStyleSetChanges(() => {
      setSelectedBoardStyleSet(getCurrentBoardStyleSet());
    });
    const unsubscribeAssetsSet = subscribeToAssetsSetChanges(() => {
      setSelectedItemsStyleSet(getCurrentAssetsSet());
    });
    return () => {
      unsubscribeBoardColorSet();
      unsubscribeBoardStyleSet();
      unsubscribeAssetsSet();
    };
  }, []);

  const handleColorSetChange =
    (colorSetKey: ColorSetKey) =>
    (
      event:
        | React.MouseEvent<HTMLButtonElement>
        | React.TouchEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      setBoardColorSet(colorSetKey);
      setBoardStyleSet(BoardStyleSet.Grid);
    };

  const handlePictureBoardSelected =
    (styleSet: PictureBoardStyleSet) =>
    (
      event:
        | React.MouseEvent<HTMLButtonElement>
        | React.TouchEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      setBoardStyleSet(styleSet);
    };

  const handleItemsStyleSetChange =
    (assetsSet: AssetsSet) =>
    (
      event:
        | React.MouseEvent<HTMLButtonElement>
        | React.TouchEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      setItemsStyleSet(assetsSet);
    };

  const renderColorSquares = (colorSet: "light" | "dark") => {
    const colors =
      colorSet === "light" ? colorSets.default : colorSets.darkAndYellow;
    const previewBoardSize = 1100;
    const previewCellSize = 100;
    return (
      <svg
        viewBox={`0 0 ${previewBoardSize} ${previewBoardSize}`}
        width="38"
        height="38"
        shapeRendering="crispEdges"
      >
        {generateBoardPattern({
          colorSet: colors,
          size: previewBoardSize,
          cellSize: previewCellSize,
          offsetY: 0,
          keyPrefix: `preview-${colorSet}`,
        })}
      </svg>
    );
  };

  const isGridBoardSelected = selectedBoardStyleSet === BoardStyleSet.Grid;

  return (
    <BoardStylePicker>
      <SectionRow>
        <ColorSquare
          $isSelected={isGridBoardSelected && currentColorSetKey === "default"}
          onClick={!isMobile ? handleColorSetChange("default") : undefined}
          onTouchStart={isMobile ? handleColorSetChange("default") : undefined}
          aria-label="Light board theme"
        >
          {renderColorSquares("light")}
        </ColorSquare>
        <ColorSquare
          $isSelected={
            isGridBoardSelected && currentColorSetKey === "darkAndYellow"
          }
          onClick={
            !isMobile ? handleColorSetChange("darkAndYellow") : undefined
          }
          onTouchStart={
            isMobile ? handleColorSetChange("darkAndYellow") : undefined
          }
          aria-label="Dark board theme"
        >
          {renderColorSquares("dark")}
        </ColorSquare>
        {PICTURE_BOARD_STYLE_SETS.map((styleSet) => {
          const previewState = boardPreviewDisplayState[styleSet];
          const selectPictureBoard = handlePictureBoardSelected(styleSet);
          return (
            <ColorSquare
              key={styleSet}
              $isSelected={selectedBoardStyleSet === styleSet}
              onClick={!isMobile ? selectPictureBoard : undefined}
              onTouchStart={isMobile ? selectPictureBoard : undefined}
              aria-label={`${styleSet} board theme`}
            >
              {!previewState.loaded && <ImagePlaceholderBg />}
              {!previewState.failed && previewState.src && (
                <PlaceholderImage src={previewState.src} alt="" />
              )}
            </ColorSquare>
          );
        })}
      </SectionRow>
      <SectionRow>
        <ItemStyleButton
          $isSelected={selectedItemsStyleSet === AssetsSet.Pixel}
          onClick={
            !isMobile ? handleItemsStyleSetChange(AssetsSet.Pixel) : undefined
          }
          onTouchStart={
            isMobile ? handleItemsStyleSetChange(AssetsSet.Pixel) : undefined
          }
          aria-label="Pixel item style"
        >
          <ItemStylePreview
            itemSet={AssetsSet.Pixel}
            previewUrl={itemStylePreviewUrls[AssetsSet.Pixel]}
          />
        </ItemStyleButton>
        <ItemStyleButton
          $isSelected={selectedItemsStyleSet === AssetsSet.Original}
          onClick={
            !isMobile
              ? handleItemsStyleSetChange(AssetsSet.Original)
              : undefined
          }
          onTouchStart={
            isMobile ? handleItemsStyleSetChange(AssetsSet.Original) : undefined
          }
          aria-label="Original item style"
        >
          <ItemStylePreview
            itemSet={AssetsSet.Original}
            previewUrl={itemStylePreviewUrls[AssetsSet.Original]}
          />
        </ItemStyleButton>
        <ItemStyleButton
          $isSelected={selectedItemsStyleSet === AssetsSet.Pangchiu}
          onClick={
            !isMobile
              ? handleItemsStyleSetChange(AssetsSet.Pangchiu)
              : undefined
          }
          onTouchStart={
            isMobile ? handleItemsStyleSetChange(AssetsSet.Pangchiu) : undefined
          }
          aria-label="Pangchiu item style"
        >
          <ItemStylePreview
            itemSet={AssetsSet.Pangchiu}
            previewUrl={itemStylePreviewUrls[AssetsSet.Pangchiu]}
          />
        </ItemStyleButton>
      </SectionRow>
    </BoardStylePicker>
  );
};

export default BoardStylePickerComponent;
