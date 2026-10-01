import { schedules, tasks } from "@trigger.dev/sdk";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./lib/sheet.js";
import { telegramRequest } from "./lib/telegram-api.js";
import { pollTelegramUpdates as pollTelegramUpdateBatch } from "./lib/telegram-polling.js";
import type { inboundMessage } from "./inbound-message.js";

export const pollTelegramUpdates = schedules.task({
  id: "poll-telegram-updates",
  cron: { pattern: "* * * * *", timezone: "Africa/Kampala" },
  queue: { name: "telegram-poller", concurrencyLimit: 1 },
  retry: { maxAttempts: 2, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 4000 },
  run: async () => pollTelegramUpdateBatch({
    readOffset: readTelegramUpdateOffset,
    getWebhookInfo: () => telegramRequest<{ url?: string }>("getWebhookInfo", {}),
    getUpdates: (payload) => telegramRequest("getUpdates", payload, 5_000),
    enqueueInbound: async (payload, idempotencyKey) => {
      await tasks.trigger<typeof inboundMessage>("inbound-message", payload, { idempotencyKey });
    },
    writeOffset: writeTelegramUpdateOffset,
  }),
});

