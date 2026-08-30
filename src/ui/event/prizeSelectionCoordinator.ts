import type {
  EventPrizeId,
  EventPrizeSelections,
} from "../../connection/connectionModels";

export type EventPrizeSelectionCoordinator = {
  dispose: () => void;
  receiveAuthoritative: (selections: EventPrizeSelections) => void;
  toggle: (prizeId: EventPrizeId) => void;
};

type EventPrizeSelectionCoordinatorOptions = {
  mutate: (prizeId: EventPrizeId) => Promise<EventPrizeId | null>;
  onError?: (error: unknown) => void;
  onPendingChange: (isPending: boolean) => void;
  onSelectionsChange: (selections: EventPrizeSelections) => void;
  profileId: string;
};

const getOwnSelection = (
  selections: EventPrizeSelections,
  profileId: string,
): EventPrizeId | null => selections[profileId] ?? null;

const withOwnSelection = (
  selections: EventPrizeSelections,
  profileId: string,
  prizeId: EventPrizeId | null,
): EventPrizeSelections => {
  const nextSelections = { ...selections };
  if (prizeId) {
    nextSelections[profileId] = prizeId;
  } else {
    delete nextSelections[profileId];
  }
  return nextSelections;
};

const selectionsEqual = (
  left: EventPrizeSelections,
  right: EventPrizeSelections,
): boolean => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([profileId, prizeId]) => right[profileId] === prizeId)
  );
};

export const createEventPrizeSelectionCoordinator = ({
  mutate,
  onError,
  onPendingChange,
  onSelectionsChange,
  profileId,
}: EventPrizeSelectionCoordinatorOptions): EventPrizeSelectionCoordinator => {
  let authoritativeSelections: EventPrizeSelections = {};
  let desiredPrizeId: EventPrizeId | null | undefined;
  let displayedSelections: EventPrizeSelections | null = null;
  let isDisposed = false;
  let isMutationInFlight = false;
  let isPending = false;
  let observedSelectionsDuringMutation: Set<EventPrizeId | null> | null = null;

  const emitPending = () => {
    const nextIsPending = isMutationInFlight || desiredPrizeId !== undefined;
    if (nextIsPending === isPending) {
      return;
    }
    isPending = nextIsPending;
    onPendingChange(nextIsPending);
  };

  const emitSelections = () => {
    const nextSelections =
      desiredPrizeId === undefined
        ? authoritativeSelections
        : withOwnSelection(authoritativeSelections, profileId, desiredPrizeId);
    if (
      displayedSelections &&
      selectionsEqual(displayedSelections, nextSelections)
    ) {
      return;
    }
    displayedSelections = nextSelections;
    onSelectionsChange(nextSelections);
  };

  const finishFailure = (error: unknown) => {
    if (isDisposed) {
      return;
    }
    isMutationInFlight = false;
    observedSelectionsDuringMutation = null;
    desiredPrizeId = undefined;
    emitSelections();
    emitPending();
    onError?.(error);
  };

  const startNextMutation = () => {
    if (isDisposed || isMutationInFlight || desiredPrizeId === undefined) {
      return;
    }

    const authoritativePrizeId = getOwnSelection(
      authoritativeSelections,
      profileId,
    );
    if (authoritativePrizeId === desiredPrizeId) {
      desiredPrizeId = undefined;
      emitSelections();
      emitPending();
      return;
    }

    const requestedPrizeId = desiredPrizeId ?? authoritativePrizeId;
    if (!requestedPrizeId) {
      desiredPrizeId = undefined;
      emitSelections();
      emitPending();
      return;
    }

    isMutationInFlight = true;
    observedSelectionsDuringMutation = new Set();
    emitPending();
    let mutation: Promise<EventPrizeId | null>;
    try {
      mutation = mutate(requestedPrizeId);
    } catch (error) {
      finishFailure(error);
      return;
    }

    void mutation.then((selectedPrizeId) => {
      if (isDisposed) {
        return;
      }
      if (!observedSelectionsDuringMutation?.has(selectedPrizeId)) {
        authoritativeSelections = withOwnSelection(
          authoritativeSelections,
          profileId,
          selectedPrizeId,
        );
      }
      observedSelectionsDuringMutation = null;
      isMutationInFlight = false;
      if (desiredPrizeId === selectedPrizeId) {
        desiredPrizeId = undefined;
      }
      emitSelections();
      emitPending();
      startNextMutation();
    }, finishFailure);
  };

  return {
    dispose: () => {
      isDisposed = true;
    },
    receiveAuthoritative: (selections) => {
      if (isDisposed) {
        return;
      }
      const nextSelections = { ...selections };
      if (isMutationInFlight) {
        observedSelectionsDuringMutation?.add(
          getOwnSelection(nextSelections, profileId),
        );
      }
      authoritativeSelections = nextSelections;
      emitSelections();
      startNextMutation();
    },
    toggle: (prizeId) => {
      if (isDisposed) {
        return;
      }
      const displayedPrizeId =
        desiredPrizeId === undefined
          ? getOwnSelection(authoritativeSelections, profileId)
          : desiredPrizeId;
      desiredPrizeId = displayedPrizeId === prizeId ? null : prizeId;
      emitSelections();
      emitPending();
      startNextMutation();
    },
  };
};
