export type MenuControlsApi = {
  closeAllKindsOfPopups(): void;
  closeMenuAndInfoIfAny(): void;
  closeMenuAndInfoIfAllowedForEvent(event: TouchEvent | MouseEvent): void;
  hasMainMenuPopupsVisible(): boolean;
};

let api: MenuControlsApi | null = null;

export const bindMenuControlsApi = (nextApi: MenuControlsApi): void => {
  api = nextApi;
};

export const closeMenuAndInfoIfAny = (): void => {
  api?.closeMenuAndInfoIfAny();
};

export const closeAllKindsOfPopups = (): void => {
  api?.closeAllKindsOfPopups();
};

export const closeMenuAndInfoIfAllowedForEvent = (
  event: TouchEvent | MouseEvent,
): void => {
  api?.closeMenuAndInfoIfAllowedForEvent(event);
};

export const hasMainMenuPopupsVisible = (): boolean =>
  api?.hasMainMenuPopupsVisible() ?? false;
