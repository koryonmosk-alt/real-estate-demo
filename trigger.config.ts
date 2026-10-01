import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

const productionVariableNames = [
  "OPENROUTER_API_KEY",
  "LLM_MODEL",
  "TELEGRAM_BOT_TOKEN",
  "OWNER_TELEGRAM_CHAT_ID",
  "TELEGRAM_LEADS_TAB",
  "TELEGRAM_EVENTS_TAB",
  "TELEGRAM_STATE_TAB",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "LEAD_SHEET_ID",
  "LISTINGS_SHEET_ID",
  "OWNER_CALENDAR_ID",
] as const;

const productionSecretNames = new Set<string>([
  "OPENROUTER_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "OWNER_TELEGRAM_CHAT_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "LEAD_SHEET_ID",
  "LISTINGS_SHEET_ID",
  "OWNER_CALENDAR_ID",
]);

export default defineConfig({
  project: "proj_sxhkgodtdkbrgumcporg",
  dirs: ["./src/trigger"],
  maxDuration: 60,
  build: {
    extensions: [
      syncEnvVars(({ env, environment }) => {
        if (environment !== "prod") return;

        const missing = productionVariableNames.filter((name) => !env[name]);
        if (missing.length > 0) {
          throw new Error(
            `Cannot deploy Production: missing required environment variables: ${missing.join(", ")}`,
          );
        }

        return productionVariableNames.map((name) => ({
          name,
          value: env[name]!,
          isSecret: productionSecretNames.has(name),
        }));
      }),
    ],
  },
});

