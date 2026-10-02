import test from "node:test";
import assert from "node:assert/strict";
import { google } from "googleapis";
import { sendTelegramText, telegramRequest } from "../dist/src/trigger/real-estate/lib/telegram-api.js";
import { callOpenRouter } from "../dist/src/trigger/real-estate/lib/send-openrouter.js";
import { confirmViewing, declineViewing, requestViewing, slotIsFree } from "../dist/src/trigger/real-estate/lib/calendar.js";
import { LEAD_HEADER, readListings, readTelegramUpdateOffset, upsertLead, writeTelegramUpdateOffset } from "../dist/src/trigger/real-estate/lib/sheet.js";

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
}

test("Telegram sender uses the configured bot and returns Telegram's accepted message", async (t) => {
  setEnv(t, { TELEGRAM_BOT_TOKEN: "unit-test-telegram-token" });
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.telegram.org/botunit-test-telegram-token/sendMessage");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      chat_id: "445566",
      text: "A reply from the demo bot",
      link_preview_options: { is_disabled: true },
    });
    return Response.json({ ok: true, result: { message_id: 23, chat: { id: 445566 }, date: 1790000000 } });
  });

  const sent = await sendTelegramText({ chatId: "445566", text: "A reply from the demo bot" });
  assert.equal(sent.message_id, 23);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("Telegram API errors preserve retry metadata and never include the bot token", async (t) => {
  setEnv(t, { TELEGRAM_BOT_TOKEN: "unit-test-telegram-token" });
  t.mock.method(globalThis, "fetch", async () => Response.json({
    ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 9 },
  }, { status: 429 }));

  await assert.rejects(telegramRequest("getUpdates", {}, 1000), (error) => {
    assert.equal(error.errorCode, 429);
    assert.equal(error.retryAfter, 9);
    assert.doesNotMatch(error.message, /unit-test-telegram-token/);
    return true;
  });
});

test("Telegram sender rejects invalid text before making a network request", async (t) => {
  setEnv(t, { TELEGRAM_BOT_TOKEN: "unit-test-telegram-token" });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });
  await assert.rejects(sendTelegramText({ chatId: "1", text: "  " }), /must not be empty/);
  await assert.rejects(sendTelegramText({ chatId: "1", text: "x".repeat(4097) }), /4096-character limit/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("OpenRouter refuses a paid model before calling the provider", async (t) => {
  setEnv(t, { OPENROUTER_API_KEY: "unit-test-openrouter-key", LLM_MODEL: "provider/paid-model" });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });

  await assert.rejects(callOpenRouter({ text: "Hello", listings: [], history: [], existing: {
    budget_ugx: null, area_preference: null, bedrooms: null, timeline: null,
    listing_id: null, needs_booking: false, prospect_name: null, deal_type: null,
  } }), /must be a free OpenRouter model/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

const blankExisting = { budget_ugx: null, area_preference: null, bedrooms: null, timeline: null,
  listing_id: null, needs_booking: false, prospect_name: null, deal_type: null };

test("OpenRouter refuses the random free router before calling the provider", async (t) => {
  setEnv(t, { OPENROUTER_API_KEY: "unit-test-openrouter-key", LLM_MODEL: "openrouter/free" });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });

  await assert.rejects(callOpenRouter({ text: "Hello", listings: [], history: [], existing: blankExisting }),
    /one specific :free model/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("OpenRouter treats an empty or JSON-only model reply as a failure so it can be retried", async (t) => {
  setEnv(t, { OPENROUTER_API_KEY: "unit-test-openrouter-key", LLM_MODEL: "vendor/model:free" });
  let body;
  const replies = ["", '{"budget_ugx":300000}'];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ choices: [{ finish_reason: "length", message: { content: replies.shift() } }] });
  });

  for (let i = 0; i < 2; i++) {
    await assert.rejects(callOpenRouter({ text: "Hi", listings: [], history: [], existing: blankExisting }),
      /no reply text \(finish_reason=length\)/);
  }
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.ok(body.max_tokens >= 1000);
});

test("OpenRouter prompt treats 'any area' as answered and forbids re-confirming collected details", async (t) => {
  setEnv(t, { OPENROUTER_API_KEY: "unit-test-openrouter-key", LLM_MODEL: "vendor/model:free" });
  let prompt = "";
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return Response.json({ choices: [{ message: { content: "Sure.\n{}" } }] });
  });

  await callOpenRouter({ text: "Any area it doesnt matter", listings: [], history: [], existing: blankExisting });
  assert.match(prompt, /set area_preference to "Any area"/);
  assert.match(prompt, /Never ask the prospect to re-confirm/);
});

