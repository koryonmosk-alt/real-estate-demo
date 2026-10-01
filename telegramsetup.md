# Telegram demo plan — $0 platform spend

**Decision (29 September 2026):** Use a Telegram bot for the fictional Kampala real-estate automation demo. Twilio trials are unavailable on the account in Uganda, and the Meta business portfolio is under review. The existing WhatsApp work remains available for a later client integration.

**Implementation status:** Telegram polling, sending, contact identity, dedicated Sheet tabs, owner commands, follow-ups, and nightly audit are implemented locally. The owner chat must normally be separate from prospect chats. For a single-account Development rehearsal only, `ALLOW_OWNER_AS_PROSPECT=true` lets ordinary owner-chat messages enter the prospect flow; keep it false in production. The live Listings spreadsheet is the runtime source of truth; `sheets/sample-listings.csv` is the fictional import seed. See `sheets/README.md` for the safe seed command.

## What the demo will prove

A prospect opens the Telegram bot, asks about a sample listing, gives budget/area/bedrooms/timeline over several messages, and receives a fitting answer from the listings Sheet. The bot records one lead, offers open Calendar slots, creates a tentative viewing on selection, asks the owner to confirm, and reports the confirmed result. Follow-ups on days 1, 3, and 7 and the nightly missed-lead audit use Telegram messages. Use fictional listings and invited testers only.

Telegram changes the **channel**. A Telegram demo demonstrates the qualification, lead capture, booking, follow-up, and audit workflow; it is not evidence that a client's WhatsApp number is connected. The sales explanation and demo video must say “Telegram demonstration of the automation; WhatsApp integration requires separate onboarding.” The earlier business blueprints in `plan.md` and `real-estate.md` still describe the eventual WhatsApp offer.

## The $0 operating boundary

