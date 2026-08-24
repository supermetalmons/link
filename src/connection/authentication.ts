import { useState, useEffect, useRef, useCallback } from "react";
import type { AuthVerificationResponse } from "@mons/shared/auth";
import { normalizeProfileEmojiId } from "@mons/shared/profiles";
import type { PlayerProfile } from "./connectionModels";
import { connection } from "./connection";
import { handleLoginSuccess } from "./loginSuccess";
import {
  clearConsumedAppleRedirectResult,
  consumeAppleRedirectResult,
} from "./appleConnection";
import {
  clearConsumedXRedirectResult,
  consumeXRedirectResult,
} from "./xConnection";
import { formatAuthCooldownErrorMessage } from "./authCooldownErrors";
import { formatXAuthErrorMessage } from "./xAuthErrors";
import { publishXAuthUiFeedback } from "./xAuthUiFeedback";
import { storage, type AuthIdentity } from "../utils/storage";
import { setupLoggedInPlayerProfile } from "../game/board";
import { didAttemptAuthentication, isWatchOnly } from "../game/gameController";
import {
  setSignInInlineAuthError,
  updateProfileDisplayName,
} from "../ui/identity/profileUiPort";
import {
  flushPendingOwnProfileMiningState,
  syncOwnProfileMiningState,
} from "../services/ownProfileMiningHydration";
import type { AuthState, AuthStatus } from "./authModels";

export type { AuthState, AuthStatus } from "./authModels";

let globalSetAuthStatus: ((status: AuthStatus) => void) | null = null;

const EMPTY_AUTH_IDENTITY: AuthIdentity = {
  profileId: "",
  ethAddress: "",
  solAddress: "",
};

type AppleRedirectResult = NonNullable<
  ReturnType<typeof consumeAppleRedirectResult>
>;
type XRedirectResult = NonNullable<ReturnType<typeof consumeXRedirectResult>>;

let inFlightAppleRedirectVerification: {
  key: string;
  promise: Promise<AuthVerificationResponse>;
} | null = null;
let inFlightXRedirectCompletion: {
  key: string;
  promise: Promise<AuthVerificationResponse>;
} | null = null;

const getAppleRedirectVerificationKey = (
  redirectResult: AppleRedirectResult,
): string => {
  return `${redirectResult.intentId}::${redirectResult.idToken}::${redirectResult.consentSource}`;
};

const verifyAppleRedirectResultOnce = (
  redirectResult: AppleRedirectResult,
): Promise<AuthVerificationResponse> => {
  const key = getAppleRedirectVerificationKey(redirectResult);
  if (
    inFlightAppleRedirectVerification &&
    inFlightAppleRedirectVerification.key === key
  ) {
    return inFlightAppleRedirectVerification.promise;
  }
  const promise = connection
    .verifyAppleToken(
      redirectResult.intentId,
      redirectResult.idToken,
      redirectResult.consentSource,
    )
    .finally(() => {
      if (inFlightAppleRedirectVerification?.key === key) {
        inFlightAppleRedirectVerification = null;
      }
    });
  inFlightAppleRedirectVerification = { key, promise };
  return promise;
};

const getXRedirectCompletionKey = (redirectResult: XRedirectResult): string => {
  return `${redirectResult.flowId}::${redirectResult.status}::${redirectResult.errorCode}::${redirectResult.consentSource}`;
};

const completeXRedirectResultOnce = (
  redirectResult: XRedirectResult,
): Promise<AuthVerificationResponse> => {
  const key = getXRedirectCompletionKey(redirectResult);
  if (inFlightXRedirectCompletion && inFlightXRedirectCompletion.key === key) {
    return inFlightXRedirectCompletion.promise;
  }
  const promise = connection
    .completeXRedirectAuth({ flowId: redirectResult.flowId })
    .finally(() => {
      if (inFlightXRedirectCompletion?.key === key) {
        inFlightXRedirectCompletion = null;
      }
    });
  inFlightXRedirectCompletion = { key, promise };
  return promise;
};

const getXAuthAction = (
  consentSource: "signin" | "settings",
): "signin" | "link" => {
  return consentSource === "settings" ? "link" : "signin";
};

const publishXAuthErrorFeedback = (
  consentSource: "signin" | "settings",
  message: string,
): void => {
  publishXAuthUiFeedback({
    target: consentSource,
    kind: "error",
    message,
  });
};

export function setAuthStatusGlobally(status: AuthStatus) {
  if (globalSetAuthStatus) {
    globalSetAuthStatus(status);
  }
}

