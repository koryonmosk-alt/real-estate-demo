import { google } from "googleapis";
import { createHash } from "node:crypto";
import type { SlotOption } from "./types.js";

function requireCalendarEnv() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!email) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!key) throw new Error("GOOGLE_PRIVATE_KEY is not set");
  const calendarId = process.env.OWNER_CALENDAR_ID;
  if (!calendarId) throw new Error("OWNER_CALENDAR_ID is not set");
  return { email, key, calendarId };
}

function calendarClient() {
  const { email, key } = requireCalendarEnv();
  const privateKey = key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

export type Slot = SlotOption;

function kampalaDate(offsetDays: number): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const date = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date;
}

export async function proposeSlots(args: {
  daysAhead?: number;
  count?: number;
}): Promise<Slot[]> {
  const { calendarId } = requireCalendarEnv();
  const calendar = calendarClient();
  const now = new Date();
  const timeMin = now;
  const timeMax = new Date(kampalaDate((args.daysAhead ?? 7) + 1).getTime() - 3 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const busy: Array<{ start: number; end: number }> = [];
  for (const ev of res.data.items ?? []) {
    if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
    const s = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : ev.start?.date ? Date.parse(ev.start.date) : NaN;
    const e = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : ev.end?.date ? Date.parse(ev.end.date) : NaN;
    if (Number.isFinite(s) && Number.isFinite(e)) busy.push({ start: s, end: e });
  }

  const slots: Slot[] = [];
  const want = args.count ?? 3;
  const slotMs = 60 * 60 * 1000;
  const businessStartHour = 9;
  const businessEndHour = 17;

  for (let d = 1; d <= (args.daysAhead ?? 7) && slots.length < want; d++) {
    for (let h = businessStartHour; h + 1 <= businessEndHour && slots.length < want; h++) {
      const start = new Date(kampalaDate(d).getTime() + (h - 3) * 60 * 60 * 1000);
      const end = new Date(start.getTime() + slotMs);
      const s = start.getTime();
      const e = end.getTime();
      if (s < now.getTime()) continue;
      const overlaps = busy.some((b) => s < b.end && e > b.start);
      if (overlaps) continue;
      const label = start.toLocaleString("en-UG", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Africa/Kampala",
      });
      slots.push({ start: start.toISOString(), end: end.toISOString(), label });
    }
  }
  return slots;
}

export function formatSlotOptions(slots: Slot[]): string {
  return slots.map((s, i) => `${i + 1}. ${s.label} (EAT)`).join("\n");
}

export async function slotIsFree(slot: Slot): Promise<boolean> {
  const { calendarId } = requireCalendarEnv();
  const res = await calendarClient().events.list({ calendarId,
    timeMin: slot.start, timeMax: slot.end, singleEvents: true });
  return !(res.data.items ?? []).some((ev) => {
    if (ev.status === "cancelled" || ev.transparency === "transparent") return false;
    const start = Date.parse(ev.start?.dateTime ?? ev.start?.date ?? "");
    const end = Date.parse(ev.end?.dateTime ?? ev.end?.date ?? "");
    return Number.isFinite(start) && Number.isFinite(end) &&
      Date.parse(slot.start) < end && Date.parse(slot.end) > start;
  });
}

export function viewingEventId(messageId: string): string {
  return `v${createHash("sha256").update(messageId).digest("hex").slice(0, 30)}`;
}

export async function requestViewing(args: { slot: Slot; eventId: string; prospect: string;
  contactKey: string; listingId: string }): Promise<void> {
  const { calendarId } = requireCalendarEnv();
  if (!(await slotIsFree(args.slot))) throw new Error("The selected slot is no longer available");
  try {
    await calendarClient().events.insert({ calendarId, requestBody: {
      id: args.eventId, summary: `Viewing request — ${args.prospect || args.contactKey}`,
      description: `Awaiting agent confirmation. Telegram contact: ${args.contactKey}. Listing: ${args.listingId || "unspecified"}.`,
      start: { dateTime: args.slot.start, timeZone: "Africa/Kampala" },
      end: { dateTime: args.slot.end, timeZone: "Africa/Kampala" },
      transparency: "opaque", status: "tentative",
    } });
  } catch (err) {
    if ((err as { code?: number }).code === 409) return; // same inbound message retry
    throw err;
  }
}

export async function confirmViewing(eventId: string): Promise<void> {
  const { calendarId } = requireCalendarEnv();
  await calendarClient().events.patch({ calendarId, eventId, requestBody: {
    status: "confirmed", summary: "Confirmed property viewing",
  } });
}

export async function declineViewing(eventId: string): Promise<void> {
  const { calendarId } = requireCalendarEnv();
  await calendarClient().events.delete({ calendarId, eventId });
}
