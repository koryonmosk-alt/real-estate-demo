import { task } from "@trigger.dev/sdk";
import { callOpenRouter } from "./lib/send-openrouter.js";
import { createQualifyLeadHandler } from "./lib/qualify-handler.js";

export const qualifyLead = task({
  id: "qualify-lead",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000 },
  run: createQualifyLeadHandler({
    hasApiKey: () => !!process.env.OPENROUTER_API_KEY,
    model: () => process.env.LLM_MODEL,
    callOpenRouter,
  }),
});
