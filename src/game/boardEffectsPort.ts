export type BoardEffectsRuntime = {
  isFlipped: boolean;
  effectsLayer: HTMLElement | null;
};

let getRuntime: () => BoardEffectsRuntime = () => ({
  isFlipped: false,
  effectsLayer: null,
});

export const bindBoardEffectsRuntime = (
  getter: () => BoardEffectsRuntime,
): void => {
  getRuntime = getter;
};

export const getBoardEffectsRuntime = (): BoardEffectsRuntime => getRuntime();
