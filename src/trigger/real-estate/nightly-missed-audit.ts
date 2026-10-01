import { schedules } from "@trigger.dev/sdk";
import { appendEvent, readEvents, readLeads } from "./lib/sheet.js";
import { sendTelegramText } from "./lib/telegram-api.js";
import { createNightlyMissedAudit } from "./lib/missed-audit.js";

export const nightlyMissedAudit = schedules.task({
  id: "nightly-missed-audit",
  cron: { pattern: "0 21 * * *", timezone: "Africa/Kampala" },
  retry: { maxAttempts: 2, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000 },
  run: createNightlyMissedAudit({
    ownerChatId: () => process.env.OWNER_TELEGRAM_CHAT_ID,
    readLeads,
    readEvents,
    sendTelegramText,
    appendEvent,
  }),
});
