import { createHash } from "node:crypto";
import { hasAllQualifiers, mapQualificationStatus } from "./types.js";
import type { ConversationTurn, EventRow, InboundPayload, LeadRow, Listing,
  QualifierExtraction, QualifyPayload, SlotOption } from "./types.js";
import type { TelegramSentMessage } from "./telegram-api.js";

export type InboundDependencies = {
  hasBotToken: () => boolean;
  ownerChatId: () => string | undefined;
  allowOwnerAsProspect: () => boolean;
  readListings: () => Promise<Listing[]>;
  findLead: (contactKey: string) => Promise<LeadRow | null>;
  readLeads: () => Promise<LeadRow[]>;
  upsertLead: (lead: LeadRow) => Promise<void>;
  appendEvent: (event: EventRow) => Promise<void>;
  nextFollowUpIso: (daysFromNow: number, from?: Date) => string;
  proposeSlots: (args: { daysAhead?: number; count?: number }) => Promise<SlotOption[]>;
  formatSlotOptions: (slots: SlotOption[]) => string;
  slotIsFree: (slot: SlotOption) => Promise<boolean>;
  viewingEventId: (messageId: string) => string;
  requestViewing: (args: { slot: SlotOption; eventId: string; prospect: string;
    contactKey: string; listingId: string }) => Promise<void>;
  confirmViewing: (eventId: string) => Promise<void>;
  declineViewing: (eventId: string) => Promise<void>;
  sendTelegramText: (args: { chatId: string; text: string }) => Promise<TelegramSentMessage>;
  qualify: (payload: QualifyPayload) => Promise<{ reply: string; extraction: QualifierExtraction }>;
  now?: () => Date;
};

