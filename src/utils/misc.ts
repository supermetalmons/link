import { INVITE_ID_RANDOM_LENGTH, randomAlphanumeric } from "@mons/shared/ids";

export const isDesktopSafari = (() => {
  const userAgent = window.navigator.userAgent;
  const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
  const isIos = /iPad|iPhone|iPod/.test(userAgent);
  return isSafari && !isIos;
})();

const userAgent = navigator.userAgent;
// TODO: make inputs work properly on devices with both touch and mouse inputs like surface
export const isMobile =
  /iPhone|iPad|iPod|Android|Windows Phone|IEMobile|Mobile|Opera Mini/i.test(
    userAgent,
  );
export const defaultInputEventName = isMobile ? "touchstart" : "click";
export const defaultEarlyInputEventName = isMobile ? "touchstart" : "mousedown";

export function generateNewInviteId(): string {
  return randomAlphanumeric(INVITE_ID_RANDOM_LENGTH);
}

export function getStableRandomIdForProfileId(
  profileId: string,
  totalIdsCount: number,
): number {
  let hash = 0;
  for (let i = 0; i < profileId.length; i++) {
    hash += profileId.charCodeAt(i);
  }
  const index = hash % totalIdsCount;
  return index;
}

export function getBuildInfo(): string {
  return import.meta.env.VITE_BUILD_DATETIME
    ? (() => {
        const date = new Date(
          Number(import.meta.env.VITE_BUILD_DATETIME) * 1000,
        );
        const weekDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        const day = weekDays[date.getDay()];
        const hours = date.getHours().toString().padStart(2, "0");
        const minutes = date.getMinutes().toString().padStart(2, "0");
        return `build ${day} (${hours}:${minutes})`;
      })()
    : "local dev";
}
