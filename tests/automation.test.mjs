import test from "node:test";
import assert from "node:assert/strict";
import { pollTelegramUpdates } from "../dist/src/trigger/real-estate/lib/telegram-polling.js";
import { createInboundMessageHandler } from "../dist/src/trigger/real-estate/lib/inbound-handler.js";
import { createFollowUpHandler, createDailyFollowUpDispatcher } from "../dist/src/trigger/real-estate/lib/follow-up-handler.js";
import { createNightlyMissedAudit } from "../dist/src/trigger/real-estate/lib/missed-audit.js";
import { createQualifyLeadHandler } from "../dist/src/trigger/real-estate/lib/qualify-handler.js";
import { TelegramApiError } from "../dist/src/trigger/real-estate/lib/telegram-api.js";

const privateMessage = (updateId, messageId, text, overrides = {}) => ({
  update_id: updateId,
  message: {
    message_id: messageId,
    date: 1790000000,
    text,
    chat: { id: 445566, type: "private", first_name: "Alex" },
    from: { id: 445566, is_bot: false, first_name: "Alex", username: "alex_demo" },
    ...overrides,
  },
});

function pollerDeps(overrides = {}) {
  const calls = { updates: [], inbound: [], offsets: [] };
  return {
    calls,
    readOffset: async () => 12,
    getWebhookInfo: async () => ({ url: "" }),
    getUpdates: async () => [],
    enqueueInbound: async (payload, idempotencyKey) => calls.inbound.push({ payload, idempotencyKey }),
    writeOffset: async (offset) => calls.offsets.push(offset),
    ...overrides,
  };
}

test("poller refuses to consume updates while a Telegram webhook is configured", async () => {
  const deps = pollerDeps({ getWebhookInfo: async () => ({ url: "https://example.test/webhook" }) });

  await assert.rejects(pollTelegramUpdates(deps), /Telegram webhook is configured/);
  assert.deepEqual(deps.calls.inbound, []);
  assert.deepEqual(deps.calls.offsets, []);
});

test("poller queues only private human text and persists the next update offset", async () => {
  const updates = [
    privateMessage(501, 41, "Is the Kisaasi home available?"),
    privateMessage(502, 42, "ignore group", { chat: { id: -77, type: "group" } }),
    privateMessage(503, 43, "ignore bot", { from: { id: 99, is_bot: true } }),
    privateMessage(504, 44, undefined),
  ];
  const deps = pollerDeps({
    getUpdates: async () => updates,
  });

  const result = await pollTelegramUpdates(deps);

  assert.equal(result.received, 4);
  assert.equal(result.queued, 1);
  assert.equal(result.ignored, 3);
  assert.equal(result.offset, 505);
  assert.equal(deps.calls.inbound[0].payload.contactKey, "telegram:445566");
  assert.equal(deps.calls.inbound[0].payload.messageId, "telegram:445566:41");
  assert.equal(deps.calls.inbound[0].idempotencyKey, "telegram-update-501");
  assert.deepEqual(deps.calls.offsets, [505]);
});

test("poller leaves the stored offset unchanged when enqueueing an update fails", async () => {
  const deps = pollerDeps({
    getUpdates: async () => [privateMessage(501, 41, "Hello")],
    enqueueInbound: async () => { throw new Error("Trigger enqueue unavailable"); },
  });

  await assert.rejects(pollTelegramUpdates(deps), /Trigger enqueue unavailable/);
  assert.deepEqual(deps.calls.offsets, []);
});

