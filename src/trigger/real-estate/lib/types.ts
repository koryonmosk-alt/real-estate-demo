export type Listing = {
  listing_id: string; title: string; area: string; bedrooms: number; bathrooms: number;
  price_ugx: number; currency: string; property_type: string; status: string;
  listing_url: string; notes: string; photo_urls: string[]; deal_type?: "rent" | "sale" | "";
};

export type QualifierExtraction = {
  budget_ugx: number | null; area_preference: string | null; bedrooms: number | null;
  timeline: string | null; listing_id: string | null; needs_booking: boolean;
  prospect_name: string | null; deal_type: "rent" | "buy" | null;
};

export type LeadStatus = "hot" | "warm" | "cold";
export type QualificationStatus = "qualified" | "pending" | "disqualified";
export type BookingStatus = "none" | "proposed" | "requested" | "confirmed" | "declined";
export type SlotOption = { start: string; end: string; label: string };
export type ConversationTurn = { role: "prospect" | "assistant"; text: string };

export type LeadRow = {
  timestamp: string; prospect_name: string; contact_key: string; channel: "telegram";
  telegram_chat_id: string; telegram_username: string; budget_ugx: string;
  area_preference: string; bedrooms: string; timeline: string; deal_type: "rent" | "buy" | "";
  qualification_status: QualificationStatus; lead_status: LeadStatus;
  listing_id: string; notes: string; next_follow_up: string;
  first_inbound_at: string; last_inbound_at: string; last_outbound_at: string;
  last_message_id: string; conversation_history: string; proposed_slots: string;
  booking_status: BookingStatus; booking_code: string; calendar_event_id: string;
  follow_up_touch: number; follow_up_sequence: string; follow_up_active: boolean;
  opted_out: boolean; needs_human: boolean; viewing_intent: boolean;
  selected_slot: string;
};

export type EventRow = {
  timestamp: string; contact_key: string; direction: "inbound" | "outbound";
  kind: "prospect" | "reply" | "follow_up" | "booking" | "owner";
  message_id: string; related_inbound_id: string;
};

export type InboundPayload = {
  channel: "telegram"; contactKey: string; chatId: string; username?: string;
  fromName?: string; text: string; messageId: string; updateId: number; timestamp: string;
};

export type QualifyPayload = {
  contactKey: string; fromName?: string; text: string; messageId: string; timestamp: string;
  listings: Listing[]; history: ConversationTurn[]; existing: QualifierExtraction;
};

export type FollowUpPayload = { contactKey: string; touch: 1 | 2 | 3; sequence: string };

export function hasAllQualifiers(extraction: QualifierExtraction): boolean {
  return extraction.budget_ugx !== null && extraction.area_preference !== null &&
    extraction.bedrooms !== null && extraction.timeline !== null &&
    (extraction.deal_type === "rent" || extraction.deal_type === "buy");
}

export function mapQualificationStatus(extraction: QualifierExtraction): QualificationStatus {
  return hasAllQualifiers(extraction) ? "qualified" : "pending";
}
