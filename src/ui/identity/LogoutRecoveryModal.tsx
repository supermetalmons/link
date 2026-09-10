import { useEffect, useRef, useState } from "react";
import { connection } from "../../connection/connection";
import {
  performLogoutCleanupAndReload,
  reloadAfterLogout,
} from "../../session/logoutOrchestrator";
import {
  ButtonsContainer,
  DangerButton,
  handleModalKeyDown,
  ModalOverlay,
  ModalPopup,
  ModalTitle,
} from "../SharedModalComponents";
import { reconcileLogoutUiLockWithAuthStatus } from "./logoutUiLock";

export function LogoutRecoveryModal() {
  const popup = useRef<HTMLDivElement>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    reconcileLogoutUiLockWithAuthStatus("unauthenticated");
    popup.current?.focus();
  }, []);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      let applied = true;
      try {
        applied = await connection.signOut();
      } catch {}
      if (!applied) {
        reloadAfterLogout();
        return;
      }
      await performLogoutCleanupAndReload().catch(() => undefined);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <ModalOverlay>
      <ModalPopup
        ref={popup}
        tabIndex={0}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-recovery-title"
        aria-describedby="logout-recovery-message"
        onKeyDown={(event) =>
          handleModalKeyDown(event, popup.current, () => {})
        }
      >
        <ModalTitle id="logout-recovery-title">Log out failed</ModalTitle>
        <p id="logout-recovery-message">
          Your session could not be cleared. Try again.
        </p>
        <ButtonsContainer>
          <DangerButton disabled={retrying} onClick={() => void retry()}>
            {retrying ? "Logging out..." : "Retry Log Out"}
          </DangerButton>
        </ButtonsContainer>
      </ModalPopup>
    </ModalOverlay>
  );
}
