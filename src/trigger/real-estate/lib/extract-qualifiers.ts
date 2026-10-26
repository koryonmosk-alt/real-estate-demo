import { parseBedrooms, parseBudget, parseDealType } from "./match-listings.js";
import type { Listing, QualifierExtraction } from "./types.js";

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";

export function parseTimeline(text: string): string | null {
  const lower = text.toLowerCase();
  if (/\b(asap|as soon as possible|immediately|right away|urgent|urgently)\b/.test(lower)) return "as soon as possible";
  if (/\b(any ?time|no rush|not in a hurry|whenever)\b/.test(lower)) return "anytime";
  const relative = lower.match(/\b(today|tomorrow|tonight|this (?:week|month|weekend)|next (?:week|month|weekend|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/);
  if (relative) return relative[1];
  const within = lower.match(/\b(?:within|in|after)\s+(?:about\s+)?(\d+|one|two|three|four|five|six)\s+(day|week|month)s?\b/);
  if (within) return `within ${within[1]} ${within[2]}${within[1] === "1" || within[1] === "one" ? "" : "s"}`;
  const month = lower.match(new RegExp(`\\b(${MONTHS})\\b`));
  return month ? `in ${month[1]}` : null;
}

export function parseArea(text: string, listings: Listing[]): string | null {
  if (/\b(any area|any ?where|any location|area (?:is not|isn't|doesn't|does not|is fine|is flexible)|no area|flexible on (?:the )?area|doesn'?t matter|does not matter|don'?t mind|not picky)\b/i.test(text)) {
    return "Any area";
  }
  const lower = text.toLowerCase();
  const areas = [...new Set(listings.map((l) => l.area.trim()).filter(Boolean))];
  return areas.find((area) => new RegExp(`\\b${area.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) ?? null;
}

// Free models often omit or garble the JSON line, so anything the prospect states
// explicitly is read straight from their message and wins over the model's guess.
export function applyStatedFacts(extraction: QualifierExtraction, latestText: string, listings: Listing[]): QualifierExtraction {
  return {
    ...extraction,
    deal_type: parseDealType(latestText) ?? extraction.deal_type,
    budget_ugx: parseBudget(latestText) ?? extraction.budget_ugx,
    bedrooms: parseBedrooms(latestText) ?? extraction.bedrooms,
    timeline: parseTimeline(latestText) ?? extraction.timeline,
    area_preference: parseArea(latestText, listings) ?? extraction.area_preference,
  };
}