| Component | Demo choice | Cost boundary |
| --- | --- | --- |
| Messaging | Telegram Bot API | Free for developers and users; use normal bot messages, not paid broadcast features. [Telegram bots](https://core.telegram.org/bots) |
| Inbound | `getUpdates` long polling on this laptop | No HTTPS webhook host, tunnel, domain, or paid phone number. Telegram polling and webhooks are mutually exclusive. [Bot API](https://core.telegram.org/bots/api) |
| Workflow | Existing Trigger.dev **Development** environment and local `npm run dev` | Trigger lists a $0 Free plan and says DEV runs are not charged. Do not upgrade or deploy to a paid plan. [Trigger pricing](https://trigger.dev/pricing/) |
| AI | Existing OpenRouter key with `LLM_MODEL=openrouter/free` | Use only free models. The current Free plan lists 50 requests/day; a limit or unavailable model must stop/retry safely, never switch to a paid model. [OpenRouter pricing](https://openrouter.ai/pricing/), [free models](https://openrouter.ai/collections/free-models/) |
| Data and booking | Existing Google Sheets and Calendar service account | Keep API use within standard quotas and do not enable a paid billing path. Google describes standard Sheets use as no additional cost and Calendar use below its daily billing threshold as no extra charge. Check current project quotas before a public demo. [Sheets quotas](https://developers.google.com/workspace/sheets/api/limits), [Calendar quotas](https://developers.google.com/workspace/calendar/api/guides/quota) |

This plan requires a computer with internet access during the live demo. Keep the laptop and the local Trigger.dev Development worker running for inbound polling, scheduled follow-ups, and the nightly audit. Telegram retains unreceived updates for **at most 24 hours**; a longer outage can lose inbound messages. An always-on client pilot needs a separate hosting decision. Do not put this prospective-client demo on Vercel Hobby: Vercel restricts that free plan to personal, non-commercial use. [Telegram update retention](https://core.telegram.org/bots/api), [Vercel Hobby](https://vercel.com/docs/plans/hobby)

## Step 1 — Prepare the Telegram bot and test chats

1. In Telegram, open the verified **@BotFather** account and send `/newbot`. Choose a demo name and a unique username ending in `bot`. BotFather gives a bot token. Store it only in local `.env` (and Trigger.dev Development variables where the sender task runs). Never paste it in chat, a Sheet, source code, screenshots, or the repository. [BotFather guide](https://core.telegram.org/bots/features#creating-a-new-bot)
2. Give the bot a short description that says it is a real-estate demo and uses fictional listings. Set commands such as `/start`, `/help`, `/stop`, `/resume`, `/confirm`, and `/decline` through BotFather or the Bot API.
3. Use **two distinct Telegram accounts** for the full rehearsal: a prospect and the owner. Both open the bot and send `/start`. For a single-account Development check, enable `ALLOW_OWNER_AS_PROSPECT=true`; `/confirm`, `/decline`, and `/whoami` remain owner commands. A bot cannot begin a private conversation before a user messages it. [Telegram bot introduction](https://core.telegram.org/bots)
4. Implement `/whoami` to reply privately with the requesting chat's ID. Save the owner's ID as `OWNER_TELEGRAM_CHAT_ID` in local `.env`; the owner ID identifies commands. A username or phone number is not a reliable substitute for a chat ID. Do not collect a prospect's phone number for this demo.
5. Restrict the demo intake to **private text chats**. Ignore groups, channels, edited messages, bot messages, and unrelated update types; politely ask for text when a tester sends unsupported media. Use Telegram's own `chat.id` and `update_id` from the API rather than an invented identifier.

## Step 2 — Complete existing Google and AI preparation

1. Confirm the current Lead spreadsheet is shared with the service account. Keep its original WhatsApp `Sheet1` and `Events` tabs untouched. Create **`TelegramLeads`** and **`TelegramEvents`** tabs in that same spreadsheet for this demo, with new headers described in Step 4. This avoids treating a Telegram chat ID as a phone number.
2. Share the Listings spreadsheet and the demo Calendar with the same service account if not already done. Seed the Listings `Sheet1` from `sheets/sample-listings.csv` with `npm run seed:listings -- --apply`; the script refuses to overwrite rows that are not identified as fictional demos. Confirm the Calendar grants permission to create and update events.
3. Confirm the existing OpenRouter key is active and the configured model is free. Keep request volume below the current free-plan limit. If a key or Google private key was exposed during earlier setup, rotate it and update only the local and Trigger.dev secret stores.
4. Check the **Trigger.dev Development** environment has the OpenRouter, Google service-account, Sheet, and Calendar variables required by the current tasks. The Google private key's PEM newlines must be preserved. Do not copy secret values into documentation or task logs.

## Step 3 — Replace the inbound transport with local polling

Add a Trigger.dev task at `src/trigger/real-estate/telegram-poller.ts`, scheduled once per minute while the local Development worker is connected. This avoids a separate daemon, package dependency, tunnel, or public webhook. The task should:

- Load `TELEGRAM_BOT_TOKEN` from Trigger.dev Development. The poll task's first `getUpdates` request checks the token; a bad token produces a clear failed run without printing the credential. Trigger.dev's local worker reads its own project configuration normally.
- Check `getWebhookInfo`. If a webhook is configured, stop with a clear instruction; do not silently delete a webhook that might belong to another running deployment. `getUpdates` cannot receive updates while a webhook is set. [Bot API](https://core.telegram.org/bots/api)
- Run a single queued scheduled task with `getUpdates`, a positive long-poll timeout, and one active poll at a time. Request only `message` updates for the first version. Filter to private text chats and supported commands.
- For each accepted update, build a normalized payload: `channel="telegram"`, `contactKey="telegram:<chat_id>"`, `chatId` as a string, `messageId="telegram:<chat_id>:<message.message_id>"`, the message text, profile display name, and the message timestamp. Use `update_id` for intake idempotency.
- Enqueue the existing Trigger `inbound-message` task with an idempotency key derived from `update_id`. Process updates in order. Persist the highest processed `update_id + 1` in the `TelegramState` Sheet tab **only after** the full returned batch was safely enqueued or intentionally ignored. On an enqueue error, leave the saved offset unchanged so Telegram returns the updates again; Trigger idempotency makes replay safe.
- Handle network errors through Trigger retries. Run only one scheduled poll task at a time. Telegram can hold incoming updates for at most 24 hours, so the local worker must be running during demos. [Polling semantics](https://core.telegram.org/bots/api#getupdates)

No public webhook, Vercel function, separate bot process, or extra npm package is needed for this phase. The Meta WhatsApp webhook endpoint has been removed from the active demo path.

## Step 4 — Refactor identity and Sheet storage

The current `LeadRow.phone`, `EventRow.phone`, `findLead(phone)`, Calendar description, owner comparison, and follow-up payload all assume WhatsApp numbers. Change the **internal** identity to a channel-qualified key, such as `telegram:123456789`, and keep contact details separate:

- Add `channel`, `contact_key`, `telegram_chat_id`, `telegram_username` (optional), and `phone` (optional/blank) to a new `TelegramLeads` schema. Preserve qualification, conversation history, booking, follow-up, and opt-out columns. Qualification includes rent-versus-buy intent; rental budgets are monthly and sale budgets are one-time totals. The Listings feed's `deal_type` column keeps inventory matching aligned with that intent. Add `channel`, `contact_key`, and provider message IDs to `TelegramEvents`. Use the existing spreadsheet ID with explicit tab names; do not overwrite old `Sheet1`/`Events` headers.
- Change `findLead`, `upsertLead`, event logging, follow-up eligibility, and idempotency to key on `contact_key`. Ensure a second message from the same Telegram chat updates the same row. Do not use display name or username as the key; either may change.
- Give `InboundPayload` and `FollowUpPayload` channel-neutral recipient/contact fields instead of a field named `from`/`phone` that silently holds a chat ID. Use a full provider message reference because Telegram's `message_id` is scoped to its chat.
- Store booking codes and Calendar event IDs deterministically from the full provider message reference. In `calendar.ts`, replace `phone` in the event description with a useful “Telegram contact” label or lead reference. Keep the slot availability check and owner confirmation behavior.
- Keep `OWNER_TELEGRAM_CHAT_ID` separate from prospect records. Compare the inbound private-chat ID to this value *before* creating/updating a lead. Accept `/confirm <code>` and `/decline <code>` only from that ID.

This explicit demo schema is the safer path because the existing Sheet code rejects mismatched headers and currently looks for the phone column at a fixed index.…1486 tokens truncated…l. [OpenRouter free tier](https://openrouter.ai/pricing/)
- When a client wants a live WhatsApp pilot, choose an approved WhatsApp sender and account path, then map the same channel-neutral lead/booking core to that provider. The Telegram demo does not resolve the Meta restriction.

## Implementation order

1. BotFather bot and private test chats; store token and owner chat ID as secrets.
2. New Telegram Sheet tabs and Google sharing; confirm OpenRouter free-model access.
3. Implement polling intake and Telegram sender.
4. Refactor identity/storage and route the existing Trigger tasks through Telegram.
5. Adapt follow-ups and nightly audit; add truthful failure states.
6. Run the full rehearsal and record a short demo showing Telegram, the lead Sheet, and Calendar.
