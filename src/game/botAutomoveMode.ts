export type BotAutomoveMode = "fast" | "normal" | "pro";

const BOT_AUTOMOVE_MODES: readonly BotAutomoveMode[] = [
  "fast",
  "normal",
  "pro",
];

export const normalizeBotAutomoveMode = (
  value: string | null | undefined,
): BotAutomoveMode => {
  if (value === "fast" || value === "normal" || value === "pro") {
    return value;
  }
  if (value === "ultra") {
    return "pro";
  }
  return "normal";
};

export const getNextBotAutomoveMode = (
  current: BotAutomoveMode,
): BotAutomoveMode => {
  const nextIndex =
    (BOT_AUTOMOVE_MODES.indexOf(current) + 1) % BOT_AUTOMOVE_MODES.length;
  return BOT_AUTOMOVE_MODES[nextIndex] ?? "normal";
};
