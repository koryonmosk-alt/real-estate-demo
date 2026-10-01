import { schedules, task } from "@trigger.dev/sdk";
import { appendEvent, findLead, nextFollowUpIso, readEvents, readLeads,
  readListings, upsertLead } from "./lib/sheet.js";
import { sendTelegramText } from "./lib/telegram-api.js";
import { createDailyFollowUpDispatcher, createFollowUpHandler } from "./lib/follow-up-handler.js";
import type { FollowUpPayload } from "./lib/types.js";

export const sendFollowUpTouch = task({
  id: "send-follow-up-touch",
  queue: { name: "real-estate-conversations", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },
  run: createFollowUpHandler({
    findLead,
    readEvents,
    readListings,
    upsertLead,
    appendEvent,
    nextFollowUpIso,
    sendTelegramText,
  }),
});

export const dailyFollowUp = schedules.task({
  id: "daily-follow-up",
  cron: { pattern: "0 9 * * *", timezone: "Africa/Kampala" },
  retry: { maxAttempts: 2, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000 },
  run: createDailyFollowUpDispatcher({
    readLeads,
    dispatch: (payload: FollowUpPayload, idempotencyKey) =>
      sendFollowUpTouch.trigger(payload, { idempotencyKey }),
  }),
});
