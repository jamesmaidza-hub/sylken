# sylken

Pharmacy stock, till and dispensing software for Botswana, built to replace Compharm (RxWin, StockWin, POSWin) and to be sold to other pharmacies later.

This is **stage 1: items and stock**. It runs beside Compharm as a test system, fed from Compharm's report exports, until dispensing, the till and BOMAid claims are built (see `docs/plan.md`).

## What stage 1 does

- **Item master**: stock code, barcodes, description, pack size, loose-unit selling, cost (last and weighted average), retail, VAT, per-item markup, drug schedule, bins, status.
- **Stock ledger**: every change to stock is an append-only movement in whole units (opening, receipt, sale, dispense, adjustment, stock take, returns, transfers). On-hand is kept by the database, never typed in.
- **Receiving**: supplier invoices with free (bonus) stock, VAT totals, duplicate-invoice check, and re-pricing from the markup rule when posted.
- **Stock take**: whole shop or one bin, scan-to-count with "add" for items on several shelves, differences valued at cost. Sales made during the count are kept.
- **Adjustments** with reasons (damaged, expired, theft, own use, found, count correction, sample, other).
- **Min/max ordering**: the same rule as Compharm (every item at or below min, order up to max), exact and whole-pack quantities, CSV download, plus suggested levels from average daily usage.
- **Reports**: stock value, negative stock, dormant stock, adjustments, GP exceptions, quarantined items, stock card and price history per item.
- **Compharm import**: item list, min/max, 12-month usage and monthly sales exports.
- **Keyboard first**: F2 items, F3 receive, F4 stock take, F6 order, F7 reports, F8 settings, `/` to search, arrows and Enter to pick. A scanned barcode opens the item directly.

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

**Ready for offline tills.** Movements carry an id the till can create itself. The till (stage 2) will record sales while offline and send them to `POST /api/movements` when it reconnects; sending the same movement twice records it once.

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
src/domain/         business rules: items, stock ledger, receiving, stock take, min/max, reports, settings, auth
src/import/         Compharm export readers and the import
src/web/            screens (Hono JSX) and the JSON API
src/cli/            migrate, create tenant, import, check min/max
test/               automated tests
docs/plan.md        stages and open questions
```
