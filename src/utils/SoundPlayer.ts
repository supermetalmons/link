import { isMobile } from "./misc";
import { getIsMuted, subscribeToMuteState } from "../runtime/muteStore";

class SoundPlayer {
  private audioContext!: AudioContext;
  private masterGainNode: GainNode | null = null;
  private audioBufferCache = new Map<string, AudioBuffer>();
  private arrayBufferCache = new Map<string, ArrayBuffer>();
  private arrayBufferPromises = new Map<string, Promise<ArrayBuffer>>();
  public isInitialized = false;
  private playIslandShowUpOnInitComplete = false;
  private isResuming = false;
  private initializationPromise: Promise<void> | null = null;
  private playIslandShowUp: () => void = () => {};

  constructor() {
    document.addEventListener(
      "touchend",
      () => this.initializeOnUserInteraction(false),
      { once: true },
    );
    document.addEventListener(
      "click",
      () => this.initializeOnUserInteraction(false),
      { once: true },
    );
    this.attachVisibilityHandlers();
    subscribeToMuteState(() => {
      this.setMuted(getIsMuted());
    });
  }

  public setIslandShowUpPlayback(playback: () => void): void {
    this.playIslandShowUp = playback;
  }

  public scheduleIslandShowUpOnInitComplete() {
    this.playIslandShowUpOnInitComplete = true;
  }

  public setMuted(muted: boolean): void {
    if (!this.masterGainNode || !this.audioContext) {
      return;
    }
    const value = muted ? 0 : 1;
    try {
      this.masterGainNode.gain.setValueAtTime(
        value,
        this.audioContext.currentTime,
      );
    } catch {
      this.masterGainNode.gain.value = value;
    }
  }

  public async initializeOnUserInteraction(force: boolean) {
    const isMuted = getIsMuted();
    if (this.isInitialized) return;
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    if (isMuted && !force) return;
    if (document.visibilityState !== "visible" && !force) return;

    const initializationPromise = this.performInitialization(force);
    this.initializationPromise = initializationPromise;
    try {
      await initializationPromise;
    } finally {
      if (this.initializationPromise === initializationPromise) {
        this.initializationPromise = null;
      }
    }
  }

  private async performInitialization(force: boolean): Promise<void> {
    this.audioContext = new (
      window.AudioContext || (window as any).webkitAudioContext
    )();
    this.masterGainNode = this.audioContext.createGain();
    this.masterGainNode.gain.value = getIsMuted() ? 0 : 1;
    this.masterGainNode.connect(this.audioContext.destination);
    this.attachStateChangeHandler();
    await this.unlockOnce(force);
    this.isInitialized = true;

    if (this.playIslandShowUpOnInitComplete) {
      this.playIslandShowUpOnInitComplete = false;
      this.playIslandShowUp();
    }
  }

