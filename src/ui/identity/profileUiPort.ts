import { cropAddress } from "@mons/shared/profiles";

export type ProfileSignInPopupMode = "inline" | "event";

export type ProfileSignInApi = {
  close: () => void;
  editDisplayName: () => void;
  requestLogout: (returnFocusId?: string) => void;
  openSettings: (returnFocusId?: string) => void;
  hideNotificationBanner: () => void;
  showNotificationBanner: (
    title: string,
    subtitle: string,
    emojiId: string,
    successHandler: () => void,
  ) => void;
  openSignInPopup: (mode?: ProfileSignInPopupMode) => void;
  hasVisiblePopup: () => boolean;
};

let profileSignInApi: ProfileSignInApi | null = null;
let setSignInInlineAuthErrorImpl: (message: string | null) => void = () => {};
let pendingSignInInlineAuthError: string | null | undefined;
let setProfileDisplayNameGlobal: ((name: string) => void) | null = null;
let updateProfileCardDisplayNameGlobal: ((name: string) => void) | null = null;
let pendingUsername: string | null = null;
let pendingEthAddress: string | null = null;
let pendingSolAddress: string | null = null;
let hasPendingProfileDisplayName = false;

export const closeProfilePopupIfAny = () => {
  profileSignInApi?.close();
};

export const handleEditDisplayName = () => {
  profileSignInApi?.editDisplayName();
};

export const handleLogout = (returnFocusId?: string) => {
  profileSignInApi?.requestLogout(returnFocusId);
};

export const showSettings = (returnFocusId?: string) => {
  profileSignInApi?.openSettings(returnFocusId);
};

export const hideNotificationBanner = () => {
  profileSignInApi?.hideNotificationBanner();
};

export const showNotificationBanner = (
  title: string,
  subtitle: string,
  emojiId: string,
  successHandler: () => void,
) => {
  profileSignInApi?.showNotificationBanner(
    title,
    subtitle,
    emojiId,
    successHandler,
  );
};

export const setSignInInlineAuthError = (message: string | null) => {
  pendingSignInInlineAuthError = typeof message === "string" ? message : null;
  setSignInInlineAuthErrorImpl(message);
};

export const openProfileSignInPopup = () => {
  profileSignInApi?.openSignInPopup("inline");
};

export const openProfileSignInPopupForEvent = () => {
  profileSignInApi?.openSignInPopup("event");
};

export function hasProfilePopupVisible(): boolean {
  return profileSignInApi?.hasVisiblePopup() ?? false;
}

export const registerProfileSignInApi = (
  api: ProfileSignInApi,
): (() => void) => {
  profileSignInApi = api;
  return () => {
    if (profileSignInApi === api) {
      profileSignInApi = null;
    }
  };
};

export const registerSignInInlineAuthErrorHandler = (
  handler: (message: string | null) => void,
): (() => void) => {
  const boundHandler = (message: string | null) => {
    pendingSignInInlineAuthError = undefined;
    handler(message);
  };
  setSignInInlineAuthErrorImpl = boundHandler;
  if (pendingSignInInlineAuthError !== undefined) {
    const pendingMessage = pendingSignInInlineAuthError;
    pendingSignInInlineAuthError = undefined;
    handler(pendingMessage);
  }
  return () => {
    if (setSignInInlineAuthErrorImpl === boundHandler) {
      setSignInInlineAuthErrorImpl = () => {};
    }
  };
};

export const formatProfileDisplayName = (
  username: string | null,
  ethAddress: string | null,
  solAddress: string | null,
): string => {
  if (username) {
    return username;
  }
  if (ethAddress) {
    return cropAddress(ethAddress);
  }
  if (solAddress) {
    return cropAddress(solAddress);
  }
  pendingUsername = null;
  pendingEthAddress = null;
  pendingSolAddress = null;
  return "anon";
};

export const getInitialProfileDisplayName = (): string => {
  return formatProfileDisplayName(
    pendingUsername,
    pendingEthAddress,
    pendingSolAddress,
  );
};

export const updateProfileDisplayName = (
  username: string | null,
  ethAddress: string | null,
  solAddress: string | null,
) => {
  if (!setProfileDisplayNameGlobal) {
    pendingUsername = username ?? null;
    pendingEthAddress = ethAddress ?? null;
    pendingSolAddress = solAddress ?? null;
    hasPendingProfileDisplayName = true;
    return;
  }
  const newDisplayName = formatProfileDisplayName(
    username,
    ethAddress,
    solAddress,
  );
  setProfileDisplayNameGlobal(newDisplayName);
  updateProfileCardDisplayNameGlobal?.(newDisplayName);
};

export const registerProfileDisplayNameHandlers = (
  setDisplayName: (name: string) => void,
  updateCardDisplayName: (name: string) => void,
): (() => void) => {
  setProfileDisplayNameGlobal = setDisplayName;
  updateProfileCardDisplayNameGlobal = updateCardDisplayName;
  if (hasPendingProfileDisplayName) {
    hasPendingProfileDisplayName = false;
    const pendingDisplayName = formatProfileDisplayName(
      pendingUsername,
      pendingEthAddress,
      pendingSolAddress,
    );
    setDisplayName(pendingDisplayName);
    updateCardDisplayName(pendingDisplayName);
  }
  return () => {
    if (setProfileDisplayNameGlobal === setDisplayName) {
      setProfileDisplayNameGlobal = null;
    }
    if (updateProfileCardDisplayNameGlobal === updateCardDisplayName) {
      updateProfileCardDisplayNameGlobal = null;
    }
  };
};
