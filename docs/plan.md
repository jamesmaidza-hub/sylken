# sylken plan

sylken can only replace Compharm once dispensing, stock, the till and BOMAid claims all work, because dispensing takes stock off the shelf. Until then it runs beside Compharm as a test system.

| Stage | Scope | Done when |
|---|---|---|
| **1. Items and stock** (this release) | Item master, stock ledger in units, Compharm import, receiving, stock take, adjustments, min/max | The 30 Sep exports load cleanly and the min/max order report matches Compharm's ✅ |
| 2. Till and cash-up | Offline-capable till (browser app that syncs movements), tenders, till runs, cash-up, petty cash, daily sales and GP | A full day can be rung up and cashed up |
| 3. Dispensing | Patients, members and dependants, doctors, scripts, labels, allergies, owed items, repeats, schedule register | A script is dispensed end to end with stock deducted |
| 4. BOMAid claims | Claim files, member updates, real-time adjudication if offered, claim reports | BOMAid's test environment accepts claims |
| 5. Switchover | Full migration, final stock take, training, parallel run | Compharm is switched off |

## Decisions taken in stage 1

- **Multi-tenant cloud** with PostgreSQL row-level security; shop rules are settings.
- **Stock in whole units**, prices per pack. Min/max levels may be fractional.
- **Append-only ledger**; corrections are new movements. Only deleting a whole pharmacy removes ledger rows.
- **Negative stock is blocked by default** for sales, dispensing and adjustments; a pharmacist can override, and a setting allows it shop-wide. Offline till sales are always recorded, since they already happened.
- **Opening stock** comes from Compharm's exports for now: the 30 Sep min/max report where it has the item, else the 8 Oct usage report. Before switchover it must come from a fresh stock take.
- **Only items the shop has used are imported** (7,317 of 22,682); the rest of the item list is Compharm's product file. New items are added from supplier invoices.
- **Imported markups are kept per item** where they differ from the shop default (837 of the imported items at Friends), so re-pricing on receipt doesn't change them.
- **GP is shown on the price excluding VAT.** Compharm's GP % includes VAT in the price, so sylken's figures are lower for the same item.
- **No licensed reference data ships with sylken.** Each pharmacy's own item list is imported into its own tenant.

## Open questions

1. Is 71.2% (50% markup plus 14% VAT) the shop's deliberate default? sylken assumes so.
2. The Oct 2025 sales file and the usage history don't reconcile; which scope does each cover? Stage 1 uses the usage history for min/max suggestions and the sales file only for pack size, bin and schedule.
3. Can Compharm give a database export? Suppliers, departments, VAT per item and patients aren't in the reports.
4. Which suppliers does the shop order from, and do any accept electronic orders?
