import type { AuthIdentity } from "../utils/storage";

export type AuthStatus = "loading" | "unauthenticated" | "authenticated";

export type AuthState = AuthIdentity & {
  authStatus: AuthStatus;
};
