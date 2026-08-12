export type MainMenuRuntime = {
  setAnimatedMonsEnabled(enabled: boolean, doNotStore?: boolean): void;
};

let runtime: MainMenuRuntime | null = null;

export const bindMainMenuRuntime = (nextRuntime: MainMenuRuntime): void => {
  runtime = nextRuntime;
};

export const setAnimatedMonsEnabled = (
  enabled: boolean,
  doNotStore?: boolean,
): void => {
  runtime?.setAnimatedMonsEnabled(enabled, doNotStore);
};