  private attachVisibilityHandlers() {
    if (isMobile) {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.cleanup();
        } else if (document.visibilityState === "visible") {
          this.setupRestartListeners();
        }
      });
      window.addEventListener("pagehide", () => {
        this.cleanup();
      });
      window.addEventListener("pageshow", () => {
        this.setupRestartListeners();
      });
    }
  }

  private cleanup() {
    if (!this.isInitialized) return;
    try {
      if (this.audioContext && this.audioContext.state !== "closed") {
        this.audioContext.suspend();
      }
    } catch (_) {}
  }

  private unlockOnce = async (force: boolean = false) => {
    if ((getIsMuted() && !force) || document.visibilityState !== "visible")
      return;
    if (!this.audioContext) return;
    if (this.audioContext.state === "closed") return;
    try {
      if (this.audioContext.state !== "running") {
        if (this.isResuming) return;
        this.isResuming = true;
        await this.audioContext.resume();
        this.isResuming = false;
      }
      const buffer = this.audioContext.createBuffer(
        1,
        1,
        this.audioContext.sampleRate,
      );
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start(0);
    } catch (_) {
      this.isResuming = false;
      this.setupRestartListeners();
    }
  };

  private async getOrFetchArrayBuffer(url: string): Promise<ArrayBuffer> {
    if (this.arrayBufferCache.has(url)) {
      return this.arrayBufferCache.get(url)!;
    }
    const pending = this.arrayBufferPromises.get(url);
    if (pending) {
      return pending;
    }
    const fetchPromise = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to fetch sound");
      }
      const arrayBuffer = await response.arrayBuffer();
      this.arrayBufferCache.set(url, arrayBuffer);
      this.arrayBufferPromises.delete(url);
      return arrayBuffer;
    })();
    this.arrayBufferPromises.set(url, fetchPromise);
    try {
      return await fetchPromise;
    } catch (error) {
      this.arrayBufferPromises.delete(url);
      this.arrayBufferCache.delete(url);
      throw error;
    }
  }

  private async loadAudioBuffer(url: string): Promise<AudioBuffer> {
    if (this.audioBufferCache.has(url)) {
      return this.audioBufferCache.get(url)!;
    }
    const arrayBuffer = await this.getOrFetchArrayBuffer(url);
    this.arrayBufferCache.delete(url);
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    this.audioBufferCache.set(url, audioBuffer);
    return audioBuffer;
  }

  private setupRestartListeners(): void {
    const handler = async () => {
      await this.unlockOnce();
      document.removeEventListener("touchend", handler);
      document.removeEventListener("click", handler);
    };
    document.addEventListener("touchend", handler, { once: true });
    document.addEventListener("click", handler, { once: true });
  }

  private async prepareContext(): Promise<AudioContext | null> {
    if (!this.isInitialized) return null;
    if (!this.audioContext) return null;
    if (this.audioContext.state === "closed") {
      this.isInitialized = false;
      this.masterGainNode = null;
      this.setupRestartListeners();
      return null;
    }
    try {
      if (this.audioContext.state !== "running") {
        if (!this.isResuming) {
          this.isResuming = true;
          await this.audioContext.resume();
          this.isResuming = false;
        }
      }
      return this.audioContext;
    } catch (_) {
      this.isResuming = false;
      this.setupRestartListeners();
      return null;
    }
  }

  private attachStateChangeHandler(): void {
    if (!this.audioContext) return;
    const ctx: any = this.audioContext as any;
    const handle = () => {
      if (!this.audioContext) return;
      if (this.audioContext.state !== "running") {
        this.setupRestartListeners();
      }
    };
    if (typeof this.audioContext.addEventListener === "function") {
      this.audioContext.addEventListener(
        "statechange",
        handle as EventListener,
      );
    } else {
      (this.audioContext as any).onstatechange = handle;
    }
    if (ctx && typeof ctx.addEventListener === "function") {
      try {
        ctx.addEventListener("interruptionend", () =>
          this.setupRestartListeners(),
        );
      } catch (_) {}
    }
  }

  public async playSound(
    url: string,
    volumeMultiplier: number = 1,
  ): Promise<void> {
    if (!this.isInitialized) return;
    if (document.visibilityState !== "visible" && isMobile) return;
    const ctx = await this.prepareContext();
    if (!ctx) return;
    try {
      const audioBuffer = await this.loadAudioBuffer(url);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      const gainNode = ctx.createGain();
      gainNode.gain.value = Math.max(0, volumeMultiplier);
      source.connect(gainNode);
      gainNode.connect(this.masterGainNode ?? ctx.destination);
      source.start(0);
    } catch (_) {
      this.setupRestartListeners();
    }
  }

  public async preloadSound(url: string): Promise<void> {
    if (document.visibilityState !== "visible" && isMobile) return;
    if (!this.isInitialized) {
      if (this.audioBufferCache.has(url)) return;
      await this.getOrFetchArrayBuffer(url);
      return;
    }
    const ctx = await this.prepareContext();
    if (!ctx) return;
    try {
      await this.loadAudioBuffer(url);
    } catch (_) {
      this.setupRestartListeners();
    }
  }
}

export const soundPlayer = new SoundPlayer();
