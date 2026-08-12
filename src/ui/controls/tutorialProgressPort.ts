let didSyncHandler: () => void = () => {};

export const bindTutorialProgressSyncHandler = (handler: () => void): void => {
  didSyncHandler = handler;
};

export const notifyTutorialProgressSynced = (): void => {
  didSyncHandler();
};
