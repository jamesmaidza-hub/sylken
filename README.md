# sylken

Pharmacy stock, till and dispensing software for Botswana, built to replace Compharm (RxWin, StockWin, POSWin) and to be sold to other pharmacies later.

Built so far: **stage 1, items and stock**, and **stage 2, till and cash-up**. It runs beside Compharm as a test system, fed from Compharm's report exports, until dispensing and BOMAid claims are built too (see `docs/plan.md`).

## What stage 1 does

- **Item master**: stock code, barcodes, description, pack size, loose-unit selling, cost (last and weighted average), retail, VAT, per-item markup, drug schedule, bins, status.
- **Stock ledger**: every change to stock is an append-only movement in whole units (opening, receipt, sale, dispense, adjustment, stock take, returns, transfers). On-hand is kept by the database, never typed in.
- **Receiving**: supplier invoices with free (bonus) stock, VAT totals, duplicate-invoice check, and re-pricing from the markup rule when posted.
- **Stock take**: whole shop or one bin, scan-to-count with "add" for items on several shelves, differences valued at cost. Sales made during the count are kept.
- **Adjustments** with reasons (damaged, expired, theft, own use, found, count correction, sample, other).
- **Min/max ordering**: the same rule as Compharm (every item at or below min, order up to max), exact and whole-pack quantities, CSV download, plus suggested levels from average daily usage.
- **Reports**: stock value, negative stock, dormant stock, adjustments, GP exceptions, quarantined items, stock card and price history per item.
- **Compharm import**: item list, min/max, 12-month usage and monthly sales exports.
- **Keyboard first**: F2 items, F3 receive, F4 stock take, F6 order, F7 reports, F8 settings, F9 till, F10 cash-up, `/` to search, arrows and Enter to pick. A scanned barcode opens the item directly.

## What stage 2 adds: the till and cash-up

- **Till screen** (`/till/`, F9): scan or search, `3*code` for three packs, `15u*code` for loose units, F4 quantity, F6 price change or discount %, F5 pay, F8 refund, F9 petty cash, F10 payment on an account, F12 reprint the slip. Slips print on an 80 mm printer through the browser.
- **Tenders**: cash (with change, rounded to 5 thebe), card, cheque, EFT / direct bank, customer account (within its credit limit) and medical aid, split any way on one sale. Slips show the VAT included and the shop's VAT number.
- **Works offline.** The till keeps the item list, its open run and every sale in the browser, and sends them when the server can be reached. Each sale has an id the till made, so a sale sent twice is recorded once. Sales are recorded even if the item was quarantined or stock would go negative, because they already happened. Anything the server can't accept is kept under Cash-up → till problems, never dropped.
- **Till runs**: each drawer session is a numbered run with its opening float. A run can be opened while offline.
- **Cash-up** (F10): count cash, card batch and cheques per run; sylken shows expected against counted and the surplus or shortage per tender. Assistants count blind: the expected figures appear once the run is closed. A sale that reaches the server after its run was cashed up is kept, flagged as late and shown on the run.
- **Sales summary** laid out like POSWin's: cash analysis per run (cash, card, cheques, total till, counted, surplus, direct bank, assistants), then the payments, bank deposit and turnover blocks, with warnings for runs not cashed up or late sales.
- **Customer accounts**: account sales and payments at the till, statements, corrections, and a debtors age analysis.
- **Reports**: daily sales (takings, VAT, cost, GP, by tender and assistant) and sales GP per item with discounts given, both with CSV. Trading days are counted in the shop's own time zone (Africa/Gaborone).
- **Sales are never edited or deleted**; a mistake is put right with a refund.

## Checked against Compharm

Loaded with the Friends Pharmacy exports of 30 Sep and 8 Oct 2026:

