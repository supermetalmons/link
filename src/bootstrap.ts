import {
  applicationDataGate,
  readApplicationRelease,
  requestApplicationReloadOnce,
  showApplicationUnavailable,
  startApplicationData,
  type ApplicationBlockReason,
} from "./session/applicationDataLifecycle.ts";
import { resetRetiredApplicationStorage } from "./session/applicationDataStorage.ts";

const reload = () => window.location.reload();
const showBlocked = (reason: ApplicationBlockReason) => {
  showApplicationUnavailable(reason, reload);
  if (reason === "update-required") {
    try {
      requestApplicationReloadOnce(window.sessionStorage, reload);
    } catch {}
  }
};
applicationDataGate.subscribe(showBlocked);

void startApplicationData({
  readRelease: () => readApplicationRelease(),
  enforcePendingLogout: async () => {
    await import("./session/pendingLogoutWipeBootstrap");
  },
  resetStorage: () => {
    resetRetiredApplicationStorage([
      window.localStorage,
      window.sessionStorage,
    ]);
  },
  start: async () => {
    const { installLogoutSync } = await import("./session/logoutOrchestrator");
    installLogoutSync();
    const { getCurrentRouteState } = await import("./navigation/routeState");
    const initialRoute = getCurrentRouteState();
    const [
      { startInitialEventBootstrap },
      { startInitialGameBootstrap },
      { startInitialIdentityBootstrap },
    ] = await Promise.all([
      import("./services/initialEventBootstrap"),
      import("./services/initialGameBootstrap"),
      import("./services/initialIdentityBootstrap"),
    ]);
    startInitialEventBootstrap(initialRoute);
    startInitialGameBootstrap(initialRoute);
    startInitialIdentityBootstrap();
    await import("./index");
  },
  onBlocked: showBlocked,
});
