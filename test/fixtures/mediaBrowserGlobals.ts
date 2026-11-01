export type ReactionSnapshot = {
  parentRenders: number;
  mountSetups: number;
  playCount: number;
  timers: number[];
  children: string[];
  wrappers: { top: string; height: string; transform: string }[];
  videos: {
    id: number;
    opacity: string;
    transform: string;
    muted: boolean;
    playsInline: boolean;
    sources: string[];
  }[];
};
export type BoardReactionsHarness = {
  render: (
    hasViewport?: boolean,
    pangchiu?: boolean,
    mountReaction?: number | null,
  ) => void;
  show: (opponent: boolean, id: number) => void;
  advance: (ms: number, runTimers?: boolean) => void;
  playing: (opponent: boolean, duration: number, currentTime?: number) => void;
  error: (opponent: boolean, source?: boolean) => void;
  resume: (eventName: string, nextVisibility?: string) => void;
  clear: (fade?: boolean) => void;
  pendingPlayback: (value: boolean) => void;
  rejectPlay: (index: number, name: string) => Promise<void>;
  snapshot: () => ReactionSnapshot;
  dispose: () => void;
};
type ImageLoadingHarness = {
  decodeRequests: (PromiseWithResolvers<void> & { image: HTMLImageElement })[];
  loadResults: (string | undefined)[];
  render: (visible?: boolean) => void;
  observeLoad: () => void;
  cachedUrl: () => string | undefined;
  snapshot: () => {
    placeholder: boolean;
    imageUrl: string | null;
    complete: boolean;
    naturalWidth: number;
  };
  resolveDecode: (index: number) => Promise<void>;
  rejectDecode: (index: number) => void;
  useOnloadFallback: () => void;
  fallbackLoads: () => number;
};
declare global {
  var cardResources: () => {
    timeouts: number;
    rafs: number;
    listeners: number;
    elements: number;
    detachedElements: number;
    observed: number;
  };
  var boardReactionsHarness: BoardReactionsHarness;
  var imageLoadingHarness: ImageLoadingHarness;
}
