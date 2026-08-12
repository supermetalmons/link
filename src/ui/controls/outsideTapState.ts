import { isMobile } from "../../utils/misc";
import {
  didOutsideTapDismissWindowPass,
  rewindOutsideTapDismissedAtForReset,
} from "./controlTiming";
let latestModalOutsideTapDismissDate = Date.now();

export const didDismissSomethingWithOutsideTapJustNow = (): void => {
  latestModalOutsideTapDismissDate = Date.now();
};

export const resetOutsideTapDismissTimeout = (): void => {
  latestModalOutsideTapDismissDate = rewindOutsideTapDismissedAtForReset(
    latestModalOutsideTapDismissDate,
    isMobile,
  );
};

export const didNotDismissAnythingWithOutsideTapJustNow = (): boolean => {
  return didOutsideTapDismissWindowPass(
    latestModalOutsideTapDismissDate,
    Date.now(),
    isMobile,
  );
};

export const resetOutsideTapStateForTests = (dismissedAtMs: number): void => {
  latestModalOutsideTapDismissDate = dismissedAtMs;
};
