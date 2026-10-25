import type { TelegramEditInput, TelegramSendInput } from "./client.js";
import {
  messageDesiredDocument,
  type TelegramAppliedDocument,
  type TelegramDesiredDocument,
  type TelegramMessageDocument,
  type TelegramSendEvidence,
} from "./records.js";

type SourceRecord = Record<string, unknown>;
const fields = (value: unknown): SourceRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
const normalizedString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

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
    return fields(this.document).revision as string;
  }

  get operation(): unknown {
    return fields(this.document).operation;
  }

  get ifMissing(): unknown {
    return fields(this.document).ifMissing;
  }

  get instanceKey(): string {
    return fields(this.document).instanceKey as string;
  }

  get text(): string {
    return fields(this.document).text as string;
  }

  get destinationDescription(): string {
    return `${fields(this.document).destination}`;
  }

  resolveDestination(resolve: (destination: string) => string): string {
    return Reflect.apply(resolve, undefined, [
      fields(this.document).destination,
    ]);
  }

  matchesAppliedContent(applied: TelegramAppliedDocument): boolean {
    return fields(applied).contentHash === fields(this.document).contentHash;
  }

  appliedTargetMismatch(
    applied: TelegramAppliedDocument,
    chatId: string,
  ): string | boolean {
    const current = fields(applied);
    const desired = fields(this.document);
    return (
      normalizedString(current.instanceKey) !== desired.instanceKey ||
      normalizedString(current.destination) !== desired.destination ||
      (normalizedString(current.chatId) &&
        normalizedString(current.chatId) !== chatId)
    );
  }

  sendInput(chatId: string): TelegramSendInput {
    const desired = fields(this.document);
    return {
      chatId,
      text: desired.text as string,
      parseMode: (desired.parseMode as "HTML" | undefined) || null,
      silent: desired.silent === true,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    };
  }

  editInput(chatId: string, messageId: number): TelegramEditInput {
    const desired = fields(this.document);
    return {
      chatId,
      messageId,
      text: desired.text as string,
      parseMode: (desired.parseMode as "HTML" | undefined) || null,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    };
  }

  createSendMarker(
    attemptId: string,
    chatId: string,
    nowMs: number,
  ): TelegramSendAttemptDocument {
    const desired = fields(this.document);
    const marker: unknown = {
      attemptId,
      revision: desired.revision,
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      contentHash: desired.contentHash,
      startedAtMs: nowMs,
      apiGateOwner: `send:${attemptId}`,
    };
    return marker as TelegramSendAttemptDocument;
  }

  createAppliedReceipt(
    chatId: string,
    messageId: number,
    nowMs: number,
  ): TelegramAppliedDocument {
    const desired = fields(this.document);
    const receipt: unknown = {
      destination: desired.destination,
      chatId,
      messageId,
      instanceKey: desired.instanceKey,
      revision: desired.revision,
      contentHash: desired.contentHash,
      appliedAtMs: nowMs,
    };
    return receipt as TelegramAppliedDocument;
  }

  refreshAppliedReceipt(
    applied: TelegramAppliedDocument,
    chatId: string,
    nowMs: number,
  ): TelegramAppliedDocument {
    const desired = fields(this.document);
    const receipt: unknown = {
      ...fields(applied),
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      revision: desired.revision,
      contentHash: desired.contentHash,
      appliedAtMs: nowMs,
    };
    return receipt as TelegramAppliedDocument;
  }
}

export function acquiredDesiredView(
  message: TelegramMessageDocument,
): RetainedDesiredView {
  const value: unknown = new AcquiredDesired(messageDesiredDocument(message));
  return value as RetainedDesiredView;
}
