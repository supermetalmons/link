import {
  normalizeTaskPayload,
  type TelegramTaskPayload,
} from "../../../functions/telegram/taskIdentity.js";

export type InitialTelegramDelivery = {
  generation: string;
  messageKey: string;
  producer: string;
  revision: string;
};

export function buildInitialTelegramDeliveryTask(
  input: InitialTelegramDelivery,
): TelegramTaskPayload {
  return normalizeTaskPayload({
    messageKey: input.messageKey,
    revision: input.revision,
    taskKind: "desired",
    retrySequence: 0,
    generation: input.generation,
  });
}

export async function enqueueInitialTelegramDelivery(
  env: Env,
  input: InitialTelegramDelivery,
): Promise<TelegramTaskPayload> {
  const payload = buildInitialTelegramDeliveryTask(input);
  await env.TELEGRAM_DELIVERY_QUEUE.send(payload);
  console.info(
    JSON.stringify({
      event: "telegram_delivery_enqueued",
      messageKey: payload.messageKey,
      producer: input.producer,
      revision: payload.revision,
    }),
  );
  return payload;
}

export async function enqueueTelegramDeliveryTask(
  env: Env,
  payload: TelegramTaskPayload,
): Promise<void> {
  await env.TELEGRAM_DELIVERY_QUEUE.send(payload);
}
