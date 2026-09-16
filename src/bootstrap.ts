import "./session/pendingLogoutWipeBootstrap";
import { installLogoutSync } from "./session/logoutOrchestrator";
import { getCurrentRouteState } from "./navigation/routeState";
import { startInitialGameBootstrap } from "./services/initialGameBootstrap";
import { startInitialEventBootstrap } from "./services/initialEventBootstrap";
import { startInitialIdentityBootstrap } from "./services/initialIdentityBootstrap";

installLogoutSync();
const initialRoute = getCurrentRouteState();
startInitialEventBootstrap(initialRoute);
startInitialGameBootstrap(initialRoute);
startInitialIdentityBootstrap();
void import("./index");