export function useAuthStatus() {
  const [authState, setAuthState] = useState<AuthState>(() => {
    const identity = storage.getAuthIdentity();
    const storedLoginId = storage.getLoginId("");
    const storedUsername = storage.getUsername("");
    if (identity.profileId !== "" && storedLoginId !== "") {
      updateProfileDisplayName(
        storedUsername,
        identity.ethAddress,
        identity.solAddress,
      );
      return { authStatus: "authenticated", ...identity };
    }
    return { authStatus: "unauthenticated", ...EMPTY_AUTH_IDENTITY };
  });
  const setAuthStatus = useCallback((nextAuthStatus: AuthStatus) => {
    const nextIdentity =
      nextAuthStatus === "authenticated"
        ? storage.getAuthIdentity()
        : EMPTY_AUTH_IDENTITY;
    setAuthState((current) => {
      if (
        current.authStatus === nextAuthStatus &&
        current.profileId === nextIdentity.profileId &&
        current.ethAddress === nextIdentity.ethAddress &&
        current.solAddress === nextIdentity.solAddress
      ) {
        return current;
      }
      return { authStatus: nextAuthStatus, ...nextIdentity };
    });
  }, []);
  const authAttemptTimeoutIdsRef = useRef<Set<number>>(new Set());
  const authChangeVersionRef = useRef(0);

  useEffect(() => {
    globalSetAuthStatus = setAuthStatus;
    return () => {
      globalSetAuthStatus = null;
    };
  }, [setAuthStatus]);

  useEffect(() => {
    let isCancelled = false;
    const completeAppleRedirectSignInIfNeeded = async () => {
      let redirectResult: ReturnType<typeof consumeAppleRedirectResult>;
      try {
        redirectResult = consumeAppleRedirectResult();
      } catch (error) {
        console.error("Apple redirect sign in error:", error);
        return;
      }
      if (!redirectResult) {
        return;
      }
      const shouldForceUnauthenticatedOnFailure =
        redirectResult.consentSource === "signin";
      try {
        const res = await verifyAppleRedirectResultOnce(redirectResult);
        if (isCancelled) {
          return;
        }
        clearConsumedAppleRedirectResult();
        if (res && res.ok === true) {
          setSignInInlineAuthError(null);
          if (handleLoginSuccess(res, "apple")) {
            setAuthStatus("authenticated");
          }
        } else if (shouldForceUnauthenticatedOnFailure) {
          setAuthStatus("unauthenticated");
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("Apple redirect verify error:", error);
          const cooldownMessage = formatAuthCooldownErrorMessage(error);
          if (cooldownMessage) {
            setSignInInlineAuthError(cooldownMessage);
          }
          clearConsumedAppleRedirectResult();
          if (shouldForceUnauthenticatedOnFailure) {
            setAuthStatus("unauthenticated");
          }
        }
      }
    };
    void completeAppleRedirectSignInIfNeeded();
    return () => {
      isCancelled = true;
    };
  }, [setAuthStatus]);

  useEffect(() => {
    let isCancelled = false;
    const completeXRedirectSignInIfNeeded = async () => {
      let redirectResult: ReturnType<typeof consumeXRedirectResult>;
      try {
        redirectResult = consumeXRedirectResult();
      } catch (error) {
        console.error("X redirect sign in parse error:", error);
        return;
      }
      if (!redirectResult) {
        return;
      }
      const shouldForceUnauthenticatedOnFailure =
        redirectResult.consentSource === "signin";
      if (redirectResult.status === "failed") {
        console.error(
          "X redirect sign in callback failed:",
          redirectResult.errorCode || "unknown",
        );
        publishXAuthErrorFeedback(
          redirectResult.consentSource,
          formatXAuthErrorMessage(
            redirectResult.errorCode,
            getXAuthAction(redirectResult.consentSource),
          ),
        );
        clearConsumedXRedirectResult();
        if (shouldForceUnauthenticatedOnFailure) {
          setAuthStatus("unauthenticated");
        }
        return;
      }
      try {
        const res = await completeXRedirectResultOnce(redirectResult);
        if (isCancelled) {
          return;
        }
        clearConsumedXRedirectResult();
        if (res && res.ok === true) {
          setSignInInlineAuthError(null);
          if (handleLoginSuccess(res, "x")) {
            setAuthStatus("authenticated");
            if (redirectResult.consentSource === "settings") {
              publishXAuthUiFeedback({
                target: "settings",
                kind: "success",
                message: "X linked successfully.",
              });
            }
          }
        } else if (shouldForceUnauthenticatedOnFailure) {
          setAuthStatus("unauthenticated");
        }
      } catch (error) {
        if (isCancelled) {
          return;
        }
        console.error("X redirect verify error:", error);
        const cooldownMessage = formatAuthCooldownErrorMessage(error);
        if (cooldownMessage) {
          publishXAuthErrorFeedback(
            redirectResult.consentSource,
            cooldownMessage,
          );
        } else {
          publishXAuthErrorFeedback(
            redirectResult.consentSource,
            formatXAuthErrorMessage(
              error,
              getXAuthAction(redirectResult.consentSource),
            ),
          );
        }
        clearConsumedXRedirectResult();
        if (shouldForceUnauthenticatedOnFailure) {
          setAuthStatus("unauthenticated");
        }
      }
    };
    void completeXRedirectSignInIfNeeded();
    return () => {
      isCancelled = true;
    };
  }, [setAuthStatus]);

  useEffect(() => {
    let isCancelled = false;
    const authAttemptTimeoutIds = authAttemptTimeoutIdsRef.current;
    const scheduleDidAttemptAuthentication = () => {
      if (isCancelled) {
        return;
      }
      const sessionGuard = connection.createSessionGuard();
      const timeoutId = window.setTimeout(() => {
        authAttemptTimeoutIds.delete(timeoutId);
        if (isCancelled || !sessionGuard()) {
          return;
        }
        didAttemptAuthentication();
      }, 23);
      authAttemptTimeoutIds.add(timeoutId);
    };
    const unsubscribe = connection.subscribeToAuthChanges((uid) => {
      if (isCancelled) {
        return;
      }
      authChangeVersionRef.current += 1;
      const authChangeVersion = authChangeVersionRef.current;
      const isCurrentAuthChange = () =>
        authChangeVersionRef.current === authChangeVersion;
      if (uid === null) {
        setAuthStatus("unauthenticated");
        scheduleDidAttemptAuthentication();
        return;
      }

      const storedLoginId = storage.getLoginId("");
      const storedEthAddress = storage.getEthAddress("");
      const storedSolAddress = storage.getSolAddress("");
      const storedUsername = storage.getUsername("");
      const profileId = storage.getProfileId("");
      if (profileId === "" || storedLoginId !== uid) {
        setAuthStatus("unauthenticated");
        scheduleDidAttemptAuthentication();
        return;
      }

      connection.refreshTokenIfNeeded();
      const sessionGuard = connection.createSessionGuard();
      void (async () => {
        const isStillValid = () =>
          !isCancelled && sessionGuard() && isCurrentAuthChange();
        let resolvedProfileId = profileId;
        let resolvedUsername = storedUsername;
        let resolvedEthAddress = storedEthAddress;
        let resolvedSolAddress = storedSolAddress;
        const storedEmojiRaw = Number.parseInt(
          storage.getPlayerEmojiId("1"),
          10,
        );
        let resolvedEmoji =
          Number.isFinite(storedEmojiRaw) && storedEmojiRaw > 0
            ? storedEmojiRaw
            : 1;
        let resolvedAura = storage.getPlayerEmojiAura("");
        let isIdentityVerified = false;
        let didLoadAuthoritativeProfile = false;
        const resetResolvedIdentityToFallback = (
          nextProfileId: string,
        ): void => {
          resolvedProfileId = nextProfileId;
          resolvedUsername = "";
          resolvedEthAddress = "";
          resolvedSolAddress = "";
          resolvedEmoji = 1;
          resolvedAura = "";
          storage.setProfileId(nextProfileId);
          storage.setUsername("");
          storage.setEthAddress("");
          storage.setSolAddress("");
          storage.setPlayerEmojiId("1");
          storage.setPlayerEmojiAura("");
          flushPendingOwnProfileMiningState();
        };
        const applyAuthoritativeProfile = (
          authoritativeProfile: PlayerProfile,
        ): boolean => {
          const authoritativeProfileId =
            typeof authoritativeProfile?.id === "string"
              ? authoritativeProfile.id
              : "";
          if (!authoritativeProfileId) {
            return false;
          }
          resolvedProfileId = authoritativeProfileId;
          resolvedUsername = authoritativeProfile.username ?? "";
          resolvedEthAddress = authoritativeProfile.eth ?? "";
          resolvedSolAddress = authoritativeProfile.sol ?? "";
          const normalizedAuthoritativeEmoji = normalizeProfileEmojiId(
            authoritativeProfile.emoji,
            0,
          );
          const authoritativeEmoji =
            normalizedAuthoritativeEmoji > 0
              ? normalizedAuthoritativeEmoji
              : resolvedEmoji;
          resolvedEmoji = authoritativeEmoji;
          resolvedAura = authoritativeProfile.aura ?? "";
          storage.setProfileId(resolvedProfileId);
          storage.setUsername(resolvedUsername);
          storage.setEthAddress(resolvedEthAddress);
          storage.setSolAddress(resolvedSolAddress);
          storage.setPlayerEmojiId(resolvedEmoji.toString());
          storage.setPlayerEmojiAura(resolvedAura);
          didLoadAuthoritativeProfile = true;
          if (authoritativeProfile?.mining) {
            syncOwnProfileMiningState(authoritativeProfile);
          } else {
            flushPendingOwnProfileMiningState();
          }
          return true;
        };
        const loadAuthoritativeProfile =
          async (): Promise<PlayerProfile | null> => {
            try {
              const authoritativeProfile =
                await connection.getProfileByLoginId(uid);
              if (!isStillValid()) {
                return null;
              }
              return authoritativeProfile;
            } catch {
              if (!isStillValid()) {
                return null;
              }
              return null;
            }
          };

        try {
          const claimSyncResult = await connection.syncProfileClaim();
          if (!isStillValid()) {
            return;
          }
          const syncedProfileId =
            typeof claimSyncResult?.profileId === "string"
              ? claimSyncResult.profileId
              : "";
          if (!syncedProfileId) {
            setAuthStatus("unauthenticated");
            scheduleDidAttemptAuthentication();
            return;
          }
          if (syncedProfileId !== profileId) {
            resetResolvedIdentityToFallback(syncedProfileId);
            const authoritativeProfile = await loadAuthoritativeProfile();
            if (!isStillValid()) {
              return;
            }
            if (authoritativeProfile) {
              applyAuthoritativeProfile(authoritativeProfile);
            }
          }
          isIdentityVerified = true;
        } catch {
          if (!isStillValid()) {
            return;
          }
          const authoritativeProfile = await loadAuthoritativeProfile();
          if (!isStillValid()) {
            return;
          }
          if (authoritativeProfile) {
            isIdentityVerified =
              applyAuthoritativeProfile(authoritativeProfile);
          } else {
            const claimedProfileId =
              await connection.getCurrentProfileClaimId();
            if (!isStillValid()) {
              return;
            }
            if (claimedProfileId !== "" && claimedProfileId === profileId) {
              isIdentityVerified = true;
            }
          }
        }

        if (!isStillValid()) {
          return;
        }
        if (!isIdentityVerified) {
          setAuthStatus("unauthenticated");
          scheduleDidAttemptAuthentication();
          return;
        }
        if (isWatchOnly && !didLoadAuthoritativeProfile) {
          const authoritativeProfile = await loadAuthoritativeProfile();
          if (!isStillValid()) {
            return;
          }
          if (authoritativeProfile) {
            applyAuthoritativeProfile(authoritativeProfile);
          }
        }
        const profile = {
          id: resolvedProfileId,
          username: resolvedUsername,
          eth: resolvedEthAddress,
          sol: resolvedSolAddress,
          rating: undefined,
          nonce: undefined,
          win: undefined,
          emoji: resolvedEmoji,
          aura: resolvedAura,
          cardBackgroundId: undefined,
          cardSubtitleId: undefined,
          profileCounter: undefined,
          profileMons: undefined,
          cardStickers: undefined,
          completedProblemIds: undefined,
          isTutorialCompleted: undefined,
        };
        updateProfileDisplayName(
          resolvedUsername,
          resolvedEthAddress,
          resolvedSolAddress,
        );
        const resolvedLoginUid = connection.getSameProfilePlayerUid() ?? uid;
        setupLoggedInPlayerProfile(profile, resolvedLoginUid);
        setAuthStatus("authenticated");
        scheduleDidAttemptAuthentication();
      })();
    });
    return () => {
      isCancelled = true;
      authChangeVersionRef.current += 1;
      authAttemptTimeoutIds.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      authAttemptTimeoutIds.clear();
      unsubscribe();
    };
  }, [setAuthStatus]);

  return { authState, setAuthStatus };
}