test("OpenRouter preserves qualifiers and rejects an incompatible listing from the feed", async (t) => {
  setEnv(t, { OPENROUTER_API_KEY: "unit-test-openrouter-key", LLM_MODEL: "vendor/model:free" });
  const listing = { listing_id: "KISAASI-1", title: "Green Court", area: "Kisaasi", bedrooms: 3,
    bathrooms: 2, price_ugx: 2500000, currency: "UGX", property_type: "Apartment", status: "available",
    listing_url: "", notes: "", photo_urls: [], deal_type: "rent" };
  const saleListing = { ...listing, listing_id: "SALE-1", deal_type: "sale" };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer unit-test-openrouter-key");
    assert.equal(JSON.parse(init.body).model, "vendor/model:free");
    return Response.json({ choices: [{ message: { content:
      'I can help with Green Court.\n{"deal_type":"rent","listing_id":"SALE-1","needs_booking":true}' } }] });
  });
  const existing = { budget_ugx: 2500000, area_preference: "Kisaasi", bedrooms: 3, timeline: "within 2 weeks",
    listing_id: "KISAASI-1", needs_booking: false, prospect_name: "Sam", deal_type: "rent" };

  const result = await callOpenRouter({ text: "Can I view it?", listings: [listing, saleListing], history: [], existing });
  assert.equal(result.reply, "I can help with Green Court.");
  assert.deepEqual(result.extraction, { ...existing, needs_booking: true });
});

function mockGoogleEnv(t) {
  setEnv(t, { GOOGLE_SERVICE_ACCOUNT_EMAIL: "service-account@example.test",
    GOOGLE_PRIVATE_KEY: "unit-test-private-key", OWNER_CALENDAR_ID: "calendar@example.test",
    LEAD_SHEET_ID: "unit-test-leads-sheet", LISTINGS_SHEET_ID: "unit-test-listings-sheet" });
}

test("Listings Sheet reads rental versus sale type with the runtime schema", async (t) => {
  mockGoogleEnv(t);
  const headings = ["listing_id", "title", "area", "bedrooms", "bathrooms", "price_ugx", "currency",
    "property_type", "status", "listing_url", "notes", "photo_urls", "deal_type"];
  t.mock.method(google, "sheets", () => ({ spreadsheets: { values: {
    get: async (args) => {
      assert.equal(args.range, "Sheet1!A1:M1000");
      return { data: { values: [headings, ["UG-RENT-001", "Kawempe 1-bedroom rental", "Kawempe", "1", "1",
        "450000", "UGX", "apartment", "available", "", "Fictional demo only; rent per month", "", "rent"]] } };
    },
  } } }));

  const listings = await readListings();
  assert.equal(listings[0].deal_type, "rent");
  assert.equal(listings[0].price_ugx, 450000);
});

test("Calendar refuses a busy slot and creates, confirms, and cancels a viewing through Google Calendar", async (t) => {
  mockGoogleEnv(t);
  const slot = { start: "2026-10-02T07:00:00.000Z", end: "2026-10-02T08:00:00.000Z", label: "Fri, Oct 2 at 10:00 AM" };
  const calls = { list: 0, insert: [], patch: [], delete: [] };
  const calendar = { events: {
    list: async () => { calls.list++; return { data: { items: [] } }; },
    insert: async (args) => { calls.insert.push(args); return { data: {} }; },
    patch: async (args) => { calls.patch.push(args); return { data: {} }; },
    delete: async (args) => { calls.delete.push(args); return { data: {} }; },
  } };
  t.mock.method(google, "calendar", () => calendar);

  assert.equal(await slotIsFree(slot), true);
  await requestViewing({ slot, eventId: "v123", prospect: "Sam", contactKey: "telegram:4455", listingId: "KISAASI-1" });
  await confirmViewing("v123");
  await declineViewing("v123");

  assert.equal(calls.insert.length, 1);
  assert.equal(calls.insert[0].requestBody.status, "tentative");
  assert.equal(calls.insert[0].requestBody.start.timeZone, "Africa/Kampala");
  assert.match(calls.insert[0].requestBody.description, /telegram:4455/);
  assert.equal(calls.patch[0].requestBody.status, "confirmed");
  assert.deepEqual(calls.delete[0], { calendarId: "calendar@example.test", eventId: "v123" });
  assert.ok(calls.list >= 2);
});

test("Calendar does not insert a viewing after availability changes", async (t) => {
  mockGoogleEnv(t);
  const calls = { insert: 0 };
  t.mock.method(google, "calendar", () => ({ events: {
    list: async () => ({ data: { items: [{ status: "confirmed", start: { dateTime: "2026-10-02T07:30:00.000Z" },
      end: { dateTime: "2026-10-02T08:30:00.000Z" } }] } }),
    insert: async () => { calls.insert++; return { data: {} }; },
  } }));
  const slot = { start: "2026-10-02T07:00:00.000Z", end: "2026-10-02T08:00:00.000Z", label: "Fri, Oct 2 at 10:00 AM" };

  await assert.rejects(requestViewing({ slot, eventId: "v456", prospect: "Sam",
    contactKey: "telegram:4455", listingId: "KISAASI-1" }), /no longer available/);
  assert.equal(calls.insert, 0);
});

