import type { TelegramMessageDocument } from "../../../runtime/telegram/records.js";
import { requireTelegramMessageDocument } from "../../../runtime/telegram/recordCodec.js";
import {
  buildTelegramEditDesired,
  buildTelegramSendDesired,
} from "../../../runtime/telegram/desiredStateCore.js";

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid telegram message fixture");
  return Object.fromEntries(Object.entries(value));
}
const string = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

export function telegramMessageFixture(
  input: unknown,
): TelegramMessageDocument | null {
  if (input === null || input === undefined) return null;
  const value: Record<string, unknown> = { schemaVersion: 1, ...fields(input) };
  const desiredSource =
    value.desired === undefined ? null : fields(value.desired);
  const desired =
    desiredSource === null
      ? null
      : desiredSource.schemaVersion === 2
        ? desiredSource
        : (desiredSource.operation === "edit"
            ? buildTelegramEditDesired
            : buildTelegramSendDesired)({
            destination: string(desiredSource.destination, "community"),
            instanceKey: string(desiredSource.instanceKey, "fixture-instance"),
            text: string(desiredSource.text, "fixture-text"),
            sourceRevision: string(
              desiredSource.sourceRevision,
              "fixture-source",
            ),
            ...(desiredSource.operation === "edit"
              ? {
                  ifMissing:
                    desiredSource.ifMissing === "send"
                      ? ("send" as const)
                      : ("skip" as const),
                }
              : {}),
          });
  if (desired !== null) value.desired = desired;
  if (value.applied !== undefined)
    value.applied = {
      appliedAtMs: 1,
      chatId: "community-chat",
      revision: "applied-revision",
      ...fields(value.applied),
    };
  if (value.delivery !== undefined) {
    const delivery = fields(value.delivery);
    delivery.status ??= delivery.sendInFlight ? "processing" : "pending";
    delivery.revision ??= desired?.revision ?? "fixture-revision";
    if (delivery.status === "processing") {
      delivery.leaseOwner ??= "fixture-lease";
      delivery.leaseExpiresAtMs ??= Number.MAX_SAFE_INTEGER;
    }
    if (delivery.status === "delivered") delivery.deliveredAtMs ??= 1;
    if (delivery.sendInFlight) {
      const marker = fields(delivery.sendInFlight);
      delivery.sendInFlight = {
        attemptId: "fixture-attempt",
        revision: delivery.revision,
        destination: desired?.destination ?? "community",
        chatId: "community-chat",
        instanceKey: desired?.instanceKey ?? "fixture-instance",
        contentHash: desired?.contentHash ?? "fixture-content",
        startedAtMs: 1,
        apiGateOwner: `send:${string(marker.attemptId, "fixture-attempt")}`,
        ...marker,
      };
    }
    if (delivery.lastError)
      delivery.lastError = { atMs: 1, ...fields(delivery.lastError) };
    value.delivery = delivery;
  }
  return requireTelegramMessageDocument(value);
}
