import { google } from "googleapis";
import type { EventRow, LeadRow, Listing } from "./types.js";

function requireSheetEnv() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!email) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!key) throw new Error("GOOGLE_PRIVATE_KEY is not set");
  return { email, key };
}

function sheetsClient() {
  const { email, key } = requireSheetEnv();
  const privateKey = key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export const LEAD_HEADER = [
  "timestamp",
  "prospect_name",
  "contact_key",
  "channel",
  "telegram_chat_id",
  "telegram_username",
  "budget_ugx",
  "area_preference",
  "bedrooms",
  "timeline",
  "qualification_status",
  "lead_status",
  "listing_id",
  "notes",
  "next_follow_up",
  "first_inbound_at", "last_inbound_at", "last_outbound_at", "last_message_id",
  "conversation_history", "proposed_slots", "booking_status", "booking_code",
  "calendar_event_id", "follow_up_touch", "follow_up_sequence", "follow_up_active",
  "opted_out", "needs_human", "viewing_intent", "selected_slot", "deal_type",
] as const;

const EVENT_HEADER = ["timestamp", "contact_key", "direction", "kind", "message_id", "related_inbound_id"] as const;
const STATE_HEADER = ["key", "value"] as const;

function leadTab(): string { return process.env.TELEGRAM_LEADS_TAB || "TelegramLeads"; }
function eventTab(): string { return process.env.TELEGRAM_EVENTS_TAB || "TelegramEvents"; }
function stateTab(): string { return process.env.TELEGRAM_STATE_TAB || "TelegramState"; }

function range(tab: string, cells: string): string {
  return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

function columnName(index: number): string {
  let n = index;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function leadSheetId(): string {
  const id = process.env.LEAD_SHEET_ID;
  if (!id) throw new Error("LEAD_SHEET_ID is not set");
  return id;
}

function listingsSheetId(): string {
  const id = process.env.LISTINGS_SHEET_ID;
  if (!id) throw new Error("LISTINGS_SHEET_ID is not set");
  return id;
}

export async function readListings(): Promise<Listing[]> {
  const sheets = sheetsClient();
  const id = listingsSheetId();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Sheet1!A1:M1000",
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];
  const header = rows[0] as string[];
  const idx = (name: string) => header.indexOf(name);
  const out: Listing[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] as string[];
    if (!r[idx("listing_id")]?.trim()) continue;
    const price = Number(String(r[idx("price_ugx")] ?? "").replace(/[^0-9]/g, ""));
    out.push({
      listing_id: r[idx("listing_id")] ?? "",
      title: r[idx("title")] ?? "",
      area: r[idx("area")] ?? "",
      bedrooms: Number(r[idx("bedrooms")] ?? 0) || 0,
      bathrooms: Number(r[idx("bathrooms")] ?? 0) || 0,
      price_ugx: Number.isFinite(price) ? price : 0,
      currency: r[idx("currency")] ?? "UGX",
      property_type: r[idx("property_type")] ?? "",
      status: r[idx("status")] ?? "available",
      listing_url: r[idx("listing_url")] ?? "",
      notes: r[idx("notes")] ?? "",
      photo_urls: (r[idx("photo_urls")] ?? "").split(";").map((s) => s.trim()).filter(Boolean),
      deal_type: r[idx("deal_type")] === "rent" || r[idx("deal_type")] === "sale"
        ? r[idx("deal_type")] as "rent" | "sale" : "",
    });
  }
  return out;
}

async function ensureTab(tab: string): Promise<void> {
  const sheets = sheetsClient();
  const spreadsheetId = leadSheetId();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title))" });
  if (!(meta.data.sheets ?? []).some((sheet) => sheet.properties?.title === tab)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: {
      requests: [{ addSheet: { properties: { title: tab } } }],
    } });
  }
}

function serializeLead(row: LeadRow): string[] {
  return LEAD_HEADER.map((key) => String(row[key] ?? ""));
}

function parseLead(row: string[], header: string[]): LeadRow {
  const get = (name: string) => row[header.indexOf(name)] ?? "";
  return {
    timestamp: get("timestamp"), prospect_name: get("prospect_name"), contact_key: get("contact_key"),
    channel: "telegram", telegram_chat_id: get("telegram_chat_id"),
    telegram_username: get("telegram_username"),
    budget_ugx: get("budget_ugx"), area_preference: get("area_preference"),
    bedrooms: get("bedrooms"), timeline: get("timeline"),
    deal_type: (get("deal_type") === "rent" || get("deal_type") === "buy"
      ? get("deal_type") as "rent" | "buy" : ""),
    qualification_status: (get("qualification_status") || "pending") as LeadRow["qualification_status"],
    lead_status: (get("lead_status") || "cold") as LeadRow["lead_status"],
    listing_id: get("listing_id"), notes: get("notes"), next_follow_up: get("next_follow_up"),
    first_inbound_at: get("first_inbound_at") || get("timestamp"),
    last_inbound_at: get("last_inbound_at") || get("timestamp"),
    last_outbound_at: get("last_outbound_at"), last_message_id: get("last_message_id"),
    conversation_history: get("conversation_history") || "[]", proposed_slots: get("proposed_slots") || "[]",
    booking_status: (get("booking_status") || "none") as LeadRow["booking_status"],
    booking_code: get("booking_code"), calendar_event_id: get("calendar_event_id"),
    follow_up_touch: Number(get("follow_up_touch")) || 0,
    follow_up_sequence: get("follow_up_sequence"), follow_up_active: get("follow_up_active") === "true",
    opted_out: get("opted_out") === "true", needs_human: get("needs_human") === "true",
    viewing_intent: get("viewing_intent") === "true", selected_slot: get("selected_slot"),
  };
}

