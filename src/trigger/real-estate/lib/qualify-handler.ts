import type { QualifierExtraction, QualifyPayload } from "./types.js";

export type QualificationDependencies = {
  hasApiKey: () => boolean;
  model: () => string | undefined;
  callOpenRouter: (payload: Pick<QualifyPayload, "text" | "listings" | "history" | "existing">) =>
    Promise<{ reply: string; extraction: QualifierExtraction }>;
};

export function createQualifyLeadHandler(deps: QualificationDependencies) {
  return async function qualifyLead(payload: QualifyPayload) {
    if (!deps.hasApiKey()) throw new Error("OPENROUTER_API_KEY is not set");
    if (!deps.model()) throw new Error("LLM_MODEL is not set");

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { reply, extraction } = await deps.callOpenRouter({
          text: payload.text,
          listings: payload.listings,
          history: payload.history,
          existing: payload.existing,
        });
        const trimmed = reply.trim();
        return {
          reply: trimmed || "Thanks for reaching out — let me connect you to the agent for details.",
          extraction,
        };
      } catch {
        if (attempt === 1) {
          return {
            reply: "Thanks for your message — the demo assistant is at capacity right now. Please try again shortly, or use /help for options.",
            extraction: { ...payload.existing, needs_booking: false,
              prospect_name: payload.existing.prospect_name ?? payload.fromName ?? null },
          };
        }
      }
    }
    throw new Error("qualify-lead failed");
  };
}
