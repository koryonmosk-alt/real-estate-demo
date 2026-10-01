import { task } from "@trigger.dev/sdk";
import { appendEvent, findLead, readLeads, readListings, upsertLead, nextFollowUpIso } from "./lib/sheet.js";
import { proposeSlots, formatSlotOptions, slotIsFree, viewingEventId, requestViewing,
  confirmViewing, declineViewing } from "./lib/calendar.js";
import { sendTelegramText } from "./lib/telegram-api.js";
import { qualifyLead } from "./qualify-lead.js";
import { createInboundMessageHandler } from "./lib/inbound-handler.js";

const handleInboundMessage = createInboundMessageHandler({
  hasBotToken: () => !!process.env.TELEGRAM_BOT_TOKEN,
  ownerChatId: () => process.env.OWNER_TELEGRAM_CHAT_ID,
  allowOwnerAsProspect: () => process.env.ALLOW_OWNER_AS_PROSPECT === "true",
  readListings,
  findLead,
  readLeads,
  upsertLead,
  appendEvent,
  nextFollowUpIso,
  proposeSlots,
  formatSlotOptions,
  slotIsFree,
  viewingEventId,
  requestViewing,
  confirmViewing,
  declineViewing,
  sendTelegramText,
  qualify: async (payload) => {
    const result = await qualifyLead.triggerAndWait(payload);
    if (!result.ok) throw new Error(`qualify-lead failed: ${String(result.error)}`);
    return result.output;
  },
});

export const inboundMessage = task({
  id: "inbound-message",
  queue: { name: "real-estate-conversations", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },
  run: handleInboundMessage,
});
