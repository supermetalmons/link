import { clearTimeout, setTimeout } from "node:timers";

export function createTimerHandle() {
  const handle = setTimeout(() => {}, 0);
  clearTimeout(handle);
  return handle;
}
