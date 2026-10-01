import { TelegramApiError, type TelegramSentMessage } from "./telegram-api.js";
import type { EventRow, FollowUpPayload, LeadRow, Listing } from "./types.js";

export type FollowUpDependencies = {
  findLead: (contactKey: string) => Promise<LeadRow | null>;
  readEvents: () => Promise<EventRow[]>;
  readListings: () => Promise<Listing[]>;
  upsertLead: (lead: LeadRow) => Promise<void>;
  appendEvent: (event: EventRow) => Promise<void>;
  nextFollowUpIso: (daysFromNow: number, from?: Date) => string;
  sendTelegramText: (args: { chatId: string; text: string }) => Promise<TelegramSentMessage>;
  now?: () => Date;
};

function isEligible(row: LeadRow, now: Date): boolean {
  const due = Date.parse(row.next_follow_up);
  return row.follow_up_active && !row.opted_out && !row.needs_human &&
    row.booking_status !== "requested" && row.booking_status !== "confirmed" &&
    row.follow_up_touch < 3 && Number.isFinite(due) && due <= now.getTime();
}

export function createFollowUpHandler(deps: FollowUpDependencies) {
  const now = deps.now ?? (() => new Date());

  async function alternatives(row: LeadRow): Promise<[string, string]> {
    const listings = await deps.readListings();
    const available = listings.filter((item) => item.status === "available" && item.listing_id !== row.listing_id);
    const budget = Number(row.budget_ugx);
    const bedrooms = Number(row.bedrooms);
    const suitable = available.filter((item) =>
      (!row.budget_ugx || item.price_ugx <= budget) && (!row.bedrooms || item.bedrooms >= bedrooms));
    const preferred = suitable.filter((item) => !row.area_preference ||
      item.area.toLowerCase().includes(row.area_preference.toLowerCase()));
    const chosen = [...preferred, ...suitable.filter((item) => !preferred.includes(item))].slice(0, 2);
    const describe = (item: (typeof chosen)[number] | undefined) => item
      ? `${item.title} in ${item.area}, ${item.bedrooms}BR, ${item.price_ugx.toLocaleString("en-UG")} UGX`
      : "ask the agent for the newest listings";
    return [describe(chosen[0]), describe(chosen[1])];
  }

  async function advanceTouch(row: LeadRow, touch: 1 | 2 | 3, sentAt: string): Promise<void> {
    row.last_outbound_at = sentAt;
    row.follow_up_touch = touch;
    row.next_follow_up = touch === 3 ? "" : deps.nextFollowUpIso(touch === 1 ? 3 : 7,
      new Date(row.last_inbound_at));
    if (touch === 3) row.follow_up_active = false;
    await deps.upsertLead(row);
  }

  return async function sendFollowUpTouch(payload: FollowUpPayload) {
    const row = await deps.findLead(payload.contactKey);
    if (!row || !isEligible(row, now()) || row.follow_up_sequence !== payload.sequence ||
        row.follow_up_touch + 1 !== payload.touch) return { skipped: true as const };

    const eventId = `followup-${payload.sequence}-${payload.touch}`;
    const alreadySent = (await deps.readEvents()).find((event) => event.message_id === eventId);
    if (alreadySent) {
      await advanceTouch(row, payload.touch, alreadySent.timestamp);
      return { reconciled: true as const };
    }

    const name = row.prospect_name || "there";
    let message: string;
    if (payload.touch === 1) {
      message = `Hi ${name}, are you still looking for a property? Reply here and I can help with current listings.`;
    } else if (payload.touch === 2) {
      const choices = await alternatives(row);
      message = `Hi ${name}, a quick follow-up with some alternatives:\n1) ${choices[0]}\n2) ${choices[1]}\nReply if you'd like details.`;
    } else {
      message = `Hi ${name}, this is my last follow-up for now. Reply any time if you'd like to continue your property search.`;
    }

    let sent: TelegramSentMessage;
    try {
      sent = await deps.sendTelegramText({ chatId: row.telegram_chat_id, text: message });
    } catch (error) {
      if (error instanceof TelegramApiError && error.errorCode === 403) {
        row.follow_up_active = false;
        row.next_follow_up = "";
        row.notes = `${row.notes} | telegram_unreachable=${now().toISOString()}`;
        await deps.upsertLead(row);
        return { blocked: true as const, touch: payload.touch };
      }
      throw error;
    }
    const sentAt = new Date(sent.date * 1000).toISOString();
    await deps.appendEvent({ timestamp: sentAt, contact_key: row.contact_key, direction: "outbound", kind: "follow_up",
      message_id: eventId, related_inbound_id: row.follow_up_sequence });
    await advanceTouch(row, payload.touch, sentAt);
    return { sent: true as const, touch: payload.touch };
  };
}

export function createDailyFollowUpDispatcher(deps: {
  readLeads: () => Promise<LeadRow[]>;
  dispatch: (payload: FollowUpPayload, idempotencyKey: string) => Promise<unknown>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return async function dispatchDueFollowUps() {
    const leads = await deps.readLeads();
    let dispatched = 0;
    const date = now().toISOString().slice(0, 10);
    for (const row of leads) {
      if (!isEligible(row, now())) continue;
      const touch = (row.follow_up_touch + 1) as 1 | 2 | 3;
      const payload = { contactKey: row.contact_key, touch, sequence: row.follow_up_sequence };
      await deps.dispatch(payload,
        `followup-${row.contact_key}-${row.follow_up_sequence}-${touch}-${date}`);
      dispatched++;
    }
    return { checked: leads.length, dispatched };
  };
}
