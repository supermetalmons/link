export const environment = {
  values: {
    ProfileId: "owner-a",
    PlayerEmojiId: "1",
    PlayerEmojiAura: "",
    CardBackgroundId: 30,
    CardSubtitleId: 0,
    CardStickers: "",
    ProfileMons: "0,0,0,0,0",
    ProfileCounter: "gp",
    PlayerRating: 1500,
    PlayerNonce: 3,
    PlayerTotalManaPoints: 7,
  } as Record<string, unknown>,
  writes: [] as unknown[][],
  spriteRequests: [] as string[],
  releaseSprites: () => {},
};

export const spritesReady = new Promise<void>((resolve) => {
  environment.releaseSprites = resolve;
});

export const storage = new Proxy(
  {} as Record<string, (...args: any[]) => any>,
  {
    get(_target, key) {
      const name = String(key);
      if (name.startsWith("get")) {
        return (fallback: unknown) =>
          environment.values[name.slice(3)] ?? fallback;
      }
      if (name.startsWith("set")) {
        return (value: unknown) => {
          environment.values[name.slice(3)] = value;
        };
      }
      throw new Error(`Unexpected fixture storage operation: ${name}`);
    },
  },
);

const spriteImages = new Map<string, string>();

export function spriteForKey(key: string): string {
  let image = spriteImages.get(key);
  if (!image) {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d")!;
    const hue = [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    context.fillStyle = `hsl(${hue % 360}, 80%, 50%)`;
    context.fillRect(0, 0, 8, 8);
    image = canvas.toDataURL("image/png").split(",")[1];
    spriteImages.set(key, image);
  }
  return image;
}
