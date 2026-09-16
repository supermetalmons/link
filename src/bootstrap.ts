import "./session/pendingLogoutWipeBootstrap";
import { installLogoutSync } from "./session/logoutOrchestrator";
import { getCurrentRouteState } from "./navigation/routeState";
import { startInitialGameBootstrap } from "./services/initialGameBootstrap";
import { startInitialEventBootstrap } from "./services/initialEventBootstrap";

installLogoutSync();
const initialRoute = getCurrentRouteState();
startInitialEventBootstrap(initialRoute);
startInitialGameBootstrap(initialRoute);
void import("./index");
