export type TelegramDesired = {
  schemaVersion: number;
  operation: "send" | "edit" | "delete";
  destination: "community" | "events";
  revision: string;
  sourceRevision: string;
  contentHash?: string;
  instanceKey?: string;
  text?: string;
  parseMode?: "HTML";
  silent?: boolean;
  disableWebPagePreview?: boolean;
  ifMissing?: "send" | "skip";
};

export function buildTelegramSendDesired(input: object): TelegramDesired;
export function buildTelegramEditDesired(input: object): TelegramDesired;
export function buildTelegramDeleteDesired(input: object): TelegramDesired;
export function validateTelegramMessageKey(messageKey: string): string;