function automationFixture({ allowOwnerAsProspect = false, listings = [{ listing_id: "KISAASI-1", title: "Green Court", area: "Kisaasi",
  bedrooms: 3, bathrooms: 2, price_ugx: 2500000, currency: "UGX", property_type: "Apartment",
  status: "available", listing_url: "", notes: "", photo_urls: [], deal_type: "rent" }] } = {}) {
  const fixedNow = new Date("2026-09-29T10:00:00.000Z");
  const slot = { start: "2026-10-02T07:00:00.000Z", end: "2026-10-02T08:00:00.000Z", label: "Fri, Oct 2 at 10:00 AM" };
  const state = { leads: new Map(), events: [], calendar: new Map(), sent: [], qualifications: [], inboundNo: 0 };
  let outboundNo = 0;
  const deps = {
    hasBotToken: () => true,
    ownerChatId: () => "owner-100",
    allowOwnerAsProspect: () => allowOwnerAsProspect,
    readListings: async () => listings,
    findLead: async (key) => state.leads.get(key) ?? null,
    readLeads: async () => [...state.leads.values()],
    upsertLead: async (row) => state.leads.set(row.contact_key, structuredClone(row)),
    appendEvent: async (event) => {
      if (!state.events.some((saved) => saved.direction === event.direction && saved.message_id === event.message_id)) {
        state.events.push(structuredClone(event));
      }
    },
    nextFollowUpIso: (days, from) => new Date(from.getTime() + days * 86400000).toISOString(),
    proposeSlots: async () => [slot, { ...slot, start: "2026-10-02T08:00:00.000Z", end: "2026-10-02T09:00:00.000Z", label: "Fri, Oct 2 at 11:00 AM" },
      { ...slot, start: "2026-10-02T09:00:00.000Z", end: "2026-10-02T10:00:00.000Z", label: "Fri, Oct 2 at 12:00 PM" }],
    formatSlotOptions: (slots) => slots.map((item, index) => `${index + 1}) ${item.label}`).join("\n"),
    slotIsFree: async (candidate) => ![...state.calendar.values()].some((event) =>
      event.status !== "cancelled" && Date.parse(candidate.start) < Date.parse(event.end) &&
      Date.parse(candidate.end) > Date.parse(event.start)),
    viewingEventId: (messageId) => `event-${messageId}`,
    requestViewing: async ({ slot: requestedSlot, eventId, prospect, contactKey, listingId }) => {
      if ([...state.calendar.values()].some((event) => event.status !== "cancelled" &&
          Date.parse(requestedSlot.start) < Date.parse(event.end) && Date.parse(requestedSlot.end) > Date.parse(event.start))) {
        throw new Error("The selected slot is no longer available");
      }
      state.calendar.set(eventId, { ...requestedSlot, prospect, contactKey, listingId, status: "tentative" });
    },
    confirmViewing: async (eventId) => { state.calendar.get(eventId).status = "confirmed"; },
    declineViewing: async (eventId) => { state.calendar.get(eventId).status = "cancelled"; },
    sendTelegramText: async ({ chatId, text }) => {
      const sent = { chat: { id: Number(chatId.replace(/\D/g, "")) || 1 }, message_id: ++outboundNo,
        date: Math.floor(fixedNow.getTime() / 1000), text };
      state.sent.push({ chatId, text });
      return sent;
    },
    qualify: async (payload) => {
      state.qualifications.push(structuredClone(payload));
      const needsBooking = /viewing|book/i.test(payload.text);
      return {
        reply: needsBooking ? "I can arrange a viewing." : "Green Court matches. What time would you like to view it?",
        extraction: { ...payload.existing, budget_ugx: 2500000, area_preference: "Kisaasi", bedrooms: 3,
          timeline: "within 2 weeks", deal_type: "rent", listing_id: "KISAASI-1", needs_booking: needsBooking,
          prospect_name: payload.existing.prospect_name ?? payload.fromName ?? "Sam" },
      };
    },
    now: () => fixedNow,
  };
  const handle = createInboundMessageHandler(deps);
  const message = (chatId, text, fromName = "Sam") => {
    const n = ++state.inboundNo;
    return { channel: "telegram", contactKey: `telegram:${chatId}`, chatId, username: fromName.toLowerCase(),
      fromName, text, messageId: `telegram:${chatId}:${n}`, updateId: n,
      timestamp: new Date(fixedNow.getTime() + n * 60000).toISOString() };
  };
  return { deps, handle, message, state, slot };
}

test("the owner chat can act as a prospect only when the demo override is enabled", async () => {
  const normal = automationFixture();
  const normalResult = await normal.handle(normal.message("owner-100", "I need a 2 bedroom home in Kisaasi"));
  assert.deepEqual(normalResult, { owner_help: true });
  assert.equal(normal.state.leads.size, 0);

  const demo = automationFixture({ allowOwnerAsProspect: true });
  const demoResult = await demo.handle(demo.message("owner-100", "I need a 2 bedroom home in Kisaasi"));
  assert.equal(demoResult.owner_help, undefined);
  assert.equal(demo.state.leads.get("telegram:owner-100").area_preference, "Kisaasi");
  assert.equal(demo.state.sent.at(-1).chatId, "owner-100");
});

