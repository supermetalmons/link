const START = "auth:restore-start";
let started = false;
let expectsName = false;
const marked = new Set<string>();

function mark(name: string): void {
  if (!started || marked.has(name)) return;
  marked.add(name);
  performance.mark(name);
  if (name !== START) performance.measure(name, START, name);
}

export function markAuthRestoreStart(): void {
  if (started) return;
  started = true;
  mark(START);
}

export const markAuthLocalReady = () => mark("auth:local-ready");
export const markAuthSessionReady = () => mark("auth:session-ready");
export const markAuthIdentityReady = (hasProfile = true) => {
  expectsName = hasProfile;
  mark("auth:identity-ready");
};

export function markAuthNameCommitted(
  isCurrent: () => boolean = () => true,
): () => void {
  if (!expectsName || !isCurrent()) return () => {};
  mark("auth:name-committed");
  if (typeof requestAnimationFrame === "undefined") return () => {};
  let canceled = false;
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (!canceled && isCurrent() && document.visibilityState !== "hidden")
        mark("auth:name-visible");
    });
  });
  return () => {
    canceled = true;
    cancelAnimationFrame(frame);
  };
}
