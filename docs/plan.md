# sylken plan

sylken can only replace Compharm once dispensing, stock, the till and BOMAid claims all work, because dispensing takes stock off the shelf. Until then it runs beside Compharm as a test system.

| Stage | Scope | Done when |
|---|---|---|
| **1. Items and stock** | Item master, stock ledger in units, Compharm import, receiving, stock take, adjustments, min/max | The 30 Sep exports load cleanly and the min/max order report matches Compharm's ✅ |
| **2. Till and cash-up** (this release) | Offline-capable till, tenders, till runs, cash-up, petty cash, customer accounts, daily sales and GP | A full day can be rung up and cashed up ✅ (tested with the Friends item list in a browser, including a spell offline) |
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

## Decisions taken in stage 2

- **The till is a browser app that works offline.** Item list, open run and sales are kept in the browser and sent when the server can be reached; ids made by the till make resending safe. A run can be opened offline; its number is given when it reaches the server.
- **A sale is recorded whatever the stock or item state says**, because it already happened. It is never edited or deleted; refunds put things right.
- **Tenders**: cash, card, cheque, EFT / direct bank, account and medical aid. Vouchers and loyalty points wait until after switchover.
- **Cash-up counts cash, card batch and cheques**; EFT is checked against the bank statement. Assistants count blind.
- **Late sales** (reaching the server after their run is cashed up) are kept, flagged and shown on the run, so a till that was offline at closing shows up as a difference rather than vanishing.
- **Sales summary** follows POSWin's layout: "cash sales" means everything paid at the till (cash, card, cheque, EFT), and runs are picked by the day they opened.
- **Medical aid at the till** is recorded as a tender with the scheme and member number. Claims come in stage 4.
- **Line prices** are the units as a fraction of the pack price, so whole packs are exact. A changed price keeps the list price beside it, and the GP report shows discounts given.

## Open questions

1. Is 71.2% (50% markup plus 14% VAT) the shop's deliberate default? sylken assumes so.
2. The Oct 2025 sales file and the usage history don't reconcile; which scope does each cover? Stage 1 uses the usage history for min/max suggestions and the sales file only for pack size, bin and schedule.
3. Can Compharm give a database export? Suppliers, departments, VAT per item and patients aren't in the reports.
4. Which suppliers does the shop order from, and do any accept electronic orders?
5. Does the shop round cash to 5 or 10 thebe at the till? sylken charges to the thebe for now.
6. What must a till slip show to count as a VAT invoice for BURS? sylken prints the shop name, VAT number (set in Settings), date, items, total incl VAT and tenders.
7. How many tills, and which slip printers and card machines? The card machine isn't linked; its batch total is entered at cash-up.
8. Is direct banking (EFT) used at Friends, and are account customers given credit limits?
