import type { Listing, QualifierExtraction } from "./types.js";

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

function ugx(value: number): string {
  return value.toLocaleString("en-US");
}

export function parseBudget(text: string): number | null {
  const pattern = /(\d+(?:[.,]\d+)*)\s*(k|m|million|thousand)?(?![a-z0-9])(\s*(?:bed|br\b|bd\b))?/gi;
  for (const match of text.replace(/(\d),(\d{3})/g, "$1$2").matchAll(pattern)) {
    if (match[3]) continue;
    const base = Number(match[1].replace(/,/g, ""));
    const unit = (match[2] ?? "").toLowerCase();
    const value = unit === "k" || unit === "thousand" ? base * 1_000
      : unit === "m" || unit === "million" ? base * 1_000_000 : base;
    const digits = match[1].replace(/[^0-9]/g, "");
    if (!unit && (digits.length >= 9 || digits.startsWith("0"))) continue;
    if (Number.isFinite(value) && value >= 50_000 && value <= 10_000_000_000) return Math.round(value);
  }
  return null;
}

export function parseBedrooms(text: string): number | null {
  if (/\b(bedsitter|bed-sitter|studio|single room)\b/i.test(text)) return 0;
  const digits = text.match(/\b(\d)\s*[- ]?(?:bed(?:room)?s?|br|bd)\b/i);
  if (digits) return Number(digits[1]);
  const word = text.match(/\b(one|two|three|four|five)\s*[- ]?(?:bed(?:room)?s?|br)\b/i);
  return word ? WORD_NUMBERS[word[1].toLowerCase()] : null;
}

export function parseDealType(text: string): "rent" | "buy" | null {
  if (/\b(rent|renting|rental|to let|lease)\b/i.test(text)) return "rent";
  if (/\b(buy|buying|purchase|for sale|to own)\b/i.test(text)) return "buy";
  return null;
}

function bedLabel(bedrooms: number): string {
  return bedrooms === 0 ? "bedsitter/studio" : `${bedrooms}-bedroom`;
}

function describe(listing: Listing, budget: number | null): string {
  const over = budget !== null && listing.price_ugx > budget ? `, ${ugx(listing.price_ugx - budget)} over budget` : "";
  return `${listing.listing_id} ${bedLabel(listing.bedrooms)} in ${listing.area} at UGX ${ugx(listing.price_ugx)}${over}`;
}

export function analyseMatches(listings: Listing[], existing: QualifierExtraction, latestText: string): string {
  const dealType = parseDealType(latestText) ?? existing.deal_type;
  if (!dealType) {
    return "Rent-or-buy is not known yet, so do not name any specific listing or price yet; ask whether they want to rent or buy.";
  }
  const kind = dealType === "rent" ? "rent" : "sale";
  const budget = parseBudget(latestText) ?? existing.budget_ugx;
  const bedrooms = parseBedrooms(latestText) ?? existing.bedrooms;
  const area = existing.area_preference && !/\b(any|anywhere|flexible)\b/i.test(existing.area_preference)
    ? existing.area_preference.trim().toLowerCase() : null;

  let pool = listings.filter((l) => l.status === "available" && l.deal_type === kind);
  const lines: string[] = [
    `Intent: ${kind === "rent" ? "rent (budget is per month)" : "buy (budget is a one-time total)"}; ` +
    `budget: ${budget === null ? "unknown" : `UGX ${ugx(budget)}`}; ` +
    `bedrooms: ${bedrooms === null ? "unknown" : bedrooms}; area: ${area ?? "any or unknown"}.`,
  ];
  if (area) {
    const inArea = pool.filter((l) => `${l.area} ${l.title}`.toLowerCase().includes(area));
    if (inArea.length) pool = inArea;
    else lines.push(`No listings are in "${area}"; the options below are from other areas.`);
  }

  const byBedrooms = bedrooms === null ? pool : pool.filter((l) => l.bedrooms === bedrooms);
  const exact = (budget === null ? byBedrooms : byBedrooms.filter((l) => l.price_ugx <= budget))
    .sort((a, b) => a.price_ugx - b.price_ugx).slice(0, 3);
  lines.push(`EXACT MATCHES (the only listings that fit both budget and bedrooms): ${
    exact.length ? exact.map((l) => describe(l, budget)).join("; ") : "none"}.`);

  let say = "";
  if (exact.length && (budget !== null || bedrooms !== null)) {
    say = `Good news: ${describe(exact[0], budget)}${exact[1] ? `. Another option is ${describe(exact[1], budget)}` : ""}.`;
  } else if (!exact.length && budget !== null) {
    const above = byBedrooms.filter((l) => l.price_ugx > budget).sort((a, b) => a.price_ugx - b.price_ugx).slice(0, 3);
    const within = pool.filter((l) => l.price_ugx <= budget && (bedrooms === null || l.bedrooms !== bedrooms))
      .sort((a, b) => Math.abs(a.bedrooms - (bedrooms ?? 0)) - Math.abs(b.bedrooms - (bedrooms ?? 0)) ||
        b.price_ugx - a.price_ugx).slice(0, 3);
    if (above.length) lines.push(`Cheapest with the right bedrooms but over budget: ${above.map((l) => describe(l, budget)).join("; ")}.`);
    if (within.length) lines.push(`Within budget but a different size: ${within.map((l) => describe(l, budget)).join("; ")}.`);
    const size = bedrooms === null ? "" : `${bedLabel(bedrooms)} `;
    say = `Unfortunately no ${size}listing fits UGX ${ugx(budget)}.` +
      `${above[0] ? ` The cheapest ${size}option is ${describe(above[0], budget)}.` : ""}` +
      `${within[0] ? ` Within your budget there is ${describe(within[0], budget)}.` : ""}`;
  }
  if (say) {
    lines.push(`AVAILABILITY STATEMENT (include this verbatim, with at most a short lead-in; never contradict it): ${say}`);
  }
  return lines.join("\n");
}