function makeLead(contactKey, budget = "2500000") {
  const row = Object.fromEntries(LEAD_HEADER.map((key) => [key, ""]));
  Object.assign(row, {
    timestamp: "2026-09-29T10:00:00.000Z", prospect_name: "Sam", contact_key: contactKey,
    channel: "telegram", telegram_chat_id: contactKey.replace("telegram:", ""), telegram_username: "sam",
    budget_ugx: budget, area_preference: "Kisaasi", bedrooms: "3", timeline: "within 2 weeks", deal_type: "rent",
    qualification_status: "qualified", lead_status: "warm", listing_id: "KISAASI-1", notes: "",
    next_follow_up: "", first_inbound_at: "2026-09-29T10:00:00.000Z",
    last_inbound_at: "2026-09-29T10:00:00.000Z", last_outbound_at: "", last_message_id: "m1",
    conversation_history: "[]", proposed_slots: "[]", booking_status: "none", booking_code: "",
    calendar_event_id: "", follow_up_touch: 0, follow_up_sequence: "m1", follow_up_active: true,
    opted_out: false, needs_human: false, viewing_intent: false, selected_slot: "",
  });
  return row;
}

test("Google Sheets upsert updates the existing row for a Telegram contact key", async (t) => {
  mockGoogleEnv(t);
  const existing = makeLead("telegram:445566");
  const grid = [LEAD_HEADER, LEAD_HEADER.map((key) => String(existing[key] ?? ""))];
  const calls = { updates: [], appends: [] };
  const sheets = {};
  sheets.spreadsheets = {
    get: async () => ({ data: { sheets: [{ properties: { title: "TelegramLeads" } }] } }),
    batchUpdate: async () => ({ data: {} }),
  };
  sheets.spreadsheets.values = {
    get: async () => ({ data: { values: grid } }),
    update: async (args) => { calls.updates.push(args); return { data: {} }; },
    append: async (args) => { calls.appends.push(args); return { data: {} }; },
  };
  t.mock.method(google, "sheets", () => sheets);

  await upsertLead({ ...existing, budget_ugx: "3000000", bedrooms: "4" });

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].range, "'TelegramLeads'!A2:AF2");
  assert.equal(calls.updates[0].requestBody.values[0][2], "telegram:445566");
  assert.equal(calls.updates[0].requestBody.values[0][6], "3000000");
  assert.equal(calls.updates[0].requestBody.values[0][8], "4");
  assert.equal(calls.appends.length, 0);
});

test("Google Sheets creates the Telegram lead tab and header before appending its first prospect", async (t) => {
  mockGoogleEnv(t);
  const lead = makeLead("telegram:778899");
  const calls = { batchUpdate: [], updates: [], appends: [] };
  const sheets = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [] } }),
      batchUpdate: async (args) => { calls.batchUpdate.push(args); return { data: {} }; },
      values: {
        get: async () => ({ data: { values: [] } }),
        update: async (args) => { calls.updates.push(args); return { data: {} }; },
        append: async (args) => { calls.appends.push(args); return { data: {} }; },
      },
    },
  };
  t.mock.method(google, "sheets", () => sheets);

  await upsertLead(lead);

  assert.equal(calls.batchUpdate[0].requestBody.requests[0].addSheet.properties.title, "TelegramLeads");
  assert.equal(calls.updates[0].range, "'TelegramLeads'!A1:AF1");
  assert.deepEqual(calls.updates[0].requestBody.values[0], [...LEAD_HEADER]);
  assert.equal(calls.appends[0].requestBody.values[0][2], "telegram:778899");
});

test("Telegram polling offset initializes its header and persists only valid offsets", async (t) => {
  mockGoogleEnv(t);
  const calls = [];
  const sheets = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { title: "TelegramState" } }] } }),
      batchUpdate: async () => ({ data: {} }),
      values: {
        get: async () => ({ data: { values: [] } }),
        update: async (args) => { calls.push(args); return { data: {} }; },
      },
    },
  };
  t.mock.method(google, "sheets", () => sheets);

  assert.equal(await readTelegramUpdateOffset(), null);
  await writeTelegramUpdateOffset(501);
  assert.deepEqual(calls[0].requestBody.values, [["key", "value"]]);
  assert.equal(calls[0].range, "'TelegramState'!A1:B1");
  assert.deepEqual(calls[1].requestBody.values, [["update_offset", "501"]]);
  assert.equal(calls[1].range, "'TelegramState'!A2:B2");
  await assert.rejects(writeTelegramUpdateOffset(-1), /Invalid Telegram update offset/);
});