test("a prospect can qualify, request a viewing, and receive the owner's Calendar confirmation", async () => {
  const { handle, message, state, slot } = automationFixture();

  await handle(message("prospect-200", "/start"));
  const first = message("prospect-200", "I need a 3 bedroom home in Kisaasi for about 2.5m within two weeks");
  await handle(first);
  const second = message("prospect-200", "Can I book a viewing?");
  await handle(second);

  let lead = state.leads.get("telegram:prospect-200");
  assert.equal(state.leads.size, 1);
  assert.equal(lead.budget_ugx, "2500000");
  assert.equal(lead.qualification_status, "qualified");
  assert.equal(lead.booking_status, "proposed");
  assert.match(state.sent.at(-1).text, /Reply 1, 2, or 3/);
  assert.deepEqual(state.qualifications[1].history.map((turn) => turn.role),
    ["prospect", "assistant", "prospect", "assistant"]);

  const selection = message("prospect-200", "1");
  await handle(selection);
  lead = state.leads.get("telegram:prospect-200");
  assert.equal(lead.booking_status, "requested");
  assert.equal(lead.follow_up_active, false);
  assert.equal(state.calendar.get(lead.calendar_event_id).status, "tentative");
  assert.equal(state.calendar.get(lead.calendar_event_id).start, slot.start);
  assert.match(state.sent.at(-1).text, new RegExp(`/confirm ${lead.booking_code}`));

  const eventsBeforeDuplicate = state.events.length;
  assert.deepEqual(await handle(selection), { duplicate: true });
  assert.equal(state.events.length, eventsBeforeDuplicate);

  await handle(message("owner-100", `/confirm ${lead.booking_code}`, "Owner"));
  lead = state.leads.get("telegram:prospect-200");
  assert.equal(lead.booking_status, "confirmed");
  assert.equal(state.calendar.get(lead.calendar_event_id).status, "confirmed");
  assert.ok(state.sent.some((item) => item.chatId === "prospect-200" && /viewing.*confirmed/i.test(item.text)));
});

test("a stopped prospect is opted out and later messages do not call AI", async () => {
  const { handle, message, state } = automationFixture();
  await handle(message("prospect-201", "/start"));
  await handle(message("prospect-201", "/stop"));

  const lead = state.leads.get("telegram:prospect-201");
  assert.equal(lead.opted_out, true);
  assert.equal(lead.follow_up_active, false);
  const qualificationCount = state.qualifications.length;

  await handle(message("prospect-201", "Actually, show me homes"));
  assert.equal(state.qualifications.length, qualificationCount);
  assert.equal(state.leads.get("telegram:prospect-201").opted_out, true);

  await handle(message("prospect-201", "/resume"));
  assert.equal(state.leads.get("telegram:prospect-201").opted_out, false);
});

test("a qualified request with no listings is routed to a human without calling AI", async () => {
  const fixture = automationFixture({ listings: [] });

  assert.deepEqual(await fixture.handle(fixture.message("prospect-208", "Hello, do you have homes?")),
    { needs_human: true });
  const lead = fixture.state.leads.get("telegram:prospect-208");
  assert.equal(lead.needs_human, true);
  assert.equal(lead.follow_up_active, false);
  assert.equal(fixture.state.qualifications.length, 0);
  assert.match(fixture.state.sent.at(-1).text, /latest property details right now/);
});

test("a lead resumes normal handling after the listings sheet becomes readable", async () => {
  const fixture = automationFixture();
  const readListings = fixture.deps.readListings;
  fixture.deps.readListings = async () => { throw new Error("The caller does not have permission"); };

  await fixture.handle(fixture.message("prospect-209", "I need a 1 bedroom rental in Kampala"));
  let lead = fixture.state.leads.get("telegram:prospect-209");
  assert.equal(lead.needs_human, true);
  assert.equal(lead.follow_up_active, false);

  fixture.deps.readListings = readListings;
  await fixture.handle(fixture.message("prospect-209", "My budget is 300k UGX, moving next month"));

  lead = fixture.state.leads.get("telegram:prospect-209");
  assert.equal(fixture.state.qualifications.length, 1);
  assert.equal(lead.needs_human, false);
  assert.equal(lead.follow_up_active, true);
  assert.doesNotMatch(fixture.state.sent.at(-1).text, /latest property details right now/);
});

