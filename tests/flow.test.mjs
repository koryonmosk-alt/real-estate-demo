import test from "node:test";
import assert from "node:assert/strict";
import { nextFollowUpIso } from "../dist/src/trigger/real-estate/lib/sheet.js";
import { hasAllQualifiers } from "../dist/src/trigger/real-estate/lib/types.js";
import { viewingEventId } from "../dist/src/trigger/real-estate/lib/calendar.js";

test("follow-up due time stays at 09:00 Kampala when the inbound crosses the local day", () => {
  assert.equal(nextFollowUpIso(1, new Date("2026-09-22T22:30:00Z")),
    "2026-09-24T06:00:00.000Z");
});

test("qualification requires rent-or-buy intent, budget, area, bedroom count, and timeline", () => {
  const extraction = { budget_ugx: 2500000, area_preference: "Kisaasi", bedrooms: null,
    timeline: "next week", listing_id: null, needs_booking: false, prospect_name: null, deal_type: null };
  assert.equal(hasAllQualifiers(extraction), false);
  assert.equal(hasAllQualifiers({ ...extraction, bedrooms: 3, deal_type: "rent" }), true);
});

test("the same inbound Telegram message produces the same Calendar event ID", () => {
  assert.equal(viewingEventId("telegram:445566:73"), viewingEventId("telegram:445566:73"));
  assert.notEqual(viewingEventId("telegram:445566:73"), viewingEventId("telegram:445566:74"));
});
