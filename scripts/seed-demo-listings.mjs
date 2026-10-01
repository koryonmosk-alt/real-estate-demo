import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { google } from "googleapis";

process.loadEnvFile(".env");

const csvPath = fileURLToPath(new URL("../sheets/sample-listings.csv", import.meta.url));
const csv = await readFile(csvPath, "utf8");

function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted && char === '"' && input[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && input[index + 1] === "\n") index++;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("The listings CSV has an unclosed quoted field.");
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

const rows = parseCsv(csv);
const headers = rows[0] ?? [];
if (headers.length !== 13 || rows.slice(1).some((row) => row.length !== headers.length)) {
  throw new Error("The demo listings CSV must have 13 matching columns on every row.");
}
if (rows.slice(1).some((row) => !row[0].startsWith("UG-") || !row[10].startsWith("FICTIONAL DEMO ONLY."))) {
  throw new Error("Refusing to seed a row that is not explicitly marked as fictional demo data.");
}

const { GOOGLE_SERVICE_ACCOUNT_EMAIL: email, GOOGLE_PRIVATE_KEY: key, LISTINGS_SHEET_ID: spreadsheetId } = process.env;
if (!email || !key || !spreadsheetId) {
  throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and LISTINGS_SHEET_ID must be set in .env.");
}
const privateKey = key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
const auth = new google.auth.JWT({ email, key: privateKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });
const range = "Sheet1!A1:M1000";
const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
const currentRows = current.data.values ?? [];

if (currentRows.length) {
  const currentHeader = currentRows[0];
  if (headers.slice(0, 12).some((header, index) => currentHeader[index] !== header)) {
    throw new Error("Sheet1 columns do not match the demo listings template; refusing to change it.");
  }
  const notesIndex = currentHeader.indexOf("notes");
  const nonDemoRows = currentRows.slice(1).filter((existing) => existing.some((value) => value !== "") &&
    !/fictional demo/i.test(existing[notesIndex] ?? ""));
  if (nonDemoRows.length) {
    throw new Error("Sheet1 contains rows not marked fictional; refusing to overwrite them.");
  }
}

console.log(`Ready to write ${rows.length - 1} fictional Uganda demo listings to Sheet1!A1:M${rows.length}.`);
if (!process.argv.includes("--apply")) {
  console.log("Dry run only. Re-run with --apply to update the demo Listings sheet.");
  process.exit(0);
}

await sheets.spreadsheets.values.update({
  spreadsheetId,
  range: `Sheet1!A1:M${rows.length}`,
  valueInputOption: "RAW",
  requestBody: { values: rows },
});
console.log("Demo Listings sheet updated.");
