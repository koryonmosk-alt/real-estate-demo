import type { InboundPayload } from "./types.js";

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat?: { id: number; type: string; first_name?: string; last_name?: string; username?: string };
    from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  };
};

export type TelegramPollingDependencies = {
  readOffset: () => Promise<number | null>;
  getWebhookInfo: () => Promise<{ url?: string }>;
  getUpdates: (payload: Record<string, unknown>) => Promise<TelegramUpdate[]>;
  enqueueInbound: (payload: InboundPayload, idempotencyKey: string) => Promise<unknown>;
  writeOffset: (offset: number) => Promise<void>;
};

export async function pollTelegramUpdates(deps: TelegramPollingDependencies) {
  const webhook = await deps.getWebhookInfo();
  if (webhook.url) {
    throw new Error("Telegram webhook is configured; polling with getUpdates is unavailable until it is removed.");
  }

  const currentOffset = await deps.readOffset();
  const request: Record<string, unknown> = {
    timeout: 15,
    limit: 20,
    allowed_updates: ["message"],
  };
  if (currentOffset !== null) request.offset = currentOffset;
  const updates = await deps.getUpdates(request);
  let queued = 0;
  let ignored = 0;
  let nextOffset: number | null = null;

  for (const update of updates) {
    const message = update.message;
    const text = message?.text?.trim();
    const chat = message?.chat;
    const from = message?.from;
    const privateUserMessage = chat?.type === "private" && !!from && !from.is_bot && !!text;

    if (privateUserMessage && message && text && chat && from) {
      const chatId = String(chat.id);
      const name = [from.first_name ?? chat.first_name, from.last_name ?? chat.last_name]
        .filter(Boolean).join(" ");
      await deps.enqueueInbound({
        channel: "telegram",
        contactKey: `telegram:${chatId}`,
        chatId,
        username: from.username ?? chat.username,
        fromName: name,
        text,
        messageId: `telegram:${chatId}:${message.message_id}`,
        updateId: update.update_id,
        timestamp: new Date(message.date * 1000).toISOString(),
      }, `telegram-update-${update.update_id}`);
      queued++;
    } else {
      ignored++;
    }

    // A failed enqueue exits before persisting, so Telegram can redeliver the batch.
    // Trigger idempotency keys prevent duplicate inbound tasks during that replay.
    nextOffset = update.update_id + 1;
  }

  if (nextOffset !== null) await deps.writeOffset(nextOffset);
  return {
    received: updates.length,
    queued,
    ignored,
    offset: nextOffset ?? currentOffset,
  };
}