test("owner confirmation commands from another chat cannot change a viewing", async () => {
  const { handle, message, state } = automationFixture();
  await handle(message("prospect-202", "/start"));
  const inquiry = message("prospect-202", "I need a 3 bedroom home in Kisaasi for 2.5m within two weeks");
  await handle(inquiry);
  await handle(message("prospect-202", "I want to book a viewing"));
  await handle(message("prospect-202", "1"));
  const requested = state.leads.get("telegram:prospect-202");

  await handle(message("intruder-999", `/confirm ${requested.booking_code}`, "Someone"));
  assert.equal(state.leads.get("telegram:prospect-202").booking_status, "requested");
  assert.equal(state.calendar.get(requested.calendar_event_id).status, "tentative");
  assert.match(state.sent.at(-1).text, /reserved for the demo owner/);
});

test("an owner can decline a viewing and the prospect receives the decision", async () => {
  const { handle, message, state } = automationFixture();
  await handle(message("prospect-209", "I need a 3 bedroom home in Kisaasi for about 2.5m within two weeks"));
  await handle(message("prospect-209", "Can I book a viewing?"));
  await handle(message("prospect-209", "1"));
  const requested = state.leads.get("telegram:prospect-209");

  await handle(message("owner-100", `/decline ${requested.booking_code}`, "Owner"));

  const declined = state.leads.get("telegram:prospect-209");
  assert.equal(declined.booking_status, "declined");
  assert.equal(state.calendar.get(declined.calendar_event_id).status, "cancelled");
  assert.ok(state.sent.some((item) => item.chatId === "prospect-209" && /unavailable/i.test(item.text)));
});

test("a due follow-up is sent once, logged, and advances to the next touch", async () => {
  const fixture = automationFixture();
  await fixture.handle(fixture.message("prospect-203", "I need a 3 bedroom home in Kisaasi for 2.5m within two weeks"));
  const lead = fixture.state.leads.get("telegram:prospect-203");
  lead.next_follow_up = "2026-09-29T09:00:00.000Z";
  lead.last_inbound_at = "2026-09-26T10:00:00.000Z";
  lead.follow_up_sequence = "sequence-203";
  lead.follow_up_touch = 0;
  await fixture.deps.upsertLead(lead);
  const runFollowUp = createFollowUpHandler({
    findLead: fixture.deps.findLead,
    readEvents: async () => fixture.state.events,
    readListings: fixture.deps.readListings,
    upsertLead: fixture.deps.upsertLead,
    appendEvent: fixture.deps.appendEvent,
    nextFollowUpIso: fixture.deps.nextFollowUpIso,
    sendTelegramText: fixture.deps.sendTelegramText,
    now: fixture.deps.now,
  });
  const payload = { contactKey: lead.contact_key, touch: 1, sequence: "sequence-203" };

  assert.deepEqual(await runFollowUp(payload), { sent: true, touch: 1 });
  const updated = fixture.state.leads.get(lead.contact_key);
  assert.equal(updated.follow_up_touch, 1);
  assert.equal(updated.follow_up_active, true);
  assert.equal(updated.next_follow_up, "2026-09-29T10:00:00.000Z");
  assert.ok(fixture.state.events.some((event) => event.message_id === "followup-sequence-203-1"));
  const sends = fixture.state.sent.length;

  assert.deepEqual(await runFollowUp(payload), { skipped: true });
  assert.equal(fixture.state.sent.length, sends);
});

test("the three-touch follow-up sequence ends after its final message", async () => {
  const fixture = automationFixture();
  await fixture.handle(fixture.message("prospect-210", "I need a 3 bedroom home in Kisaasi for 2.5m within two weeks"));
  const lead = fixture.state.leads.get("telegram:prospect-210");
  lead.last_inbound_at = "2026-09-26T10:00:00.000Z";
  lead.follow_up_sequence = "sequence-210";
  lead.next_follow_up = "2026-09-29T09:00:00.000Z";
  await fixture.deps.upsertLead(lead);
  const runFollowUp = createFollowUpHandler({
    findLead: fixture.deps.findLead,
    readEvents: async () => fixture.state.events,
    readListings: fixture.deps.readListings,
    upsertLead: fixture.deps.upsertLead,
    appendEvent: fixture.deps.appendEvent,
    nextFollowUpIso: fixture.deps.nextFollowUpIso,
    sendTelegramText: fixture.deps.sendTelegramText,
    now: fixture.deps.now,
  });

  await runFollowUp({ contactKey: lead.contact_key, touch: 1, sequence: "sequence-210" });
  let updated = fixture.state.leads.get(lead.contact_key);
  updated.next_follow_up = "2026-09-29T09:00:00.000Z";
  await fixture.deps.upsertLead(updated);
  await runFollowUp({ contactKey: lead.contact_key, touch: 2, sequence: "sequence-210" });
  assert.match(fixture.state.sent.at(-1).text, /alternatives/);
  updated = fixture.state.leads.get(lead.contact_key);
  updated.next_follow_up = "2026-09-29T09:00:00.000Z";
  await fixture.deps.upsertLead(updated);
  await runFollowUp({ contactKey: lead.contact_key, touch: 3, sequence: "sequence-210" });

  updated = fixture.state.leads.get(lead.contact_key);
  assert.equal(updated.follow_up_touch, 3);
  assert.equal(updated.follow_up_active, false);
  assert.equal(updated.next_follow_up, "");
  assert.match(fixture.state.sent.at(-1).text, /last follow-up/);
});

