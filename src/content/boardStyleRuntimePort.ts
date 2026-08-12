let boardColorChangeHandler: () => void = () => {};

export const bindBoardColorChangeHandler = (handler: () => void): void => {
  boardColorChangeHandler = handler;
};

export const notifyBoardColorChange = (): void => {
  boardColorChangeHandler();
};
