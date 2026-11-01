const tracks = [
  "arploop",
  "band",
  "bell_dance",
  "bell_glide",
  "bounce",
  "bubble_jam",
  "buzz",
  "change",
  "chimes_photography_going_home",
  "clock_tower",
  "cloud_propeller_2",
  "cloud_propeller",
  "crumbs",
  "driver",
  "drreams",
  "ewejam",
  "gilded",
  "gustofwind",
  "honkshoooo_memememeee_zzzzzz",
  "jelly_jam",
  "mana_pool",
  "melodine",
  "object",
  "organwhawha",
  "ping",
  "runner",
  "spirit_track",
  "super",
  "whale2",
];

const MAX_TRACK_HISTORY_LENGTH = 100;

let audioElement: HTMLAudioElement | null = null;
let currentTrack = "";
let trackHistory: string[] = [];
let trackHistoryIndex = -1;
let mediaMetadata: MediaMetadata | null = null;
let isMusicMuted = false;
let isMusicPlaying = false;
const musicPlaybackListeners = new Set<() => void>();

const setMusicPlaying = (playing: boolean): void => {
  if (isMusicPlaying === playing) {
    return;
  }
  isMusicPlaying = playing;
  musicPlaybackListeners.forEach((listener) => listener());
};

export const getIsMusicPlaying = (): boolean => isMusicPlaying;

export const subscribeToMusicPlayback = (listener: () => void) => {
  musicPlaybackListeners.add(listener);
  return () => {
    musicPlaybackListeners.delete(listener);
  };
};

function showMonsAlbumArtwork(title: string) {
  if (!mediaMetadata) {
    mediaMetadata = new MediaMetadata({
      artist: "mons.link",
      artwork: [
        {
          src: "/music-cover.jpg",
          sizes: "512x512",
        },
      ],
    });
  }

  if ("mediaSession" in navigator) {
    mediaMetadata.title = title;
    navigator.mediaSession.metadata = mediaMetadata;
  }
}

const onPause = () => setMusicPlaying(false);
const onPlay = () => setMusicPlaying(true);

function playAudio(errorMessage: string): void {
  const element = audioElement;
  if (!element) {
    return;
  }
  element.play().catch((error) => {
    if (audioElement === element && element.paused) {
      setMusicPlaying(false);
    }
    console.error(errorMessage, error);
  });
}

export function setMusicMuted(muted: boolean): void {
  isMusicMuted = muted;
  if (audioElement) {
    audioElement.muted = muted;
  }
}

export function startPlayingMusic(): void {
  if (!audioElement) {
    currentTrack = getRandomTrack();
    trackHistory = [currentTrack];
    trackHistoryIndex = 0;
    audioElement = new Audio(getTrackUrl(currentTrack));
    audioElement.muted = isMusicMuted;
    audioElement.addEventListener("ended", playNextTrack);
    audioElement.addEventListener("pause", onPause);
    audioElement.addEventListener("play", onPlay);

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        playNextTrack();
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        playPreviousTrack();
      });
    }
  }
  playAudio("Error playing audio:");
  showMonsAlbumArtwork(currentTrack);
}

export function stopPlayingMusic(): void {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
    audioElement.removeEventListener("ended", playNextTrack);
    audioElement.removeEventListener("pause", onPause);
    audioElement.removeEventListener("play", onPlay);

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("nexttrack", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
    }

    audioElement = null;
    currentTrack = "";
    trackHistory = [];
    trackHistoryIndex = -1;
  }
  setMusicPlaying(false);
}

export function playNextTrack(): void {
  if (audioElement) {
    if (trackHistoryIndex < trackHistory.length - 1) {
      trackHistoryIndex += 1;
      playTrack(trackHistory[trackHistoryIndex]!);
      return;
    }

    const nextTrack = getRandomTrack(currentTrack);
    trackHistory.push(nextTrack);
    if (trackHistory.length > MAX_TRACK_HISTORY_LENGTH) {
      trackHistory.splice(0, trackHistory.length - MAX_TRACK_HISTORY_LENGTH);
    }
    trackHistoryIndex = trackHistory.length - 1;
    playTrack(nextTrack);
  } else {
    startPlayingMusic();
  }
}

export function playPreviousTrack(): void {
  if (!audioElement) {
    startPlayingMusic();
    return;
  }

  if (trackHistoryIndex <= 0) {
    audioElement.currentTime = 0;
    playAudio("Error restarting current track:");
    return;
  }

  trackHistoryIndex -= 1;
  playTrack(trackHistory[trackHistoryIndex]!);
}

function playTrack(track: string): void {
  if (!audioElement) {
    return;
  }
  currentTrack = track;
  audioElement.src = getTrackUrl(track);
  playAudio("Error playing track:");
  showMonsAlbumArtwork(currentTrack);
}

function getRandomTrack(excludedTrack = ""): string {
  if (tracks.length === 1) {
    return tracks[0]!;
  }

  const availableTracks = tracks.filter((track) => track !== excludedTrack);
  const randomIndex = Math.floor(Math.random() * availableTracks.length);
  return availableTracks[randomIndex]!;
}

function getTrackUrl(track: string): string {
  return `https://cdn.lil.org/mons/music/original/${track}.aac`;
}
