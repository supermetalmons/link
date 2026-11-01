export const PrimaryActionType = {
  None: "none",
  JoinGame: "joinGame",
  Rematch: "rematch",
} as const;

export type PrimaryAction =
  (typeof PrimaryActionType)[keyof typeof PrimaryActionType];