| | |
|---|---|
| Items imported | 7,317 of the 22,682 in the item list: those that appear in the min/max, usage or sales exports. The other 15,365 are Compharm's product file and are skipped (`--all` brings them in) |
| Active / dormant / quarantined | 2,069 / 5,157 / 91 |
| Min/max order report | **1,581 of 1,581 lines match** Compharm's 30 Sep report, same items and same order quantities (run `npm run check:minmax`) |

Dormant items appear in an export but had no stock, sales or purchases in the last year. They stay searchable but are kept out of counts and lists. Quarantined items came in with no description, no cost, no retail price, or an impossible cost (for example P13,387,138.67); they can't be sold until fixed.

## Stack, and why

| Part | Choice | Why |
|---|---|---|
| Language | TypeScript on Node 22 | One language for server, screens and the offline till to come |
| Web | [Hono](https://hono.dev), server-rendered pages | Fast, tiny, no front-end build step for the back office |
| Database | PostgreSQL 16 | Row-level security for many pharmacies on one database; reliable; free |
| Hosting | One small cloud server running Docker Compose (Postgres, app, Caddy for HTTPS) | *Estimate:* about P100–150 a month for the first several pharmacies, against P3,000 a month for Compharm |

**Built for many pharmacies from day one.** Every table carries a `tenant_id`, and PostgreSQL row-level security means one pharmacy's session cannot read or write another's rows, even through a bug in a query. Shop rules (VAT, default markup, rounding, negative stock, min/max days, the highest believable cost) are settings per pharmacy, not code. Items whose Compharm price doesn't follow the shop's default markup keep their own markup, so re-pricing on receipt doesn't move prices the shop set on purpose.

**Offline tills.** The till is a small browser app (`src/web/till/`) with a service worker, so the page itself loads without internet once it has been opened. It sends what it recorded to `POST /api/till/sync` in the order it happened; runs, sales and till entries carry ids the till made, so resending is harmless. Service workers need HTTPS (Caddy provides it) or `localhost`.

**Units, not fractional packs.** Compharm shows stock like "0.53 packs". sylken stores 53 units and shows "53/100". Min/max levels stay fractional because Compharm calculates them from usage.

## Running it

Needs Node 22 and PostgreSQL 16.

```sh
npm install
cp .env.example .env            # then set the passwords; export the variables
npm run migrate                 # creates tables and the sylken_app role
npm run tenant:create -- --slug friends --name "Friends Pharmacy" --email you@example.com --owner "Your Name" --password '...'
npm run import:compharm -- --tenant friends \
  --items Item_List_Cost_Retail_30Sep26.xlsx --minmax MinMaxLevel_30Sep26.xlsx \
  --usage Stock_Usage_History_All_08Oct26.xlsx --sales Sales_Oct2025_All_Items.csv \
  --report import-report.json
npm run check:minmax -- --tenant friends --minmax MinMaxLevel_30Sep26.xlsx
npm start                       # http://localhost:3000
```

The import only runs into an empty pharmacy, and by default skips item-list lines that appear in no other export; new items come in on supplier invoices. `import-report.json` lists every item it quarantined or had questions about.

To deploy on a server: set `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` and `DOMAIN`, then `docker compose up -d` and `docker compose run --rm app npm run migrate`.

## Tests

```sh
TEST_ADMIN_URL=postgres://postgres@localhost:5432/postgres npm test
SYLKEN_SEED_DIR=/path/to/compharm/exports npm test   # also checks the real exports
```

Tests run against a real PostgreSQL database that is recreated each run. Pharmacy data is never committed to this repository; the real-export test only runs when `SYLKEN_SEED_DIR` points at the files.

## Layout

```
migrations/         SQL schema, applied in order
src/domain/         business rules: items, stock ledger, receiving, stock take, min/max, till, cash-up, accounts, sales reports, settings, auth
src/import/         Compharm export readers and the import
src/web/            screens (Hono JSX) and the JSON API
src/web/till/       the till app that runs in the browser (plain JavaScript, no build step) and its service worker
src/cli/            migrate, create tenant, import, check min/max
test/               automated tests
docs/plan.md        stages and open questions
```
