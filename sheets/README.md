# Demo listings data

`sample-listings.csv` is the small, replaceable seed dataset for the Telegram demonstration. Every row is fictional, has no real address or contact details, and leaves listing/photo URLs blank. Do not present it as live inventory or as verified market pricing.

The CSV is the reviewable source copy in the repository. The running bot reads the live **Listings spreadsheet → `Sheet1`** using `LISTINGS_SHEET_ID`; the CSV does nothing until imported. To safely seed that sheet from the project root, run:

```powershell
npm run seed:listings
npm run seed:listings -- --apply
```

The first command checks credentials, sheet access, and whether existing rows are clearly marked demo-only, then prints a dry-run summary. The second writes the CSV only after those checks pass. The script refuses to overwrite rows that do not look like fictional demo entries.

There are 20 examples across Kampala, Wakiso, Entebbe, Mukono, Jinja, Mbarara, Gulu, Mbale, Masaka, and Fort Portal. Rentals range from a bedsitter through three bedrooms and carry a monthly UGX price. Sale examples cover residential homes and a plot with one-time asking prices. The `deal_type` column keeps those budgets separate in the bot's replies.

The amounts are illustrative test values, not a market survey or recommendation. They were chosen to exercise low-to-middle rental budgets and a broad purchase range, informed by visible Uganda asking-price examples on [Jiji Uganda rentals](https://jiji.ug/kampala/42-bedsitters-for-rent), [Jiji Uganda sales](https://jiji.ug/houses-apartments-for-sale/2-bedrooms), and [Homes.ug rentals](https://homes.ug/rent). Actual prices and availability must be checked with the owner or an agent.
