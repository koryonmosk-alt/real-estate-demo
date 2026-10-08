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
| Workflow | Trigger.dev **Production** on the Free plan, with a once-per-minute non-blocking Telegram poll | Trigger lists a $0 Free plan with $5 monthly usage credits. Production runs use those included credits; the Free plan stops tasks when credits are exhausted. Do not upgrade or add billing. [Trigger pricing](https://trigger.dev/pricing/) |
| AI | Existing OpenRouter key with `LLM_MODEL=nvidia/nemotron-3-super-120b-a12b:free` (pinned; never `openrouter/free`) | Use only free models. Free-model limit: 50 requests/day, or 1,000/day once the account has bought $10 of credits (this account has); a limit or unavailable model must stop/retry safely, never switch to a paid model. [OpenRouter pricing](https://openrouter.ai/pricing/), [free models](https://openrouter.ai/collections/free-models/) |
| Data and booking | Existing Google Sheets and Calendar service account | Keep API use within standard quotas and do not enable a paid billing path. Google describes standard Sheets use as no additional cost and Calendar use below its daily billing threshold as no extra charge. Check current project quotas before a public demo. [Sheets quotas](https://developers.google.com/workspace/sheets/api/limits), [Calendar quotas](https://developers.google.com/workspace/calendar/api/guides/quota) |

Production polling and scheduled follow-ups run on Trigger.dev while usage credits remain; no laptop worker is needed. The poller checks Telegram once per minute without long polling to reduce compute use. Monitor Trigger.dev usage; if the $5 monthly credit runs out, the Free plan stops tasks until credits reset. Telegram retains unreceived updates for **at most 24 hours**; a longer outage can lose inbound messages. An always-on client pilot needs a separate hosting decision. Do not put this prospective-client demo on Vercel Hobby: Vercel restricts that free plan to personal, non-commercial use. [Telegram update retention](https://core.telegram.org/bots/api), [Vercel Hobby](https://vercel.com/docs/plans/hobby)

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
  - Run a single queued scheduled task with `getUpdates` every minute, `timeout: 0`, a short request timeout, and one active poll at a time. Request only `message` updates for the first version. This gives up to about one minute of intake delay while avoiding the compute cost of long polling. Filter to private text chats and supported commands.
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

This explicit demo schema is the safer path because the existing Sheet code rejects mismatched headers and currently looks for the phone column at a fixed index. A later provider-unified schema can migrate both datasets after the demo.

## Step 5 — Replace WhatsApp sends and adapt the conversation

Add `src/trigger/real-estate/lib/send-telegram.ts` using Telegram's HTTPS `sendMessage` endpoint. It takes `chatId` and plain text, checks both HTTP status and the Bot API `ok` field, and returns Telegram's sent `message_id` for the event log. Keep the token out of logs, especially because the Bot API URL contains it. Handle `429` using the API's `retry_after` value; when a user blocks the bot or the chat becomes unavailable, mark follow-up inactive instead of retrying forever. Keep each message within Telegram's current 4,096-character text limit. [Bot API `sendMessage`](https://core.telegram.org/bots/api#sendmessage)

Update the existing tasks:

| Current file | Telegram change |
| --- | --- |
| `src/trigger/real-estate/inbound-message.ts` | Use channel-qualified lead ID and Telegram sender. Keep conversation memory, listing checks, qualifiers, slot selection, tentative event, and owner decision. Handle `/start`, `/help`, `/stop`, `/resume` before the AI call. Allow both `1/2/3` slot replies and owner `/confirm <code>` or `/decline <code>`. Only log a reply as sent after the Telegram API accepts it. |
| `src/trigger/real-estate/qualify-lead.ts` and `lib/send-openrouter.ts` | Keep extraction and listing constraints; change the prompt from “WhatsApp assistant” to a channel-neutral “real-estate demo assistant.” Require a free model and provide a clear, truthful fallback if free-model capacity is exhausted. |
| `src/trigger/real-estate/daily-follow-up.ts` | Replace Meta template names with ordinary Telegram text for days 1, 3, and 7. Preserve eligibility, deduplication, stop-on-reply, booking, and opt-out rules. Do not mark a touch sent when Telegram rejects it. |
| `src/trigger/real-estate/nightly-missed-audit.ts` | Keep the existing reply-timing calculation; send the digest with `sendMessage` to `OWNER_TELEGRAM_CHAT_ID`. Record the sent Telegram message ID or clear delivery failure. |
| `src/trigger/real-estate/lib/sheet.ts`, `lib/types.ts`, `lib/calendar.ts` | Implement the identity/schema updates from Step 4; keep listing and Calendar API behavior otherwise. |
| `.env.example` | Add blank `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_CHAT_ID`, the Development-only owner-as-prospect switch, and Telegram Sheet tab names. Meta/Twilio variables are inactive in this demo. |

The current `lib/send-whatsapp.ts` can remain as an unused adapter for possible later WhatsApp onboarding. The Telegram demo must not call it or require Meta environment variables.

## Automated regression tests

Run `npm test` before a demo or code change. It compiles the TypeScript and runs the Node test suite. The tests use in-memory records and mocked Telegram, OpenRouter, Google Sheets, and Google Calendar boundaries; they do not message real chats or modify real sheets or calendars.

Coverage includes Telegram polling and offset safety, contact identity and conversation memory, qualification and free-model fallback, slot availability and owner confirmation, opt-out and follow-up rules, blocked chats, nightly reply-SLA counts, and the Google Sheets schema/upsert paths. A live rehearsal is still needed to verify the account credentials, actual sheet sharing, and actual Calendar permissions.

## Step 6 — Run a $0 rehearsal

1. Confirm the Production deployment and its `poll-telegram-updates` schedule are active. The task polls once per minute. After the first successful poll, send `/start` from the prospect account.
2. Send a listing inquiry from the prospect account. Check a reply arrives and one row appears in `TelegramLeads`; send a second message and verify the same row is updated with remembered answers.
3. Ask for a viewing; choose `1`, `2`, or `3`. Confirm Calendar availability was checked and a tentative event was created. The owner account should receive the booking code.
4. From the owner account, send `/confirm <code>`. Check the Calendar event is confirmed, the lead row records confirmation, and the prospect receives the decision. Rehearse `/decline` with a separate request.
5. Rehearse `/stop` and `/resume`. Confirm scheduled messages stop while opted out and resume only after the user's own command. Block the bot on a disposable test chat and verify the send failure stops follow-ups.
6. Confirm a scheduled follow-up is due for a dedicated test lead and inspect the 09:00 EAT Trigger run. Keep the laptop on for the overnight audit and, if desired, the full seven-day sequence. Show audit totals in Trigger and the Telegram owner chat.
7. Replay a previously seen update and confirm it does not duplicate the lead, outbound reply, follow-up touch, or Calendar event. Restart the local worker and verify polling resumes from the offset in `TelegramState`.

**Done means:** a person can open the bot on their own Telegram phone, chat naturally, see one qualified lead row, request a viewing, and receive an owner-confirmed result. The follow-up and audit path must have a recorded successful send or an explicit failure state. The demo stays inside the free plan limits.

## Practical limits and future handoff

- This local arrangement is available only while the computer and Trigger Development worker are running. Telegram retains undelivered updates for no more than 24 hours. It is suited to a controlled live demo and recording, not an unattended client pilot. [Bot API](https://core.telegram.org/bots/api)
- Telegram users must initiate the bot chat. The bot cannot reach a lead by phone number or automatically take over a brokerage's existing WhatsApp inbox. [Telegram bots](https://core.telegram.org/bots)
- OpenRouter's free models can be rate-limited or unavailable. The bot should show a capacity message and preserve the lead rather than silently use a paid model. [OpenRouter free tier](https://openrouter.ai/pricing/)
- When a client wants a live WhatsApp pilot, choose an approved WhatsApp sender and account path, then map the same channel-neutral lead/booking core to that provider. The Telegram demo does not resolve the Meta restriction.

## Implementation order

1. BotFather bot and private test chats; store token and owner chat ID as secrets.
2. New Telegram Sheet tabs and Google sharing; confirm OpenRouter free-model access.
3. Implement polling intake and Telegram sender.
4. Refactor identity/storage and route the existing Trigger tasks through Telegram.
5. Adapt follow-ups and nightly audit; add truthful failure states.
6. Run the full rehearsal and record a short demo showing Telegram, the lead Sheet, and Calendar.