test("a blocked Telegram chat is removed from follow-up eligibility without advancing the touch", async () => {
  const fixture = automationFixture();
  await fixture.handle(fixture.message("prospect-204", "I need a 3 bedroom home in Kisaasi for 2.5m within two weeks"));
  const lead = fixture.state.leads.get("telegram:prospect-204");
  lead.next_follow_up = "2026-09-29T09:00:00.000Z";
  lead.last_inbound_at = "2026-09-26T10:00:00.000Z";
  lead.follow_up_sequence = "sequence-204";
  await fixture.deps.upsertLead(lead);
  const runFollowUp = createFollowUpHandler({
    findLead: fixture.deps.findLead,
    readEvents: async () => fixture.state.events,
    readListings: fixture.deps.readListings,
    upsertLead: fixture.deps.upsertLead,
    appendEvent: fixture.deps.appendEvent,
    nextFollowUpIso: fixture.deps.nextFollowUpIso,
    sendTelegramText: async () => { throw new TelegramApiError("blocked", 403); },
    now: fixture.deps.now,
  });

  assert.deepEqual(await runFollowUp({ contactKey: lead.contact_key, touch: 1, sequence: "sequence-204" }),
    { blocked: true, touch: 1 });
  const updated = fixture.state.leads.get(lead.contact_key);
  assert.equal(updated.follow_up_active, false);
  assert.equal(updated.follow_up_touch, 0);
  assert.equal(updated.next_follow_up, "");
});

test("daily dispatch selects only due, active, non-opted-out follow-ups", async () => {
  const fixture = automationFixture();
  await fixture.handle(fixture.message("prospect-205", "I need a 3 bedroom home in Kisaasi for 2.5m within two weeks"));
  const base = fixture.state.leads.get("telegram:prospect-205");
  const makeRow = (key, extra = {}) => ({ ...base, contact_key: `telegram:${key}`, follow_up_sequence: `seq-${key}`,
    follow_up_active: true, opted_out: false, needs_human: false, booking_status: "none", follow_up_touch: 0,
    next_follow_up: "2026-09-29T09:00:00.000Z", ...extra });
  const rows = [makeRow("due"), makeRow("future", { next_follow_up: "2026-09-30T09:00:00.000Z" }),
    makeRow("opted", { opted_out: true }), makeRow("human", { needs_human: true }),
    makeRow("booked", { booking_status: "requested" })];
  const dispatched = [];
  const dispatchDue = createDailyFollowUpDispatcher({ readLeads: async () => rows,
    dispatch: async (payload, idempotencyKey) => dispatched.push({ payload, idempotencyKey }),
    now: fixture.deps.now });

  assert.deepEqual(await dispatchDue(), { checked: 5, dispatched: 1 });
  assert.equal(dispatched[0].payload.contactKey, "telegram:due");
  assert.equal(dispatched[0].payload.touch, 1);
  assert.match(dispatched[0].idempotencyKey, /seq-due-1/);
});

