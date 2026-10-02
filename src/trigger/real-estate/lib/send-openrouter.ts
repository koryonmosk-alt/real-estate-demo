import type { ConversationTurn, Listing, QualifierExtraction } from "./types.js";

function requireOpenRouterEnv() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const model = process.env.LLM_MODEL;
  if (!model) throw new Error("LLM_MODEL is not set");
  if (model === "openrouter/free") {
    throw new Error("LLM_MODEL must name one specific :free model; openrouter/free routes randomly and can pick models that return empty or non-chat replies");
  }
  if (!model.endsWith(":free")) {
    throw new Error("LLM_MODEL must be a free OpenRouter model for the zero-cost demo");
  }
  return { key, model };
}

function buildPrompt(params: { text: string; listings: Listing[]; history: ConversationTurn[]; existing: QualifierExtraction }): string {
  const feed = params.listings
    .filter((l) => l.status === "available")
    .map(
      (l) =>
        `- ${l.listing_id} | ${l.deal_type === "rent" ? "RENT (price per month)" : l.deal_type === "sale" ? "FOR SALE (one-time asking price)" : "transaction type unknown"} | ${l.title} | ${l.area} | ${l.bedrooms}BR/${l.bathrooms}BA | ${l.price_ugx} UGX | ${l.property_type} | ${l.listing_url} | ${l.notes}`
    )
    .join("\n");

  const history = params.history.slice(-12).map((turn) => `${turn.role}: ${turn.text}`).join("\n");
  return `You are the Telegram assistant for a fictional demo brokerage in Kampala (Uganda Homes Ltd).
Reply naturally and briefly. Collect whether the person wants to rent or buy, their budget (UGX), preferred area and bedrooms, and timeline over the conversation. Use the confirmed values below unless the prospect corrects them. Ask only for information still missing. A rental budget is monthly; a purchase budget is a one-time total. Match rental inquiries only to RENT listings and purchase inquiries only to FOR SALE listings. Do not compare monthly rent with a sale price. Only talk about properties in the Listings Feed; never invent listings, prices, availability, fees, or booking confirmation. If a detail is absent, offer to connect them to the agent.

Output: you MUST end with a single JSON object on its own line (no markdown fence) with keys: deal_type ("rent"|"buy"|null), budget_ugx (number|null), area_preference (string|null), bedrooms (number|null), timeline (string|null), listing_id (string|null matching a compatible feed id or null), needs_booking (boolean), prospect_name (string|null). Dates/timelines as short strings like "within 2 weeks" or "next Saturday".
Set needs_booking=true only when the latest prospect message asks to arrange a viewing. A request is not a confirmed booking.

Confirmed values from earlier messages:
${JSON.stringify(params.existing)}

Recent conversation:
${history || "(first message)"}

Listings Feed (only these are answerable):
${feed || "(no available listings — deflect to human)"}

Prospect message:
"""${params.text}"""

Reply naturally first (1-3 short sentences), then output the JSON line.
Preserve earlier confirmed values in the JSON even if they are not repeated in the latest message. If information is still missing, ask for the next missing qualifier. Do not offer a viewing slot until all qualifiers are collected.`;
}

function extractJsonLine(text: string): string | null {
  const lines = text.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("{") && t.endsWith("}")) return t;
  }
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

export async function callOpenRouter(params: {
  text: string;
  listings: Listing[];
  history: ConversationTurn[];
  existing: QualifierExtraction;
}): Promise<{ reply: string; extraction: QualifierExtraction }> {
  const { key, model } = requireOpenRouterEnv();
  const prompt = buildPrompt(params);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/ai-automations",
      "X-Title": "UG Rentals Bot",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 1200,
      reasoning: { enabled: false },
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonLine = extractJsonLine(content);

  let extraction: QualifierExtraction = { ...params.existing, needs_booking: false };

  if (jsonLine) {
    try {
      const parsed = JSON.parse(jsonLine) as Partial<QualifierExtraction>;
      const dealType = parsed.deal_type === "rent" || parsed.deal_type === "buy"
        ? parsed.deal_type : params.existing.deal_type;
      extraction = {
        budget_ugx:
          typeof parsed.budget_ugx === "number" && Number.isFinite(parsed.budget_ugx)
            ? parsed.budget_ugx
            : params.existing.budget_ugx,
        area_preference:
          typeof parsed.area_preference === "string" && parsed.area_preference.trim()
            ? parsed.area_preference.trim()
            : params.existing.area_preference,
        bedrooms:
          typeof parsed.bedrooms === "number" && Number.isFinite(parsed.bedrooms)
            ? parsed.bedrooms
            : params.existing.bedrooms,
        timeline:
          typeof parsed.timeline === "string" && parsed.timeline.trim()
            ? parsed.timeline.trim()
            : params.existing.timeline,
        deal_type: dealType,
        listing_id:
          typeof parsed.listing_id === "string" && params.listings.some((l) =>
            l.listing_id === parsed.listing_id && l.status === "available" &&
            (!dealType || l.deal_type === (dealType === "rent" ? "rent" : "sale")))
            ? parsed.listing_id
            : params.existing.listing_id,
        needs_booking: parsed.needs_booking === true,
        prospect_name:
          typeof parsed.prospect_name === "string" && parsed.prospect_name.trim()
            ? parsed.prospect_name.trim()
            : params.existing.prospect_name,
      };
    } catch {
      // keep defaults
    }
  }

  const reply = (jsonLine ? content.replace(jsonLine, "") : content).trim();
  if (!reply) throw new Error(`OpenRouter returned no reply text (finish_reason=${data.choices?.[0]?.finish_reason ?? "unknown"})`);
  return { reply, extraction };
}
