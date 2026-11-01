import type { TelegramEditInput, TelegramSendInput } from "./client.js";
import {
  messageDesiredDocument,
  type TelegramAppliedDocument,
  type TelegramDesiredDocument,
  type TelegramMessageDocument,
  type TelegramSendEvidence,
} from "./records.js";

type DesiredIdentity = {
  readonly revision: string;
  readonly destinationDescription: string;
  resolveDestination(resolve: (destination: string) => string): string;
  matchesAppliedContent(applied: TelegramAppliedDocument): boolean;
  appliedTargetMismatch(
    applied: TelegramAppliedDocument,
    chatId: string,
  ): string | boolean;
  createSendMarker(
    attemptId: string,
    chatId: string,
    nowMs: number,
  ): TelegramSendAttemptDocument;
  createAppliedReceipt(
    chatId: string,
    messageId: number,
    nowMs: number,
  ): TelegramAppliedDocument;
  refreshAppliedReceipt(
    applied: TelegramAppliedDocument,
    chatId: string,
    nowMs: number,
  ): TelegramAppliedDocument;
};

type TextDesiredFields = DesiredIdentity & {
  readonly instanceKey: string;
  readonly text: string;
  sendInput(chatId: string): TelegramSendInput;
  editInput(chatId: string, messageId: number): TelegramEditInput;
};

export type TextDesiredView = TextDesiredFields &
  (
    | { readonly operation: "send"; readonly ifMissing?: never }
    | { readonly operation: "edit"; readonly ifMissing: "send" | "skip" }
  );

export type RetainedDesiredView =
  | TextDesiredView
  | (DesiredIdentity & {
      readonly operation: "delete";
      readonly ifMissing?: never;
    });

export type TelegramSendAttemptDocument = TelegramSendEvidence & {
  readonly attemptId: string;
  readonly apiGateOwner: string;
};

class AcquiredDesired {
  constructor(private readonly document: TelegramDesiredDocument) {}

  get revision(): string {
    return this.document.revision as string;
  }

  get operation(): TelegramDesiredDocument["operation"] {
    return this.document.operation;
  }

  get ifMissing(): "send" | "skip" | undefined {
    return this.document.operation === "edit"
      ? this.document.ifMissing
      : undefined;
  }

  get instanceKey(): string {
    if (this.document.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return this.document.instanceKey;
  }

  get text(): string {
    if (this.document.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return this.document.text;
  }

  get destinationDescription(): string {
    return `${this.document.destination}`;
  }

  resolveDestination(resolve: (destination: string) => string): string {
    return resolve(this.document.destination);
  }

  matchesAppliedContent(applied: TelegramAppliedDocument): boolean {
    return (
      this.document.operation !== "delete" &&
      applied.contentHash === this.document.contentHash
    );
  }

  appliedTargetMismatch(
    applied: TelegramAppliedDocument,
    chatId: string,
  ): string | boolean {
    const current = applied;
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return (
      current.instanceKey !== desired.instanceKey ||
      current.destination !== desired.destination ||
      (current.chatId && current.chatId !== chatId)
    );
  }

  sendInput(chatId: string): TelegramSendInput {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return {
      chatId,
      text: desired.text as string,
      parseMode: (desired.parseMode as "HTML" | undefined) || null,
      silent: desired.silent === true,
      disableWebPagePreview: desired.disableWebPagePreview,
    };
  }

  editInput(chatId: string, messageId: number): TelegramEditInput {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return {
      chatId,
      messageId,
      text: desired.text as string,
      parseMode: (desired.parseMode as "HTML" | undefined) || null,
      disableWebPagePreview: desired.disableWebPagePreview,
    };
  }

  createSendMarker(
    attemptId: string,
    chatId: string,
    nowMs: number,
  ): TelegramSendAttemptDocument {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    const marker: TelegramSendAttemptDocument = {
      attemptId,
      revision: desired.revision,
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      contentHash: desired.contentHash,
      startedAtMs: nowMs,
      apiGateOwner: `send:${attemptId}`,
    };
    return marker;
  }

  createAppliedReceipt(
    chatId: string,
    messageId: number,
    nowMs: number,
  ): TelegramAppliedDocument {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    const receipt: TelegramAppliedDocument = {
      destination: desired.destination,
      chatId,
      messageId,
      instanceKey: desired.instanceKey,
      revision: desired.revision,
      contentHash: desired.contentHash,
      appliedAtMs: nowMs,
    };
    return receipt;
  }

  refreshAppliedReceipt(
    applied: TelegramAppliedDocument,
    chatId: string,
    nowMs: number,
  ): TelegramAppliedDocument {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    const receipt: TelegramAppliedDocument = {
      ...applied,
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      revision: desired.revision,
      contentHash: desired.contentHash,
      appliedAtMs: nowMs,
    };
    return receipt;
  }
}

export function acquiredDesiredView(
  message: TelegramMessageDocument,
): RetainedDesiredView {
  const desired = messageDesiredDocument(message);
  if (!desired) throw new TypeError("telegram-desired-missing");
  return new AcquiredDesired(desired) as RetainedDesiredView;
}