test("nightly audit applies the reply SLA and does not count a future reply as already sent", async () => {
  const now = new Date("2026-09-29T19:00:00.000Z");
  const inbound = (id, key, timestamp) => ({ timestamp, contact_key: key, direction: "inbound",
    kind: "prospect", message_id: id, related_inbound_id: "" });
  const outbound = (id, key, timestamp, related) => ({ timestamp, contact_key: key, direction: "outbound",
    kind: "reply", message_id: `out-${id}`, related_inbound_id: related });
  const events = [
    inbound("in-1", "telegram:timely", "2026-09-29T08:00:00.000Z"),
    outbound("1", "telegram:timely", "2026-09-29T08:15:00.000Z", "in-1"),
    inbound("in-2", "telegram:late", "2026-09-29T09:00:00.000Z"),
    outbound("2", "telegram:late", "2026-09-29T10:00:00.000Z", "in-2"),
    inbound("in-3", "telegram:future", "2026-09-29T10:00:00.000Z"),
    outbound("3", "telegram:future", "2026-09-29T20:00:00.000Z", "in-3"),
    inbound("in-4", "telegram:fresh", "2026-09-29T18:45:00.000Z"),
  ];
  const leads = [
    { contact_key: "telegram:timely", qualification_status: "qualified", booking_status: "requested" },
    { contact_key: "telegram:late", qualification_status: "pending", booking_status: "none" },
    { contact_key: "telegram:future", qualification_status: "pending", booking_status: "none" },
    { contact_key: "telegram:fresh", qualification_status: "pending", booking_status: "none" },
  ];
  const sent = [];
  const appended = [];
  const runAudit = createNightlyMissedAudit({
    ownerChatId: () => "owner-100",
    readLeads: async () => leads,
    readEvents: async () => events,
    sendTelegramText: async (message) => {
      sent.push(message);
      return { chat: { id: 100 }, message_id: 200, date: Math.floor(now.getTime() / 1000) };
    },
    appendEvent: async (event) => appended.push(event),
    now: () => now,
  });

  assert.deepEqual(await runAudit(), { day: "2026-09-29", prospects: 4, qualified: 1,
    requested: 1, confirmed: 0, missed: 2 });
  assert.match(sent[0].text, /Replied today: 2/);
  assert.match(sent[0].text, /Missed replies: 2/);
  assert.equal(appended.length, 1);
});

test("qualification retries provider errors and falls back without inventing booking intent", async () => {
  let calls = 0;
  const runQualification = createQualifyLeadHandler({
    hasApiKey: () => true,
    model: () => "vendor/model:free",
    callOpenRouter: async () => { calls++; throw new Error("provider unavailable"); },
  });
  const existing = { budget_ugx: 2500000, area_preference: "Kisaasi", bedrooms: 3,
    timeline: "within 2 weeks", listing_id: "KISAASI-1", needs_booking: true, prospect_name: null };

  const result = await runQualification({ text: "Can I view it?", fromName: "Sam", existing,
    listings: [], history: [], contactKey: "telegram:445566", messageId: "m1", timestamp: "2026-09-29T10:00:00Z" });

  assert.equal(calls, 2);
  assert.match(result.reply, /at capacity right now/);
  assert.deepEqual(result.extraction, { ...existing, needs_booking: false, prospect_name: "Sam" });
});

test("a viewing request with no available slots is handed to an agent and removed from follow-ups", async () => {
  const fixture = automationFixture();
  fixture.deps.proposeSlots = async () => [];
  await fixture.handle(fixture.message("prospect-206", "I need a 3 bedroom home in Kisaasi for 2.5m within two weeks"));
  await fixture.handle(fixture.message("prospect-206", "Can I book a viewing?"));

  const lead = fixture.state.leads.get("telegram:prospect-206");
  assert.equal(lead.needs_human, true);
  assert.equal(lead.viewing_intent, false);
  assert.equal(lead.follow_up_active, false);
  assert.equal(lead.next_follow_up, "");
  assert.match(fixture.state.sent.at(-1).text, /agent will contact you/);
});

test("when a proposed slot becomes unavailable and no replacement exists, the lead is handed to an agent", async () => {
  const fixture = automationFixture();
  await fixture.handle(fixture.message("prospect-207", "I need a 3 bedroom home in Kisaasi for 2.5m within two weeks"));
  await fixture.handle(fixture.message("prospect-207", "Can I book a viewing?"));
  fixture.deps.slotIsFree = async () => false;
  fixture.deps.proposeSlots = async () => [];

  await fixture.handle(fixture.message("prospect-207", "1"));
  const lead = fixture.state.leads.get("telegram:prospect-207");
  assert.equal(lead.booking_status, "none");
  assert.equal(lead.needs_human, true);
  assert.equal(lead.follow_up_active, false);
  assert.equal(fixture.state.calendar.size, 0);
});