export function createInboundMessageHandler(deps: InboundDependencies) {
  const now = deps.now ?? (() => new Date());

  function blankLead(payload: InboundPayload): LeadRow {
    return {
      timestamp: payload.timestamp,
      prospect_name: payload.fromName ?? "",
      contact_key: payload.contactKey,
      channel: "telegram",
      telegram_chat_id: payload.chatId,
      telegram_username: payload.username ?? "",
      budget_ugx: "", area_preference: "", bedrooms: "", timeline: "", deal_type: "",
      qualification_status: "pending", lead_status: "cold", listing_id: "", notes: "",
      next_follow_up: "", first_inbound_at: payload.timestamp, last_inbound_at: payload.timestamp,
      last_outbound_at: "", last_message_id: "", conversation_history: "[]", proposed_slots: "[]",
      booking_status: "none", booking_code: "", calendar_event_id: "",
      follow_up_touch: 0, follow_up_sequence: "", follow_up_active: false,
      opted_out: false, needs_human: false, viewing_intent: false, selected_slot: "",
    };
  }

  function extractionFrom(row: LeadRow): QualifierExtraction {
    const budget = Number(row.budget_ugx);
    const bedrooms = Number(row.bedrooms);
    return {
      budget_ugx: row.budget_ugx && Number.isFinite(budget) ? budget : null,
      area_preference: row.area_preference || null,
      bedrooms: row.bedrooms && Number.isFinite(bedrooms) ? bedrooms : null,
      timeline: row.timeline || null,
      deal_type: row.deal_type || null,
      listing_id: row.listing_id || null,
      needs_booking: row.viewing_intent || row.booking_status === "proposed" ||
        row.booking_status === "requested" || row.booking_status === "confirmed",
      prospect_name: row.prospect_name || null,
    };
  }

  function historyFrom(row: LeadRow): ConversationTurn[] {
    try {
      const value: unknown = JSON.parse(row.conversation_history);
      return Array.isArray(value) ? value.filter((turn): turn is ConversationTurn =>
        typeof turn?.text === "string" && (turn.role === "prospect" || turn.role === "assistant")) : [];
    } catch { return []; }
  }

  function slotsFrom(row: LeadRow): SlotOption[] {
    try {
      const value: unknown = JSON.parse(row.proposed_slots);
      return Array.isArray(value) ? value.filter((slot): slot is SlotOption =>
        typeof slot?.start === "string" && typeof slot?.end === "string" &&
        typeof slot?.label === "string") : [];
    } catch { return []; }
  }

  function remember(row: LeadRow, turn: ConversationTurn): void {
    row.conversation_history = JSON.stringify([...historyFrom(row), turn].slice(-12));
  }

  function recordInbound(row: LeadRow, payload: InboundPayload): void {
    row.last_inbound_at = payload.timestamp;
    row.last_message_id = payload.messageId;
    if (payload.username) row.telegram_username = payload.username;
    if (payload.fromName) row.prospect_name = row.prospect_name || payload.fromName;
    remember(row, { role: "prospect", text: payload.text });
    if (row.follow_up_touch > 0) {
      row.follow_up_active = false;
      row.next_follow_up = "";
    } else if (row.booking_status !== "requested" && row.booking_status !== "confirmed") {
      row.follow_up_sequence = payload.messageId;
      row.follow_up_active = true;
      row.next_follow_up = deps.nextFollowUpIso(1, new Date(payload.timestamp));
    }
  }

  async function logInbound(payload: InboundPayload, kind: EventRow["kind"] = "prospect"): Promise<void> {
    await deps.appendEvent({ timestamp: payload.timestamp, contact_key: payload.contactKey, direction: "inbound",
      kind, message_id: payload.messageId, related_inbound_id: "" });
  }

  async function sendLogged(row: LeadRow | null, chatId: string, contactKey: string, text: string,
    inboundId: string, kind: EventRow["kind"] = "reply"): Promise<void> {
    const sent = await deps.sendTelegramText({ chatId, text });
    const sentAt = new Date(sent.date * 1000).toISOString();
    await deps.appendEvent({ timestamp: sentAt, contact_key: contactKey, direction: "outbound", kind,
      message_id: `telegram:${sent.chat.id}:${sent.message_id}`, related_inbound_id: inboundId });
    if (row) {
      row.last_outbound_at = sentAt;
      remember(row, { role: "assistant", text });
      await deps.upsertLead(row);
    }
  }

  async function sendCustomerDecision(row: LeadRow, text: string, inboundId: string): Promise<void> {
    const sent = await deps.sendTelegramText({ chatId: row.telegram_chat_id, text });
    const sentAt = new Date(sent.date * 1000).toISOString();
    await deps.appendEvent({ timestamp: sentAt, contact_key: row.contact_key, direction: "outbound", kind: "booking",
      message_id: `telegram:${sent.chat.id}:${sent.message_id}`, related_inbound_id: inboundId });
    row.last_outbound_at = sentAt;
    remember(row, { role: "assistant", text });
    await deps.upsertLead(row);
  }

  async function handleOwnerCommand(payload: InboundPayload): Promise<{ handled: boolean; result?: string }> {
    const match = payload.text.trim().match(/^\/(confirm|decline)(?:@[a-z0-9_]+)?(?:\s+([a-f0-9]{8}))?$/i);
    if (!match) return { handled: false };
    const owner = deps.ownerChatId();
    if (!owner) throw new Error("OWNER_TELEGRAM_CHAT_ID is not set");
    await logInbound(payload, "owner");
    if (payload.chatId !== owner) {
      await sendLogged(null, payload.chatId, payload.contactKey,
        "That command is reserved for the demo owner.", payload.messageId, "owner");
      return { handled: true, result: "unauthorized" };
    }
    if (!match[2]) {
      await sendLogged(null, owner, payload.contactKey,
        "Use /confirm <8-character code> or /decline <8-character code>.", payload.messageId, "owner");
      return { handled: true, result: "help" };
    }
    const lead = (await deps.readLeads()).find((row) => row.booking_code === match[2].toLowerCase());
    if (!lead || lead.booking_status !== "requested" || !lead.calendar_event_id) {
      await sendLogged(null, owner, payload.contactKey,
        "No pending viewing request matches that code.", payload.messageId, "owner");
      return { handled: true, result: "not_found" };
    }
    const slot = slotsFrom(lead).find((item) => item.start === lead.selected_slot);
    const label = slot?.label ?? "the selected time";
    if (match[1].toLowerCase() === "confirm") {
      await deps.confirmViewing(lead.calendar_event_id);
      lead.booking_status = "confirmed";
      lead.notes = `${lead.notes} | confirmed_at=${now().toISOString()…2108 tokens truncated…ion.deal_type ?? row.deal_type;
    row.listing_id = extraction.listing_id ?? row.listing_id;
    row.qualification_status = mapQualificationStatus(extraction);
    row.lead_status = hasAllQualifiers(extraction) ? "warm" : "cold";
    if (extraction.needs_booking) row.viewing_intent = true;

    let finalReply = reply;
    if (row.viewing_intent && hasAllQualifiers(extraction) && row.booking_status !== "requested" &&
        row.booking_status !== "confirmed") {
      const slots = await deps.proposeSlots({ daysAhead: 7, count: 3 });
      if (slots.length) {
        row.proposed_slots = JSON.stringify(slots);
        row.booking_status = "proposed";
        row.viewing_intent = false;
        finalReply += `\n\nAvailable viewing times (EAT):\n${deps.formatSlotOptions(slots)}\nReply 1, 2, or 3 to request one.`;
      } else {
        row.needs_human = true;
        row.viewing_intent = false;
        row.follow_up_active = false;
        row.next_follow_up = "";
        finalReply += "\n\nThe agent will contact you to arrange a viewing.";
      }
    }
    if (["proposed", "requested", "confirmed"].includes(row.booking_status)) row.lead_status = "hot";
    await deps.upsertLead(row);
    await sendLogged(row, row.telegram_chat_id, row.contact_key, finalReply, payload.messageId);
    return { lead_status: row.lead_status, qualification_status: row.qualification_status,
      booking_status: row.booking_status };
  };
}