async function readLeadGrid(): Promise<string[][]> {
  const sheets = sheetsClient();
  const id = leadSheetId();
  const tab = leadTab();
  await ensureTab(tab);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: range(tab, "A1:AZ10000"),
  });
  return (res.data.values ?? []) as string[][];
}

async function ensureLeadHeader(grid: string[][]): Promise<void> {
  const current = grid[0] ?? [];
  if (current.length && current.some((value, index) => value !== LEAD_HEADER[index])) {
    throw new Error(`${leadTab()} headers differ from the Telegram lead schema; see telegramsetup.md`);
  }
  if (current.length === LEAD_HEADER.length) return;
  await sheetsClient().spreadsheets.values.update({
    spreadsheetId: leadSheetId(),
    range: range(leadTab(), `A1:${columnName(LEAD_HEADER.length)}1`), valueInputOption: "RAW",
    requestBody: { values: [[...LEAD_HEADER]] },
  });
}

export async function readLeads(): Promise<LeadRow[]> {
  const grid = await readLeadGrid();
  if (!grid.length) return [];
  return grid.slice(1).filter((row) => !!row[2]?.trim()).map((row) => parseLead(row, grid[0]));
}

export async function findLead(contactKey: string): Promise<LeadRow | null> {
  return (await readLeads()).find((row) => row.contact_key === contactKey) ?? null;
}

export async function upsertLead(lead: LeadRow): Promise<void> {
  const grid = await readLeadGrid();
  await ensureLeadHeader(grid);
  const index = grid.findIndex((row, i) => i > 0 && row[2] === lead.contact_key);
  const sheets = sheetsClient();
  if (index < 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: leadSheetId(), range: range(leadTab(), "A:AZ"), valueInputOption: "RAW",
      requestBody: { values: [serializeLead(lead)] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: leadSheetId(),
      range: range(leadTab(), `A${index + 1}:${columnName(LEAD_HEADER.length)}${index + 1}`),
      valueInputOption: "RAW", requestBody: { values: [serializeLead(lead)] },
    });
  }
}

async function ensureEventsTab(): Promise<void> {
  const sheets = sheetsClient();
  const spreadsheetId = leadSheetId();
  const tab = eventTab();
  await ensureTab(tab);
  const header = await sheets.spreadsheets.values.get({ spreadsheetId, range: range(tab, "A1:F1") });
  const current = (header.data.values?.[0] ?? []) as string[];
  if (current.length && current.some((value, index) => value !== EVENT_HEADER[index])) {
    throw new Error(`${tab} headers differ from the Telegram event schema; see telegramsetup.md`);
  }
  if (current.length !== EVENT_HEADER.length) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: range(tab, "A1:F1"),
      valueInputOption: "RAW", requestBody: { values: [[...EVENT_HEADER]] } });
  }
}

export async function readEvents(): Promise<EventRow[]> {
  await ensureEventsTab();
  const res = await sheetsClient().spreadsheets.values.get({
    spreadsheetId: leadSheetId(), range: range(eventTab(), "A2:F10000"),
  });
  return ((res.data.values ?? []) as string[][]).map((r) => ({
    timestamp: r[0] ?? "", contact_key: r[1] ?? "", direction: r[2] as EventRow["direction"],
    kind: r[3] as EventRow["kind"], message_id: r[4] ?? "", related_inbound_id: r[5] ?? "",
  }));
}

export async function appendEvent(event: EventRow): Promise<void> {
  await ensureEventsTab();
  const existing = await readEvents();
  if (existing.some((row) => row.message_id === event.message_id && row.direction === event.direction)) return;
  await sheetsClient().spreadsheets.values.append({
    spreadsheetId: leadSheetId(), range: range(eventTab(), "A:F"), valueInputOption: "RAW",
    requestBody: { values: [[event.timestamp, event.contact_key, event.direction, event.kind,
      event.message_id, event.related_inbound_id]] },
  });
}

export async function readTelegramUpdateOffset(): Promise<number | null> {
  const sheets = sheetsClient();
  const spreadsheetId = leadSheetId();
  const tab = stateTab();
  await ensureTab(tab);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: range(tab, "A1:B2") });
  const rows = (res.data.values ?? []) as string[][];
  const header = rows[0] ?? [];
  if (header.length && (header[0] !== STATE_HEADER[0] || header[1] !== STATE_HEADER[1])) {
    throw new Error(`${tab} headers differ from the Telegram state schema; see telegramsetup.md`);
  }
  if (!header.length) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: range(tab, "A1:B1"),
      valueInputOption: "RAW", requestBody: { values: [[...STATE_HEADER]] } });
  }
  const row = rows.find((item, index) => index > 0 && item[0] === "update_offset");
  const offset = Number(row?.[1]);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

export async function writeTelegramUpdateOffset(offset: number): Promise<void> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Telegram update offset");
  const sheets = sheetsClient();
  const spreadsheetId = leadSheetId();
  const tab = stateTab();
  await ensureTab(tab);
  await sheets.spreadsheets.values.update({ spreadsheetId, range: range(tab, "A2:B2"),
    valueInputOption: "RAW", requestBody: { values: [["update_offset", String(offset)]] } });
}

export function nextFollowUpIso(daysFromNow: number, from = new Date()): string {
  const date = new Date(from);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const midnightUtc = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00.000Z`);
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() + daysFromNow);
  return new Date(midnightUtc.getTime() + 6 * 60 * 60 * 1000).toISOString(); // 09:00 EAT
}
