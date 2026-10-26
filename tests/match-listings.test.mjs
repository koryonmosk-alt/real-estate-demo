import test from "node:test";
import assert from "node:assert/strict";
import { analyseMatches, parseBedrooms, parseBudget, parseDealType } from "../dist/src/trigger/real-estate/lib/match-listings.js";

const listing = (listing_id, area, bedrooms, price_ugx, deal_type = "rent", status = "available") => ({
  listing_id, title: `Fictional ${bedrooms}-bedroom`, area, bedrooms, bathrooms: 1, price_ugx, currency: "UGX",
  property_type: "apartment", status, listing_url: "", notes: "", photo_urls: [], deal_type,
});
const listings = [
  listing("R-1", "Bwaise", 0, 350000),
  listing("R-2", "Mbale", 1, 400000),
  listing("R-3", "Kireka", 1, 550000),
  listing("R-4", "Jinja", 2, 600000),
  listing("R-5", "Mukono", 2, 700000),
  listing("R-6", "Nansana", 2, 750000),
  listing("R-7", "Kisaasi", 3, 2500000),
  listing("S-1", "Bulenga", 2, 65000000, "sale"),
  listing("R-8", "Gone", 1, 100000, "rent", "let"),
];
const none = { budget_ugx: null, area_preference: null, bedrooms: null, timeline: null,
  listing_id: null, needs_booking: false, prospect_name: null, deal_type: null };

test("budget parsing handles k, m, commas and ignores bedroom counts and timelines", () => {
  assert.equal(parseBudget("300k ugx 1 bed"), 300000);
  assert.equal(parseBudget("My budget is 500k"), 500000);
  assert.equal(parseBudget("about 1.2m per month"), 1200000);
  assert.equal(parseBudget("UGX 1,500,000"), 1500000);
  assert.equal(parseBudget("2 bedrooms within 2 weeks"), null);
  assert.equal(parseBudget("Any area"), null);
});

test("bedroom and intent parsing", () => {
  assert.equal(parseBedrooms("2 bedrooms"), 2);
  assert.equal(parseBedrooms("one bedroom please"), 1);
  assert.equal(parseBedrooms("a bedsitter"), 0);
  assert.equal(parseBedrooms("budget 500k"), null);
  assert.equal(parseDealType("I want to rent"), "rent");
  assert.equal(parseDealType("looking to buy a house"), "buy");
  assert.equal(parseDealType("hello"), null);
});

test("unknown intent forbids naming listings or prices yet", () => {
  assert.match(analyseMatches(listings, none, "Hi, I need a place"), /do not name any specific listing/);
});

test("a 500k two-bedroom rental has no exact match and offers honest closest options", () => {
  const out = analyseMatches(listings, { ...none, deal_type: "rent", bedrooms: 2 }, "Any area is fine. My budget is 500k");
  assert.match(out, /EXACT MATCHES[^:]*: none/);
  assert.match(out, /Cheapest with the right bedrooms but over budget: R-4 2-bedroom in Jinja at UGX 600,000, 100,000 over budget/);
  assert.match(out, /Within budget but a different size: R-2 1-bedroom in Mbale at UGX 400,000/);
  assert.doesNotMatch(out.split("\n").find((l) => l.startsWith("EXACT")), /R-5|R-6/);
});

test("exact matches fit both budget and bedrooms, exclude sale and unavailable listings, and sort by price", () => {
  const out = analyseMatches(listings, { ...none, deal_type: "rent" }, "I want a 1 bedroom, budget 600k");
  const exact = out.split("\n").find((l) => l.startsWith("EXACT"));
  assert.ok(exact.indexOf("R-2") < exact.indexOf("R-3"));
  assert.doesNotMatch(exact, /R-8|S-1|R-4/);
});

test("a requested area with no listings is stated, and a flexible area is ignored", () => {
  const withArea = analyseMatches(listings, { ...none, deal_type: "rent", bedrooms: 2, budget_ugx: 800000, area_preference: "Entebbe" }, "ok");
  assert.match(withArea, /No listings are in "entebbe"/);
  const flexible = analyseMatches(listings, { ...none, deal_type: "rent", bedrooms: 2, budget_ugx: 800000, area_preference: "Any area" }, "ok");
  assert.doesNotMatch(flexible, /No listings are in/);
  assert.match(flexible, /area: any or unknown/);
});

test("a purchase budget is matched only against sale listings", () => {
  const out = analyseMatches(listings, { ...none, deal_type: "buy", bedrooms: 2 }, "I want to buy, budget 70m");
  assert.match(out, /one-time total/);
  assert.match(out.split("\n").find((l) => l.startsWith("EXACT")), /S-1/);
});

import { applyStatedFacts, parseArea, parseTimeline } from "../dist/src/trigger/real-estate/lib/extract-qualifiers.js";

test("timelines are read from natural phrases", () => {
  assert.equal(parseTimeline("I hope to move next week"), "next week");
  assert.equal(parseTimeline("Anytime"), "anytime");
  assert.equal(parseTimeline("within 2 weeks please"), "within 2 weeks");
  assert.equal(parseTimeline("in one month"), "within one month");
  assert.equal(parseTimeline("by December"), "in december");
  assert.equal(parseTimeline("asap"), "as soon as possible");
  assert.equal(parseTimeline("1 bedroom 400k"), null);
});

test("areas are read as flexible or matched against listing areas", () => {
  assert.equal(parseArea("Any area it doesnt matter", listings), "Any area");
  assert.equal(parseArea("anywhere is fine", listings), "Any area");
  assert.equal(parseArea("something in Nansana please", listings), "Nansana");
  assert.equal(parseArea("I want a room", listings), null);
});

test("facts the prospect states override the model, and a phone number is not a budget", () => {
  const base = { ...none, deal_type: "rent", budget_ugx: 300000, bedrooms: 1, area_preference: "Kampala" };
  assert.deepEqual(applyStatedFacts(base, "Actually my budget is 500k and 2 bedrooms", listings),
    { ...base, budget_ugx: 500000, bedrooms: 2 });
  assert.deepEqual(applyStatedFacts(base, "yes please", listings), base);
  assert.equal(parseBudget("call me on 0772123456"), null);
});

test("the availability statement is decided by code: exact match wins, otherwise an honest no", () => {
  const exact = analyseMatches(listings, { ...none, deal_type: "rent", bedrooms: 1 }, "budget 450k");
  assert.match(exact, /AVAILABILITY STATEMENT[^:]*: Good news: R-2 1-bedroom in Mbale at UGX 400,000/);
  assert.doesNotMatch(exact, /Unfortunately/);

  const nothing = analyseMatches(listings, { ...none, deal_type: "rent", bedrooms: 2 }, "budget 500k");
  assert.match(nothing, /Unfortunately no 2-bedroom listing fits UGX 500,000\. The cheapest 2-bedroom option is R-4/);
  assert.match(nothing, /Within your budget there is R-2 1-bedroom in Mbale/);

  const unknownBudget = analyseMatches(listings, { ...none, deal_type: "rent" }, "hello");
  assert.doesNotMatch(unknownBudget, /AVAILABILITY STATEMENT/);
});
