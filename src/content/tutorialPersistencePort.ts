export type TutorialPersistence = {
  updateCompletedProblems(ids: string[]): void;
  updateTutorialCompleted(completed: boolean): void;
};

let persistence: TutorialPersistence | null = null;

const getPersistence = (): TutorialPersistence => {
  if (!persistence) {
    throw new Error("tutorial-persistence-not-bound");
  }
  return persistence;
};

export const bindTutorialPersistence = (
  nextPersistence: TutorialPersistence,
): TutorialPersistence => {
  persistence = nextPersistence;
  return nextPersistence;
};

export const updatePersistedCompletedProblems = (ids: string[]): void => {
  getPersistence().updateCompletedProblems(ids);
};

export const updatePersistedTutorialCompleted = (completed: boolean): void => {
  getPersistence().updateTutorialCompleted(completed);
};
