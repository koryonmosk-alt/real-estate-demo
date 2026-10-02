import type { QualifierExtraction, QualifyPayload } from "./types.js";

export type QualificationDependencies = {
  hasApiKey: () => boolean;
  model: () => string | undefined;
  callOpenRouter: (payload: Pick<QualifyPayload, "text" | "listings" | "history" | "existing">) =>
    Promise<{ reply: string; extraction: QualifierExtraction }>;
};

const DAILY_LIMIT_REPLY = "Thanks for your message — the demo assistant has reached its free daily limit. " +
  "Please try again tomorrow, or use /help for options.";
const BUSY_REPLY = "Thanks for your message — the demo assistant is at capacity right now. " +
  "Please try again shortly, or use /help for options.";

export function createQualifyLeadHandler(deps: QualificationDependencies) {
  return async function qualifyLead(payload: QualifyPayload) {
    if (!deps.hasApiKey()) throw new Error("OPENROUTER_API_KEY is not set");
    if (!deps.model()) throw new Error("LLM_MODEL is not set");

    const fallback = (reply: string) => ({
      reply,
      extraction: { ...payload.existing, needs_booking: false,
        prospect_name: payload.existing.prospect_name ?? payload.fromName ?? null },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { reply, extraction } = await deps.callOpenRouter({
          text: payload.text,
          listings: payload.listings,
          history: payload.history,
          existing: payload.existing,
        });
        return { reply: reply.trim(), extraction };
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.warn(`qualify attempt ${attempt + 1} failed: ${message.slice(0, 300)}`);
        // A spent daily quota cannot recover on retry, so don't waste a call or the customer's time.
        if (/free-models-per-day/.test(message)) return fallback(DAILY_LIMIT_REPLY);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
        else return fallback(BUSY_REPLY);
      }
    }
    throw new Error("qualify-lead failed");
  };
}
