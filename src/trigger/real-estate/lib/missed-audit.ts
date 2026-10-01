import type { EventRow, LeadRow } from "./types.js";
import type { TelegramSentMessage } from "./telegram-api.js";

function eastAfricaDay(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export type MissedAuditDependencies = {
  ownerChatId: () => string | undefined;
  readLeads: () => Promise<LeadRow[]>;
  readEvents: () => Promise<EventRow[]>;
  sendTelegramText: (args: { chatId: string; text: string }) => Promise<TelegramSentMessage>;
  appendEvent: (event: EventRow) => Promise<void>;
  now?: () => Date;
};

export function createNightlyMissedAudit(deps: MissedAuditDependencies) {
  const now = deps.now ?? (() => new Date());
  return async function runNightlyMissedAudit() {
    const owner = deps.ownerChatId();
    if (!owner) throw new Error("OWNER_TELEGRAM_CHAT_ID is not set");
    const [leads, events] = await Promise.all([deps.readLeads(), deps.readEvents()]);
    const currentTime = now();
    const day = eastAfricaDay(currentTime.toISOString());
    const inbound = events.filter((event) => event.direction === "inbound" &&
      event.kind === "prospect" && eastAfricaDay(event.timestamp) === day);
    const contacts = new Set(inbound.map((event) => event.contact_key));
    const active = leads.filter((lead) => contacts.has(lead.contact_key));
    const inboundById = new Map(inbound.map((event) => [event.message_id, event]));
    const prospectReplies = events.filter((event) => {
      if (event.direction !== "outbound" || !["reply", "booking"].includes(event.kind)) return false;
      const original = inboundById.get(event.related_inbound_id);
      const sent = Date.parse(event.timestamp);
      return !!original && Number.isFinite(sent) && sent <= currentTime.getTime() &&
        sent >= Date.parse(original.timestamp) && eastAfricaDay(event.timestamp) === day;
    });
    const replied = new Set(prospectReplies.map((event) => event.related_inbound_id));
    const missed = new Set(inbound.filter((event) => {
      const received = Date.parse(event.timestamp);
      if (!Number.isFinite(received) || currentTime.getTime() - received < 30 * 60 * 1000) return false;
      return !events.some((outbound) => {
        if (outbound.direction !== "outbound" || !["reply", "booking"].includes(outbound.kind) ||
            outbound.related_inbound_id !== event.message_id) return false;
        const sent = Date.parse(outbound.timestamp);
        return Number.isFinite(sent) && sent >= received && sent - received <= 30 * 60 * 1000;
      });
    }).map((event) => event.contact_key));

    const qualified = active.filter((lead) => lead.qualification_status === "qualified").length;
    const requested = active.filter((lead) => lead.booking_status === "requested").length;
    const confirmed = active.filter((lead) => lead.booking_status === "confirmed").length;
    const repliedToday = inbound.filter((event) => replied.has(event.message_id)).length;
    const text = `Nightly lead audit — ${day}\nProspects: ${contacts.size}\nQualified: ${qualified}\n` +
      `Viewing requests: ${requested}\nConfirmed: ${confirmed}\nMissed replies: ${missed.size}\n` +
      `Replied today: ${repliedToday}`;
    const sent = await deps.sendTelegramText({ chatId: owner, text });
    await deps.appendEvent({
      timestamp: new Date(sent.date * 1000).toISOString(), contact_key: `telegram:${owner}`,
      direction: "outbound", kind: "owner", message_id: `telegram:${sent.chat.id}:${sent.message_id}`,
      related_inbound_id: `nightly-audit-${day}`,
    });
    return { day, prospects: contacts.size, qualified, requested, confirmed, missed: missed.size };
  };
}
