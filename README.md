# Real Estate Telegram Automation Demo

A Telegram-based demonstration of a real-estate lead workflow built with Trigger.dev, Google Sheets, Google Calendar, and OpenRouter. It captures and qualifies inquiries, suggests viewing slots, tracks follow-ups, and sends an owner audit.

This repository contains the automation service, not a public-facing website. Trigger.dev runs the automation tasks. Vercel does not host the scheduled Telegram polling worker; a Vercel deployment would need a separate web application or HTTP endpoint.

## Requirements

- Node.js compatible with the installed Trigger.dev SDK
- A Trigger.dev project configured in `trigger.config.ts`
- A Telegram bot
- Google Sheets and Calendar access for a service account
- An OpenRouter API key and a free model selection

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and fill in the required values. Never commit `.env` or share its values.
3. Configure the same runtime secrets in the appropriate Trigger.dev environment.
4. Start the local Trigger.dev worker with `npm run dev`.

See [telegramsetup.md](telegramsetup.md) for the complete demo setup, data-sheet expectations, and rehearsal checklist.
The fictional sample inventory is in [sheets/sample-listings.csv](sheets/sample-listings.csv); the runtime reads the Listings spreadsheet, and [sheets/README.md](sheets/README.md) documents the guarded seed command.

## Validation

- `npm run build` checks the TypeScript sources.
- `npm test` compiles the sources and runs the mocked regression suite.

Tests use mocked service boundaries and do not send Telegram messages or modify real Google Sheets or Calendar events.

## Deployment

Deploy these tasks to Trigger.dev using the Trigger.dev CLI and the appropriate Trigger.dev project environment. Do not configure Vercel as the runtime for the polling/scheduled automation. Vercel can be connected to this GitHub repository if a separate website is later added, but this repository currently has no Vercel web application to deploy.

## Demo scope

The Telegram bot demonstrates the workflow and is not a WhatsApp integration. The WhatsApp adapter remains inactive; client WhatsApp onboarding requires its own provider setup and credentials.
